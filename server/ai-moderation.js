/**
 * AI moderation. Every user-sent message passes through `moderateMessage()`
 * which asks an LLM (the same DeepSeek endpoint the helper bot uses) to
 * judge whether the message is safe to deliver. The LLM is also given:
 *
 *   - the nearest 10 prior messages in the room (so it can spot taunts,
 *     sarcasm, and replies that only make sense in context),
 *   - the sender's running severity score 0..10 so repeat offenders are
 *     judged more strictly,
 *   - a short description of any attachment (the LLM can't see binary
 *     content but knowing "image attached" or "file attached: <name>" is
 *     enough to flag suspicious filenames).
 *
 * The LLM must reply with strict JSON; anything else is treated as ALLOW
 * (fail-open) so that an LLM hiccup or proxy outage doesn't block the
 * whole chat.
 */

import {
  db,
  HELPER_USER_ID,
  bumpUserModerationSeverity,
  getUserModerationSeverity,
} from './db.js';
import { deepseekFetch } from './deepseek-client.js';

// Same endpoint the helper bot uses. No public fallback: without a
// DEEPSEEK_KEY (or explicit DEEPSEEK_API_URL), AI moderation is disabled
// and messages are allowed through (fail-open). Deployers bring their own key.
const DEEPSEEK_API = process.env.DEEPSEEK_KEY
  ? 'https://api.deepseek.com/v1/chat/completions'
  : (process.env.DEEPSEEK_API_URL || '');

const MOD_MODEL = process.env.AI_MOD_MODEL || 'deepseek-chat';
const MOD_TIMEOUT_MS = 8000;

/* === System prompt =====================================================
 *
 * Lightly adapted from the user-supplied moderation prompt. The structural
 * additions describe:
 *  - the JSON response shape
 *  - severity_delta semantics (how much to bump the user's running score)
 *  - how to use the sender_severity input
 *  - how to interpret attachment placeholders
 *
 * The behaviour rules in the middle of the prompt are kept verbatim from
 * the user's brief.
 * ====================================================================== */
const MOD_SYSTEM_PROMPT = [
  'You are an AI chat moderation assistant. Your role is to keep the chat',
  'safe, respectful, and appropriate for all users, especially in a casual',
  'gaming environment. You analyze every message before it is allowed to be',
  'sent. Your highest priority is preventing harassment, abuse, hate speech,',
  'inappropriate sexual content, and any behaviour that makes the chat',
  'unsafe or hostile.',
  '',
  'You must block any message that targets a person or group with insults,',
  'aggression, or harmful intent. This includes direct insults such as',
  '"loser," "you idiot," "you suck," "you goddamned skill is the worst I\'ve',
  'ever seen," or similar phrases when aimed at someone. It also includes',
  'stronger or more aggressive statements, especially when combined with',
  'profanity, such as "you\'re trash," "shut up," or any message clearly',
  'meant to attack or degrade another user. Even if the wording is mild, if',
  'the intent is to insult or provoke, it must be blocked.',
  '',
  'Profanity is allowed only when it is not directed at a person or group.',
  'Casual expressions like "oh shit," "this is hard as hell," or "what the',
  'fuck was that" are acceptable because they express emotion rather than',
  'attack others. However, if profanity is used toward someone (for example',
  '"you\'re fucking stupid"), the message must be blocked. Some texts can',
  'have completely different meanings in different context — "Ohh so',
  'scary!" sent while looking at a scary photo or playing a scary game is',
  'fine, but the same line in reply to an admin warning ("I\'m admin, if',
  'you keep spamming I can block you.") becomes mockery / abuse and must',
  'be blocked. Always read the recent messages first and judge in context.',
  '',
  'You must block all forms of hate speech. This includes any racist,',
  'discriminatory, or degrading language toward a person or group based on',
  'identity, including race, ethnicity, nationality, religion, gender,',
  'sexual orientation, or disability. Slurs are strictly forbidden in any',
  'form, including censored, partially hidden, or symbol-replaced versions.',
  'Even if presented as a joke, meme, or sarcasm, it must be treated as a',
  'violation and blocked.',
  '',
  'You must also block inappropriate sexual content. This includes explicit',
  'sexual language, sexual harassment, sexual insults, or any sexually',
  'suggestive content directed at another person. Any sexual content',
  'involving minors is strictly forbidden and must always be blocked. Mild',
  'non-explicit references that are clearly not targeting anyone may be',
  'tolerated, but anything explicit, uncomfortable, or directed at others',
  'must not be allowed.',
  '',
  'You must detect and block attempts to bypass moderation using symbols,',
  'spacing, or altered spelling. For example, replacing letters with',
  'symbols, adding spaces between letters, or using coded language to hide',
  'insults or slurs must still be treated as violations if the meaning is',
  'clear. Also shortened phrases like "sybau" (for "shut your bitch ass',
  'up") and similar abbreviations.',
  '',
  'You must also block indirect harassment. This includes mocking,',
  'taunting, repeated negativity toward a user, passive-aggressive',
  'remarks, or messages designed to provoke or annoy someone. Even if the',
  'message does not contain obvious bad words, if the intent is clearly',
  'harmful or targeted, it must be blocked.',
  '',
  'Threats, intimidation, or encouragement of harm are strictly forbidden.',
  'Any message suggesting violence or harm toward another person must be',
  'blocked immediately.',
  '',
  'You must distinguish between general statements and targeted attacks.',
  '"this game sucks" is allowed, "you suck" is not. "that level is',
  'annoying" is allowed, "you are annoying" is not. Always evaluate whether',
  'the message is attacking a person.',
  '',
  'Context matters, but safety comes first. If a message is borderline or',
  'unclear, err on the side of caution and block it. However, do not',
  'over-block normal conversation. Friendly jokes, excitement, frustration,',
  'and casual game talk should be allowed as long as they are not harmful',
  'or targeted.',
  '',
  'When you block a message, your `reason` should be a short, neutral,',
  'first-person-plural explanation written for the user — for example:',
  '"That message looks like a personal attack — please rephrase without',
  'targeting another person." Do NOT quote the harmful message back. Do',
  'NOT lecture. Two short sentences max.',
  '',
  'You are not part of the conversation. You are a moderation filter. Do',
  'not engage, argue, or add opinions outside of the JSON response.',
  '',
  'Although you are keeping a nice place to chat, it is a game chat so',
  'all kinds of people might appear. Do not be too strict about messages.',
  '',
  '=== SEVERITY SCORE ===',
  'You receive a `sender_severity` integer 0..10 indicating how often the',
  'user has been blocked recently (0 = clean record, 10 = repeat severe',
  'offender). When `sender_severity` is high, treat ambiguous messages',
  'less charitably and be quicker to block. When it is 0 or 1, give the',
  'benefit of the doubt on borderline cases.',
  '',
  '=== ATTACHMENTS ===',
  'You will sometimes see lines like "[image attached] caption text" or',
  '"[file attached: <filename>]". You cannot see image / binary content,',
  'but you can flag suspicious filenames or captions. Judge the visible',
  'caption text as you would any other message; do not block solely',
  'because something was attached.',
  '',
  '=== OUTPUT (STRICT) ===',
  'Respond with EXACTLY one JSON object and nothing else. The shape is:',
  '{',
  '  "allowed": true | false,',
  '  "reason": "short, neutral explanation for the user when blocked, or empty string when allowed",',
  '  "severity_delta": <integer 0..3>,',
  '  "category": "harassment" | "hate_speech" | "sexual" | "threat" | "spam" | "other" | "ok"',
  '}',
  '',
  '`severity_delta` rules:',
  '  - 0  message is allowed (always for allowed messages)',
  '  - 1  mild / first-time block (rude but not extreme)',
  '  - 2  clear targeted insult or hate, slurs in any form, sexual harassment',
  '  - 3  severe (threats, slurs aimed at a person, sexual content involving minors)',
  '',
  'Never output anything outside the JSON object. No prose before or after.',
].join('\n');

/* === Helpers =========================================================== */

/** Pull the most recent N messages from a room as plain readable lines.
 *  This is what the moderator sees as `recent_messages`. We strip private
 *  data and always include the sender's display name (so the moderator can
 *  judge whether a message targets a specific person in the same room). */
function getRecentRoomContext(roomType, roomId, limit = 10) {
  if (!roomType || !roomId) return [];
  try {
    // Whispers are excluded entirely from the moderator's prior-context
    // window: they're 1:1 secrets shared with a specific audience and
    // shouldn't leak into the per-room moderation context for unrelated
    // senders. The new whisper's body is still moderated by the caller
    // (the text is passed in via the user-message directly).
    const rows = db.prepare(`
      SELECT m.content, m.msg_type, m.sender_id, m.created_at,
             u.username, u.display_name
      FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.room_type = ? AND m.room_id = ?
        AND m.recalled_at IS NULL AND m.deleted_by_admin = 0
        AND (m.msg_type IS NULL OR m.msg_type != 'whisper')
      ORDER BY m.created_at DESC LIMIT ?
    `).all(roomType, roomId, Math.max(1, Math.min(20, Number(limit) || 10)));
    return rows.reverse().map(r => ({
      sender: r.display_name || r.username || 'User',
      sender_id: r.sender_id,
      msg_type: r.msg_type || 'text',
      content: renderForLLM(r.content, r.msg_type),
    }));
  } catch (err) {
    console.warn('[ai-mod] context fetch failed:', err?.message || err);
    return [];
  }
}

function renderForLLM(content, msgType) {
  const raw = (content || '').toString();
  const t = (msgType || 'text').toLowerCase();
  if (!raw) return '';
  if (t === 'image') return `[image attached] ${raw}`.trim();
  if (t === 'video') return `[video attached] ${raw}`.trim();
  if (t === 'audio') return `[audio attached] ${raw}`.trim();
  if (t === 'voice') return `[voice message]`;
  if (t === 'file') return `[file attached] ${raw}`.trim();
  return raw;
}

function describeAttachment(file) {
  if (!file) return null;
  const name = file.originalname || file.originalName || file.name || '';
  const mime = file.mimetype || file.mimeType || '';
  if (mime.startsWith('image/')) return `[image attached: ${name || 'image'}]`;
  if (mime.startsWith('video/')) return `[video attached: ${name || 'video'}]`;
  if (mime.startsWith('audio/')) return `[audio attached: ${name || 'audio'}]`;
  return `[file attached: ${name || 'file'} (${mime || 'unknown type'})]`;
}

/** Cheap pre-check: empty / whitespace-only messages, "ok", "👍" etc. don't
 *  need the LLM. Saves a round-trip on the most common case. */
function isObviouslySafe(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  // pure emoji / single short reaction
  if (/^[\p{Emoji}\p{Extended_Pictographic}\s]+$/u.test(t) && t.length < 12) return true;
  return false;
}

function safeJsonParse(text) {
  if (!text) return null;
  // Some models wrap JSON in code fences. Strip them defensively.
  const stripped = String(text).trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  try { return JSON.parse(stripped); } catch (_) {}
  // Last-ditch: find the first {...} block.
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  return null;
}

async function callDeepseekJson(payload) {
  if (!DEEPSEEK_API) return null; // no key configured: moderation disabled (fail-open)
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.DEEPSEEK_KEY) headers['Authorization'] = `Bearer ${process.env.DEEPSEEK_KEY}`;

  // Retry transient failures (429 / 5xx / network) with backoff. Moderation
  // still fails open, but a brief rate-limit no longer disables the filter
  // for every message in the burst — it just adds a short delay.
  // The caller's MOD_TIMEOUT_MS budget is shared across attempts via the
  // outer AbortController, so a slow upstream can't stall past that bound.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MOD_TIMEOUT_MS);
  try {
    const result = await deepseekFetch({
      url: DEEPSEEK_API,
      headers,
      signal: ctrl.signal,
      tag: 'ai-mod',
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 2500,
      body: payload,
    });
    if (!result.ok) return null;
    return result.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    if (err?.name === 'AbortError') console.warn('[ai-mod] deepseek timed out');
    else console.warn('[ai-mod] deepseek error:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* === Public API ======================================================== */

/**
 * Decide whether a single outgoing message is allowed.
 *
 *   userId        - sender id
 *   senderName    - display name (for the LLM to refer to in `reason`)
 *   content       - the text the user wants to send (caption for files)
 *   roomType      - 'group' | 'dm'
 *   roomId        - panel id or conversation id
 *   msgType       - 'text' | 'image' | 'file' | 'voice' | ...
 *   file          - optional multer file object (used to describe attachment)
 *   replyToId     - optional id of the message this is a reply to
 *
 * Returns:
 *   { allowed: true, severity, category, reason: '' }
 *   { allowed: false, severity, category, reason: '...explanation...' }
 *
 * On any unexpected error or LLM outage, returns `{ allowed: true, ... }`
 * (fail-open). Server-side spam / blacklist / timeout checks remain the
 * authoritative hard guard — the AI moderator is an additional layer.
 */
export async function moderateMessage({
  userId,
  senderName = '',
  content = '',
  roomType,
  roomId,
  msgType = 'text',
  file = null,
  replyToId = null,
} = {}) {
  // Skip moderation entirely for the helper bot and for jimmyqrg.
  if (!userId || userId === HELPER_USER_ID || userId === 'jimmyqrg') {
    return { allowed: true, severity: getUserModerationSeverity(userId), category: 'ok', reason: '' };
  }

  const text = (content || '').toString();
  const fileDesc = describeAttachment(file);
  const hasText = text.trim().length > 0;
  const hasFile = !!fileDesc;

  // Voice / pure-binary messages with no caption: nothing the text moderator
  // can read, so allow and rely on user reports.
  if (!hasText && !hasFile) {
    return { allowed: true, severity: getUserModerationSeverity(userId), category: 'ok', reason: '' };
  }

  // Trivial messages skip the LLM round-trip.
  if (hasText && !hasFile && isObviouslySafe(text)) {
    return { allowed: true, severity: getUserModerationSeverity(userId), category: 'ok', reason: '' };
  }

  const severity = getUserModerationSeverity(userId);
  const recent = getRecentRoomContext(roomType, roomId, 10);

  // Optional: include the message we're replying to even if it's older than
  // the 10-message window (gives the LLM the parent of a quoted reply).
  let replyTarget = null;
  if (replyToId) {
    try {
      const r = db.prepare(`
        SELECT m.content, m.msg_type, m.sender_id, m.created_at,
               u.username, u.display_name
        FROM messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.id = ?
      `).get(replyToId);
      if (r) {
        replyTarget = {
          sender: r.display_name || r.username || 'User',
          content: renderForLLM(r.content, r.msg_type),
        };
      }
    } catch (_) {}
  }

  const messageForLLM = hasText
    ? (hasFile ? `${fileDesc} ${text}` : text)
    : fileDesc;

  const userPayload = {
    sender_severity: severity,
    sender_name: senderName || '',
    room_type: roomType || 'group',
    recent_messages: recent.map((m, i) => ({
      i,
      sender: m.sender,
      is_sender: m.sender_id === userId,
      text: m.content,
    })),
    reply_to: replyTarget,
    message: messageForLLM,
    has_attachment: hasFile,
    msg_type: msgType,
  };

  const userContent = [
    'Evaluate the new message below. Use `recent_messages` only as context;',
    'do NOT moderate them, only the `message` field. Reply with strict JSON.',
    '',
    'INPUT:',
    JSON.stringify(userPayload, null, 2),
  ].join('\n');

  const reply = await callDeepseekJson({
    model: MOD_MODEL,
    temperature: 0,
    max_tokens: 220,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: MOD_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });

  if (!reply) {
    // Fail-open: allow but do not bump severity.
    return { allowed: true, severity, category: 'ok', reason: '' };
  }

  const parsed = safeJsonParse(reply);
  if (!parsed || typeof parsed.allowed !== 'boolean') {
    console.warn('[ai-mod] unparseable LLM reply:', String(reply).slice(0, 200));
    return { allowed: true, severity, category: 'ok', reason: '' };
  }

  if (parsed.allowed) {
    return {
      allowed: true,
      severity,
      category: parsed.category || 'ok',
      reason: '',
    };
  }

  const reason = (parsed.reason || '').toString().trim()
    || 'Message blocked: harassment, hate speech, or inappropriate content is not allowed.';
  const delta = Math.max(0, Math.min(3, Number(parsed.severity_delta) || 1));
  const nextSeverity = bumpUserModerationSeverity(userId, delta, reason);

  return {
    allowed: false,
    severity: nextSeverity,
    category: parsed.category || 'other',
    reason,
  };
}

export { MOD_SYSTEM_PROMPT };
