// @ts-nocheck
import { apiGet, apiPost, apiPatch, apiPut, apiDelete, uploadFile, getDefaultAvatarUrl } from './api.js';
import { compressMedia, isCompressibleMedia, formatBytes } from './mediaCompression.js';

if (typeof window !== 'undefined' && window.katex) {
  window.renderKatex = function (latex, displayMode) {
    return window.katex.renderToString(latex, { throwOnError: false, displayMode: !!displayMode });
  };
}

function applyTheme(theme) {
  const t = theme || state.theme || 'jimmyqrg';
  document.documentElement.setAttribute('data-theme', t);
}

let state = {
  user: null,
  users: [],
  group: null,
  panel: 'free_chat',
  dmUserId: null,
  convId: null,
  messages: {},
  socket: null,
  replyTo: null,
  inbox: [],
  friend_ids: [],
  pending_friend_ids: [],
  blocked_ids: [],
  blacklisted: false,
  adminBlacklistedIds: [],
  supportMessageIdForSolve: null,
  leftBarExpanded: typeof localStorage !== 'undefined' && localStorage.getItem('leftBarExpanded') === '1',
  panelSearchOpen: false,
  profileUserId: null,
  editingDocKey: null,
  editingMessageId: null,
  messageVersionIndex: {},
  panelColumnExpanded: false,
  lastSeenByRoom: {},
  convByUserId: {},
  convIdToUserId: {},
  lastMessageAtByUserId: {},
  language: typeof localStorage !== 'undefined' ? (localStorage.getItem('language') || 'en') : 'en',
  theme: typeof localStorage !== 'undefined' ? (localStorage.getItem('theme') || 'jimmyqrg') : 'jimmyqrg',
  _recording: false,
  _recordingStream: null,
  _recordingRecorder: null,
  _recordingChunks: [],
  commandMode: true, // commands are always on; toggle UI removed.
  uiAnimations: typeof localStorage !== 'undefined' ? localStorage.getItem('uiAnimations') !== '0' : true,
  enterToSend: typeof localStorage !== 'undefined' ? localStorage.getItem('enter_to_send') === '1' : false,
  notificationPrefs: null,
  pushActive: false,
  drafts: {},
  collections: [],
  _hasMoreMessages: {},
  _loadingOlderMessages: {},
  _messageRenderLimitByRoom: {},
  _chatSidePanelOpen: false,
  _chatSidePanelTab: 'users',
  _chatSearchQuery: '',
  _chatSearchFilter: '',
  _chatSearchFromUser: '',
  _chatSearchDateRange: 'any',
  _chatSearchAfter: '',
  _chatSearchBefore: '',
  _chatSearchAttachmentType: '',
  _chatSearchResults: [],
  _chatSearchLoading: false,
  _pinnedMessage: {},
  // Voice chat
  _voiceJoined: false,
  _voiceParticipants: [],
  _voicePeers: {},
  _voiceLocalStream: null,
  _voiceScreenStream: null,
  _voiceMicOn: true,
  _voiceCamOn: false,
  _voiceScreenOn: false,
  _voiceSidePanel: null,
  _voiceChatMessages: [],
  _voiceParticipantCount: 0,
  // DM voice chat (1:1 private calls). Mirrors the group voice feature set.
  _dmVoiceJoined: false,
  _dmVoiceConvId: null,
  _dmVoicePeer: null,            // single RTCPeerConnection
  _dmVoiceDataChannel: null,     // for in-call text chat
  _dmVoiceLocalStream: null,
  _dmVoiceScreenStream: null,
  _dmVoiceMicOn: true,
  _dmVoiceCamOn: false,
  _dmVoiceScreenOn: false,
  _dmVoiceSidePanel: null,       // 'chat' | 'members' | null
  _dmVoiceChatMessages: [],      // transient in-call chat (NOT persisted)
  _dmVoicePeerMedia: { audio: true, video: false, screen: false },
  _dmVoiceRinging: null,         // { fromUserId, fromUsername, fromDisplayName, fromAvatarUrl, convId }
  _dmVoiceRingingOutgoing: null, // { toUserId, convId }
  _chatboxStyles: [],
  _presence: {},
  _typing: {},
  _reportCounts: { total: 0, open: 0, in_review: 0 },
  _modReports: { items: [], status: 'open', search: '', loading: false, selected: null, notes: [] },
  _adminAuditSearch: '',
  _adminUserSearch: '',
  _backups: [],
  _exportRunning: null,
  _mentionAutocomplete: null,
  _attachmentsPending: [],
  // Venory helper: owner's persisted model/effort + live per-room run state.
  agentModel: typeof localStorage !== 'undefined' ? (localStorage.getItem('agent_model') || 'deepseek/deepseek-v4-pro') : 'deepseek/deepseek-v4-pro',
  agentEffort: typeof localStorage !== 'undefined' ? (localStorage.getItem('agent_effort') || 'high') : 'high',
  agentSessions: [],
  agentSession: '',
  agentSessionView: null, // { key, label, messages, loading, error, loadedAt } — history view of the selected session
  appVersion: '',
  agentMode: 'openclaw', // 'openclaw' (full assistant) | 'basic' (DeepSeek helper) — server-persisted
  agentBridgeOnline: true,
  agentBridgeEnabled: true,
  helperRuns: {}, // roomKey -> { busy, working, done, tools: [{id,name,title,status,meta}] }
  sessionRuns: {}, // gateway sessionKey -> { busy, working, done, tools: [...] } (per-session live state)
  // ask_user questions surfaced from the gateway (rendered as a tappable
  // panel in the owner's helper DM until answered/expired).
  helperQuestions: {}, // recordId -> { convId, recordId, sessionKey, expiresAtMs, questions: [...] }
  helperQuestionSelections: {}, // `${recordId}:${questionId}` -> [labels] (multiSelect)
  helperQuestionSending: {}, // `${recordId}:${questionId}` -> true while resolving
  helperQuestionErrors: {}, // `${recordId}:${questionId}` -> error text
  helperCompacting: false, // Compact button busy state (sessions.compact in flight)
};

if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  try {
    const rawDrafts = localStorage.getItem('chat_drafts_v1');
    if (rawDrafts) state.drafts = JSON.parse(rawDrafts) || {};
  } catch (_) {
    state.drafts = {};
  }
}

if (typeof document !== 'undefined' && document.documentElement) document.documentElement.setAttribute('lang', state.language || 'en');
if (typeof window !== 'undefined' && !window._pendingFileUnloadGuardBound) {
  window._pendingFileUnloadGuardBound = true;
  window.addEventListener('beforeunload', (e) => {
    if (!state._pendingFile) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/** Toast notifications (replacement for alert). type: 'error' | 'success' | 'info' */
function showToast(message, type = 'error') {
  if (typeof document === 'undefined') return;
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);
  const dismiss = () => {
    el.classList.add('toast--dismissed');
    setTimeout(() => el.remove(), 200);
  };
  setTimeout(dismiss, 4000);
  el.addEventListener('click', dismiss);
}

const HTML_MAX_BYTES = 100 * 1024 * 1024;
const ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MEDIA_CONFIRM_BYTES = 35 * 1024 * 1024;
const MEDIA_TARGET_MB = 25;
const OTHER_MAX_BYTES = 100 * 1024 * 1024;

/** True if the file is HTML by extension or mime. Server allows these up to 100 MB. */
function isHtmlFile(file) {
  if (!file) return false;
  const t = (file.type || '').toLowerCase();
  if (t === 'text/html' || t === 'application/xhtml+xml') return true;
  const name = (file.name || '').toLowerCase();
  return /\.(html?|xhtml)$/.test(name);
}

/** True if the file is a ZIP archive by extension or mime. Server allows up to 2 GB. */
function isZipFile(file) {
  if (!file) return false;
  const t = (file.type || '').toLowerCase();
  if (t === 'application/zip' || t === 'application/x-zip-compressed' || t === 'application/x-zip') return true;
  const name = (file.name || '').toLowerCase();
  return /\.zip$/.test(name);
}

/** Returns "video" / "image" / "gif" / "audio" / null based on mime. */
function mediaKindFromFile(file) {
  const t = (file?.type || '').toLowerCase();
  if (t === 'image/gif') return 'gif';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return null;
}

/** Modal: blocks until user clicks Send (resolves true) or Cancel/escape (resolves false). */
function showCompressConfirmModal(file, kind) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const sizeLabel = formatBytes(file.size);
    const typeLabel = t('fileCompressBodyType_' + kind) || kind;
    const body = (t('fileCompressBody') || 'This {type} is {size}. It will be compressed to about 25 MB before sending. Continue?')
      .replace('{type}', typeLabel)
      .replace('{size}', sizeLabel);
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px;">
        <h3>${escapeHtml(t('fileCompressTitle') || 'Large file')}</h3>
        <p class="modal-hint" style="margin:0.5rem 0 1rem 0;">${escapeHtml(body)}</p>
        <div class="modal-actions">
          <button type="button" id="file-compress-cancel" class="modal-close"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${escapeHtml(t('cancel'))}</button>
          <button type="button" id="file-compress-ok" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>${escapeHtml(t('fileCompressContinue') || 'Compress and send')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    overlay.querySelector('#file-compress-cancel')?.addEventListener('click', () => finish(false));
    overlay.querySelector('#file-compress-ok')?.addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKey);
  });
}

/** Modal that lets users report a message or user. */
function showReportMessageModal(msgOrTarget) {
  const isMessage = !!msgOrTarget?.id && !!msgOrTarget?.content !== undefined;
  const messageId = isMessage ? msgOrTarget.id : null;
  const targetUserId = msgOrTarget?.sender_id || msgOrTarget?.target_user_id || msgOrTarget?.id || null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const reasons = [
    ['spam', tx('reportReasonSpam', 'Spam')],
    ['harassment', tx('reportReasonHarassment', 'Harassment / bullying')],
    ['hate_speech', tx('reportReasonHate', 'Hate speech')],
    ['sexual_content', tx('reportReasonSexual', 'Sexual or explicit content')],
    ['violence', tx('reportReasonViolence', 'Violence or threats')],
    ['self_harm', tx('reportReasonSelfHarm', 'Self-harm or suicide')],
    ['illegal', tx('reportReasonIllegal', 'Illegal activity')],
    ['misinformation', tx('reportReasonMisinformation', 'Misinformation')],
    ['impersonation', tx('reportReasonImpersonation', 'Impersonation')],
    ['other', tx('reportReasonOther', 'Other')],
  ];
  overlay.innerHTML = `
    <div class="modal" style="max-width:460px;">
      <h3>${escapeHtml(tx('reportMessageTitle', 'Report message'))}</h3>
      <p class="modal-hint">${escapeHtml(tx('reportMessageHint', 'Select a reason and add optional context. Admins will review your report.'))}</p>
      <label>${tx('reportReasonLabel', 'Reason')}</label>
      <select id="report-reason" class="settings-select">
        ${reasons.map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join('')}
      </select>
      <label>${tx('reportDetailsLabel', 'Details (optional)')}</label>
      <textarea id="report-details" rows="3" placeholder="${tx('reportDetailsPlaceholder', 'Add anything that helps admins understand the issue.')}"></textarea>
      <div class="modal-actions">
        <button type="button" id="report-cancel" class="modal-close">${t('cancel')}</button>
        <button type="button" id="report-submit" class="btn-primary">${tx('reportSubmit', 'Submit report')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#report-cancel')?.addEventListener('click', close);
  overlay.querySelector('#report-submit')?.addEventListener('click', async () => {
    const reason = overlay.querySelector('#report-reason')?.value || 'other';
    const details = overlay.querySelector('#report-details')?.value?.trim();
    try {
      await apiPost('/api/reports', { message_id: messageId, target_user_id: targetUserId, reason, details: details || null });
      showToast(tx('reportSubmitted', 'Report submitted. Thank you.'), 'success');
      close();
    } catch (err) {
      showToast(err.message || 'Failed to submit report');
    }
  });
}

/** Modal: simple OK-only error dialog (used for HTML > 100 MB). */
function showFileBlockedModal(title, body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:440px;">
      <h3>${escapeHtml(title)}</h3>
      <p class="modal-hint" style="margin:0.5rem 0 1rem 0;">${escapeHtml(body)}</p>
      <div class="modal-actions">
        <button type="button" id="file-blocked-ok" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#file-blocked-ok')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

/** Modal shown when the AI moderator blocks an outgoing message. The
 *  `reason` is the AI's plain-language explanation; we keep the wording the
 *  AI provided as-is so the user gets context-specific feedback (e.g. "this
 *  message reads as a personal attack"). */
function showAiModerationModal(reason, opts = {}) {
  // Only one moderation modal at a time — if the user is sending fast and
  // multiple drafts get blocked back-to-back, replace the previous one
  // rather than stacking them.
  document.querySelectorAll('.modal-overlay.ai-mod-overlay').forEach(n => n.remove());
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ai-mod-overlay';
  const title = opts.title || tx('aiModBlockTitle', 'Message not sent');
  const fallback = tx('aiModBlockFallback', 'This message looks like it might break the chat rules. Please rephrase and try again.');
  const reasonText = (reason || '').toString().trim() || fallback;
  const help = tx('aiModBlockHelp', "Your draft was reviewed by the chat's AI moderator before being sent. If you think this was a mistake, you can edit your message and try again.");
  overlay.innerHTML = `
    <div class="modal ai-mod-modal" role="alertdialog" aria-labelledby="ai-mod-title" aria-describedby="ai-mod-reason">
      <div class="ai-mod-header">
        <span class="ai-mod-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg></span>
        <h3 id="ai-mod-title">${escapeHtml(title)}</h3>
      </div>
      <p id="ai-mod-reason" class="ai-mod-reason">${escapeHtml(reasonText)}</p>
      <p class="ai-mod-help">${escapeHtml(help)}</p>
      <div class="modal-actions">
        <button type="button" id="ai-mod-ok" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>${escapeHtml(tx('aiModBlockOk', 'Got it'))}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#ai-mod-ok')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  // Focus the OK button so screen readers announce the alert and Enter
  // dismisses it without pinging anything else.
  setTimeout(() => overlay.querySelector('#ai-mod-ok')?.focus(), 50);
}

/** The two known mirrors of this chat app. "Primary" is the custom domain; "secondary"
 *  is the direct Fly.io host (works even if the custom domain is down). */
const CHAT_LINKS = [
  { id: 'primary', label: 'Primary Link', url: 'https://discord.jimmyqrg.com', hint: 'discord.jimmyqrg.com' },
  { id: 'secondary', label: 'Secondary Link', url: 'https://jchat.fly.dev', hint: 'jchat.fly.dev' },
];

/**
 * "Choose Link" modal, shown once each time the chat app is opened from Home or
 * Contacts. The user picks which host to load the app from; picking navigates
 * the top-level window to that origin so the whole app (cookies, sockets,
 * static assets) runs on the chosen host rather than cross-origin.
 *
 * Choice is remembered in localStorage purely to mark the last-used option —
 * the modal still appears on every fresh open, as requested.
 */
function showChooseLinkModal() {
  if (document.querySelector('.choose-link-overlay')) return;
  let last = null;
  try { last = localStorage.getItem('chatChosenLink'); } catch (_) {}

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay choose-link-overlay';
  const options = CHAT_LINKS.map((l) => `
    <button type="button" class="choose-link-option${last === l.id ? ' is-last' : ''}" data-link-id="${l.id}" data-link-url="${l.url}">
      <span class="choose-link-option-label">${escapeHtml(l.label)}</span>
      <span class="choose-link-option-url">${escapeHtml(l.hint)}</span>
      ${last === l.id ? `<span class="choose-link-option-badge">${escapeHtml(tx('chooseLinkLastUsed', 'Last used'))}</span>` : ''}
    </button>`).join('');

  overlay.innerHTML = `
    <div class="modal choose-link-modal" role="dialog" aria-modal="true" aria-labelledby="choose-link-title">
      <h3 id="choose-link-title">${escapeHtml(tx('chooseLinkTitle', 'Choose Link'))}</h3>
      <p class="modal-hint">${escapeHtml(tx('chooseLinkHint', 'Pick which link to open the chat on. Primary is the main address; Secondary is the direct backup host.'))}</p>
      <div class="choose-link-options">${options}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('.choose-link-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-link-id');
      const url = btn.getAttribute('data-link-url');
      try { localStorage.setItem('chatChosenLink', id); } catch (_) {}
      if (url && url !== window.location.origin) {
        window.location.href = url + '/chat/group/';
      } else {
        overlay.remove();
      }
    });
  });
}

/** Lightweight blocking overlay shown while compression runs. Returns { update(pct), close() }. */
function showCompressingOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:340px;text-align:center;">
      <h3 style="margin-bottom:0.75rem;">${escapeHtml(t('fileCompressing') || 'Compressing…')}</h3>
      <div style="width:100%;height:8px;background:rgba(127,127,127,0.2);border-radius:4px;overflow:hidden;">
        <div id="file-compress-bar" style="width:0%;height:100%;background:var(--accent-primary,#5b6cff);transition:width 0.15s ease;"></div>
      </div>
      <div id="file-compress-pct" style="margin-top:0.5rem;font-size:0.85rem;opacity:0.75;">0%</div>
    </div>
  `;
  document.body.appendChild(overlay);
  const bar = overlay.querySelector('#file-compress-bar');
  const pct = overlay.querySelector('#file-compress-pct');
  return {
    update(p) {
      const v = Math.max(0, Math.min(1, p));
      const s = Math.round(v * 100) + '%';
      if (bar) bar.style.width = s;
      if (pct) pct.textContent = s;
    },
    close() { overlay.remove(); },
  };
}

/** Upload with retry. Keeps progress usable across retries for large files. */
function uploadFormWithRetry({ uploadPath, form, maxRetries = 2, onProgress }) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const totalAttempts = maxRetries + 1;
    const send = () => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', uploadPath);
      xhr.withCredentials = true;
      xhr.upload.addEventListener('progress', (e) => {
        if (!e.lengthComputable) return;
        // Represent attempt progress over whole retry budget, so users see meaningful continuation.
        const unit = 1 / totalAttempts;
        const pctOverall = Math.min(1, (attempt * unit) + ((e.loaded / e.total) * unit));
        onProgress?.(pctOverall);
      });
      xhr.addEventListener('load', () => {
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && !data?.error) {
          onProgress?.(1);
          resolve(data);
          return;
        }
        // AI moderation block: don't retry, surface the AI's reason directly
        // to the caller so it can pop the moderation modal.
        if (data?.error === 'AI_MOD_BLOCK') {
          const err = new Error('AI_MOD_BLOCK');
          err.code = 'AI_MOD_BLOCK';
          err.status = xhr.status;
          err.data = data;
          err.reason = data.reason || '';
          reject(err);
          return;
        }
        const retryableStatus = xhr.status === 0 || xhr.status >= 500 || xhr.status === 429;
        if (retryableStatus && attempt < maxRetries) {
          attempt += 1;
          showToast((t('uploadRetrying') || 'Upload failed. Retrying ({attempt}/{max})…')
            .replace('{attempt}', String(attempt + 1))
            .replace('{max}', String(totalAttempts)), 'info');
          setTimeout(send, 450 * attempt);
          return;
        }
        const err = new Error(data?.error || t('uploadFailedRetry') || 'Upload failed after retries. Please try again.');
        err.status = xhr.status;
        err.data = data || null;
        if (data?.error) err.code = data.error;
        if (data?.reason) err.reason = data.reason;
        reject(err);
      });
      xhr.addEventListener('error', () => {
        if (attempt < maxRetries) {
          attempt += 1;
          showToast((t('uploadRetrying') || 'Upload failed. Retrying ({attempt}/{max})…')
            .replace('{attempt}', String(attempt + 1))
            .replace('{max}', String(totalAttempts)), 'info');
          setTimeout(send, 450 * attempt);
          return;
        }
        reject(new Error(t('uploadFailedRetry') || 'Upload failed after retries. Please try again.'));
      });
      xhr.send(form);
    };
    send();
  });
}

/** Modal shown when compression fails; resolves true to send original, false to cancel upload. */
function showCompressionFallbackModal(file, kind) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const typeLabel = t('fileCompressBodyType_' + kind) || kind || 'file';
    const body = (t('fileCompressFallbackBody') || 'Could not compress this {type}. Send the original file ({size}) instead?')
      .replace('{type}', typeLabel)
      .replace('{size}', formatBytes(file?.size || 0));
    overlay.innerHTML = `
      <div class="modal" style="max-width:440px;">
        <h3>${escapeHtml(t('fileCompressFallbackTitle') || 'Compression failed')}</h3>
        <p class="modal-hint" style="margin:0.5rem 0 1rem 0;">${escapeHtml(body)}</p>
        <div class="modal-actions">
          <button type="button" id="file-compress-fallback-cancel" class="modal-close"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${escapeHtml(t('fileCompressCancel') || 'Cancel upload')}</button>
          <button type="button" id="file-compress-fallback-send" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>${escapeHtml(t('fileCompressSendOriginal') || 'Send original')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    overlay.querySelector('#file-compress-fallback-cancel')?.addEventListener('click', () => finish(false));
    overlay.querySelector('#file-compress-fallback-send')?.addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKey);
  });
}

/**
 * Validate + (optionally) compress a file before upload.
 *  - HTML > 100 MB → blocked with a "use Google Drive/GitHub" modal; returns null.
 *  - HTML ≤ 100 MB → returned as-is.
 *  - ZIP > 2 GB  → blocked with a similar modal; returns null.
 *  - ZIP ≤ 2 GB  → returned as-is.
 *  - image/video/audio (and GIF) > 35 MB → confirm modal, then compress to ~25 MB.
 *  - Other files > 100 MB → blocked; otherwise returned as-is.
 * Returns the (possibly recompressed) File, or null if the user cancelled / file was rejected.
 */
async function prepareFileForUpload(file) {
  if (!file) return null;

  if (isHtmlFile(file)) {
    if (file.size > HTML_MAX_BYTES) {
      showFileBlockedModal(t('fileTooLargeHtmlTitle'), t('fileTooLargeHtmlBody'));
      return null;
    }
    return file;
  }

  if (isZipFile(file)) {
    if (file.size > ZIP_MAX_BYTES) {
      showFileBlockedModal(t('fileTooLargeZipTitle'), t('fileTooLargeZipBody'));
      return null;
    }
    return file;
  }

  const kind = mediaKindFromFile(file);
  if (kind && isCompressibleMedia(file) && file.size > MEDIA_CONFIRM_BYTES) {
    const ok = await showCompressConfirmModal(file, kind);
    if (!ok) return null;
    const ui = showCompressingOverlay();
    try {
      const originalBytes = file.size;
      const compressed = await compressMedia(file, { targetMB: MEDIA_TARGET_MB, onProgress: (p) => ui.update(p) });
      if (!compressed || !Number.isFinite(compressed.size) || compressed.size <= 0) {
        ui.close();
        const sendOriginal = await showCompressionFallbackModal(file, kind);
        if (!sendOriginal) return null;
        showToast((t('fileCompressFallbackUsingOriginal') || 'Sending original file ({size}).').replace('{size}', formatBytes(file.size)), 'info');
        return file;
      }
      if (compressed.size >= originalBytes) {
        showToast((t('fileCompressNoGain') || 'Compression did not reduce the size — the original {size} is attached. Press Send to upload it.').replace('{size}', formatBytes(file.size)), 'info');
        return file;
      }
      const typeLabel = t('fileCompressBodyType_' + kind) || kind;
      const resultMsg = (t('fileCompressResult') || 'Compressed {type}: {from} -> {to}.')
        .replace('{type}', typeLabel)
        .replace('{from}', formatBytes(originalBytes))
        .replace('{to}', formatBytes(compressed.size));
      showToast(resultMsg, 'success');
      return compressed;
    } catch (err) {
      ui.close();
      console.error('[prepareFileForUpload] compress error:', err);
      const sendOriginal = await showCompressionFallbackModal(file, kind);
      if (!sendOriginal) return null;
      showToast((t('fileCompressFallbackUsingOriginal') || 'Sending original file ({size}).').replace('{size}', formatBytes(file.size)), 'info');
      return file;
    } finally {
      // Always release the blocking overlay. If compression throws or stalls,
      // a stuck overlay would make the composer's file button look dead.
      ui.close();
    }
  }

  if (file.size > OTHER_MAX_BYTES) {
    showToast(t('fileTooLargeOther'));
    return null;
  }
  return file;
}

/** Fallback strings until data.json loads. Full translations in /assets/translation/data.json */
const DEFAULT_STRINGS = {
  en: {
    general: 'General',
    profile: 'Profile',
    account: 'Account',
    settings: 'Settings',
    theme: 'Theme',
    systemLanguage: 'System Language',
    chooseTheme: 'Choose the visual theme for the app.',
    chooseLanguage: 'Choose the display language for the app.',
    language: 'Language',
    password: 'Password',
    changePassword: 'Change password',
    changePasswordDesc: 'Change your password. Your current password is required.',
    signOut: 'Sign out',
    signOutDesc: 'Sign out of your account on this device.',
    home: 'Home',
    chat: 'Chat',
    inbox: 'Inbox',
    admin: 'Admin',
    expand: 'Expand',
    collapse: 'Collapse',
    dropImage: 'Drop image here or choose below',
    chooseImage: 'Choose image',
    displayName: 'Display name',
    username: 'Username',
    description: 'Description',
    descriptionPlaceholder: 'A short bio or description',
    website: 'Website',
    save: 'Save',
    avatar: 'Avatar',
    loading: 'Loading…',
    selectPanel: 'Select a panel.',
    selectConversation: 'Select a conversation.',
    noMailYet: 'No mail yet.',
    accept: 'Accept',
    reject: 'Reject',
    'delete': 'Delete',
    deleteMailConfirm: 'Delete this mail?',
    recording: 'Recording',
    cancel: 'Cancel',
    send: 'Send',
    currentPassword: 'Current password',
    newPassword: 'New password',
    confirmNewPassword: 'Confirm new password',
    atLeast6: 'At least 6 characters',
    confirmNewPasswordPlaceholder: 'Confirm new password',
    passwordChanged: 'Password changed.',
    fillCurrentNew: 'Please fill in current and new password.',
    newPasswordMin: 'New password must be at least 6 characters.',
    newPasswordMismatch: 'New password and confirmation do not match.',
    failedChangePassword: 'Failed to change password.',
    usernameOrEmail: 'Username or email',
    confirmPassword: 'Confirm password',
    email: 'Email',
    signUp: 'Sign up',
    login: 'Login',
    alreadyHaveAccount: 'Already have an account? ',
    noAccount: "Don't have an account? ",
    logIn: 'Log in',
    passwordRequired: 'Password is required',
    passwordsDoNotMatch: 'Passwords do not match',
    freeChat: 'Free Chat',
    support: 'Support',
    problemSolving: 'Problem Solving',
    rules: 'Rules',
    announcements: 'Announcements',
    action: 'Action',
    users: 'Users',
    recalled: 'Recalled',
    timeout: 'Time out',
    block: 'Block',
    unblock: 'Unblock',
    blocked: 'Blocked',
    sendFriendRequest: 'Send friend request',
    requestSent: 'Request sent',
    requestPending: 'Request pending',
    sendMessage: 'Send message',
    notifications: 'Notifications',
    notificationsDesc: 'Desktop notifications for messages and mail.',
    notifyMails: 'Mail (inbox)',
    notifyDm: 'Private messages',
    notifyGroup: 'Group messages',
    doNotDisturb: 'Do not disturb',
    dndSet: 'Set',
    dndCancel: 'Cancel',
    dndDays: 'Days',
    dndHours: 'Hours',
    dndMinutes: 'Minutes',
    dndSeconds: 'Seconds',
    dndEndNow: 'End DND now',
    dndAtNight: 'Do not disturb at night',
    dndUseLocation: 'Use my location',
    dndEnterCity: 'Enter city',
    dndCityHint: 'Enter your city to use its local time for night hours.',
    dndCityPlaceholder: 'e.g. New York, London',
    scrollToBottom: 'Scroll to bottom',
    notifModalTitle: 'Desktop notifications',
    notifModalDesc: 'Would you like to receive desktop notifications from this chat app on this device? You can change this later in Settings → Notifications.',
    notifModalAllow: 'Enable notifications',
    notifModalDecline: 'Not now',
    adminSendToInbox: 'Send to inbox',
    adminSendToInboxDesc: 'Send a message to a specific user\'s inbox.',
    adminBroadcast: 'Broadcast to all',
    adminBroadcastDesc: 'Send a message to every user\'s inbox.',
    adminTimeoutUser: 'Time out user',
    adminTimeoutDurationDesc: 'Prevent a user from sending messages in the JimmyQrg group chat for a set time.',
    adminTimeoutUserDesc: 'Prevent a user from sending messages in the JimmyQrg group chat.',
    adminSelectUser: 'Select user',
    adminTitle: 'Title',
    adminBody: 'Body',
    adminMessageBody: 'Message body',
    adminDuration: 'Duration',
    adminDurationPlaceholder: 'e.g. 5 minute, 1 hour, forever',
    adminTimeoutPickUser: 'Pick a user',
    adminTimeoutSearchUsers: 'Search users…',
    adminTimeoutNoUserMatch: 'No user matches your search.',
    adminTimeoutPreset5min: '5 min',
    adminTimeoutPreset10min: '10 min',
    adminTimeoutPreset30min: '30 min',
    adminTimeoutPreset1h: '1 hour',
    adminTimeoutPreset6h: '6 hours',
    adminTimeoutPreset12h: '12 hours',
    adminTimeoutPreset1day: '1 day',
    adminTimeoutPreset3day: '3 days',
    adminTimeoutPreset1week: '1 week',
    adminTimeoutCustom: 'Custom…',
    adminTimeoutCustomNumber: 'Number',
    adminTimeoutCustomUnitMinute: 'minutes',
    adminTimeoutCustomUnitHour: 'hours',
    adminTimeoutCustomUnitDay: 'days',
    adminTimeoutCustomUnitWeek: 'weeks',
    adminTimeoutCustomInvalid: 'Enter a valid number for the custom duration.',
    adminTimeoutPickDuration: 'Pick a duration first.',
    adminOnlyICanRelease: 'Only I can release',
    adminNoPermissions: 'You have no action permissions. Ask an admin to grant Send mail, Broadcast, or Time out.',
    adminRecalledMessages: 'Recalled messages',
    adminRecalledDesc: 'Messages that were recalled by users in the group chat.',
    adminUsersSection: 'Users',
    adminUsersDesc: 'Add users to the admin list here. After adding someone, set what they are allowed to do (e.g. send mail, broadcast, edit docs).',
    adminPermSendMail: 'Send mail',
    adminPermBroadcast: 'Broadcast',
    adminPermEditDocs: 'Edit docs',
    adminPermRemoveAccount: 'Remove account',
    adminPermDeleteMessages: 'Delete messages',
    adminPermManageUsers: 'Manage users',
    adminPermTimeout: 'Time out',
    adminRoleAdmin: 'Admin',
    adminRoleDeleted: 'Deleted',
    adminRoleOnList: 'On admin list',
    adminRoleMember: 'Member',
    adminRemoveFromList: 'Remove from list',
    adminAddToList: 'Add to list',
    adminRestore: 'Restore',
    adminDeletePermanently: 'Delete permanently',
    adminRemoveAccount: 'Remove account',
    adminBlacklist: 'Blacklist',
    adminUnblacklist: 'Unblacklist',
    adminDeleteAccountTitle: 'Delete account permanently',
    adminDeleteAccountDesc: 'This will remove the user from the user list, remove them from private chat lists, and clear all data about them. This cannot be undone.',
    adminDeleteGroupMessages: 'Delete messages in group chat also',
    adminDeleteAdmin: 'Delete (admin)',
    adminRemoveAccountConfirm: 'Remove this account? The user will not be able to log in. Messages stay. You can restore later.',
    replyToMessage: 'Reply to message',
    recall: 'Recall',
    edit: 'Edit',
    solve: 'Solve',
    getFileId: 'Get file id',
    copy: 'Copy',
    reply: 'Reply',
    mentionDeletedUsers: 'Note: You\'re mentioning user(s) whose accounts have been deleted: ',
    adminNoRecalledMessages: 'No recalled messages.',
    adminFailedToLoad: 'Failed to load.',
    adminSent: 'Sent.',
    adminBroadcastSent: 'Broadcast sent.',
    adminNoActiveTimeouts: 'No active timeouts.',
    adminTimeoutUntil: 'until ',
    adminTimeoutForever: 'forever',
    adminTimeoutLocked: '(locked)',
    adminRelease: 'Release',
    collections: 'Collections',
    noCollections: 'No saved messages yet.',
    addToCollection: 'Add to collection',
    addedToCollection: 'Added to collections',
    searchMessages: 'Search message',
    searchFilterHint: 'e.g. 2026/5, 2025/01/01~2025/02/01, from:@jimmyqrg',
    noSearchResults: 'No messages found.',
    back: 'Back',
    more: 'More',
    search: 'Search',
    open: 'Open',
    fileTooLargeHtmlTitle: 'HTML file too large',
    fileTooLargeHtmlBody: 'HTML files cannot be larger than 100 MB. Please use Google Drive, GitHub, or another file-sharing service to send this file.',
    fileTooLargeZipTitle: 'Zip file too large',
    fileTooLargeZipBody: 'Zip files cannot be larger than 2 GB. Please use Google Drive, GitHub, or another file-sharing service to send this file.',
    fileTooLargeOther: 'File is too large. Maximum size is 100 MB.',
    fileCompressTitle: 'Large file',
    fileCompressBody: 'This {type} is {size}. It will be compressed to about 25 MB before sending. Continue?',
    fileCompressBodyType_video: 'video',
    fileCompressBodyType_image: 'image',
    fileCompressBodyType_gif: 'GIF',
    fileCompressBodyType_audio: 'audio',
    fileCompressContinue: 'Compress and send',
    fileCompressing: 'Compressing…',
    fileCompressFailed: 'Compression failed. Sending the original file.',
    fileCompressResult: 'Compressed {type}: {from} -> {to}.',
    fileCompressNoGain: 'Compression did not reduce size. Sending original {size}.',
    fileCompressFallbackTitle: 'Compression failed',
    fileCompressFallbackBody: 'Could not compress this {type}. Send the original file ({size}) instead?',
    fileCompressSendOriginal: 'Send original',
    fileCompressCancel: 'Cancel upload',
    fileCompressFallbackUsingOriginal: 'Sending original file ({size}).',
    uploadRetrying: 'Upload failed. Retrying ({attempt}/{max})…',
    uploadFailedRetry: 'Upload failed after retries. Please try again.',
    leaveWithPendingFile: 'You have a selected file that has not been sent yet. Leave anyway?',
    showEarlierMessages: 'Show {count} earlier loaded messages',
    adminAuditLog: 'Audit log',
    adminAuditBy: 'By',
    adminAuditTarget: 'Target',
    adminAuditNoItems: 'No audit items yet.',
    mediaLoading: 'Loading media…',
    mediaLoadError: 'Could not load media.',
    mediaKbHintImage: 'Esc close • ←/→ next • Wheel or +/- zoom • Drag/pinch to pan/zoom • 0 reset',
    mediaKbHintVideo: 'Esc close • ←/→ next • K/Space play/pause',
    // Account Key settings
    accountRecoveryKey: 'Account recovery key',
    accountRecoveryKeyDesc: 'A living proof that this account is yours. Required to recover access if your password is changed by an attacker. We will email a one-time code to confirm before showing it.',
    viewAccountKey: 'View account key',
    akModalTitle: 'Your Account Recovery Key',
    akWarnOnce: '⚠️ You will only see this key once.',
    akIntro: 'This is your Account Key — a living proof that this account belongs to you. Save it somewhere safe right now.',
    akWhatItDoes: 'What this key can do:',
    akBenefit1: 'Recover a lost or stolen account — if your password is changed by an attacker, this key plus a code we email to you will let you reset the password and reclaim ownership.',
    akBenefit2: 'Acts as your living identity proof — we trust this key as evidence that you are the original account owner.',
    akRisk: 'Risk if leaked: If someone else gets your account key, they can almost take over your account. They will still need access to the email on file to finish recovery, but they would only need to phish or compromise that one email to get in. Treat this key like your password.',
    akStore: 'Do not share this with anyone. Store it in a password manager, a secure note, or write it down somewhere private.',
    akCopyBtn: 'Copy to clipboard',
    akCopiedBtn: 'Copied!',
    akSavedBtn: "I've saved my key",
    akFooterDefault: 'You can view this key again from Account Settings (with email verification).',
    viewAccountKeyTitle: 'View account key',
    viewAccountKeyDesc: 'For your safety, we will email a 6-digit code to the address on file. Enter it to reveal your account key.',
    viewAccountKeySendBtn: 'Send code to my email',
    viewAccountKeySendingBtn: 'Sending…',
    viewAccountKeySent: 'Code sent. Check your inbox (expires in 2 minutes).',
    viewAccountKeyRevealBtn: 'Reveal my account key',
    viewAccountKeyVerifyingBtn: 'Verifying…',
    viewAccountKeyErrCode: 'Enter the 6-digit code.',
    viewAccountKeyErrNetwork: 'Network error.',
    viewAccountKeyFooter: 'You can request to view this key again from Account Settings.',
  }
};
let STRINGS = { ...DEFAULT_STRINGS };

async function loadTranslationData() {
  try {
    const r = await fetch('/assets/translation/data.json');
    const data = await r.json();
    if (data.strings) STRINGS = data.strings;
    if (data.languages) state.languageOptions = data.languages;
    setState({});
  } catch (e) { console.warn('Failed to load translations', e); }
}

function t(key) {
  const lang = state.language || 'en';
  const strings = STRINGS[lang] || STRINGS.en;
  return strings[key] != null ? strings[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key);
}

function tx(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

const _REMOVED_TRANSLATIONS = {
  zh: {
    profile: '个人资料',
    account: '账号',
    settings: '设置',
    theme: '主题',
    systemLanguage: '系统语言',
    chooseTheme: '选择应用的视觉主题。',
    chooseLanguage: '选择应用的显示语言。',
    language: '语言',
    password: '密码',
    changePassword: '修改密码',
    changePasswordDesc: '修改密码。需要输入当前密码。',
    signOut: '退出登录',
    signOutDesc: '在此设备上退出账号。',
    home: '首页',
    chat: '私信',
    inbox: '收件箱',
    admin: '管理',
    expand: '展开',
    collapse: '收起',
    dropImage: '将图片拖到此处或从下方选择',
    chooseImage: '选择图片',
    displayName: '显示名称',
    username: '用户名',
    description: '简介',
    descriptionPlaceholder: '简短介绍',
    website: '网站',
    save: '保存',
    avatar: '头像',
    loading: '加载中…',
    selectPanel: '请选择一个面板。',
    selectConversation: '请选择会话。',
    noMailYet: '暂无消息。',
    accept: '接受',
    reject: '拒绝',
    'delete': '删除',
    deleteMailConfirm: '删除此邮件？',
    recording: '录音中',
    cancel: '取消',
    send: '发送',
    currentPassword: '当前密码',
    newPassword: '新密码',
    confirmNewPassword: '确认新密码',
    atLeast6: '至少 6 个字符',
    confirmNewPasswordPlaceholder: '确认新密码',
    passwordChanged: '密码已修改。',
    fillCurrentNew: '请填写当前密码和新密码。',
    newPasswordMin: '新密码至少需要 6 个字符。',
    newPasswordMismatch: '新密码与确认不一致。',
    failedChangePassword: '修改密码失败。',
    usernameOrEmail: '用户名或邮箱',
    confirmPassword: '确认密码',
    email: '邮箱',
    signUp: '注册',
    login: '登录',
    alreadyHaveAccount: '已有账号？',
    noAccount: '没有账号？',
    logIn: '登录',
    passwordRequired: '请输入密码',
    passwordsDoNotMatch: '两次密码不一致',
    freeChat: '自由聊天',
    support: '求助',
    problemSolving: '帮助',
    rules: '规则',
    announcements: '公告',
    action: '操作',
    users: '用户',
    recalled: '已撤回',
    timeout: '禁言',
    block: '屏蔽',
    unblock: '取消屏蔽',
    blocked: '已屏蔽',
    sendFriendRequest: '发送好友请求',
    requestSent: '已发送',
    sendMessage: '发送消息',
    notifications: '通知',
    notificationsDesc: '桌面通知，用于消息和邮件。',
    notifyMails: '邮件（收件箱）',
    notifyDm: '私信',
    notifyGroup: '群组消息',
    doNotDisturb: '勿扰模式',
    dndSet: '设置',
    dndCancel: '取消',
    dndDays: '天',
    dndHours: '小时',
    dndMinutes: '分钟',
    dndSeconds: '秒',
    dndEndNow: '立即结束勿扰',
    dndAtNight: '夜间勿扰',
    dndUseLocation: '使用我的位置',
    dndEnterCity: '输入城市',
    dndCityHint: '输入城市以使用其本地时间判断夜间。',
    dndCityPlaceholder: '例如：北京、上海',
    scrollToBottom: '滚动到底部',
    notifModalTitle: '桌面通知',
    notifModalDesc: '是否要在此设备上接收此聊天应用的桌面通知？您可以在设置 → 通知中稍后更改。',
    notifModalAllow: '启用通知',
    notifModalDecline: '暂不',
    adminSendToInbox: '发送到收件箱',
    adminSendToInboxDesc: '向指定用户的收件箱发送消息。',
    adminBroadcast: '广播给所有人',
    adminBroadcastDesc: '向所有用户的收件箱发送消息。',
    adminTimeoutUser: '禁言用户',
    adminTimeoutDurationDesc: '在一段时间内禁止该用户在 JimmyQrg 群聊中发送消息。',
    adminTimeoutUserDesc: '禁止该用户在 JimmyQrg 群聊中发送消息。',
    adminSelectUser: '选择用户',
    adminTitle: '标题',
    adminBody: '正文',
    adminMessageBody: '消息正文',
    adminDuration: '时长',
    adminDurationPlaceholder: '例如：5 分钟、1 小时、永久',
    adminOnlyICanRelease: '仅我可解除',
    adminNoPermissions: '您没有操作权限。请让管理员授予发送邮件、广播或禁言权限。',
    adminRecalledMessages: '已撤回的消息',
    adminRecalledDesc: '群聊中用户已撤回的消息记录。',
    adminUsersSection: '用户',
    adminUsersDesc: '在此添加管理员。添加后，可设置其权限（如发邮件、广播、编辑文档等）。',
    adminPermSendMail: '发邮件',
    adminPermBroadcast: '广播',
    adminPermEditDocs: '编辑文档',
    adminPermRemoveAccount: '移除账号',
    adminPermDeleteMessages: '删除消息',
    adminPermManageUsers: '管理用户',
    adminPermTimeout: '禁言',
    adminRoleAdmin: '管理员',
    adminRoleDeleted: '已删除',
    adminRoleOnList: '在管理员列表中',
    adminRoleMember: '成员',
    adminRemoveFromList: '移出列表',
    adminAddToList: '加入列表',
    adminRestore: '恢复',
    adminDeletePermanently: '永久删除',
    adminRemoveAccount: '移除账号',
    adminBlacklist: '拉黑',
    adminUnblacklist: '取消拉黑',
    adminDeleteAccountTitle: '永久删除账号',
    adminDeleteAccountDesc: '将把该用户从用户列表中移除，从私聊列表中移除，并清除其所有数据。此操作不可撤销。',
    adminDeleteGroupMessages: '同时删除群聊中的消息',
    adminDeleteAdmin: '删除（管理员）',
    adminRemoveAccountConfirm: '确定要移除此账号吗？用户将无法登录。消息会保留，之后可恢复。',
    replyToMessage: '回复消息',
    recall: '撤回',
    edit: '编辑',
    solve: '标记已解决',
    getFileId: '获取文件 ID',
    copy: '复制',
    reply: '回复',
    mentionDeletedUsers: '提示：您正在提及已删除账号的用户：',
    adminNoRecalledMessages: '暂无已撤回的消息。',
    adminFailedToLoad: '加载失败。',
    adminSent: '已发送。',
    adminBroadcastSent: '广播已发送。',
    adminNoActiveTimeouts: '暂无禁言中的用户。',
    adminTimeoutUntil: '至 ',
    adminTimeoutForever: '永久',
    adminTimeoutLocked: '（仅我可解除）',
    adminRelease: '解除',
  },
  'ja': {
    general: '一般',
    profile: 'プロフィール',
    account: 'アカウント',
    settings: '設定',
    theme: 'テーマ',
    systemLanguage: 'システム言語',
    chooseTheme: 'アプリの表示テーマを選択します。',
    chooseLanguage: 'アプリの表示言語を選択します。',
    language: '言語',
    password: 'パスワード',
    changePassword: 'パスワードを変更',
    changePasswordDesc: 'パスワードを変更します。現在のパスワードが必要です。',
    signOut: 'ログアウト',
    signOutDesc: 'このデバイスからログアウトします。',
    home: 'ホーム',
    chat: 'チャット',
    inbox: '受信トレイ',
    admin: '管理',
    expand: '展開',
    collapse: '折りたたむ',
    dropImage: '画像をここにドロップするか、下から選択',
    chooseImage: '画像を選択',
    displayName: '表示名',
    username: 'ユーザー名',
    description: '自己紹介',
    descriptionPlaceholder: '短い自己紹介',
    website: 'ウェブサイト',
    save: '保存',
    avatar: 'アバター',
    loading: '読み込み中…',
    selectPanel: 'パネルを選択してください。',
    selectConversation: '会話を選択してください。',
    noMailYet: 'メールはまだありません。',
    accept: '承諾',
    reject: '拒否',
    'delete': '削除',
    deleteMailConfirm: 'このメールを削除しますか？',
    recording: '録音中',
    cancel: 'キャンセル',
    send: '送信',
    currentPassword: '現在のパスワード',
    newPassword: '新しいパスワード',
    confirmNewPassword: '新しいパスワードの確認',
    atLeast6: '6文字以上',
    confirmNewPasswordPlaceholder: '新しいパスワードの確認',
    passwordChanged: 'パスワードを変更しました。',
    fillCurrentNew: '現在のパスワードと新しいパスワードを入力してください。',
    newPasswordMin: '新しいパスワードは6文字以上にしてください。',
    newPasswordMismatch: '新しいパスワードと確認が一致しません。',
    failedChangePassword: 'パスワードの変更に失敗しました。',
    usernameOrEmail: 'ユーザー名またはメール',
    confirmPassword: 'パスワードの確認',
    email: 'メール',
    signUp: '登録',
    login: 'ログイン',
    alreadyHaveAccount: 'すでにアカウントをお持ちですか？',
    noAccount: 'アカウントをお持ちでないですか？',
    logIn: 'ログイン',
    passwordRequired: 'パスワードを入力してください',
    passwordsDoNotMatch: 'パスワードが一致しません',
    freeChat: 'フリーチャット',
    support: 'サポート',
    problemSolving: '問題解決',
    rules: 'ルール',
    announcements: 'お知らせ',
    action: '操作',
    users: 'ユーザー',
    recalled: '取り消し',
    timeout: 'タイムアウト',
    notifications: '通知',
    notificationsDesc: 'メッセージとメールのデスクトップ通知。',
    notifyMails: 'メール（受信トレイ）',
    notifyDm: 'プライベートメッセージ',
    notifyGroup: 'グループメッセージ',
    doNotDisturb: 'おやすみモード',
    dndSet: '設定',
    dndCancel: 'キャンセル',
    dndDays: '日',
    dndHours: '時間',
    dndMinutes: '分',
    dndSeconds: '秒',
    dndEndNow: 'おやすみモードを終了',
    dndAtNight: '夜間おやすみモード',
    dndUseLocation: '現在地を使用',
    dndEnterCity: '都市を入力',
    dndCityHint: '都市を入力すると、その地域の現地時間で夜間を判定します。',
    dndCityPlaceholder: '例：東京、大阪',
    scrollToBottom: '一番下へ',
    notifModalTitle: 'デスクトップ通知',
    notifModalDesc: 'このチャットアプリのデスクトップ通知をこのデバイスで受け取りますか？設定 → 通知で後から変更できます。',
    notifModalAllow: '通知を有効にする',
    notifModalDecline: '後で',
    adminSendToInbox: '受信トレイに送信',
    adminSendToInboxDesc: '特定のユーザーの受信トレイにメッセージを送信します。',
    adminBroadcast: '全員に一斉送信',
    adminBroadcastDesc: '全ユーザーの受信トレイにメッセージを送信します。',
    adminTimeoutUser: 'ユーザーをミュート',
    adminTimeoutDurationDesc: '指定時間、JimmyQrg グループチャットでメッセージを送信できなくします。',
    adminTimeoutUserDesc: 'JimmyQrg グループチャットでメッセージを送信できなくします。',
    adminSelectUser: 'ユーザーを選択',
    adminTitle: 'タイトル',
    adminBody: '本文',
    adminMessageBody: 'メッセージ本文',
    adminDuration: '期間',
    adminDurationPlaceholder: '例：5分、1時間、永久',
    adminOnlyICanRelease: '解除は自分だけ',
    adminNoPermissions: '操作権限がありません。管理者にメール送信・一斉送信・ミュートの権限を付与してもらってください。',
    adminRecalledMessages: '取り消されたメッセージ',
    adminRecalledDesc: 'グループチャットでユーザーが取り消したメッセージの記録。',
    adminUsersSection: 'ユーザー',
    adminUsersDesc: 'ここで管理者を追加します。追加後、許可する操作（メール送信、一斉送信、ドキュメント編集など）を設定できます。',
    adminPermSendMail: 'メール送信',
    adminPermBroadcast: '一斉送信',
    adminPermEditDocs: 'ドキュメント編集',
    adminPermRemoveAccount: 'アカウント削除',
    adminPermDeleteMessages: 'メッセージ削除',
    adminPermManageUsers: 'ユーザー管理',
    adminPermTimeout: 'ミュート',
    adminRoleAdmin: '管理者',
    adminRoleDeleted: '削除済み',
    adminRoleOnList: '管理者リストに登録',
    adminRoleMember: 'メンバー',
    adminRemoveFromList: 'リストから削除',
    adminAddToList: 'リストに追加',
    adminRestore: '復元',
    adminDeletePermanently: '完全に削除',
    adminRemoveAccount: 'アカウント削除',
    adminBlacklist: 'ブラックリスト',
    adminUnblacklist: 'ブラックリスト解除',
    adminDeleteAccountTitle: 'アカウントを完全に削除',
    adminDeleteAccountDesc: 'ユーザーをユーザーリストから削除し、プライベートチャットリストから削除し、関連するすべてのデータを消去します。元に戻せません。',
    adminDeleteGroupMessages: 'グループチャットのメッセージも削除',
    adminDeleteAdmin: '削除（管理者）',
    adminRemoveAccountConfirm: 'このアカウントを削除しますか？ユーザーはログインできなくなります。メッセージは残り、後で復元できます。',
    replyToMessage: 'メッセージに返信',
    recall: '取り消す',
    edit: '編集',
    solve: '解決済みにする',
    getFileId: 'ファイルIDを取得',
    copy: 'コピー',
    reply: '返信',
    mentionDeletedUsers: '注意：削除済みアカウントのユーザーをメンションしています：',
    adminNoRecalledMessages: '取り消されたメッセージはありません。',
    adminFailedToLoad: '読み込みに失敗しました。',
    adminSent: '送信しました。',
    adminBroadcastSent: '一斉送信しました。',
    adminNoActiveTimeouts: 'ミュート中のユーザーはいません。',
    adminTimeoutUntil: 'まで ',
    adminTimeoutForever: '永久',
    adminTimeoutLocked: '（解除は自分だけ）',
    adminRelease: '解除',
    block: 'ブロック',
    unblock: 'ブロック解除',
    blocked: 'ブロック済み',
    sendFriendRequest: '友達リクエストを送る',
    requestSent: 'リクエスト送信済み',
    sendMessage: 'メッセージを送る',
  },
  'ko': {
    general: '일반',
    profile: '프로필',
    account: '계정',
    settings: '설정',
    theme: '테마',
    systemLanguage: '시스템 언어',
    chooseTheme: '앱의 테마를 선택하세요.',
    chooseLanguage: '앱의 표시 언어를 선택하세요.',
    language: '언어',
    password: '비밀번호',
    changePassword: '비밀번호 변경',
    changePasswordDesc: '비밀번호를 변경합니다. 현재 비밀번호가 필요합니다.',
    signOut: '로그아웃',
    signOutDesc: '이 기기에서 로그아웃합니다.',
    home: '홈',
    chat: '채팅',
    inbox: '받은편지함',
    admin: '관리',
    expand: '펼치기',
    collapse: '접기',
    dropImage: '이미지를 여기에 놓거나 아래에서 선택',
    chooseImage: '이미지 선택',
    displayName: '표시 이름',
    username: '사용자 이름',
    description: '소개',
    descriptionPlaceholder: '간단한 소개',
    website: '웹사이트',
    save: '저장',
    avatar: '아바타',
    loading: '로딩 중…',
    selectPanel: '패널을 선택하세요.',
    selectConversation: '대화를 선택하세요.',
    noMailYet: '메일이 없습니다.',
    accept: '수락',
    reject: '거절',
    'delete': '삭제',
    deleteMailConfirm: '이 메일을 삭제하시겠습니까?',
    recording: '녹음 중',
    cancel: '취소',
    send: '보내기',
    currentPassword: '현재 비밀번호',
    newPassword: '새 비밀번호',
    confirmNewPassword: '새 비밀번호 확인',
    atLeast6: '6자 이상',
    confirmNewPasswordPlaceholder: '새 비밀번호 확인',
    passwordChanged: '비밀번호가 변경되었습니다.',
    fillCurrentNew: '현재 비밀번호와 새 비밀번호를 입력하세요.',
    newPasswordMin: '새 비밀번호는 6자 이상이어야 합니다.',
    newPasswordMismatch: '새 비밀번호와 확인이 일치하지 않습니다.',
    failedChangePassword: '비밀번호 변경에 실패했습니다.',
    usernameOrEmail: '사용자 이름 또는 이메일',
    confirmPassword: '비밀번호 확인',
    email: '이메일',
    signUp: '가입',
    login: '로그인',
    alreadyHaveAccount: '이미 계정이 있으신가요? ',
    noAccount: '계정이 없으신가요? ',
    logIn: '로그인',
    passwordRequired: '비밀번호를 입력하세요',
    passwordsDoNotMatch: '비밀번호가 일치하지 않습니다',
    freeChat: '자유 채팅',
    support: '지원',
    problemSolving: '문제 해결',
    rules: '규칙',
    announcements: '공지',
    action: '작업',
    users: '사용자',
    recalled: '취소됨',
    timeout: '타임아웃',
    notifications: '알림',
    notificationsDesc: '메시지 및 메일용 데스크톱 알림.',
    notifyMails: '메일(받은편지함)',
    notifyDm: '개인 메시지',
    notifyGroup: '그룹 메시지',
    doNotDisturb: '방해 금지',
    dndSet: '설정',
    dndCancel: '취소',
    dndDays: '일',
    dndHours: '시간',
    dndMinutes: '분',
    dndSeconds: '초',
    dndEndNow: '방해 금지 종료',
    dndAtNight: '야간 방해 금지',
    dndUseLocation: '내 위치 사용',
    dndEnterCity: '도시 입력',
    dndCityHint: '도시를 입력하면 해당 지역의 현지 시간으로 야간을 판단합니다.',
    dndCityPlaceholder: '예: 서울, 부산',
    scrollToBottom: '맨 아래로',
    block: '차단',
    unblock: '차단 해제',
    blocked: '차단됨',
    sendFriendRequest: '친구 요청 보내기',
    requestSent: '요청 보냄',
    sendMessage: '메시지 보내기',
    notifModalTitle: '데스크톱 알림',
    notifModalDesc: '이 채팅 앱의 데스크톱 알림을 이 기기에서 받으시겠습니까? 설정 → 알림에서 나중에 변경할 수 있습니다.',
    notifModalAllow: '알림 사용',
    notifModalDecline: '나중에',
    adminSendToInbox: '받은편지함으로 보내기',
    adminSendToInboxDesc: '특정 사용자의 받은편지함에 메시지를 보냅니다.',
    adminBroadcast: '전체 공지',
    adminBroadcastDesc: '모든 사용자의 받은편지함에 메시지를 보냅니다.',
    adminTimeoutUser: '사용자 채팅 금지',
    adminTimeoutDurationDesc: '지정한 시간 동안 JimmyQrg 그룹 채팅에서 메시지 전송을 막습니다.',
    adminTimeoutUserDesc: 'JimmyQrg 그룹 채팅에서 메시지 전송을 막습니다.',
    adminSelectUser: '사용자 선택',
    adminTitle: '제목',
    adminBody: '본문',
    adminMessageBody: '메시지 본문',
    adminDuration: '기간',
    adminDurationPlaceholder: '예: 5분, 1시간, 영구',
    adminOnlyICanRelease: '해제는 본인만 가능',
    adminNoPermissions: '작업 권한이 없습니다. 관리자에게 메일 발송, 공지, 채팅 금지 권한을 요청하세요.',
    adminRecalledMessages: '취소된 메시지',
    adminRecalledDesc: '그룹 채팅에서 사용자가 취소한 메시지 기록입니다.',
    adminUsersSection: '사용자',
    adminUsersDesc: '여기서 관리자를 추가합니다. 추가 후 허용할 작업(메일 발송, 공지, 문서 편집 등)을 설정하세요.',
    adminPermSendMail: '메일 발송',
    adminPermBroadcast: '공지',
    adminPermEditDocs: '문서 편집',
    adminPermRemoveAccount: '계정 삭제',
    adminPermDeleteMessages: '메시지 삭제',
    adminPermManageUsers: '사용자 관리',
    adminPermTimeout: '채팅 금지',
    adminRoleAdmin: '관리자',
    adminRoleDeleted: '삭제됨',
    adminRoleOnList: '관리자 목록',
    adminRoleMember: '멤버',
    adminRemoveFromList: '목록에서 제거',
    adminAddToList: '목록에 추가',
    adminRestore: '복원',
    adminDeletePermanently: '영구 삭제',
    adminRemoveAccount: '계정 삭제',
    adminBlacklist: '차단 목록',
    adminUnblacklist: '차단 해제',
    adminDeleteAccountTitle: '계정 영구 삭제',
    adminDeleteAccountDesc: '사용자를 사용자 목록에서 제거하고, 개인 채팅 목록에서 제거하며, 관련 데이터를 모두 삭제합니다. 되돌릴 수 없습니다.',
    adminDeleteGroupMessages: '그룹 채팅 메시지도 삭제',
    adminDeleteAdmin: '삭제(관리자)',
    adminRemoveAccountConfirm: '이 계정을 삭제하시겠습니까? 사용자는 로그인할 수 없습니다. 메시지는 유지되며 나중에 복원할 수 있습니다.',
    replyToMessage: '메시지에 답장',
    recall: '취소',
    edit: '편집',
    solve: '해결됨으로 표시',
    getFileId: '파일 ID 가져오기',
    copy: '복사',
    reply: '답장',
    mentionDeletedUsers: '참고: 삭제된 계정의 사용자를 멘션하고 있습니다: ',
    adminNoRecalledMessages: '취소된 메시지가 없습니다.',
    adminFailedToLoad: '로드에 실패했습니다.',
    adminSent: '전송되었습니다.',
    adminBroadcastSent: '공지가 전송되었습니다.',
    adminNoActiveTimeouts: '채팅 금지 중인 사용자가 없습니다.',
    adminTimeoutUntil: '까지 ',
    adminTimeoutForever: '영구',
    adminTimeoutLocked: '(해제는 본인만)',
    adminRelease: '해제',
  },
  'es': {
    general: 'General',
    profile: 'Perfil',
    account: 'Cuenta',
    settings: 'Ajustes',
    theme: 'Tema',
    systemLanguage: 'Idioma del sistema',
    chooseTheme: 'Elige el tema visual de la aplicación.',
    chooseLanguage: 'Elige el idioma de visualización de la aplicación.',
    language: 'Idioma',
    password: 'Contraseña',
    changePassword: 'Cambiar contraseña',
    changePasswordDesc: 'Cambia tu contraseña. Se requiere la contraseña actual.',
    signOut: 'Cerrar sesión',
    signOutDesc: 'Cerrar sesión en este dispositivo.',
    home: 'Inicio',
    chat: 'Chat',
    inbox: 'Bandeja de entrada',
    admin: 'Administración',
    expand: 'Expandir',
    collapse: 'Contraer',
    dropImage: 'Suelta la imagen aquí o elige abajo',
    chooseImage: 'Elegir imagen',
    displayName: 'Nombre para mostrar',
    username: 'Nombre de usuario',
    description: 'Descripción',
    descriptionPlaceholder: 'Una breve biografía o descripción',
    website: 'Sitio web',
    save: 'Guardar',
    avatar: 'Avatar',
    loading: 'Cargando…',
    selectPanel: 'Selecciona un panel.',
    selectConversation: 'Selecciona una conversación.',
    noMailYet: 'Aún no hay correo.',
    accept: 'Aceptar',
    reject: 'Rechazar',
    'delete': 'Eliminar',
    deleteMailConfirm: '¿Eliminar este correo?',
    recording: 'Grabando',
    cancel: 'Cancelar',
    send: 'Enviar',
    currentPassword: 'Contraseña actual',
    newPassword: 'Nueva contraseña',
    confirmNewPassword: 'Confirmar nueva contraseña',
    atLeast6: 'Al menos 6 caracteres',
    confirmNewPasswordPlaceholder: 'Confirmar nueva contraseña',
    passwordChanged: 'Contraseña cambiada.',
    fillCurrentNew: 'Por favor, introduce la contraseña actual y la nueva.',
    newPasswordMin: 'La nueva contraseña debe tener al menos 6 caracteres.',
    newPasswordMismatch: 'La nueva contraseña y la confirmación no coinciden.',
    failedChangePassword: 'Error al cambiar la contraseña.',
    usernameOrEmail: 'Nombre de usuario o correo',
    confirmPassword: 'Confirmar contraseña',
    email: 'Correo electrónico',
    signUp: 'Registrarse',
    login: 'Iniciar sesión',
    alreadyHaveAccount: '¿Ya tienes una cuenta? ',
    noAccount: '¿No tienes una cuenta? ',
    logIn: 'Iniciar sesión',
    passwordRequired: 'La contraseña es obligatoria',
    passwordsDoNotMatch: 'Las contraseñas no coinciden',
    freeChat: 'Chat libre',
    support: 'Soporte',
    problemSolving: 'Resolución de problemas',
    rules: 'Reglas',
    announcements: 'Anuncios',
    action: 'Acción',
    users: 'Usuarios',
    recalled: 'Recuperado',
    timeout: 'Tiempo de espera',
    block: 'Bloquear',
    unblock: 'Desbloquear',
    blocked: 'Bloqueado',
    sendFriendRequest: 'Enviar solicitud de amistad',
    requestSent: 'Solicitud enviada',
    sendMessage: 'Enviar mensaje',
    notifications: 'Notificaciones',
    notificationsDesc: 'Notificaciones de escritorio para mensajes y correo.',
    notifyMails: 'Correo (bandeja de entrada)',
    notifyDm: 'Mensajes privados',
    notifyGroup: 'Mensajes de grupo',
    doNotDisturb: 'No molestar',
    dndSet: 'Establecer',
    dndCancel: 'Cancelar',
    dndDays: 'Días',
    dndHours: 'Horas',
    dndMinutes: 'Minutos',
    dndSeconds: 'Segundos',
    dndEndNow: 'Terminar no molestar ahora',
    dndAtNight: 'No molestar por la noche',
    dndUseLocation: 'Usar mi ubicación',
    dndEnterCity: 'Introducir ciudad',
    dndCityHint: 'Introduce tu ciudad para usar su hora local en el horario nocturno.',
    dndCityPlaceholder: 'ej. Madrid, Barcelona',
    scrollToBottom: 'Ir al final',
    notifModalTitle: 'Notificaciones de escritorio',
    notifModalDesc: '¿Quieres recibir notificaciones de escritorio de esta aplicación de chat en este dispositivo? Puedes cambiarlo más tarde en Ajustes → Notificaciones.',
    notifModalAllow: 'Activar notificaciones',
    notifModalDecline: 'Ahora no',
    adminSendToInbox: 'Enviar a bandeja de entrada',
    adminSendToInboxDesc: 'Enviar un mensaje a la bandeja de entrada de un usuario específico.',
    adminBroadcast: 'Transmitir a todos',
    adminBroadcastDesc: 'Enviar un mensaje a la bandeja de entrada de todos los usuarios.',
    adminTimeoutUser: 'Silenciar usuario',
    adminTimeoutDurationDesc: 'Impedir que un usuario envíe mensajes en el chat grupal JimmyQrg durante un tiempo determinado.',
    adminTimeoutUserDesc: 'Impedir que un usuario envíe mensajes en el chat grupal JimmyQrg.',
    adminSelectUser: 'Seleccionar usuario',
    adminTitle: 'Título',
    adminBody: 'Cuerpo',
    adminMessageBody: 'Cuerpo del mensaje',
    adminDuration: 'Duración',
    adminDurationPlaceholder: 'ej. 5 minutos, 1 hora, para siempre',
    adminOnlyICanRelease: 'Solo yo puedo liberar',
    adminNoPermissions: 'No tienes permisos de acción. Pide a un administrador que te conceda Enviar correo, Transmitir o Silenciar.',
    adminRecalledMessages: 'Mensajes recuperados',
    adminRecalledDesc: 'Mensajes que los usuarios recuperaron en el chat grupal.',
    adminUsersSection: 'Usuarios',
    adminUsersDesc: 'Añade usuarios a la lista de administradores aquí. Después de añadir a alguien, configura qué puede hacer (ej. enviar correo, transmitir, editar documentos).',
    adminPermSendMail: 'Enviar correo',
    adminPermBroadcast: 'Transmitir',
    adminPermEditDocs: 'Editar documentos',
    adminPermRemoveAccount: 'Eliminar cuenta',
    adminPermDeleteMessages: 'Eliminar mensajes',
    adminPermManageUsers: 'Gestionar usuarios',
    adminPermTimeout: 'Silenciar',
    adminRoleAdmin: 'Administrador',
    adminRoleDeleted: 'Eliminado',
    adminRoleOnList: 'En lista de administradores',
    adminRoleMember: 'Miembro',
    adminRemoveFromList: 'Quitar de la lista',
    adminAddToList: 'Añadir a la lista',
    adminRestore: 'Restaurar',
    adminDeletePermanently: 'Eliminar permanentemente',
    adminRemoveAccount: 'Eliminar cuenta',
    adminBlacklist: 'Lista negra',
    adminUnblacklist: 'Quitar de lista negra',
    adminDeleteAccountTitle: 'Eliminar cuenta permanentemente',
    adminDeleteAccountDesc: 'Esto eliminará al usuario de la lista, lo quitará de las listas de chat privado y borrará todos sus datos. No se puede deshacer.',
    adminDeleteGroupMessages: 'Eliminar también los mensajes del chat grupal',
    adminDeleteAdmin: 'Eliminar (admin)',
    adminRemoveAccountConfirm: '¿Eliminar esta cuenta? El usuario no podrá iniciar sesión. Los mensajes permanecen. Puedes restaurar más tarde.',
    replyToMessage: 'Responder al mensaje',
    recall: 'Recuperar',
    edit: 'Editar',
    solve: 'Marcar como resuelto',
    getFileId: 'Obtener ID de archivo',
    copy: 'Copiar',
    reply: 'Responder',
    mentionDeletedUsers: 'Nota: Estás mencionando usuario(s) cuyas cuentas han sido eliminadas: ',
    adminNoRecalledMessages: 'No hay mensajes recuperados.',
    adminFailedToLoad: 'Error al cargar.',
    adminSent: 'Enviado.',
    adminBroadcastSent: 'Transmisión enviada.',
    adminNoActiveTimeouts: 'No hay silenciamientos activos.',
    adminTimeoutUntil: 'hasta ',
    adminTimeoutForever: 'para siempre',
    adminTimeoutLocked: '(bloqueado)',
    adminRelease: 'Liberar',
  },
  'fr': {
    general: 'Général',
    profile: 'Profil',
    account: 'Compte',
    settings: 'Paramètres',
    theme: 'Thème',
    systemLanguage: 'Langue du système',
    chooseTheme: 'Choisissez le thème visuel de l\'application.',
    chooseLanguage: 'Choisissez la langue d\'affichage de l\'application.',
    language: 'Langue',
    password: 'Mot de passe',
    changePassword: 'Changer le mot de passe',
    changePasswordDesc: 'Changez votre mot de passe. Votre mot de passe actuel est requis.',
    signOut: 'Déconnexion',
    signOutDesc: 'Se déconnecter de ce périphérique.',
    home: 'Accueil',
    chat: 'Chat',
    inbox: 'Boîte de réception',
    admin: 'Administration',
    expand: 'Développer',
    collapse: 'Réduire',
    dropImage: 'Déposez l\'image ici ou choisissez ci-dessous',
    chooseImage: 'Choisir une image',
    displayName: 'Nom d\'affichage',
    username: 'Nom d\'utilisateur',
    description: 'Description',
    descriptionPlaceholder: 'Une courte biographie ou description',
    website: 'Site web',
    save: 'Enregistrer',
    avatar: 'Avatar',
    loading: 'Chargement…',
    selectPanel: 'Sélectionnez un panneau.',
    selectConversation: 'Sélectionnez une conversation.',
    noMailYet: 'Pas encore de courrier.',
    accept: 'Accepter',
    reject: 'Refuser',
    'delete': 'Supprimer',
    deleteMailConfirm: 'Supprimer ce courrier ?',
    recording: 'Enregistrement',
    cancel: 'Annuler',
    send: 'Envoyer',
    currentPassword: 'Mot de passe actuel',
    newPassword: 'Nouveau mot de passe',
    confirmNewPassword: 'Confirmer le nouveau mot de passe',
    atLeast6: 'Au moins 6 caractères',
    confirmNewPasswordPlaceholder: 'Confirmer le nouveau mot de passe',
    passwordChanged: 'Mot de passe modifié.',
    fillCurrentNew: 'Veuillez remplir le mot de passe actuel et le nouveau.',
    newPasswordMin: 'Le nouveau mot de passe doit contenir au moins 6 caractères.',
    newPasswordMismatch: 'Le nouveau mot de passe et la confirmation ne correspondent pas.',
    failedChangePassword: 'Échec du changement de mot de passe.',
    usernameOrEmail: 'Nom d\'utilisateur ou e-mail',
    confirmPassword: 'Confirmer le mot de passe',
    email: 'E-mail',
    signUp: 'S\'inscrire',
    login: 'Connexion',
    alreadyHaveAccount: 'Vous avez déjà un compte ? ',
    noAccount: 'Vous n\'avez pas de compte ? ',
    logIn: 'Se connecter',
    passwordRequired: 'Le mot de passe est requis',
    passwordsDoNotMatch: 'Les mots de passe ne correspondent pas',
    freeChat: 'Chat libre',
    support: 'Support',
    problemSolving: 'Résolution de problèmes',
    rules: 'Règles',
    announcements: 'Annonces',
    action: 'Action',
    users: 'Utilisateurs',
    recalled: 'Récupéré',
    timeout: 'Temps mort',
    block: 'Bloquer',
    unblock: 'Débloquer',
    blocked: 'Bloqué',
    sendFriendRequest: 'Envoyer une demande d\'ami',
    requestSent: 'Demande envoyée',
    sendMessage: 'Envoyer un message',
    notifications: 'Notifications',
    notificationsDesc: 'Notifications de bureau pour les messages et le courrier.',
    notifyMails: 'Courrier (boîte de réception)',
    notifyDm: 'Messages privés',
    notifyGroup: 'Messages de groupe',
    doNotDisturb: 'Ne pas déranger',
    dndSet: 'Définir',
    dndCancel: 'Annuler',
    dndDays: 'Jours',
    dndHours: 'Heures',
    dndMinutes: 'Minutes',
    dndSeconds: 'Secondes',
    dndEndNow: 'Terminer NPD maintenant',
    dndAtNight: 'Ne pas déranger la nuit',
    dndUseLocation: 'Utiliser ma position',
    dndEnterCity: 'Entrer la ville',
    dndCityHint: 'Entrez votre ville pour utiliser son heure locale pour les heures nocturnes.',
    dndCityPlaceholder: 'ex. Paris, Lyon',
    scrollToBottom: 'Aller en bas',
    notifModalTitle: 'Notifications de bureau',
    notifModalDesc: 'Voulez-vous recevoir les notifications de bureau de cette application de chat sur ce périphérique ? Vous pouvez modifier cela plus tard dans Paramètres → Notifications.',
    notifModalAllow: 'Activer les notifications',
    notifModalDecline: 'Pas maintenant',
    adminSendToInbox: 'Envoyer à la boîte de réception',
    adminSendToInboxDesc: 'Envoyer un message à la boîte de réception d\'un utilisateur spécifique.',
    adminBroadcast: 'Diffuser à tous',
    adminBroadcastDesc: 'Envoyer un message à la boîte de réception de tous les utilisateurs.',
    adminTimeoutUser: 'Mettre en sourdine un utilisateur',
    adminTimeoutDurationDesc: 'Empêcher un utilisateur d\'envoyer des messages dans le chat de groupe JimmyQrg pendant une durée déterminée.',
    adminTimeoutUserDesc: 'Empêcher un utilisateur d\'envoyer des messages dans le chat de groupe JimmyQrg.',
    adminSelectUser: 'Sélectionner un utilisateur',
    adminTitle: 'Titre',
    adminBody: 'Corps',
    adminMessageBody: 'Corps du message',
    adminDuration: 'Durée',
    adminDurationPlaceholder: 'ex. 5 minutes, 1 heure, pour toujours',
    adminOnlyICanRelease: 'Seul je peux libérer',
    adminNoPermissions: 'Vous n\'avez pas les permissions d\'action. Demandez à un administrateur d\'accorder Envoyer du courrier, Diffuser ou Mettre en sourdine.',
    adminRecalledMessages: 'Messages récupérés',
    adminRecalledDesc: 'Messages qui ont été récupérés par les utilisateurs dans le chat de groupe.',
    adminUsersSection: 'Utilisateurs',
    adminUsersDesc: 'Ajoutez des utilisateurs à la liste des administrateurs ici. Après en avoir ajouté un, définissez ce qu\'il peut faire (ex. envoyer du courrier, diffuser, modifier des documents).',
    adminPermSendMail: 'Envoyer du courrier',
    adminPermBroadcast: 'Diffuser',
    adminPermEditDocs: 'Modifier les documents',
    adminPermRemoveAccount: 'Supprimer le compte',
    adminPermDeleteMessages: 'Supprimer les messages',
    adminPermManageUsers: 'Gérer les utilisateurs',
    adminPermTimeout: 'Mettre en sourdine',
    adminRoleAdmin: 'Administrateur',
    adminRoleDeleted: 'Supprimé',
    adminRoleOnList: 'Sur la liste des administrateurs',
    adminRoleMember: 'Membre',
    adminRemoveFromList: 'Retirer de la liste',
    adminAddToList: 'Ajouter à la liste',
    adminRestore: 'Restaurer',
    adminDeletePermanently: 'Supprimer définitivement',
    adminRemoveAccount: 'Supprimer le compte',
    adminBlacklist: 'Liste noire',
    adminUnblacklist: 'Retirer de la liste noire',
    adminDeleteAccountTitle: 'Supprimer le compte définitivement',
    adminDeleteAccountDesc: 'Cela supprimera l\'utilisateur de la liste, le retirera des listes de chat privé et effacera toutes ses données. Cette action est irréversible.',
    adminDeleteGroupMessages: 'Supprimer aussi les messages du chat de groupe',
    adminDeleteAdmin: 'Supprimer (admin)',
    adminRemoveAccountConfirm: 'Supprimer ce compte ? L\'utilisateur ne pourra plus se connecter. Les messages restent. Vous pourrez restaurer plus tard.',
    replyToMessage: 'Répondre au message',
    recall: 'Récupérer',
    edit: 'Modifier',
    solve: 'Marquer comme résolu',
    getFileId: 'Obtenir l\'ID du fichier',
    copy: 'Copier',
    reply: 'Répondre',
    mentionDeletedUsers: 'Note : Vous mentionnez des utilisateur(s) dont les comptes ont été supprimés : ',
    adminNoRecalledMessages: 'Aucun message récupéré.',
    adminFailedToLoad: 'Échec du chargement.',
    adminSent: 'Envoyé.',
    adminBroadcastSent: 'Diffusion envoyée.',
    adminNoActiveTimeouts: 'Aucune mise en sourdine active.',
    adminTimeoutUntil: 'jusqu\'à ',
    adminTimeoutForever: 'pour toujours',
    adminTimeoutLocked: '(verrouillé)',
    adminRelease: 'Libérer',
  },
  'de': {
    general: 'Allgemein',
    profile: 'Profil',
    account: 'Konto',
    settings: 'Einstellungen',
    theme: 'Design',
    systemLanguage: 'Systemsprache',
    chooseTheme: 'Wählen Sie das visuelle Design der App.',
    chooseLanguage: 'Wählen Sie die Anzeigesprache der App.',
    language: 'Sprache',
    password: 'Passwort',
    changePassword: 'Passwort ändern',
    changePasswordDesc: 'Ändern Sie Ihr Passwort. Ihr aktuelles Passwort wird benötigt.',
    signOut: 'Abmelden',
    signOutDesc: 'Von diesem Gerät abmelden.',
    home: 'Startseite',
    chat: 'Chat',
    inbox: 'Posteingang',
    admin: 'Verwaltung',
    expand: 'Erweitern',
    collapse: 'Einklappen',
    dropImage: 'Bild hier ablegen oder unten auswählen',
    chooseImage: 'Bild auswählen',
    displayName: 'Anzeigename',
    username: 'Benutzername',
    description: 'Beschreibung',
    descriptionPlaceholder: 'Eine kurze Biografie oder Beschreibung',
    website: 'Website',
    save: 'Speichern',
    avatar: 'Avatar',
    loading: 'Laden…',
    selectPanel: 'Wählen Sie einen Bereich.',
    selectConversation: 'Wählen Sie eine Konversation.',
    noMailYet: 'Noch keine Nachrichten.',
    accept: 'Akzeptieren',
    reject: 'Ablehnen',
    'delete': 'Löschen',
    deleteMailConfirm: 'Diese Nachricht löschen?',
    recording: 'Aufnahme',
    cancel: 'Abbrechen',
    send: 'Senden',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    confirmNewPassword: 'Neues Passwort bestätigen',
    atLeast6: 'Mindestens 6 Zeichen',
    confirmNewPasswordPlaceholder: 'Neues Passwort bestätigen',
    passwordChanged: 'Passwort geändert.',
    fillCurrentNew: 'Bitte geben Sie das aktuelle und das neue Passwort ein.',
    newPasswordMin: 'Das neue Passwort muss mindestens 6 Zeichen haben.',
    newPasswordMismatch: 'Neues Passwort und Bestätigung stimmen nicht überein.',
    failedChangePassword: 'Passwortänderung fehlgeschlagen.',
    usernameOrEmail: 'Benutzername oder E-Mail',
    confirmPassword: 'Passwort bestätigen',
    email: 'E-Mail',
    signUp: 'Registrieren',
    login: 'Anmelden',
    alreadyHaveAccount: 'Bereits ein Konto? ',
    noAccount: 'Noch kein Konto? ',
    logIn: 'Anmelden',
    passwordRequired: 'Passwort ist erforderlich',
    passwordsDoNotMatch: 'Passwörter stimmen nicht überein',
    freeChat: 'Freier Chat',
    support: 'Support',
    problemSolving: 'Problemlösung',
    rules: 'Regeln',
    announcements: 'Ankündigungen',
    action: 'Aktion',
    users: 'Benutzer',
    recalled: 'Widerrufen',
    timeout: 'Auszeit',
    block: 'Blockieren',
    unblock: 'Entsperren',
    blocked: 'Blockiert',
    sendFriendRequest: 'Freundschaftsanfrage senden',
    requestSent: 'Anfrage gesendet',
    sendMessage: 'Nachricht senden',
    notifications: 'Benachrichtigungen',
    notificationsDesc: 'Desktop-Benachrichtigungen für Nachrichten und E-Mail.',
    notifyMails: 'E-Mail (Posteingang)',
    notifyDm: 'Private Nachrichten',
    notifyGroup: 'Gruppennachrichten',
    doNotDisturb: 'Nicht stören',
    dndSet: 'Festlegen',
    dndCancel: 'Abbrechen',
    dndDays: 'Tage',
    dndHours: 'Stunden',
    dndMinutes: 'Minuten',
    dndSeconds: 'Sekunden',
    dndEndNow: 'Nicht stören jetzt beenden',
    dndAtNight: 'Nachts nicht stören',
    dndUseLocation: 'Meinen Standort verwenden',
    dndEnterCity: 'Stadt eingeben',
    dndCityHint: 'Geben Sie Ihre Stadt ein, um ihre Ortszeit für die Nachtstunden zu verwenden.',
    dndCityPlaceholder: 'z.B. Berlin, München',
    scrollToBottom: 'Nach unten scrollen',
    notifModalTitle: 'Desktop-Benachrichtigungen',
    notifModalDesc: 'Möchten Sie Desktop-Benachrichtigungen dieser Chat-App auf diesem Gerät erhalten? Sie können dies später unter Einstellungen → Benachrichtigungen ändern.',
    notifModalAllow: 'Benachrichtigungen aktivieren',
    notifModalDecline: 'Nicht jetzt',
    adminSendToInbox: 'An Posteingang senden',
    adminSendToInboxDesc: 'Eine Nachricht an den Posteingang eines bestimmten Benutzers senden.',
    adminBroadcast: 'An alle senden',
    adminBroadcastDesc: 'Eine Nachricht an den Posteingang aller Benutzer senden.',
    adminTimeoutUser: 'Benutzer stummschalten',
    adminTimeoutDurationDesc: 'Einen Benutzer für eine bestimmte Zeit am Senden von Nachrichten im JimmyQrg-Gruppenchat hindern.',
    adminTimeoutUserDesc: 'Einen Benutzer am Senden von Nachrichten im JimmyQrg-Gruppenchat hindern.',
    adminSelectUser: 'Benutzer auswählen',
    adminTitle: 'Titel',
    adminBody: 'Inhalt',
    adminMessageBody: 'Nachrichtentext',
    adminDuration: 'Dauer',
    adminDurationPlaceholder: 'z.B. 5 Minuten, 1 Stunde, dauerhaft',
    adminOnlyICanRelease: 'Nur ich kann freigeben',
    adminNoPermissions: 'Sie haben keine Aktionsberechtigungen. Bitten Sie einen Administrator um E-Mail senden, Senden oder Stummschalten.',
    adminRecalledMessages: 'Widerrufene Nachrichten',
    adminRecalledDesc: 'Nachrichten, die von Benutzern im Gruppenchat widerrufen wurden.',
    adminUsersSection: 'Benutzer',
    adminUsersDesc: 'Fügen Sie hier Benutzer zur Admin-Liste hinzu. Nach dem Hinzufügen legen Sie fest, was sie dürfen (z.B. E-Mail senden, senden, Dokumente bearbeiten).',
    adminPermSendMail: 'E-Mail senden',
    adminPermBroadcast: 'Senden',
    adminPermEditDocs: 'Dokumente bearbeiten',
    adminPermRemoveAccount: 'Konto entfernen',
    adminPermDeleteMessages: 'Nachrichten löschen',
    adminPermManageUsers: 'Benutzer verwalten',
    adminPermTimeout: 'Stummschalten',
    adminRoleAdmin: 'Administrator',
    adminRoleDeleted: 'Gelöscht',
    adminRoleOnList: 'In Admin-Liste',
    adminRoleMember: 'Mitglied',
    adminRemoveFromList: 'Von Liste entfernen',
    adminAddToList: 'Zur Liste hinzufügen',
    adminRestore: 'Wiederherstellen',
    adminDeletePermanently: 'Dauerhaft löschen',
    adminRemoveAccount: 'Konto entfernen',
    adminBlacklist: 'Schwarze Liste',
    adminUnblacklist: 'Von schwarzer Liste entfernen',
    adminDeleteAccountTitle: 'Konto dauerhaft löschen',
    adminDeleteAccountDesc: 'Dies entfernt den Benutzer aus der Liste, aus privaten Chat-Listen und löscht alle seine Daten. Dies kann nicht rückgängig gemacht werden.',
    adminDeleteGroupMessages: 'Auch Nachrichten im Gruppenchat löschen',
    adminDeleteAdmin: 'Löschen (Admin)',
    adminRemoveAccountConfirm: 'Dieses Konto entfernen? Der Benutzer kann sich nicht mehr anmelden. Nachrichten bleiben. Sie können später wiederherstellen.',
    replyToMessage: 'Auf Nachricht antworten',
    recall: 'Widerrufen',
    edit: 'Bearbeiten',
    solve: 'Als gelöst markieren',
    getFileId: 'Datei-ID abrufen',
    copy: 'Kopieren',
    reply: 'Antworten',
    mentionDeletedUsers: 'Hinweis: Sie erwähnen Benutzer, deren Konten gelöscht wurden: ',
    adminNoRecalledMessages: 'Keine widerrufenen Nachrichten.',
    adminFailedToLoad: 'Laden fehlgeschlagen.',
    adminSent: 'Gesendet.',
    adminBroadcastSent: 'Rundsendung gesendet.',
    adminNoActiveTimeouts: 'Keine aktiven Stummschaltungen.',
    adminTimeoutUntil: 'bis ',
    adminTimeoutForever: 'dauerhaft',
    adminTimeoutLocked: '(gesperrt)',
    adminRelease: 'Freigeben',
  },
};

const GROUP_ID = 'JimmyQrg';

/** Current user avatar URL with cache-busting so updates show after profile save. */
function getCurrentUserAvatarUrl() {
  const u = state.user;
  if (!u) return getDefaultAvatarUrl(null);
  const base = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : getDefaultAvatarUrl(u.id);
  if (!base || !base.startsWith('/')) return base;
  return base + '?v=' + (u._avatarVersion || 0);
}

// URL panel param <-> internal panel
const PANEL_TO_URL = { free_chat: 'chat', support: 'support', problem_solving: 'problem', rules: 'rules', announcements: 'announcements', voice_chat: 'voice' };
const URL_TO_PANEL = { chat: 'free_chat', support: 'support', problem: 'problem_solving', rules: 'rules', announcements: 'announcements', voice: 'voice_chat' };

function roomKey(roomType, roomId) {
  return `${roomType}:${roomId}`;
}

function getDraftKey(roomType, roomId) {
  return roomId ? roomKey(roomType, roomId) : null;
}

function saveDraft(roomType, roomId, text) {
  const key = getDraftKey(roomType, roomId);
  if (!key || typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  state.drafts = state.drafts || {};
  if (!text) {
    delete state.drafts[key];
  } else {
    state.drafts[key] = text;
  }
  try {
    localStorage.setItem('chat_drafts_v1', JSON.stringify(state.drafts));
  } catch (_) {}
}

function getDraft(roomType, roomId) {
  const key = getDraftKey(roomType, roomId);
  if (!key) return '';
  return (state.drafts && state.drafts[key]) || '';
}

function clearDraft(roomType, roomId) {
  saveDraft(roomType, roomId, '');
}

async function jumpToMessageInCurrentChat(msgId, createdAt, roomType, roomId) {
  const key = roomKey(roomType, roomId);
  let list = state.messages[key] || [];
  let attempts = 0;
  while (!list.some((m) => m.id === msgId) && state._hasMoreMessages?.[key] && attempts < 50) {
    const oldest = list[0]?.created_at || createdAt || Date.now();
    await loadMessagesPage(roomType, roomId, { appendTop: true, before: oldest });
    list = state.messages[key] || [];
    attempts += 1;
  }
  state._chatSidePanelOpen = false;
  state._scrollToMessageId = msgId;
  render();
}

function currentRoomKey() {
  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  return roomId ? roomKey(roomType, roomId) : null;
}

/** Tell the service worker which room we're viewing so it suppresses pushes for it. */
function postActiveRoomToPush() {
  if (!('serviceWorker' in navigator)) return;
  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  navigator.serviceWorker.getRegistration('/sw.js').then((reg) => {
    if (reg?.active) {
      reg.active.postMessage({ type: 'jchat:active-room', roomType, roomId: roomId || null });
    }
  }).catch(() => {});
}

function getCurrentRoomContext() {
  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  return roomId ? { roomType, roomId } : null;
}

function getNewCount(roomType, roomId) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list || !list.length) return 0;
  const seen = state.lastSeenByRoom[key] || 0;
  return list.filter(m => (m.created_at || 0) > seen).length;
}

/** Group chat: show red dot only (no amount). */
function hasNewGroupMessages() {
  const panels = state.group?.panels || [];
  return panels.some(p => (p === 'free_chat' || p === 'support') && getNewCount('group', p) > 0);
}

/** Private chat: show total new count on Chat icon and per-user in list. */
function getTotalNewDmCount() {
  let total = 0;
  for (const key of Object.keys(state.messages || {})) {
    if (key.startsWith('dm:')) total += getNewCount('dm', key.slice(4));
  }
  return total;
}

function getUnreadInboxCount() {
  return (state.inbox || []).filter(i => !i.read_at).length;
}

function getPath() {
  return window.location.pathname.replace(/\/$/, '') || '/';
}

function interceptLinks(container) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const messageAvatarWrap = e.target.closest('.message-avatar-wrap');
    if (messageAvatarWrap) {
      const id = messageAvatarWrap.dataset.senderId;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        showProfileModal(id);
      }
      return;
    }
    const panelAvatarWrap = e.target.closest('.panel-user-avatar-wrap');
    if (panelAvatarWrap) {
      const id = panelAvatarWrap.dataset.userId;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        showProfileModal(id);
      }
      return;
    }
    const linkifyA = e.target.closest('a.linkify-link');
    if (linkifyA) {
      e.preventDefault();
      e.stopPropagation();
      const href = linkifyA.getAttribute('href');
      const comefrom = getPath();
      const u = `/redirect.html?url=${encodeURIComponent(href || '')}&comefrom=${encodeURIComponent(comefrom)}`;
      window.open(u, '_blank', 'noopener');
      return;
    }
    const a = e.target.closest('a[href^="/"]');
    if (!a || a.hasAttribute('target') || a.getAttribute('href').startsWith('/api')) return;
    e.preventDefault();
    navigateTo(a.getAttribute('href'));
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const messageAvatarWrap = e.target.closest('.message-avatar-wrap');
    if (messageAvatarWrap) {
      const id = messageAvatarWrap.dataset.senderId;
      if (id) {
        e.preventDefault();
        showProfileModal(id);
      }
      return;
    }
    const panelAvatarWrap = e.target.closest('.panel-user-avatar-wrap');
    if (panelAvatarWrap) {
      const id = panelAvatarWrap.dataset.userId;
      if (id) {
        e.preventDefault();
        showProfileModal(id);
      }
    }
  });
}

const LINK_PREVIEW_DELAY_MS = 500;
let linkPreviewTimer = null;
let linkPreviewEl = null;
let linkPreviewAbort = null;

function bindLinkPreview(container) {
  if (!container) return;
  container.addEventListener('mouseenter', (e) => {
    const a = e.target.closest('a[href^="http"]');
    if (!a || a.closest('.link-preview-popover')) return;
    const href = a.getAttribute('href')?.trim();
    if (!href) return;
    linkPreviewTimer = setTimeout(async () => {
      linkPreviewTimer = null;
      linkPreviewAbort = new AbortController();
      try {
        const data = await apiGet(`/api/link-preview?url=${encodeURIComponent(href)}`);
        if (!data.title && !data.description && !data.image) return;
        hideLinkPreview();
        const descLimit = 320;
        const desc = data.description ? escapeHtml(data.description.slice(0, descLimit)) + (data.description.length > descLimit ? '…' : '') : '';
        linkPreviewEl = document.createElement('div');
        linkPreviewEl.className = 'link-preview-popover';
        linkPreviewEl.innerHTML = `
          ${data.image ? `<img src="${escapeHtml(data.image)}" alt="" class="link-preview-img" />` : ''}
          <div class="link-preview-body">
            ${data.title ? `<div class="link-preview-title">${escapeHtml(data.title)}</div>` : ''}
            ${desc ? `<div class="link-preview-desc">${desc}</div>` : ''}
          </div>
        `;
        document.body.appendChild(linkPreviewEl);
        const rect = a.getBoundingClientRect();
        linkPreviewEl.style.left = `${rect.left}px`;
        linkPreviewEl.style.top = `${rect.top - 8}px`;
        linkPreviewEl.style.transform = 'translateY(-100%)';
        linkPreviewEl.addEventListener('mouseleave', () => hideLinkPreview());
      } catch (_) {}
    }, LINK_PREVIEW_DELAY_MS);
  }, true);
  container.addEventListener('mouseleave', (e) => {
    const a = e.target.closest('a[href^="http"]');
    if (a && !e.relatedTarget?.closest?.('.link-preview-popover')) {
      if (linkPreviewTimer) {
        clearTimeout(linkPreviewTimer);
        linkPreviewTimer = null;
      }
      hideLinkPreview();
    }
  }, true);
}

function hideLinkPreview() {
  if (linkPreviewEl) {
    linkPreviewEl.remove();
    linkPreviewEl = null;
  }
}

function parseRoute() {
  const pathname = window.location.pathname;
  const params = new URLSearchParams(window.location.search || '');
  const redirect = params.get('redirect') || null;

  // Normalize group chat: only /chat/group/ is valid (trailing slash required, no /chat/group/index etc.)
  if (pathname === '/chat/group' || (pathname.startsWith('/chat/group/') && pathname !== '/chat/group/')) {
    const search = window.location.search || '';
    if (window.location.pathname !== '/chat/group/' || window.location.search !== search) {
      window.history.replaceState({}, '', '/chat/group/' + search);
    }
  }

  const path = getPath();
  if (path === '/login') return { page: 'login', redirect };
  if (path === '/signup') return { page: 'signup', redirect };
  if (path === '/forgot-password') return { page: 'forgot-password', redirect };
  if (path === '/reset-password') return { page: 'reset-password', token: params.get('token') || '' };
  if (path === '/settings') return { page: 'settings', tab: params.get('tab') || 'profile' };
  if (path === '/inbox') return { page: 'inbox' };
  if (path === '/collections') return { page: 'collections' };
  if (path === '/manage' || path === '/manage/') return { page: 'admin', adminTab: params.get('tab') || 'action' };
  if (path === '/chat') return { page: 'chat', section: 'dms' }; // DM user list, no conversation selected
  const chatMatch = path.match(/^\/chat\/([^/]+)$/);
  if (chatMatch) {
    const id = chatMatch[1];
    if (id.toLowerCase() === 'group') {
      const panelParam = params.get('panel') || 'chat';
      const panel = URL_TO_PANEL[panelParam] || 'free_chat';
      return { page: 'chat', group: true, panel };
    }
    return { page: 'chat', dmUserId: id, view: params.get('view') || null };
  }
  return { page: 'chat', group: true, panel: 'free_chat' };
}

/** Primary nav for app shell: home (group), chat (DMs), inbox, admin, settings */
function getPrimaryNav(route) {
  if (route.page === 'admin') return 'admin';
  if (route.page === 'settings') return 'settings';
  if (route.page === 'inbox') return 'inbox';
  if (route.page === 'collections') return 'collections';
  if (route.page === 'chat') return route.group ? 'home' : 'chat';
  return 'home';
}

function getPage() {
  const route = parseRoute();
  return route.page;
}

/** Build auth path with optional redirect param. Use when navigating to login/signup. */
function authPath(page, redirectPath) {
  const base = page === 'signup' ? '/signup' : '/login';
  if (!redirectPath) return base;
  const enc = encodeURIComponent(redirectPath.startsWith('/') ? redirectPath : '/' + redirectPath);
  return `${base}?redirect=${enc}`;
}

/** Get redirect target from current URL, or default path. */
function getRedirectOrDefault(defaultPath = '/chat/group/') {
  const params = new URLSearchParams(window.location.search || '');
  const r = params.get('redirect');
  return (r && r.startsWith('/')) ? r : defaultPath;
}

/** True if we consider this a mobile context (Enter should add newline instead of send). */
function isMobile() {
  return typeof window !== 'undefined' && (('ontouchstart' in window) || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches));
}

function hasPendingUploadSelection() {
  return !!state._pendingFile;
}

function navigateTo(path) {
  if (hasPendingUploadSelection()) {
    const ok = window.confirm(t('leaveWithPendingFile') || 'You have a selected file that has not been sent yet. Leave anyway?');
    if (!ok) return;
  }
  const full = path.startsWith('http') ? path : (path.startsWith('/') ? path : '/' + path);
  if (full.startsWith('http') && new URL(full).origin !== window.location.origin) {
    window.location.href = full;
    return;
  }
  const pathname = full.startsWith('http') ? new URL(full).pathname : full.split('?')[0];
  const search = full.includes('?') ? full.slice(full.indexOf('?')) : '';
  if (window.location.pathname !== pathname || window.location.search !== search) {
    window.history.pushState({}, '', pathname + search);
  }
  applyRoute(parseRoute());
  postActiveRoomToPush();
}

export function getState() {
  return state;
}

export function setState(updates) {
  Object.assign(state, updates);
  render();
}

const LOAD_ME_TIMEOUT_MS = 12_000;

/** Load current user from session. 401 here is expected when not logged in (e.g. on login/signup page). */
export async function loadMe() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOAD_ME_TIMEOUT_MS);
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include', signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.status === 401) {
      state.user = null;
      return null;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    state.user = data.user;
    return data.user;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      console.warn('Auth check timed out; showing login.');
    }
    state.user = null;
    return null;
  }
}

/** Load public config (e.g. reCAPTCHA site key). Cached in state. */
export async function loadConfig() {
  if (state._configLoaded) return state.recaptchaSiteKey != null ? { recaptchaSiteKey: state.recaptchaSiteKey } : null;
  try {
    const data = await apiGet('/api/config');
    state.recaptchaSiteKey = data.recaptchaSiteKey || '';
    state._configLoaded = true;
    return data;
  } catch {
    state._configLoaded = true;
    state.recaptchaSiteKey = '';
    return { recaptchaSiteKey: '' };
  }
}

export async function loadUsers() {
  const { users } = await apiGet('/api/users');
  state.users = users;
  return users;
}

export async function loadGroup() {
  const g = await apiGet('/api/group');
  state.group = g;
  return g;
}

export async function loadMessages(roomType, roomId) {
  const key = roomKey(roomType, roomId);
  if (!state._messageRenderLimitByRoom) state._messageRenderLimitByRoom = {};
  state._messageRenderLimitByRoom[key] = MESSAGE_RENDER_WINDOW;
  loadPinnedMessage(roomType, roomId);
  return loadMessagesPage(roomType, roomId, { reset: true, key });
}

async function loadPinnedMessage(roomType, roomId) {
  try {
    const { pinned } = await apiGet(`/api/rooms/${roomType}/${roomId}/pinned`);
    const key = roomKey(roomType, roomId);
    if (pinned) state._pinnedMessage[key] = pinned;
    else delete state._pinnedMessage[key];
  } catch (_) {}
}

function clearPinnedIfMatches(msgId) {
  for (const key in state._pinnedMessage) {
    if (state._pinnedMessage[key]?.message_id === msgId) {
      delete state._pinnedMessage[key];
      render();
      return;
    }
  }
}

export async function loadMessagesPage(roomType, roomId, options = {}) {
  const key = roomKey(roomType, roomId);
  state._loadingMessages = state._loadingMessages || {};
  state._loadingOlderMessages = state._loadingOlderMessages || {};
  const isOlder = !!options.appendTop;
  if (isOlder) state._loadingOlderMessages[key] = true;
  else state._loadingMessages[key] = true;
  setState({});
  try {
  const basePath = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
  const params = new URLSearchParams();
  params.set('limit', '30');
  if (options.before) params.set('before', String(options.before));
  const path = `${basePath}?${params.toString()}`;
  const { messages, has_more } = await apiGet(path);
  const nextMessages = messages || [];
  if (isOlder) state.messages[key] = [...nextMessages, ...(state.messages[key] || [])];
  else state.messages[key] = nextMessages;
  state._hasMoreMessages = state._hasMoreMessages || {};
  state._hasMoreMessages[key] = !!has_more;
    state.blacklisted = false;
    const list = state.messages[key];
    if (currentRoomKey() === key && list.length) {
      const maxAt = Math.max(...list.map(m => m.created_at || 0));
      state.lastSeenByRoom[key] = Math.max(state.lastSeenByRoom[key] || 0, maxAt);
    }
    return list;
  } catch (err) {
    if (roomType === 'group' && err?.status === 403 && /blacklist/i.test(err?.message || '')) {
      state.blacklisted = true;
      state.messages[key] = [];
    }
    throw err;
  } finally {
    if (isOlder) state._loadingOlderMessages[key] = false;
    else state._loadingMessages[key] = false;
  }
}

export async function loadDoc(docKey) {
  return apiGet(`/api/docs/${docKey}`);
}

export async function saveDoc(docKey, content, supportMessageId) {
  return apiPut(`/api/docs/${docKey}`, { content, support_message_id: supportMessageId });
}

export async function loadInbox() {
  const { items } = await apiGet('/api/inbox');
  state.inbox = items || [];
  return state.inbox;
}

export async function loadCollections() {
  const { items } = await apiGet('/api/collections');
  state.collections = items || [];
  return state.collections;
}

/** Load conversation list so DM list order (last chat time > new count > alpha) and per-user badges work. */
export async function loadConversations() {
  const { conversations } = await apiGet('/api/conversations').catch(() => ({ conversations: [] }));
  state.lastMessageAtByUserId = {};
  (conversations || []).forEach((c) => {
    state.convByUserId[c.other_user_id] = c.conversation_id;
    state.convIdToUserId[c.conversation_id] = c.other_user_id;
    if (c.last_message_at != null) state.lastMessageAtByUserId[c.other_user_id] = c.last_message_at;
  });
  return conversations || [];
}

export async function loadFriends() {
  try {
    const { friend_ids } = await apiGet('/api/friends');
    state.friend_ids = friend_ids || [];
    // Keep outgoing friend-request status in sync with friend list refreshes.
    await loadPendingFriendRequests();
    return state.friend_ids;
  } catch {
    state.friend_ids = [];
    state.pending_friend_ids = [];
    return [];
  }
}

export async function loadPendingFriendRequests() {
  try {
    const { to_user_ids } = await apiGet('/api/friends/pending');
    state.pending_friend_ids = to_user_ids || [];
    return state.pending_friend_ids;
  } catch {
    state.pending_friend_ids = [];
    return [];
  }
}

export async function loadReportCounts() {
  if (!state.user?.is_allowed) return null;
  try {
    const counts = await apiGet('/api/reports/counts');
    state._reportCounts = counts || { total: 0, open: 0, in_review: 0 };
    return counts;
  } catch {
    state._reportCounts = { total: 0, open: 0, in_review: 0 };
    return null;
  }
}

/** Load any active timeouts for the current user so the UI can show hints. */
export async function loadMyTimeouts() {
  try {
    const { timeouts } = await apiGet('/api/my/timeouts');
    state._myTimeouts = timeouts || [];
  } catch {
    state._myTimeouts = [];
  }
}

export function hasDmTimeout() {
  return !!(state._myTimeouts || []).find((t) => t.scope === 'dm');
}

export function hasGroupTimeout() {
  return !!(state._myTimeouts || []).find((t) => t.scope === 'group' || !t.scope);
}

export function getActiveDmTimeout() {
  return (state._myTimeouts || []).find((t) => t.scope === 'dm') || null;
}

/* Cancel an in-flight or about-to-start file upload if the current user is
 * timed out from the relevant scope. Returns `true` if the upload was
 * blocked (caller should bail out), `false` if it's safe to proceed.
 *
 * - `roomType` is 'group' or 'dm'.
 * - `dmUserId` is required when roomType === 'dm' so we can keep the
 *   jimmyqrg exception (DM-timed-out users are still allowed to message
 *   jimmyqrg, mirroring the server's blockedByDmTimeout()).
 * - `clearPending` defaults to true: if there's a staged _pendingFile, drop
 *   it so the composer pill goes away immediately and the admin doesn't get
 *   re-spammed if the user keeps clicking Send.
 */
export function maybeBlockTimeoutUpload({ roomType, dmUserId, clearPending = true } = {}) {
  let blocked = false;
  let toast = '';
  if (roomType === 'group' && hasGroupTimeout()) {
    blocked = true;
    toast = tx('groupTimeoutUploadBlocked', "You're timed out from group chat — file upload cancelled.");
  } else if (roomType === 'dm' && dmUserId && dmUserId !== 'jimmyqrg' && hasDmTimeout()) {
    blocked = true;
    toast = tx('dmTimeoutUploadBlocked', "You're timed out from private chat — file upload cancelled. You can still message jimmyqrg.");
  }
  if (!blocked) return false;
  showToast(toast);
  if (clearPending && state._pendingFile) {
    state._pendingFile = null;
    try { render(); } catch (_) {}
  }
  return true;
}

export async function loadModerationQueue(status = state._modReports?.status || 'open', search = state._modReports?.search || '') {
  if (!state.user?.is_allowed) return [];
  if (!state._modReports) state._modReports = { items: [], status, search, loading: false, selected: null, notes: [] };
  state._modReports.status = status;
  state._modReports.search = search;
  state._modReports.loading = true;
  render();
  try {
    const params = new URLSearchParams({ status, q: search });
    const data = await apiGet(`/api/reports?${params.toString()}`);
    state._modReports.items = data?.reports || [];
  } catch (err) {
    showToast(err.message || 'Failed to load reports');
    state._modReports.items = [];
  } finally {
    state._modReports.loading = false;
    render();
  }
  return state._modReports.items;
}

export async function loadModerationReportDetail(reportId) {
  if (!state.user?.is_allowed) return null;
  try {
    const data = await apiGet(`/api/reports/${reportId}`);
    state._modReports = state._modReports || { items: [], status: 'open', search: '', loading: false, selected: null, notes: [] };
    state._modReports.selected = data?.report || null;
    state._modReports.notes = data?.notes || [];
    render();
    return data;
  } catch (err) {
    showToast(err.message || 'Failed to load report');
    return null;
  }
}

export async function loadBackups() {
  if (state.user?.id !== 'jimmyqrg') {
    state._backups = [];
    return [];
  }
  try {
    const data = await apiGet('/api/admin/backup');
    state._backups = data?.backups || [];
    return state._backups;
  } catch {
    state._backups = [];
    return [];
  }
}

export async function loadBlocks() {
  try {
    const { blocked_ids } = await apiGet('/api/blocks');
    state.blocked_ids = blocked_ids || [];
    return state.blocked_ids;
  } catch {
    state.blocked_ids = [];
    return [];
  }
}

export async function loadNotificationPrefs() {
  try {
    const prefs = await apiGet('/api/notifications/prefs');
    state.notificationPrefs = prefs;
    return prefs;
  } catch {
    state.notificationPrefs = null;
    return null;
  }
}

// ── Web Push (service worker) ────────────────────────────────────────────
// The old notification system was browser-tab-only: it fired only while a
// chat tab sat open in the background. Web Push keeps working when the tab
// is closed or the phone is locked. state.pushActive = subscription is live
// (server will push); in-page desktop notifications are suppressed then so
// we don't double-notify.

async function registerPushServiceWorker() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return !!reg.active;
  } catch (_) {
    return false;
  }
}

async function syncPushSubscription() {
  try {
    const canPush = 'serviceWorker' in navigator && 'PushManager' in window &&
      'Notification' in window && Notification.permission === 'granted';
    const wantPush = canPush && state.notificationPrefs?.enabled;
    const reg = wantPush ? await registerPushServiceWorker() : null;

    if (!wantPush || !reg) {
      // Disabled or unsupported: drop any existing subscription.
      try {
        const existing = await navigator.serviceWorker?.getRegistration('/sw.js');
        const sub = existing ? await existing.pushManager.getSubscription() : null;
        if (sub) {
          await apiPost('/api/notifications/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
          await sub.unsubscribe();
        }
      } catch (_) {}
      state.pushActive = false;
      return;
    }

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await apiGet('/api/notifications/vapid-public-key');
      if (!key) {
        state.pushActive = false;
        return;
      }
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await apiPost('/api/notifications/subscribe', JSON.parse(JSON.stringify(sub)));
    state.pushActive = true;
  } catch (err) {
    console.error('[push] sync failed:', err);
    state.pushActive = false;
  }
}

/** Convert a base64url VAPID key (string) to a Uint8Array for subscribe(). */
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function bindPushLifecycle() {
  if (!('serviceWorker' in navigator)) return;
  // Re-sync on subscription changes (e.g. browser rotates keys).
  navigator.serviceWorker.addEventListener('controllerchange', () => syncPushSubscription());
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg?.type === 'jchat:push-click' && msg.url) {
      navigateTo(msg.url);
    }
  });
  // If the browser swaps keys while we're away, re-register.
  if ('pushManager' in window) {
    navigator.serviceWorker.getRegistration('/sw.js').then((reg) => {
      reg?.pushManager?.getSubscription().then((sub) => {
        if (sub) syncPushSubscription();
      }).catch(() => {});
    }).catch(() => {});
  }
}

function showNotificationPermissionModal() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const asked = localStorage.getItem('notification_asked');
  if (asked === '1') return;
  if (state.notificationPrefs?.enabled) return;
  const existing = document.getElementById('notif-permission-modal');
  if (existing) return;
  const overlay = document.createElement('div');
  overlay.id = 'notif-permission-modal';
  overlay.className = 'notif-permission-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'notif-permission-title');
  overlay.innerHTML = `
    <div class="notif-permission-modal">
      <h2 id="notif-permission-title" class="notif-permission-title">${t('notifModalTitle')}</h2>
      <p class="notif-permission-desc">${t('notifModalDesc')}</p>
      <div class="notif-permission-actions">
        <button type="button" class="btn-primary notif-permission-allow" id="notif-permission-allow"><span class="icon" aria-hidden="true">${ICON_BELL_SM}</span>${t('notifModalAllow')}</button>
        <button type="button" class="btn-secondary notif-permission-decline" id="notif-permission-decline"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${t('notifModalDecline')}</button>
      </div>
    </div>
  `;
  overlay.querySelector('#notif-permission-allow').addEventListener('click', () => {
    localStorage.setItem('notification_asked', '1');
    overlay.remove();
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') {
        apiPatch('/api/notifications/prefs', { enabled: true }).then(() => {
          state.notificationPrefs = { ...(state.notificationPrefs || {}), enabled: true };
          syncPushSubscription().catch(() => {});
        }).catch(() => {});
      }
    });
  });
  overlay.querySelector('#notif-permission-decline').addEventListener('click', () => {
    localStorage.setItem('notification_asked', '1');
    overlay.remove();
  });
  document.body.appendChild(overlay);
}

function maybeAskNotificationPermission() {
  showNotificationPermissionModal();
}

function shouldShowNotifPermissionModal() {
  return ('Notification' in window) && Notification.permission === 'default' &&
    localStorage.getItem('notification_asked') !== '1' && !state.notificationPrefs?.enabled;
}

function ensureNotificationPermissionModalVisible() {
  if (!shouldShowNotifPermissionModal()) return;
  const existing = document.getElementById('notif-permission-modal');
  if (existing) {
    const style = getComputedStyle(existing);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.01) {
      existing.remove();
      showNotificationPermissionModal();
    }
    return;
  }
  showNotificationPermissionModal();
}

const DND_TZ_KEY = 'dnd_timezone';

function getDndTimezone() {
  try {
    const tz = localStorage.getItem(DND_TZ_KEY);
    return tz && tz.length < 64 ? tz : null;
  } catch (_) { return null; }
}

function setDndTimezone(tz) {
  try {
    if (tz) localStorage.setItem(DND_TZ_KEY, tz);
    else localStorage.removeItem(DND_TZ_KEY);
  } catch (_) {}
}

function isNightTime() {
  try {
    const tz = getDndTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
    return hour >= 22 || hour < 7;
  } catch (_) {
    const hour = new Date().getHours();
    return hour >= 22 || hour < 7;
  }
}

/** Try geolocation -> /api/timezone, save to localStorage. Returns Promise<boolean>. */
async function resolveDndTimezoneFromLocation() {
  if (!navigator.geolocation) return false;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { lat, lng } = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          const data = await apiGet(`/api/timezone?lat=${lat}&lng=${lng}`);
          if (data?.timezone) {
            setDndTimezone(data.timezone);
            resolve(true);
          } else resolve(false);
        } catch (_) { resolve(false); }
      },
      () => resolve(false),
      { timeout: 10000, maximumAge: 86400000 }
    );
  });
}

/** Geocode city -> timezone, save. Returns Promise<boolean>. */
async function resolveDndTimezoneFromCity(city) {
  const q = (city || '').trim().slice(0, 100);
  if (!q) return false;
  try {
    const geo = await apiGet(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (geo?.lat == null || geo?.lon == null) return false;
    const tzData = await apiGet(`/api/timezone?lat=${geo.lat}&lng=${geo.lon}`);
    if (tzData?.timezone) {
      setDndTimezone(tzData.timezone);
      return true;
    }
  } catch (_) {}
  return false;
}

function shouldShowNotification(trigger, fromUserId) {
  const prefs = state.notificationPrefs;
  if (!prefs?.enabled) return false;
  if (document.hasFocus?.() && document.visibilityState === 'visible') return false;
  const now = Date.now();
  if (prefs.dnd_until && now < prefs.dnd_until) return false;
  if (prefs.dnd_at_night && isNightTime()) return false;
  if (trigger === 'mail' && !prefs.notify_mails) return false;
  if (trigger === 'dm' && !prefs.notify_dm) return false;
  if (trigger === 'group' && !prefs.notify_group) return false;
  if (trigger === 'dm' && fromUserId) {
    if (prefs.dm_allow_list?.length && !prefs.dm_allow_list.includes(fromUserId)) return false;
    if (prefs.dm_block_list?.length && prefs.dm_block_list.includes(fromUserId)) return false;
  }
  return true;
}

function showDesktopNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (state.pushActive) return; // service worker push handles it (tab closed/background)
  try {
    new Notification(title || 'JimmyQrg Chat', { body: body || '', icon: '/assets/favicon.ico' });
  } catch (_) {}
}

function isBlocked(userId) {
  return state.blocked_ids && state.blocked_ids.includes(userId);
}

function isUserDeleted(userId) {
  const u = (state.users || []).find(x => x.id === userId);
  return u && u.deleted_at != null;
}

/** Returns usernames of deleted users mentioned in content (excluding @All). */
function getMentionedDeletedUsers(content) {
  if (!content || typeof content !== 'string') return [];
  const mentioned = [...(content.matchAll(/\@([a-z0-9]+)/gi) || [])].map(m => m[1].toLowerCase());
  const deleted = [];
  for (const u of (state.users || [])) {
    if (u.deleted_at != null && mentioned.includes((u.username || '').toLowerCase())) deleted.push(u.display_name || u.username || u.id);
  }
  return deleted;
}

function isFriend(userId) {
  // JimmyQrg is auto-friend to everyone (server side: AUTO_FRIEND_IDS). Symmetrically,
  // jimmyqrg himself gets all friend features by default — file attach, voice-record
  // button, no 10-message cap — regardless of whether the other user has friended him.
  if (userId === 'jimmyqrg' || state.user?.id === 'jimmyqrg') return true;
  return state.friend_ids && state.friend_ids.includes(userId);
}

function isFriendRequestPending(userId) {
  return !!(userId && state.pending_friend_ids && state.pending_friend_ids.includes(userId));
}

/**
 * Resilient text-message send:
 *  - Prefers the Socket.IO path (lower latency, triggers room broadcast).
 *  - Falls back to HTTP if the socket is disconnected, the connection has
 *    given up reconnecting, or the ack never comes back within `ackTimeoutMs`.
 *  - Resolves with `{ message }` on success or `{ error }` on server rejection.
 *  - Rejects only on transport / network failures.
 */
async function sendMessageResilient({ roomType, roomId, text, reply_to_id, ackTimeoutMs = 12000, agent_model, agent_effort }) {
  const socket = state.socket;
  const socketReady = socket && socket.connected;
  // AI moderation can take a couple of seconds, especially on cold starts or
  // when the deepseek proxy is slow. Use a generous ack timeout so we don't
  // fall through to HTTP and double-bill the user with two LLM round-trips.
  if (socketReady) {
    try {
      const res = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ackTimeoutMs);
        const payload = { roomType, roomId, content: text, reply_to_id };
        if (agent_model) payload.agent_model = agent_model;
        if (agent_effort) payload.agent_effort = agent_effort;
        socket.emit('message:send', payload, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
      });
      // Don't fall through to HTTP when the message was *decisively rejected*
      // — re-running the moderator would bill the user a second time and
      // could even produce a different verdict.
      if (res && res.error) return res;
      return res || {};
    } catch (_) {
      // socket transport problem → fall through to HTTP
    }
  }
  const httpPath = roomType === 'dm'
    ? `/api/conversations/${roomId}/messages`
    : `/api/rooms/${roomType}/${roomId}/messages`;
  const body = { content: text };
  if (reply_to_id) body.reply_to_id = reply_to_id;
  if (agent_model) body.agent_model = agent_model;
  if (agent_effort) body.agent_effort = agent_effort;
  try {
    const data = await apiPost(httpPath, body);
    return data && data.message ? { message: data.message } : (data || {});
  } catch (err) {
    const code = err?.code || '';
    if (code === 'AI_MOD_BLOCK') {
      return { error: 'AI_MOD_BLOCK', reason: err?.reason || '', category: err?.data?.category || 'other' };
    }
    const raw = err && err.message ? String(err.message) : '';
    if (/spam/i.test(raw)) return { error: 'NO SPAMMING!' };
    return { error: raw || 'Network error' };
  }
}

export function addMessageLocal(msg) {
  if (isBlocked(msg.sender_id)) return;
  const key = roomKey(msg.room_type, msg.room_id);
  if (!state.messages[key]) state.messages[key] = [];
  if (state.messages[key].some(m => m.id === msg.id)) return;
  state.messages[key].push(msg);
  if (currentRoomKey() === key) {
    state.lastSeenByRoom[key] = Math.max(state.lastSeenByRoom[key] || 0, msg.created_at || 0);
  }
  render();
}

export function updateMessageLocal(id, roomType, roomId, patch) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list) return;
  const i = list.findIndex(m => m.id === id);
  if (i === -1) return;
  list[i] = { ...list[i], ...patch };
  render();
}

export function removeMessageContent(id, roomType, roomId) {
  updateMessageLocal(id, roomType, roomId, { content: null, recalled_at: Date.now(), msg_type: 'recalled' });
}

export function deleteMessageLocal(id, roomType, roomId) {
  updateMessageLocal(id, roomType, roomId, { deleted_by_admin: 1, content: null, msg_type: 'deleted' });
}

/** Remove a message from the list entirely (admin delete – no trace). */
export function removeMessageLocal(id, roomType, roomId) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list) return;
  const i = list.findIndex(m => m.id === id);
  if (i === -1) return;
  list.splice(i, 1);
  render();
}

/** Find a message by id in state.messages (group messages live under group:free_chat / group:support, not group:JimmyQrg). */
function findMessageInState(msgId) {
  if (!msgId) return null;
  for (const key of Object.keys(state.messages || {})) {
    const m = state.messages[key].find(x => x.id === msgId);
    if (m) return m;
  }
  return null;
}

/**
 * After a socket reconnect, pull anything we might have missed while disconnected.
 * The server can't replay missed broadcast events to us, so we re-fetch:
 *  - messages for the room currently on screen
 *  - inbox (for DM/mention/admin notifications)
 *  - user list (presence + new/removed accounts)
 *  - pinned message for the current room
 *  - moderation report counts (admins only)
 *  - our active timeouts (in case an admin timed us out while offline)
 * We run these in parallel and swallow individual failures so one failing
 * request doesn't block the rest.
 */
async function syncAfterReconnect() {
  try {
    const roomType = state.dmUserId ? 'dm' : 'group';
    const roomId = state.dmUserId ? state.convId : state.panel;
    const tasks = [];
    if (roomType && roomId) {
      tasks.push(loadMessages(roomType, roomId).catch(() => {}));
    }
    tasks.push(loadInbox().catch(() => {}));
    tasks.push(loadUsers().catch(() => {}));
    tasks.push(loadMyTimeouts().catch(() => {}));
    if (state.user?.is_allowed) {
      tasks.push(loadReportCounts().catch(() => {}));
    }
    await Promise.all(tasks);
    render();
  } catch (_) {
    // best-effort sync; ignore errors so the UI doesn't flash
  }
}

let _connectSocketScheduled = null;
function connectSocket() {
  if (_connectSocketScheduled) return;
  _connectSocketScheduled = true;
  const io = window.io;
  if (!io) {
    _connectSocketScheduled = false;
    return;
  }
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
  }
  const s = io({
    withCredentials: true,
    transports: ['polling', 'websocket'],
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 20000,
  });
  let hadConnection = false;
  let wasDisconnected = false;
  s.on('connect', () => {
    _connectSocketScheduled = false;
    if (state.dmUserId && state.convId) s.emit('dm:join', state.convId, () => {});
    if (hadConnection && wasDisconnected) {
      wasDisconnected = false;
      syncAfterReconnect();
    }
    hadConnection = true;
  });
  s.on('connect_error', (err) => {
    _connectSocketScheduled = false;
    if (err?.message === 'Not authenticated' || err?.message?.includes('auth')) {
      state.user = null;
      state.socket = null;
      state.authError = 'Session expired. Please log in again.';
      navigateTo('/login');
    }
  });
  s.on('disconnect', () => {
    _connectSocketScheduled = false;
    wasDisconnected = true;
  });
  s.on('message', (msg) => {
    if (msg.room_type === 'group' && msg.room_id === 'voice_chat') {
      if (state._voiceJoined) {
        state._voiceChatMessages.push(msg);
        render();
        requestAnimationFrame(() => {
          const wrap = document.getElementById('voice-chat-messages');
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        });
      }
      return;
    }
    addMessageLocal(msg);
    const trigger = msg.room_type === 'dm' ? 'dm' : 'group';
    if (shouldShowNotification(trigger, msg.sender_id)) {
      const from = msg.display_name || msg.username || 'Someone';
      const preview = (msg.content || '').slice(0, 80);
      showDesktopNotification(`${from}: ${trigger === 'dm' ? 'Private message' : 'Group'}`, preview || '(attachment)');
    }
  });
  s.on('message:recalled', ({ id }) => {
    const m = findMessageInState(id);
    if (m) removeMessageContent(id, m.room_type, m.room_id);
    clearPinnedIfMatches(id);
  });
  s.on('message:edited', ({ id, content, edit_history, updated_at }) => {
    const m = findMessageInState(id);
    if (m) updateMessageLocal(id, m.room_type, m.room_id, { content, edit_history, updated_at });
  });
  s.on('message:liked', ({ id, likes }) => {
    const m = findMessageInState(id);
    if (m) {
      updateMessageLocal(id, m.room_type, m.room_id, { likes });
      if (m.sender_id === state.user?.id && shouldShowNotification('group', null)) {
        showDesktopNotification('JimmyQrg Chat', 'Someone liked your message');
      }
    }
  });
  s.on('message:reactions', ({ id, reactions }) => {
    const m = findMessageInState(id);
    if (m) updateMessageLocal(id, m.room_type, m.room_id, { reactions: reactions || [] });
  });
  s.on('message:deleted', ({ id }) => {
    const m = findMessageInState(id);
    if (m) removeMessageLocal(id, m.room_type, m.room_id);
    clearPinnedIfMatches(id);
  });
  s.on('account_removed', () => {
    showToast('Your account has been removed.');
    window.location.reload();
  });
  s.on('force_logout', () => {
    // Server asked us to hard-kill this session (admin removed the account or
    // similar). Clear any cached auth and reload so the user lands on login.
    try { localStorage.removeItem('auth_token'); } catch (_) {}
    try { document.cookie = 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT'; } catch (_) {}
    window.location.reload();
  });
  s.on('blacklist:changed', ({ blacklisted } = {}) => {
    // If you just got blacklisted, reload so the UI drops you out of the
    // group and the banner renders. Same on removal so you regain access.
    showToast(blacklisted
      ? tx('blacklistedNotice', 'You have been blacklisted from group chat.')
      : tx('blacklistClearedNotice', 'Your blacklist has been lifted.'));
    setTimeout(() => window.location.reload(), 300);
  });
  s.on('permissions:changed', () => {
    // Re-pull the user profile so new timeout/permission state is picked up
    // without a full reload. Used for timeouts and perm-grant/revoke.
    loadMe().then(() => { render(); loadAgentMode(); loadAgentSessions(); }).catch(() => {});
    try { loadMyTimeouts?.().then(() => render()); } catch (_) {}
  });
  s.on('message:pinned', ({ room_type, room_id, pinned }) => {
    if (pinned) {
      state._pinnedMessage[roomKey(room_type, room_id)] = pinned;
      render();
    }
  });
  s.on('message:unpinned', ({ room_type, room_id }) => {
    delete state._pinnedMessage[roomKey(room_type, room_id)];
    render();
  });
  s.on('inbox:item', (item) => {
    if (shouldShowNotification('mail', null)) {
      showDesktopNotification(item?.title || 'New mail', item?.body || '');
    }
    loadInbox().then(render);
  });
  s.on('announcements:updated', ({ newItems }) => {
    const summary = newItems?.length ? newItems.join(', ') : 'New content available';
    showToast(`📢 ${tx('announcementsUpdated', 'Announcements updated')}: ${summary}`, 'info');
    if (state.panel === 'announcements') {
      loadDoc('announcements').then(({ doc }) => {
        state._docContent = doc?.content ?? '';
        render();
      }).catch(() => {});
    }
  });
  s.on('presence:snapshot', (snapshot) => {
    const map = {};
    for (const entry of snapshot || []) {
      map[entry.user_id] = { state: entry.state, last_seen_at: entry.last_seen_at };
    }
    state._presence = map;
    render();
  });
  s.on('presence:update', ({ user_id, state: pState, last_seen_at }) => {
    if (!state._presence) state._presence = {};
    const prev = state._presence[user_id];
    if (prev && prev.state === pState && prev.last_seen_at === last_seen_at) return;
    state._presence[user_id] = { state: pState, last_seen_at };
    if (user_id === state.user?.id) return;
    schedulePresenceTypingRender();
  });
  s.on('typing:update', ({ room, user_ids }) => {
    if (!state._typing) state._typing = {};
    const next = (user_ids || []).filter((id) => id !== state.user?.id);
    const prev = state._typing[room] || [];
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) return;
    state._typing[room] = next;
    schedulePresenceTypingRender();
  });
  s.on('reports:counts', (counts) => {
    state._reportCounts = counts || { total: 0, open: 0, in_review: 0 };
    render();
  });
  s.on('timeouts:changed', async () => {
    await loadMyTimeouts();
    render();
  });
  // ── Venory helper: live busy + agent status events ──
  s.on('helper:busy', ({ status, taskId, roomType, roomId, sessionKey }) => {
    const key = roomType && roomId ? roomKey(roomType, roomId) : null;
    // The event's roomId is the helper DM's conv, so the DM's gateway key is
    // derivable even when the owner is currently viewing another room.
    const evDmKey = (roomType === 'dm' && roomId) ? `agent:main:openai-user:jchat:dm:${roomId}` : '';
    const sk = (typeof sessionKey === 'string' && sessionKey) ? sessionKey : evDmKey;
    // Only runs belonging to THIS DM's own session may drive the DM's UI;
    // routed runs (other sessions) update only their own session slot.
    const isThisDmRun = !sessionKey || sk === evDmKey;
    const run = (key && isThisDmRun) ? (state.helperRuns[key] || { busy: false, working: false, done: false, tools: [] }) : null;
    const srun = sk ? (state.sessionRuns[sk] || { busy: false, working: false, done: false, tools: [] }) : null;
    if (status === 'start') {
      if (run) { run.busy = true; run.working = true; run.done = false; run.tools = []; state.helperRuns[key] = run; }
      if (srun) { srun.busy = true; srun.working = true; srun.done = false; srun.tools = []; state.sessionRuns[sk] = srun; }
    } else {
      if (run) { run.busy = false; state.helperRuns[key] = run; }
      if (srun) { srun.busy = false; srun.working = false; state.sessionRuns[sk] = srun; }
    }
    if (key) updateHelperUiInPlace(key);
    else updateHelperUiInPlace();
  });
  s.on('helper:status', ({ taskId, kind, status, name, title, meta, id, roomType, roomId, sessionKey }) => {
    const key = roomType && roomId ? roomKey(roomType, roomId) : helperDmKey();
    if (!key) return;
    const evDmKey = (roomType === 'dm' && roomId) ? `agent:main:openai-user:jchat:dm:${roomId}` : '';
    const sk = (typeof sessionKey === 'string' && sessionKey) ? sessionKey : evDmKey;
    const isThisDmRun = !sessionKey || sk === evDmKey;
    const applyEvent = (run) => {
      if (kind === 'lifecycle') {
        if (status === 'working') { run.working = true; run.done = false; }
        else if (status === 'done') { run.working = false; run.done = true; }
      } else if (kind === 'tool') {
        const i = run.tools.findIndex((t) => id && t.id === id);
        if (status === 'running') {
          const tool = { id, name, title, status: 'running', meta };
          if (i >= 0) run.tools[i] = tool;
          else run.tools.push(tool);
        } else if (i >= 0) {
          run.tools[i] = { ...run.tools[i], status: status || 'completed' };
        }
      }
    };
    if (isThisDmRun) {
      const run = state.helperRuns[key];
      if (run) { applyEvent(run); state.helperRuns[key] = run; }
    }
    // Mirror into the per-session run so the VIEWED session's bar shows its own tools.
    if (sk) {
      const srun = state.sessionRuns[sk];
      if (srun) { applyEvent(srun); state.sessionRuns[sk] = srun; }
    }
    updateHelperUiInPlace(key);
  });
  // ask_user question records from the bridge (gateway). Rendered as a
  // tappable panel in the owner's helper DM; answers go back via
  // helper:answer → bridge → gateway question.resolve.
  s.on('helper:question', (p) => {
    if (!isOwner() || !p?.recordId || !Array.isArray(p?.questions)) return;
    state.helperQuestions[p.recordId] = p;
    updateHelperQuestionPanel();
  });
  // Full pending set (after reload / socket reconnect).
  s.on('helper:question:list', (p) => {
    if (!isOwner()) return;
    state.helperQuestions = {};
    for (const q of (Array.isArray(p?.questions) ? p.questions : [])) {
      if (q?.recordId) state.helperQuestions[q.recordId] = q;
    }
    updateHelperQuestionPanel();
  });
  s.on('helper:question:resolved', (p) => {
    if (!p?.recordId) return;
    delete state.helperQuestions[p.recordId];
    for (const k of Object.keys(state.helperQuestionSelections)) {
      if (k.startsWith(`${p.recordId}:`)) delete state.helperQuestionSelections[k];
    }
    for (const k of Object.keys(state.helperQuestionSending)) {
      if (k.startsWith(`${p.recordId}:`)) delete state.helperQuestionSending[k];
    }
    for (const k of Object.keys(state.helperQuestionErrors)) {
      if (k.startsWith(`${p.recordId}:`)) delete state.helperQuestionErrors[k];
    }
    updateHelperQuestionPanel();
  });
  s.on('helper:question:resolve-failed', (p) => {
    if (!p?.recordId) return;
    // Dead record: the bridge also sends resolved for these, but drop the
    // stale card immediately so the error never lingers on screen.
    if (/not found|cancelled|expired/i.test(String(p?.error || ''))) {
      delete state.helperQuestions[p.recordId];
    }
    const key = p.questionId ? `${p.recordId}:${p.questionId}` : '';
    if (key) {
      state.helperQuestionSending[key] = false;
      state.helperQuestionErrors[key] = typeof p?.error === 'string' ? p.error : 'resolve failed';
    }
    updateHelperQuestionPanel();
  });
  // Compact result for the control-bar Compact button.
  s.on('helper:compact:result', (p) => {
    state.helperCompacting = false;
    updateHelperUiInPlace();
    if (p?.ok) {
      showToast(p.message || 'Session compacted', 'success');
    } else {
      showToast(p?.error || 'Compact failed', 'error');
    }
  });
  // OpenClaw session picker: the bridge pushes a fresh list whenever the
  // gateway session index changes, so the owner's picker stays live without
  // a request round-trip.
  s.on('agent:sessions:update', ({ sessions } = {}) => {
    if (!isOwner()) return;
    if (Array.isArray(sessions)) {
      state.agentSessions = sessions;
      updateHelperUiInPlace();
      const view = state.agentSessionView;
      if (view?.key) {
        const fresh = sessions.find((x) => x.key === view.key);
        if (fresh?.label && fresh.label !== view.label) {
          state.agentSessionView.label = fresh.label;
          render();
        }
        // updatedAt moved → something changed in the viewed session; the live
        // stream covers immediacy, this schedules a catch-up refetch so the
        // page always ends up at the most current state.
        const freshUpdatedAt = typeof fresh?.updatedAt === 'number' ? fresh.updatedAt : 0;
        if (freshUpdatedAt > (view.updatedAt || 0)) {
          state.agentSessionView._pendingUpdatedAt = Math.max(freshUpdatedAt, view._pendingUpdatedAt || 0);
          scheduleAgentHistoryRefresh();
        }
      }
    } else {
      loadAgentSessions();
    }
  });
  // Live transcript feed for the session view (bridge → server → owner).
  s.on('agent:session:live', ({ sessionKey, role, text, fileRef, msgType } = {}) => {
    if (!isOwner() || !isHelperDm()) return;
    if (!state.agentSessionView || state.agentSessionView.key !== sessionKey) return;
    if (role !== 'user' && role !== 'assistant') return;
    const cleanRef = (typeof fileRef === 'string' && fileRef.trim().startsWith('/file ')) ? fileRef.trim() : '';
    const clean = String(text || '').trim();
    if (!cleanRef && !clean) return;
    appendAgentSessionLive({ role, text: clean, fileRef: cleanRef, msgType });
  });
  state.socket = s;
  voiceSetupSignalListeners();
  dmVoiceSetupSignalListeners();
  // Restore any pending incoming DM voice ring from a page reload / socket reconnect.
  apiGet('/api/dm-voice/state').then(({ ringing_from, in_call, conv }) => {
    if (ringing_from) {
      state._dmVoiceRinging = {
        fromUserId: ringing_from.userId,
        fromUsername: ringing_from.username,
        fromDisplayName: ringing_from.display_name,
        fromAvatarUrl: ringing_from.avatar_url,
        convId: ringing_from.convId,
      };
      render();
    }
  }).catch(() => {});
  startPresenceHeartbeat();
}

let _presenceHeartbeatTimer = null;
function startPresenceHeartbeat() {
  if (_presenceHeartbeatTimer) clearInterval(_presenceHeartbeatTimer);
  _presenceHeartbeatTimer = setInterval(() => {
    if (!state.socket?.connected) return;
    const isHidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    state.socket.emit('presence:heartbeat', { state: isHidden ? 'idle' : 'online' });
  }, 30 * 1000);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!state.socket?.connected) return;
    state.socket.emit('presence:heartbeat', { state: document.visibilityState === 'hidden' ? 'idle' : 'online' });
  });
}

function getPresence(userId) {
  if (!userId) return null;
  return state._presence?.[userId] || null;
}

function presenceLabel(presence) {
  if (!presence) return '';
  if (presence.state === 'online') return tx('presenceOnline', 'Online');
  if (presence.state === 'idle') return tx('presenceIdle', 'Idle');
  return tx('presenceOffline', 'Offline');
}

function presenceDot(userId, { withLabel = false } = {}) {
  const presence = getPresence(userId);
  const cls = presence ? `presence-dot presence-dot-${presence.state}` : 'presence-dot presence-dot-offline';
  const label = presence ? presenceLabel(presence) : tx('presenceOffline', 'Offline');
  const idAttr = userId ? ` data-presence-user-id="${escapeHtml(String(userId))}"` : '';
  const dot = `<span class="${cls}"${idAttr} title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></span>`;
  if (!withLabel) return dot;
  return `${dot}<span class="presence-label">${escapeHtml(label)}</span>`;
}

function getTypingUsersForRoom(roomType, roomId) {
  if (!state._typing) return [];
  const key = roomType === 'dm' ? `dm:${roomId}` : `group:JimmyQrg`;
  return (state._typing[key] || [])
    .map((id) => state.users?.find((u) => u.id === id))
    .filter(Boolean);
}

/**
 * Lightweight DOM patcher for presence/typing updates so we don't rebuild the
 * whole UI (which would steal focus and break in-progress typing/paste).
 */
let _presenceTypingRafId = 0;
function schedulePresenceTypingRender() {
  if (_presenceTypingRafId) return;
  _presenceTypingRafId = requestAnimationFrame(() => {
    _presenceTypingRafId = 0;
    updateTypingIndicatorsInPlace();
    updatePresenceDotsInPlace();
  });
}

function updateTypingIndicatorsInPlace() {
  const slots = document.querySelectorAll('[data-typing-indicator-slot]');
  if (!slots.length) return;
  slots.forEach((slot) => {
    const roomType = slot.dataset.roomType;
    const roomId = slot.dataset.roomId;
    if (!roomType || !roomId) return;
    slot.innerHTML = renderTypingIndicator(roomType, roomId) || '';
  });
}

function updatePresenceDotsInPlace() {
  document.querySelectorAll('[data-presence-user-id]').forEach((el) => {
    const uid = el.dataset.presenceUserId;
    const presence = getPresence(uid);
    const next = presence?.state || 'offline';
    el.classList.remove('presence-dot-online', 'presence-dot-idle', 'presence-dot-offline');
    el.classList.add(`presence-dot-${next}`);
    const label = presenceLabel(presence) || tx('presenceOffline', 'Offline');
    el.setAttribute('title', label);
    el.setAttribute('aria-label', label);
  });
}

function renderTypingIndicator(roomType, roomId) {
  const users = getTypingUsersForRoom(roomType, roomId);
  if (!users.length) return '';
  const names = users.map((u) => u.display_name || u.username).filter(Boolean);
  if (!names.length) return '';
  const label = names.length === 1
    ? (tx('typingOne', '{name} is typing…')).replace('{name}', names[0])
    : names.length === 2
      ? (tx('typingTwo', '{a} and {b} are typing…')).replace('{a}', names[0]).replace('{b}', names[1])
      : (tx('typingMany', '{n} people are typing…')).replace('{n}', String(names.length));
  return `<div class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span><span class="typing-label">${escapeHtml(label)}</span></div>`;
}

let _typingEmitTimer = null;
let _typingLastSent = 0;
function emitTypingActivity(roomType, roomId) {
  if (!state.socket?.connected || !roomType || !roomId) return;
  const now = Date.now();
  if (now - _typingLastSent > 2000) {
    state.socket.emit('typing:start', { roomType, roomId });
    _typingLastSent = now;
  }
  if (_typingEmitTimer) clearTimeout(_typingEmitTimer);
  _typingEmitTimer = setTimeout(() => {
    state.socket?.emit('typing:stop', { roomType, roomId });
    _typingLastSent = 0;
  }, 4000);
}

function emitTypingStop(roomType, roomId) {
  if (!state.socket?.connected || !roomType || !roomId) return;
  if (_typingEmitTimer) clearTimeout(_typingEmitTimer);
  _typingEmitTimer = null;
  _typingLastSent = 0;
  state.socket.emit('typing:stop', { roomType, roomId });
}

let _mentionFetchToken = 0;

function findMentionContextAt(input) {
  if (!input) return null;
  const value = input.value || '';
  const caret = input.selectionStart || 0;
  const before = value.slice(0, caret);
  const m = before.match(/(^|\s)@([a-zA-Z0-9_]*)$/);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2], end: caret };
}

/**
 * Click-only mention picker:
 * - Opens as soon as the caret follows a bare `@` (optionally with letters).
 * - Shows up to 10 matching users; list is vertically scrollable if it overflows.
 * - Typing letters after `@` narrows the list; no keyboard auto-completion
 *   (Enter / Tab keep their normal composer behaviour). Only a click completes.
 */
const MENTION_MAX_ITEMS = 10;

async function maybeOpenMentionAutocomplete(input) {
  const ctx = findMentionContextAt(input);
  if (!ctx) {
    if (state._mentionAutocomplete) {
      state._mentionAutocomplete = null;
      renderMentionAutocomplete();
    }
    return;
  }
  const token = ++_mentionFetchToken;
  let users = [];
  let tokens = [];
  try {
    const data = await apiGet(`/api/users/mention-search?q=${encodeURIComponent(ctx.query)}&limit=${MENTION_MAX_ITEMS}`);
    users = data?.users || [];
    tokens = data?.tokens || [];
  } catch (_) {}
  if (token !== _mentionFetchToken) return;
  const options = [];
  for (const tok of tokens) options.push({ kind: 'token', token: tok.token, label: tok.label });
  for (const u of users) options.push({ kind: 'user', user: u });
  const limited = options.slice(0, MENTION_MAX_ITEMS);
  if (!limited.length) {
    state._mentionAutocomplete = null;
    renderMentionAutocomplete();
    return;
  }
  state._mentionAutocomplete = {
    options: limited,
    range: { start: ctx.start, end: ctx.end },
    inputId: input.id || null,
  };
  renderMentionAutocomplete();
}

function ensureMentionAutocompleteEl() {
  let el = document.getElementById('mention-autocomplete');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mention-autocomplete';
    el.className = 'mention-autocomplete';
    document.body.appendChild(el);
    el.addEventListener('mousedown', (e) => e.preventDefault());
  }
  return el;
}

function renderMentionAutocomplete() {
  const el = ensureMentionAutocompleteEl();
  const ac = state._mentionAutocomplete;
  if (!ac || !ac.options?.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const items = ac.options.map((opt, idx) => {
    if (opt.kind === 'token') {
      return `<button type="button" class="mention-option mention-option-token-row" data-idx="${idx}">
        <span class="mention-option-avatar mention-option-token-avatar">@</span>
        <span class="mention-option-info">
          <span class="mention-option-name">@${escapeHtml(opt.token)}</span>
          <span class="mention-option-sub">${escapeHtml(opt.label || '')}</span>
        </span>
      </button>`;
    }
    const u = opt.user;
    const av = u?.avatar_url || getDefaultAvatarUrl(u?.id);
    const displayName = u?.display_name || u?.username || '';
    return `<button type="button" class="mention-option" data-idx="${idx}">
      <img src="${escapeHtml(av)}" alt="" class="mention-option-avatar" />
      <span class="mention-option-info">
        <span class="mention-option-name">${escapeHtml(displayName)}${userTag(u?.id)}</span>
        <span class="mention-option-sub">@${escapeHtml(u?.username || '')}</span>
      </span>
    </button>`;
  }).join('');
  el.innerHTML = items;
  const inputId = ac.inputId || 'composer-input';
  const input = document.getElementById(inputId);
  el.style.transform = '';
  el.style.display = 'block';
  if (input) {
    const rect = input.getBoundingClientRect();
    const popupHeight = el.offsetHeight || 220;
    const margin = 8;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, vw - Math.min(360, rect.width) - margin));
    el.style.left = `${left}px`;
    const desiredTop = rect.top - margin - popupHeight;
    if (desiredTop < margin) {
      el.style.top = `${Math.min(rect.bottom + margin, (window.innerHeight || 0) - popupHeight - margin)}px`;
    } else {
      el.style.top = `${desiredTop}px`;
    }
    el.style.minWidth = `${Math.min(360, rect.width)}px`;
  }
  el.querySelectorAll('.mention-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const opt = ac.options[idx];
      if (opt) applyMentionSelection(opt);
    });
  });
}

function applyMentionSelection(option) {
  const ac = state._mentionAutocomplete;
  if (!ac || !option) return;
  const inputId = ac.inputId || 'composer-input';
  const input = document.getElementById(inputId);
  if (!input) return;
  const value = input.value;
  const insert = option.kind === 'token' ? `@${option.token}` : `@${option.user.username}`;
  const next = value.slice(0, ac.range.start) + insert + ' ' + value.slice(ac.range.end);
  input.value = next;
  const caret = ac.range.start + insert.length + 1;
  input.setSelectionRange(caret, caret);
  state._mentionAutocomplete = null;
  renderMentionAutocomplete();
  input.dispatchEvent(new Event('input'));
  input.focus();
}

// ── Voice Chat WebRTC Manager ──

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

async function voiceJoin() {
  if (state._voiceJoined) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state._voiceLocalStream = stream;
    state._voiceMicOn = true;
    stream.getAudioTracks().forEach((t) => { t.enabled = true; });
    state._voiceCamOn = false;
    state._voiceScreenOn = false;
    state._voiceJoined = true;
    voiceBroadcastMediaState();
    state.socket?.emit('voice:join', (res) => {
      if (res?.participants) {
        state._voiceParticipants = res.participants;
        for (const p of res.participants) {
          if (p.id !== state.user?.id) voiceCreatePeer(p.id, true);
        }
        render();
      }
    });
    apiGet('/api/rooms/group/voice_chat/messages?limit=50').then(({ messages }) => {
      state._voiceChatMessages = messages || [];
    }).catch(() => {});
  } catch (err) {
    showToast('Could not access microphone: ' + (err.message || err));
  }
}

function voiceLeave() {
  state.socket?.emit('voice:leave', () => {});
  voiceCleanup();
  state.panel = 'free_chat';
  navigateTo('/chat/group/?panel=chat');
}

function voiceCleanup() {
  for (const peerId of Object.keys(state._voicePeers)) {
    state._voicePeers[peerId]?.close();
  }
  state._voicePeers = {};
  state._voiceLocalStream?.getTracks().forEach(t => t.stop());
  state._voiceScreenStream?.getTracks().forEach(t => t.stop());
  state._voiceLocalStream = null;
  state._voiceScreenStream = null;
  state._voiceJoined = false;
  state._voiceParticipants = [];
  state._voiceCamOn = false;
  state._voiceMicOn = true;
  state._voiceScreenOn = false;
  state._voiceSidePanel = null;
  state._voiceChatMessages = [];
}

function voiceCreatePeer(peerId, initiator) {
  if (state._voicePeers[peerId]) { state._voicePeers[peerId].close(); }
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state._voicePeers[peerId] = pc;

  let negotiating = false;
  const sendOffer = async () => {
    if (!initiator || negotiating || pc.signalingState !== 'stable') return;
    try {
      negotiating = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket?.emit('voice:offer', { to: peerId, offer: pc.localDescription }, () => {});
    } catch (_) {
      // Ignore transient offer races; a later negotiationneeded will retry.
    } finally {
      negotiating = false;
    }
  };

  if (state._voiceLocalStream) {
    for (const track of state._voiceLocalStream.getTracks()) {
      pc.addTrack(track, state._voiceLocalStream);
    }
  }
  if (state._voiceScreenStream) {
    for (const track of state._voiceScreenStream.getTracks()) {
      pc.addTrack(track, state._voiceScreenStream);
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      state.socket?.emit('voice:ice-candidate', { to: peerId, candidate: e.candidate }, () => {});
    }
  };

  pc.ontrack = (e) => {
    let container = document.getElementById(`voice-remote-${peerId}`);
    if (!container) {
      render();
      container = document.getElementById(`voice-remote-${peerId}`);
    }
    if (container) {
      const track = e.track;
      let el;
      if (track.kind === 'video') {
        el = container.querySelector('video') || document.createElement('video');
        el.autoplay = true;
        el.playsInline = true;
        el.muted = false;
        if (!el.parentNode) container.appendChild(el);
        const ms = el.srcObject instanceof MediaStream ? el.srcObject : new MediaStream();
        ms.addTrack(track);
        el.srcObject = ms;
      } else if (track.kind === 'audio') {
        el = container.querySelector('audio') || document.createElement('audio');
        el.autoplay = true;
        el.muted = false;
        if (!el.parentNode) container.appendChild(el);
        const ms = el.srcObject instanceof MediaStream ? el.srcObject : new MediaStream();
        ms.addTrack(track);
        el.srcObject = ms;
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      pc.close();
      delete state._voicePeers[peerId];
    }
  };

  if (initiator) {
    pc.onnegotiationneeded = sendOffer;
    // Some browsers can miss negotiationneeded when handlers are attached late.
    // Force an initial offer so mic audio always gets a transport path.
    queueMicrotask(() => { void sendOffer(); });
  }

  return pc;
}

function voiceSetupSignalListeners() {
  const s = state.socket;
  if (!s) return;
  s.on('voice:offer', async ({ from, offer }) => {
    if (!state._voiceJoined) return;
    let pc = state._voicePeers[from];
    if (!pc) pc = voiceCreatePeer(from, false);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit('voice:answer', { to: from, answer: pc.localDescription }, () => {});
    } catch (_) {}
  });
  s.on('voice:answer', async ({ from, answer }) => {
    const pc = state._voicePeers[from];
    if (pc) {
      try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch (_) {}
    }
  });
  s.on('voice:ice-candidate', async ({ from, candidate }) => {
    const pc = state._voicePeers[from];
    if (pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
    }
  });
  s.on('voice:participants', (participants) => {
    state._voiceParticipants = participants;
    state._voiceParticipantCount = participants.length;
    if (state._voiceJoined) {
      for (const p of participants) {
        if (p.id !== state.user?.id && !state._voicePeers[p.id]) {
          voiceCreatePeer(p.id, true);
        }
      }
    }
    render();
  });
  s.on('voice:peer-left', ({ userId }) => {
    const pc = state._voicePeers[userId];
    if (pc) { pc.close(); delete state._voicePeers[userId]; }
    const container = document.getElementById(`voice-remote-${userId}`);
    if (container) { container.querySelectorAll('audio, video').forEach(el => { el.srcObject = null; }); }
  });
  s.on('voice:media-state', ({ userId, audio, video, screen }) => {
    const p = state._voiceParticipants.find(p => p.id === userId);
    if (p) { p.media = { audio, video, screen }; render(); }
  });
  s.on('voice:kicked', () => {
    showToast('You joined voice chat from another session.');
    voiceCleanup();
    render();
  });
  s.on('voice:participant-count', (count) => {
    state._voiceParticipantCount = count;
    render();
  });
}

async function voiceToggleMic() {
  if (!state._voiceLocalStream) return;
  const audioTracks = state._voiceLocalStream.getAudioTracks();
  state._voiceMicOn = !state._voiceMicOn;
  audioTracks.forEach(t => { t.enabled = state._voiceMicOn; });
  voiceBroadcastMediaState();
  render();
}

async function voiceToggleCam() {
  if (!state._voiceLocalStream) return;
  if (!state._voiceCamOn) {
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const videoTrack = camStream.getVideoTracks()[0];
      state._voiceLocalStream.addTrack(videoTrack);
      for (const [, pc] of Object.entries(state._voicePeers)) {
        pc.addTrack(videoTrack, state._voiceLocalStream);
      }
      state._voiceCamOn = true;
      const localVid = document.getElementById('voice-local-video');
      if (localVid) {
        localVid.srcObject = state._voiceLocalStream;
        localVid.style.display = '';
      }
    } catch (err) {
      showToast('Could not access camera: ' + (err.message || err));
      return;
    }
  } else {
    const videoTracks = state._voiceLocalStream.getVideoTracks();
    videoTracks.forEach(t => {
      t.stop();
      state._voiceLocalStream.removeTrack(t);
      for (const [, pc] of Object.entries(state._voicePeers)) {
        const sender = pc.getSenders().find(s => s.track === t);
        if (sender) pc.removeTrack(sender);
      }
    });
    state._voiceCamOn = false;
    const localVid = document.getElementById('voice-local-video');
    if (localVid) { localVid.srcObject = null; localVid.style.display = 'none'; }
  }
  voiceBroadcastMediaState();
  render();
}

async function voiceShareScreen(options = {}) {
  if (state._voiceScreenOn) {
    voiceStopScreenShare();
    return;
  }
  try {
    const constraints = { video: true, audio: !!options.systemAudio };
    if (options.displaySurface) constraints.video = { displaySurface: options.displaySurface };
    const screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    state._voiceScreenStream = screenStream;
    state._voiceScreenOn = true;
    for (const track of screenStream.getTracks()) {
      for (const [, pc] of Object.entries(state._voicePeers)) {
        pc.addTrack(track, screenStream);
      }
      track.onended = () => voiceStopScreenShare();
    }
    // Safari often fails to fire onnegotiationneeded when addTrack is called
    // from a MediaStream that differs from the one used during the initial
    // handshake. Explicitly kick a renegotiation for each peer so the
    // receiver learns about the new video m-section.
    await voiceKickRenegotiation();
    voiceBroadcastMediaState();
    render();
  } catch (err) {
    if (err.name !== 'NotAllowedError') showToast('Screen share failed: ' + (err.message || err));
  }
}

// Force a renegotiation offer for every group-voice peer. Safe to call
// after any pc.addTrack / pc.removeTrack — skips peers whose pc isn't in
// the stable state (e.g. another offer is already in flight).
async function voiceKickRenegotiation() {
  const entries = Object.entries(state._voicePeers || {});
  for (const [peerId, pc] of entries) {
    if (pc.signalingState !== 'stable') continue;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket?.emit('voice:offer', { to: peerId, offer: pc.localDescription }, () => {});
    } catch (_) {
      // Best-effort; ignore transient negotiation races.
    }
  }
}

function voiceStopScreenShare() {
  if (state._voiceScreenStream) {
    state._voiceScreenStream.getTracks().forEach(t => {
      t.stop();
      for (const [, pc] of Object.entries(state._voicePeers)) {
        const sender = pc.getSenders().find(s => s.track === t);
        if (sender) pc.removeTrack(sender);
      }
    });
    state._voiceScreenStream = null;
  }
  state._voiceScreenOn = false;
  voiceBroadcastMediaState();
  render();
}

function voiceBroadcastMediaState() {
  state.socket?.emit('voice:media-state', { audio: state._voiceMicOn, video: state._voiceCamOn, screen: state._voiceScreenOn });
}

function voiceSendChatMessage(content) {
  if (!content?.trim() || !state._voiceJoined) return;
  state.socket?.emit('message:send', { roomType: 'group', roomId: 'voice_chat', content: content.trim(), msg_type: 'text' }, (res) => {
    if (res?.error) {
      if (res.error === 'AI_MOD_BLOCK') {
        showAiModerationModal(res.reason || '');
        return;
      }
      showToast(res.error);
      return;
    }
    if (res?.message) {
      state._voiceChatMessages.push(res.message);
      render();
      requestAnimationFrame(() => {
        const wrap = document.getElementById('voice-chat-messages');
        if (wrap) wrap.scrollTop = wrap.scrollHeight;
      });
    }
  });
}

// ── DM Voice Chat (1:1 WebRTC, per-conversation) ──
// Mirrors the group voice chat feature set: mic, cam, screen share, in-call text
// chat side panel, participants list. Access is friends-only (defense-in-depth on
// the client; the server re-checks with areFriends in dm-voice:invite).

function dmVoiceLookupUser(uid) {
  return (state.users || []).find(u => u.id === uid);
}

function dmVoiceUserName(uid) {
  const u = dmVoiceLookupUser(uid);
  return u?.display_name || u?.username || uid;
}

function dmVoiceUserAvatar(uid) {
  const u = dmVoiceLookupUser(uid);
  return u?.avatar_url || getDefaultAvatarUrl(uid);
}

async function dmVoiceInvite(toUserId, convId) {
  if (!state.socket || !toUserId || !convId) return;
  if (state._dmVoiceJoined) { showToast('You are already in a call'); return; }
  state.socket.emit('dm-voice:invite', { to: toUserId, convId }, (res) => {
    if (res?.error) { showToast(res.error); return; }
    state._dmVoiceRingingOutgoing = { toUserId, convId };
    render();
  });
}

function dmVoiceCancelInvite() {
  const out = state._dmVoiceRingingOutgoing;
  if (!out) return;
  state.socket?.emit('dm-voice:cancel-invite', { to: out.toUserId, convId: out.convId });
  state._dmVoiceRingingOutgoing = null;
  render();
}

async function dmVoiceAccept(fromUserId, convId) {
  if (state._dmVoiceJoined) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state._dmVoiceLocalStream = stream;
    stream.getAudioTracks().forEach(t => { t.enabled = true; });
    state._dmVoiceMicOn = true;
    state._dmVoiceConvId = convId;
    state._dmVoiceRinging = null;
    state.socket?.emit('dm-voice:accept', { to: fromUserId, convId }, (res) => {
      if (res?.error) {
        showToast(res.error);
        dmVoiceCleanup();
        return;
      }
      state._dmVoiceJoined = true;
      // Create the peer connection as the non-initiator (callee). The caller will
      // send the offer once they see our dm-voice:state.
      dmVoiceCreatePeer(fromUserId, false);
      render();
    });
  } catch (err) {
    showToast('Could not access microphone: ' + (err.message || err));
  }
}

function dmVoiceDecline(fromUserId, convId) {
  state.socket?.emit('dm-voice:decline', { to: fromUserId, convId });
  state._dmVoiceRinging = null;
  render();
}

function dmVoiceLeave() {
  const convId = state._dmVoiceConvId;
  state.socket?.emit('dm-voice:leave', { convId }, () => {});
  dmVoiceCleanup();
  render();
}

function dmVoiceCleanup() {
  if (state._dmVoicePeer) {
    try { state._dmVoicePeer.close(); } catch (_) {}
  }
  state._dmVoiceDataChannel = null;
  state._dmVoicePeer = null;
  state._dmVoicePeerUserId = null;
  state._dmVoiceLocalStream?.getTracks().forEach(t => t.stop());
  state._dmVoiceScreenStream?.getTracks().forEach(t => t.stop());
  state._dmVoiceLocalStream = null;
  state._dmVoiceScreenStream = null;
  state._dmVoiceJoined = false;
  state._dmVoiceConvId = null;
  state._dmVoiceCamOn = false;
  state._dmVoiceMicOn = true;
  state._dmVoiceScreenOn = false;
  state._dmVoiceSidePanel = null;
  state._dmVoiceChatMessages = [];
  state._dmVoicePeerMedia = { audio: true, video: false, screen: false };
  state._dmVoiceRinging = null;
  state._dmVoiceRingingOutgoing = null;
}

function dmVoiceCreatePeer(remoteUserId, initiator) {
  if (state._dmVoicePeer) {
    try { state._dmVoicePeer.close(); } catch (_) {}
  }
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state._dmVoicePeer = pc;
  // Preserve the peer userId on state so renegotiation helpers (e.g. when
  // adding screen-share tracks) can address the dm-voice:offer payload
  // without needing the closure-local variable.
  state._dmVoicePeerUserId = remoteUserId;

  // Caller (initiator) creates the data channel; callee receives via ondatachannel.
  if (initiator) {
    const dc = pc.createDataChannel('dm-voice-chat');
    dmVoiceAttachDataChannel(dc);
  } else {
    pc.ondatachannel = (e) => dmVoiceAttachDataChannel(e.channel);
  }

  let negotiating = false;
  const sendOffer = async () => {
    if (!initiator || negotiating || pc.signalingState !== 'stable') return;
    try {
      negotiating = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket?.emit('dm-voice:offer', { to: remoteUserId, convId: state._dmVoiceConvId, offer: pc.localDescription }, () => {});
    } catch (_) {} finally { negotiating = false; }
  };

  if (state._dmVoiceLocalStream) {
    for (const track of state._dmVoiceLocalStream.getTracks()) {
      pc.addTrack(track, state._dmVoiceLocalStream);
    }
  }
  if (state._dmVoiceScreenStream) {
    for (const track of state._dmVoiceScreenStream.getTracks()) {
      pc.addTrack(track, state._dmVoiceScreenStream);
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      state.socket?.emit('dm-voice:ice-candidate', { to: remoteUserId, convId: state._dmVoiceConvId, candidate: e.candidate }, () => {});
    }
  };

  pc.ontrack = (e) => {
    const container = document.getElementById('dm-voice-remote');
    if (!container) { render(); return; }
    const track = e.track;
    let el;
    if (track.kind === 'video') {
      el = container.querySelector('video') || document.createElement('video');
      el.autoplay = true; el.playsInline = true; el.muted = false;
      if (!el.parentNode) container.appendChild(el);
      const ms = el.srcObject instanceof MediaStream ? el.srcObject : new MediaStream();
      ms.addTrack(track);
      el.srcObject = ms;
    } else if (track.kind === 'audio') {
      el = container.querySelector('audio') || document.createElement('audio');
      el.autoplay = true; el.muted = false;
      if (!el.parentNode) container.appendChild(el);
      const ms = el.srcObject instanceof MediaStream ? el.srcObject : new MediaStream();
      ms.addTrack(track);
      el.srcObject = ms;
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      // Peer disconnected — keep the overlay open so the user can re-invite, but
      // close the connection so we don't keep trying to a dead peer.
      try { pc.close(); } catch (_) {}
      if (state._dmVoicePeer === pc) state._dmVoicePeer = null;
    }
  };

  if (initiator) {
    pc.onnegotiationneeded = sendOffer;
    queueMicrotask(() => { void sendOffer(); });
  }
  return pc;
}

function dmVoiceAttachDataChannel(dc) {
  state._dmVoiceDataChannel = dc;
  dc.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg?.kind === 'chat' && typeof msg.text === 'string') {
        const peerId = state._dmVoicePeerUserId || 'peer';
        state._dmVoiceChatMessages.push({ from: peerId, text: msg.text, ts: Date.now() });
        render();
        requestAnimationFrame(() => {
          const wrap = document.getElementById('dm-voice-chat-messages');
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        });
      }
    } catch (_) {}
  };
}

function dmVoiceSendChatMessage(content) {
  if (!content?.trim() || !state._dmVoiceJoined) return;
  const text = content.trim();
  // Local echo (peer echoes back via the data channel when they receive).
  state._dmVoiceChatMessages.push({ from: state.user?.id, text, ts: Date.now() });
  const dc = state._dmVoiceDataChannel;
  if (dc && dc.readyState === 'open') {
    try { dc.send(JSON.stringify({ kind: 'chat', text })); } catch (_) {}
  }
  render();
  requestAnimationFrame(() => {
    const wrap = document.getElementById('dm-voice-chat-messages');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  });
}

async function dmVoiceToggleMic() {
  if (!state._dmVoiceLocalStream) return;
  state._dmVoiceMicOn = !state._dmVoiceMicOn;
  state._dmVoiceLocalStream.getAudioTracks().forEach(t => { t.enabled = state._dmVoiceMicOn; });
  dmVoiceBroadcastMediaState();
  render();
}

async function dmVoiceToggleCam() {
  if (!state._dmVoiceLocalStream) return;
  if (!state._dmVoiceCamOn) {
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const videoTrack = camStream.getVideoTracks()[0];
      state._dmVoiceLocalStream.addTrack(videoTrack);
      state._dmVoicePeer?.addTrack(videoTrack, state._dmVoiceLocalStream);
      state._dmVoiceCamOn = true;
      const localVid = document.getElementById('dm-voice-local-video');
      if (localVid) {
        localVid.srcObject = state._dmVoiceLocalStream;
        localVid.style.display = '';
      }
    } catch (err) {
      showToast('Could not access camera: ' + (err.message || err));
      return;
    }
  } else {
    state._dmVoiceLocalStream.getVideoTracks().forEach(t => {
      t.stop();
      state._dmVoiceLocalStream.removeTrack(t);
      const sender = state._dmVoicePeer?.getSenders().find(s => s.track === t);
      if (sender) state._dmVoicePeer.removeTrack(sender);
    });
    state._dmVoiceCamOn = false;
    const localVid = document.getElementById('dm-voice-local-video');
    if (localVid) { localVid.srcObject = null; localVid.style.display = 'none'; }
  }
  dmVoiceBroadcastMediaState();
  render();
}

async function dmVoiceShareScreen(options = {}) {
  if (state._dmVoiceScreenOn) { dmVoiceStopScreenShare(); return; }
  try {
    const constraints = { video: true, audio: !!options.systemAudio };
    if (options.displaySurface) constraints.video = { displaySurface: options.displaySurface };
    const screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    state._dmVoiceScreenStream = screenStream;
    state._dmVoiceScreenOn = true;
    for (const track of screenStream.getTracks()) {
      state._dmVoicePeer?.addTrack(track, screenStream);
      track.onended = () => dmVoiceStopScreenShare();
    }
    // Safari often fails to fire onnegotiationneeded when addTrack is called
    // from a MediaStream that differs from the one used during the initial
    // handshake. Explicitly kick a renegotiation so the receiver learns
    // about the new video m-section.
    await dmVoiceKickRenegotiation();
    dmVoiceBroadcastMediaState();
    render();
  } catch (err) {
    if (err.name !== 'NotAllowedError') showToast('Screen share failed: ' + (err.message || err));
  }
}

async function dmVoiceKickRenegotiation() {
  const pc = state._dmVoicePeer;
  const to = state._dmVoicePeerUserId;
  const convId = state._dmVoiceConvId;
  if (!pc || pc.signalingState !== 'stable') return;
  if (!to || !convId) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket?.emit('dm-voice:offer', { to, convId, offer: pc.localDescription }, () => {});
  } catch (_) {
    // Best-effort; ignore transient negotiation races.
  }
}

function dmVoiceStopScreenShare() {
  if (state._dmVoiceScreenStream) {
    state._dmVoiceScreenStream.getTracks().forEach(t => {
      t.stop();
      const sender = state._dmVoicePeer?.getSenders().find(s => s.track === t);
      if (sender) state._dmVoicePeer.removeTrack(sender);
    });
    state._dmVoiceScreenStream = null;
  }
  state._dmVoiceScreenOn = false;
  dmVoiceBroadcastMediaState();
  render();
}

function dmVoiceBroadcastMediaState() {
  if (!state._dmVoiceConvId) return;
  state.socket?.emit('dm-voice:media-state', {
    convId: state._dmVoiceConvId,
    audio: state._dmVoiceMicOn,
    video: state._dmVoiceCamOn,
    screen: state._dmVoiceScreenOn,
  });
}

function dmVoiceSetupSignalListeners() {
  const s = state.socket;
  if (!s) return;

  s.on('dm-voice:incoming', ({ fromUserId, fromUsername, fromDisplayName, fromAvatarUrl, convId }) => {
    // Don't replace an existing incoming call unless it's for the same caller / different conv.
    if (state._dmVoiceRinging) return;
    state._dmVoiceRinging = { fromUserId, fromUsername, fromDisplayName, fromAvatarUrl, convId };
    render();
  });

  s.on('dm-voice:cancelled', ({ fromUserId, convId }) => {
    if (state._dmVoiceRinging && state._dmVoiceRinging.fromUserId === fromUserId && state._dmVoiceRinging.convId === convId) {
      state._dmVoiceRinging = null;
      render();
    }
  });

  s.on('dm-voice:declined', () => {
    state._dmVoiceRingingOutgoing = null;
    showToast('Call declined');
    render();
  });

  s.on('dm-voice:accepted', async ({ convId, by }) => {
    if (!state._dmVoiceRingingOutgoing || state._dmVoiceRingingOutgoing.convId !== convId) return;
    state._dmVoiceRingingOutgoing = null;
    // Get mic, set joined, create peer as initiator.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      state._dmVoiceLocalStream = stream;
      stream.getAudioTracks().forEach(t => { t.enabled = true; });
      state._dmVoiceMicOn = true;
      state._dmVoiceConvId = convId;
      state._dmVoiceJoined = true;
      state._dmVoicePeerUserId = by;
      dmVoiceCreatePeer(by, true);
      render();
    } catch (err) {
      showToast('Could not access microphone: ' + (err.message || err));
      dmVoiceLeave();
    }
  });

  s.on('dm-voice:state', ({ convId, participants }) => {
    if (state._dmVoiceConvId !== convId) return;
    const peer = participants.find(p => p.id !== state.user?.id);
    if (peer) {
      state._dmVoicePeerUserId = peer.id;
      state._dmVoicePeerMedia = peer.media || state._dmVoicePeerMedia;
    }
    render();
  });

  s.on('dm-voice:offer', async ({ from, convId, offer }) => {
    if (state._dmVoiceConvId !== convId) return;
    let pc = state._dmVoicePeer;
    if (!pc) pc = dmVoiceCreatePeer(from, false);
    state._dmVoicePeerUserId = from;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit('dm-voice:answer', { to: from, convId, answer: pc.localDescription }, () => {});
    } catch (_) {}
  });

  s.on('dm-voice:answer', async ({ from, convId, answer }) => {
    if (state._dmVoiceConvId !== convId) return;
    const pc = state._dmVoicePeer;
    if (pc) {
      try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch (_) {}
    }
  });

  s.on('dm-voice:ice-candidate', async ({ from, convId, candidate }) => {
    if (state._dmVoiceConvId !== convId) return;
    const pc = state._dmVoicePeer;
    if (pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
    }
  });

  s.on('dm-voice:media-state', ({ userId, audio, video, screen, convId }) => {
    if (state._dmVoiceConvId !== convId) return;
    state._dmVoicePeerMedia = { audio, video, screen };
    render();
  });

  s.on('dm-voice:peer-left', ({ userId, convId }) => {
    if (state._dmVoiceConvId !== convId) return;
    // Peer hung up — close overlay, free streams.
    if (state._dmVoicePeer) {
      try { state._dmVoicePeer.close(); } catch (_) {}
      state._dmVoicePeer = null;
    }
    const remote = document.getElementById('dm-voice-remote');
    if (remote) remote.querySelectorAll('audio, video').forEach(el => { el.srcObject = null; });
    state._dmVoiceJoined = false;
    state._dmVoiceConvId = null;
    state._dmVoiceLocalStream?.getTracks().forEach(t => t.stop());
    state._dmVoiceScreenStream?.getTracks().forEach(t => t.stop());
    state._dmVoiceLocalStream = null;
    state._dmVoiceScreenStream = null;
    showToast('Call ended');
    render();
  });

  s.on('dm-voice:kicked', ({ convId }) => {
    if (state._dmVoiceConvId && state._dmVoiceConvId !== convId) return;
    showToast('Call ended (joined from another session)');
    dmVoiceCleanup();
    render();
  });
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.remove('app-loading');
  const route = parseRoute();

  if (!state.user) {
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.add('auth-page');
    if (route.page === 'forgot-password') {
      app.innerHTML = renderForgotPassword(state.authError || '');
      state.authError = null;
      bindForgotPassword();
      state.authPrevSignup = null;
      return;
    }
    if (route.page === 'reset-password') {
      app.innerHTML = renderResetPassword(route.token || '', state.authError || '');
      state.authError = null;
      bindResetPassword(route.token || '');
      state.authPrevSignup = null;
      return;
    }
    const isSignup = route.page === 'signup';
    const redirect = route.redirect || null;
    const authError = state.authError || '';
    state.authError = null;
    const isAuthSwitch = state.authPrevSignup != null && state.authPrevSignup !== isSignup && app.querySelector('.auth-screen');
    if (isAuthSwitch) {
      authTransition(app, state.authPrevSignup, isSignup, authError, redirect);
    } else {
      app.innerHTML = renderAuth(isSignup, authError, redirect);
    bindAuth(isSignup);
    }
    state.authPrevSignup = isSignup;
    return;
  }

  applyTheme(state.theme);
  document.body.classList.remove('auth-page');
  app.innerHTML = renderMain();
  bindMain();
  updateHelperQuestionPanel();
  if (route.page === 'settings') bindSettings();
  if (state._voiceJoined && state._voiceLocalStream) {
    const localVid = document.getElementById('voice-local-video');
    if (localVid && state._voiceCamOn) { localVid.srcObject = state._voiceLocalStream; }
  }
}

function renderAuth(isSignup = false, initialError = '', redirect = null) {
  const switchHref = authPath(isSignup ? 'login' : 'signup', redirect);
  return `
    <div class="auth-screen auth-ani-1">
      <div class="auth-box auth-ani-2">
        <h1 class="auth-ani-3">JimmyQrg Chat</h1>
        <form id="auth-form" class="auth-ani-7" novalidate>
          <div id="auth-error" class="error auth-ani-8">${initialError ? escapeHtml(initialError) : ''}</div>
          <div id="auth-fields-login" class="auth-ani-9" style="display:${isSignup ? 'none' : 'block'}">
            <label class="auth-ani-10">${t('usernameOrEmail')}</label>
            <input class="auth-ani-11" name="login_identifier" type="text" autocomplete="username" placeholder="${t('usernameOrEmail')}" />
            <label class="auth-ani-12">${t('password')}</label>
            <input class="auth-ani-13" name="login_password" type="password" autocomplete="current-password" />
            <p class="auth-forgot-link">
              <a href="/forgot-password" class="auth-switch-link">${tx('forgotPasswordLink', 'Forgot password?')}</a>
              <span style="margin:0 8px;color:rgba(255,255,255,.3)">\u00B7</span>
              <a href="#" id="auth-recover-link" class="auth-switch-link">Recover Account</a>
            </p>
        </div>
          <div id="auth-fields-register" class="auth-ani-14" style="display:${isSignup ? 'block' : 'none'}">
            <label class="auth-ani-15">${t('displayName')}</label>
            <input class="auth-ani-16" name="display_name" type="text" autocomplete="name" placeholder="${t('displayName')}" />
            <label class="auth-ani-17">Username (lowercase letters and numbers only)</label>
            <input class="auth-ani-18" name="reg_username" type="text" autocomplete="username" placeholder="Username" />
            <label class="auth-ani-19">${t('email')}</label>
            <input class="auth-ani-20" name="email" type="email" autocomplete="email" placeholder="${t('email')}" />
            <div id="auth-verify-row" class="auth-verify-row" style="display:none">
              <div class="auth-verify-info">A 6-digit verification code has been sent to your email from <strong>ikunbeautiful@gmail.com</strong>. The code is valid for 2 minutes.</div>
              <label>Verification code</label>
              <input name="email_code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" />
              <button type="button" id="auth-resend-code" class="auth-resend-btn" disabled>Resend code (<span id="auth-resend-timer">60</span>s)</button>
            </div>
            <div id="auth-verify-skip" class="auth-verify-info auth-verify-skip" style="display:none">Good news — email verification isn&rsquo;t required for your email address. You can create your account right away.</div>
            <button type="button" id="auth-send-code" class="auth-send-code-btn" style="display:none">Send verification code</button>
            <label class="auth-ani-21">${t('password')}</label>
            <input class="auth-ani-22" name="reg_password" type="password" autocomplete="new-password" placeholder="${t('password')}" />
            <label class="auth-ani-23">${t('confirmPassword')}</label>
            <input class="auth-ani-24" name="confirm_password" type="password" autocomplete="new-password" placeholder="${t('confirmPassword')}" />
            <div id="auth-recaptcha-wrap" class="auth-recaptcha-wrap" aria-live="polite"></div>
          </div>
          <button type="submit" id="auth-submit" class="auth-ani-25"><span class="icon" aria-hidden="true">${isSignup ? ICON_USER_PLUS_SM : ICON_LOG_IN_SM}</span>${isSignup ? t('signUp') : t('login')}</button>
          <p class="auth-switch auth-ani-26">
            ${isSignup ? t('alreadyHaveAccount') : t('noAccount')}
            <a href="${switchHref}" class="auth-switch-link">${isSignup ? t('logIn') : t('signUp')}</a>
          </p>
        </form>
      </div>
    </div>
  `;
}

function renderForgotPassword(initialError = '') {
  return `
    <div class="auth-screen auth-ani-1">
      <div class="auth-box auth-ani-2">
        <h1 class="auth-ani-3">${tx('forgotPasswordTitle', 'Forgot password')}</h1>
        <p class="auth-subtitle auth-ani-4">${tx('forgotPasswordIntro', 'Enter your username or the email on your account. We\u2019ll send you a link to choose a new password.')}</p>
        <form id="forgot-form" class="auth-ani-7" novalidate>
          <div id="auth-error" class="error auth-ani-8">${initialError ? escapeHtml(initialError) : ''}</div>
          <div id="auth-success" class="auth-success" style="display:none"></div>
          <label class="auth-ani-10">${t('usernameOrEmail')}</label>
          <input class="auth-ani-11" name="forgot_identifier" type="text" autocomplete="username" placeholder="${t('usernameOrEmail')}" />
          <div id="forgot-recaptcha-wrap" class="auth-recaptcha-wrap" aria-live="polite"></div>
          <button type="submit" id="forgot-submit" class="auth-ani-25">${tx('sendResetLink', 'Send reset link')}</button>
          <p class="auth-switch auth-ani-26">
            <a href="/login" class="auth-switch-link">${tx('backToLogin', 'Back to login')}</a>
          </p>
        </form>
      </div>
    </div>
  `;
}

function bindForgotPassword() {
  const form = document.getElementById('forgot-form');
  if (!form) return;
  const errEl = form.querySelector('#auth-error');
  const successEl = form.querySelector('#auth-success');
  let recaptchaWidgetId = null;
  loadConfig().then((config) => {
    const wrap = document.getElementById('forgot-recaptcha-wrap');
    if (wrap && config?.recaptchaSiteKey) {
      loadRecaptchaAndRender(config.recaptchaSiteKey, wrap).then((id) => { recaptchaWidgetId = id; }).catch(() => {});
    }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (errEl) errEl.textContent = '';
    if (successEl) successEl.style.display = 'none';
    const identifier = (form.forgot_identifier?.value || '').trim();
    if (!identifier) { errEl.textContent = tx('usernameOrEmailRequired', 'Username or email is required'); return; }
    let recaptchaToken = null;
    if (state.recaptchaSiteKey && window.grecaptcha) {
      try {
        recaptchaToken = recaptchaWidgetId != null ? window.grecaptcha.getResponse(recaptchaWidgetId) : window.grecaptcha.getResponse();
      } catch { recaptchaToken = ''; }
      if (!recaptchaToken) { errEl.textContent = 'Please complete the reCAPTCHA check.'; return; }
    }
    try {
      const body = { identifier };
      if (recaptchaToken != null) body.recaptcha_token = recaptchaToken;
      await apiPost('/api/auth/forgot-password', body);
      if (successEl) {
        successEl.style.display = '';
        successEl.textContent = tx('forgotPasswordSent', 'If an account matches that, we just sent a reset link to its email. Check your inbox (and spam folder).');
      }
      const submitBtn = form.querySelector('#forgot-submit');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = tx('forgotPasswordSentBtn', 'Reset link sent');
      }
    } catch (err) {
      errEl.textContent = err?.message || 'Failed to send reset link';
      if (state.recaptchaSiteKey && window.grecaptcha && recaptchaWidgetId != null) {
        try { window.grecaptcha.reset(recaptchaWidgetId); } catch (_) {}
      }
    }
  };
}

function renderResetPassword(token, initialError = '') {
  if (!token) {
    return `
      <div class="auth-screen auth-ani-1">
        <div class="auth-box auth-ani-2">
          <h1 class="auth-ani-3">${tx('resetPasswordTitle', 'Reset password')}</h1>
          <p class="error">${tx('resetPasswordMissingToken', 'This reset link is missing its token. Please request a new one.')}</p>
          <p class="auth-switch">
            <a href="/forgot-password" class="auth-switch-link">${tx('requestNewResetLink', 'Request a new link')}</a>
          </p>
        </div>
      </div>
    `;
  }
  return `
    <div class="auth-screen auth-ani-1">
      <div class="auth-box auth-ani-2">
        <h1 class="auth-ani-3">${tx('resetPasswordTitle', 'Reset password')}</h1>
        <p id="reset-info" class="auth-subtitle auth-ani-4" data-loading="1">${tx('resetPasswordChecking', 'Checking your link\u2026')}</p>
        <form id="reset-form" class="auth-ani-7" novalidate style="display:none">
          <div id="auth-error" class="error auth-ani-8">${initialError ? escapeHtml(initialError) : ''}</div>
          <label class="auth-ani-12">${tx('newPassword', 'New password')}</label>
          <input class="auth-ani-13" name="reset_password" type="password" autocomplete="new-password" />
          <label class="auth-ani-12">${t('confirmPassword')}</label>
          <input class="auth-ani-13" name="reset_password_confirm" type="password" autocomplete="new-password" />
          <div id="reset-recaptcha-wrap" class="auth-recaptcha-wrap" aria-live="polite"></div>
          <button type="submit" id="reset-submit" class="auth-ani-25">${tx('saveNewPassword', 'Save new password')}</button>
          <p class="auth-switch auth-ani-26">
            <a href="/login" class="auth-switch-link">${tx('backToLogin', 'Back to login')}</a>
          </p>
        </form>
        <div id="reset-bad" class="auth-error-block" style="display:none">
          <p class="error" id="reset-bad-msg"></p>
          <p class="auth-switch">
            <a href="/forgot-password" class="auth-switch-link">${tx('requestNewResetLink', 'Request a new link')}</a>
          </p>
        </div>
      </div>
    </div>
  `;
}

function bindResetPassword(token) {
  if (!token) return;
  const form = document.getElementById('reset-form');
  const info = document.getElementById('reset-info');
  const bad = document.getElementById('reset-bad');
  const badMsg = document.getElementById('reset-bad-msg');

  const showError = (msg) => {
    if (info) info.style.display = 'none';
    if (form) form.style.display = 'none';
    if (bad) bad.style.display = '';
    if (badMsg) badMsg.textContent = msg;
  };

  apiGet(`/api/auth/reset-password/${encodeURIComponent(token)}`).then((data) => {
    if (info) {
      const name = data.display_name || data.username || '';
      info.textContent = name
        ? tx('resetPasswordFor', 'Resetting password for {name}').replace('{name}', name)
        : tx('resetPasswordReady', 'Choose a new password.');
      info.removeAttribute('data-loading');
    }
    if (form) form.style.display = '';
    loadConfig().then((config) => {
      const wrap = document.getElementById('reset-recaptcha-wrap');
      if (wrap && config?.recaptchaSiteKey) {
        loadRecaptchaAndRender(config.recaptchaSiteKey, wrap).then((id) => { wrap._widgetId = id; }).catch(() => {});
      }
    });
  }).catch((err) => {
    showError(err?.message || tx('resetPasswordInvalidLink', 'This reset link is invalid or has expired.'));
  });

  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const errEl = form.querySelector('#auth-error');
      if (errEl) errEl.textContent = '';
      const pw = form.reset_password?.value || '';
      const pw2 = form.reset_password_confirm?.value || '';
      if (!pw || pw.length < 6) { errEl.textContent = tx('passwordTooShort', 'Password must be at least 6 characters'); return; }
      if (pw !== pw2) { errEl.textContent = t('passwordsDoNotMatch'); return; }
      let recaptchaToken = null;
      if (state.recaptchaSiteKey && window.grecaptcha) {
        const wrap = document.getElementById('reset-recaptcha-wrap');
        try {
          recaptchaToken = wrap?._widgetId != null ? window.grecaptcha.getResponse(wrap._widgetId) : window.grecaptcha.getResponse();
        } catch { recaptchaToken = ''; }
        if (!recaptchaToken) { errEl.textContent = 'Please complete the reCAPTCHA check.'; return; }
      }
      try {
        const body = { token, password: pw };
        if (recaptchaToken != null) body.recaptcha_token = recaptchaToken;
        await apiPost('/api/auth/reset-password', body);
        showToast(tx('resetPasswordSuccess', 'Password updated. Please log in with your new password.'), 'success');
        navigateTo('/login');
      } catch (err) {
        if (errEl) errEl.textContent = err?.message || 'Failed to reset password';
      }
    };
  }
}

function authTransition(container, fromSignup, toSignup, authError, redirect) {
  const box = container.querySelector('.auth-box');
  const form = container.querySelector('#auth-form');
  if (!box || !form) return;
  const formContent = form;
  const beforeHeight = box.offsetHeight;

  formContent.classList.add('auth-content-vanish');
  formContent.offsetHeight;

  formContent.addEventListener('transitionend', function onVanish(e) {
    if (e.target !== formContent || e.propertyName !== 'opacity') return;
    formContent.removeEventListener('transitionend', onVanish);

    const errEl = form.querySelector('#auth-error');
    const fieldsLogin = form.querySelector('#auth-fields-login');
    const fieldsRegister = form.querySelector('#auth-fields-register');
    const submitBtn = form.querySelector('#auth-submit');
    const switchP = form.querySelector('.auth-switch');

    if (errEl) errEl.textContent = authError || '';
    if (fieldsLogin) fieldsLogin.style.display = toSignup ? 'none' : 'block';
    if (fieldsRegister) fieldsRegister.style.display = toSignup ? 'block' : 'none';
    if (submitBtn) submitBtn.textContent = toSignup ? 'Sign up' : 'Login';
    if (switchP) {
      switchP.innerHTML = toSignup ? 'Already have an account? ' : "Don't have an account? ";
      const link = document.createElement('a');
      link.href = authPath(toSignup ? 'login' : 'signup', redirect);
      link.className = 'auth-switch-link';
      link.textContent = toSignup ? 'Log in' : 'Sign up';
      switchP.appendChild(link);
    }

    const afterHeight = box.offsetHeight;
    if (beforeHeight !== afterHeight) {
      box.style.height = beforeHeight + 'px';
      box.style.overflow = 'hidden';
      box.style.transition = 'height 0.25s ease';
      box.offsetHeight;
      box.style.height = afterHeight + 'px';
      box.addEventListener('transitionend', function onResize(e) {
        if (e.target !== box || e.propertyName !== 'height') return;
        box.removeEventListener('transitionend', onResize);
        box.style.height = '';
        box.style.overflow = '';
        box.style.transition = '';
        formContent.classList.remove('auth-content-vanish');
        formContent.classList.add('auth-content-appear');
        formContent.offsetHeight;
        formContent.addEventListener('transitionend', function onAppear(ev) {
          if (ev.target !== formContent || ev.propertyName !== 'opacity') return;
          formContent.removeEventListener('transitionend', onAppear);
          formContent.classList.remove('auth-content-appear');
        });
      });
    } else {
      formContent.classList.remove('auth-content-vanish');
      formContent.classList.add('auth-content-appear');
      formContent.offsetHeight;
      formContent.addEventListener('transitionend', function onAppear(ev) {
        if (ev.target !== formContent || ev.propertyName !== 'opacity') return;
        formContent.removeEventListener('transitionend', onAppear);
        formContent.classList.remove('auth-content-appear');
      });
    }
  });

  bindAuth(toSignup);
}

/** Load reCAPTCHA script and render widget into container. Resolves when widget is ready. */
function loadRecaptchaAndRender(siteKey, container) {
  return new Promise((resolve, reject) => {
    if (window.grecaptcha && window.grecaptcha.render) {
      try {
        const widgetId = window.grecaptcha.render(container, { sitekey: siteKey, theme: 'light' });
        resolve(widgetId);
      } catch (err) {
        reject(err);
      }
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?onload=__recaptchaOnLoad&render=explicit';
    script.async = true;
    script.defer = true;
    window.__recaptchaOnLoad = () => {
      try {
        const widgetId = window.grecaptcha.render(container, { sitekey: siteKey, theme: 'light' });
        resolve(widgetId);
      } catch (err) {
        reject(err);
      }
    };
    document.head.appendChild(script);
  });
}

function showRecoveryModal() {
  const old = document.getElementById('jq-recovery-modal');
  if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'jq-recovery-modal';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px)';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1a1028;border:1px solid rgba(136,65,214,.4);border-radius:16px;padding:24px;max-width:520px;width:100%;color:#e0e0e8;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto';
  ov.appendChild(box);
  document.body.appendChild(ov);

  const closeXBtn = document.createElement('button');
  closeXBtn.textContent = '\u00D7';
  closeXBtn.setAttribute('aria-label', 'Close');
  closeXBtn.style.cssText = 'position:absolute;top:6px;right:10px;background:transparent;border:0;color:rgba(255,255,255,.5);font-size:24px;cursor:pointer;line-height:1';
  closeXBtn.onclick = () => ov.remove();
  box.style.position = 'relative';
  box.appendChild(closeXBtn);

  let recoveryToken = null;
  let recognition = null;
  let username = null;
  let frozen = false;

  function clearBox() {
    const children = Array.from(box.children).filter(c => c !== closeXBtn);
    children.forEach(c => c.remove());
  }
  function addH(text) {
    const h = document.createElement('h2');
    h.style.cssText = 'margin:0 0 12px;font-size:19px;font-weight:700;color:#a78bfa';
    h.textContent = text;
    box.appendChild(h);
    return h;
  }
  function addP(html) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:0 0 12px;font-size:13px;line-height:1.55;color:rgba(255,255,255,.8)';
    p.innerHTML = html;
    box.appendChild(p);
    return p;
  }
  function addInput(opts) {
    const i = document.createElement('input');
    i.type = opts.type || 'text';
    i.placeholder = opts.placeholder || '';
    if (opts.maxlength) i.maxLength = opts.maxlength;
    if (opts.inputmode) i.inputMode = opts.inputmode;
    if (opts.pattern) i.pattern = opts.pattern;
    if (opts.value) i.value = opts.value;
    i.style.cssText = (opts.style || '') + 'width:100%;padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:10px;font-family:inherit;font-size:14px;outline:none;box-sizing:border-box;margin-bottom:10px';
    box.appendChild(i);
    return i;
  }
  function addBtn(label, primary) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = primary
      ? 'width:100%;padding:11px;background:linear-gradient(135deg,#8841d6,#6d28d9);border:0;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:8px'
      : 'width:100%;padding:9px;background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:10px;font-size:13px;cursor:pointer;font-family:inherit;margin-bottom:8px';
    box.appendChild(b);
    return b;
  }
  function addLink(label) {
    const a = document.createElement('a');
    a.textContent = label;
    a.href = '#';
    a.style.cssText = 'display:inline-block;color:#a78bfa;font-size:12px;text-decoration:underline;cursor:pointer;margin-top:6px';
    a.onclick = (e) => e.preventDefault();
    box.appendChild(a);
    return a;
  }
  function addErr() {
    const e = document.createElement('div');
    e.style.cssText = 'color:#ff7a7a;font-size:13px;min-height:18px;margin:-4px 0 8px';
    box.appendChild(e);
    return e;
  }
  function addOk() {
    const e = document.createElement('div');
    e.style.cssText = 'color:#7affa0;font-size:13px;min-height:18px;margin:-4px 0 8px';
    box.appendChild(e);
    return e;
  }

  // Step 1: enter key
  function stepEnterKey(initialError) {
    clearBox();
    addH('Recover Account');
    addP('Enter your <strong>account key</strong> or <strong>payment key</strong> to recover access to your account.');
    addP('<span style="color:rgba(255,255,255,.6);font-size:12px"><strong style="color:#fbbf24">Account key:</strong> almost gives access \u2014 still requires a code from your email.<br><strong style="color:#ff7a7a">Payment key:</strong> gives <strong>FULL</strong> access \u2014 immediate password reset.</span>');
    const input = addInput({ placeholder: 'paste your key here', style: 'font-family:monospace;font-size:13px' });
    const err = addErr();
    if (initialError) err.textContent = initialError;
    const submit = addBtn('Continue', true);
    submit.onclick = async () => {
      err.textContent = '';
      const k = (input.value || '').trim();
      if (k.length < 20) { err.textContent = 'That does not look like a valid key.'; return; }
      submit.disabled = true; submit.textContent = 'Checking\u2026';
      try {
        const r = await fetch('/api/auth/recover/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: k }),
        });
        const d = await r.json();
        if (!r.ok) {
          err.textContent = d.error || 'Recovery failed.';
          submit.disabled = false; submit.textContent = 'Continue';
          return;
        }
        recoveryToken = d.recovery_token;
        recognition = d.recognition;
        username = d.username;
        frozen = !!d.frozen;
        if (recognition === 'full') stepFullReset();
        else stepHalfEmailEntry();
      } catch (e) {
        err.textContent = 'Network error. Please try again.';
        submit.disabled = false; submit.textContent = 'Continue';
      }
    };
  }

  // Step 2 (half): enter email
  function stepHalfEmailEntry() {
    clearBox();
    addH('Verify your email');
    addP('We recognized your account key for <strong>' + (username || 'this account') + '</strong>. To finish, enter the email on file. We\u2019ll send a 6-digit code to confirm it\u2019s you.');
    const emailIn = addInput({ type: 'email', placeholder: 'your email' });
    const err = addErr();
    const send = addBtn('Send code to my email', true);
    let resendIv = null;
    let resendCount = 0;
    send.onclick = async () => {
      err.textContent = '';
      const email = (emailIn.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter a valid email.'; return; }
      send.disabled = true; send.textContent = 'Sending\u2026';
      try {
        const r = await fetch('/api/auth/recover/send-code', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recovery_token: recoveryToken, email }),
        });
        const d = await r.json();
        if (!r.ok) {
          err.textContent = d.error || 'Could not send code.';
          send.disabled = false; send.textContent = 'Send code to my email';
          return;
        }
        if (d.skipped) { stepFullReset('Your organization blocks external emails, so we\u2019ve skipped email verification. Set a new password below.'); return; }
        stepHalfEnterCode(email);
      } catch (e) {
        err.textContent = 'Network error.';
        send.disabled = false; send.textContent = 'Send code to my email';
      }
    };

    const sep = document.createElement('hr');
    sep.style.cssText = 'border:none;border-top:1px solid rgba(255,255,255,.1);margin:12px 0';
    box.appendChild(sep);
    const altLink = addLink('Email was changed, or email inaccessible \u2192');
    altLink.onclick = (e) => { e.preventDefault(); stepHalfFallback(); };
  }

  // Step 2b: enter code
  function stepHalfEnterCode(emailUsed) {
    clearBox();
    addH('Enter the code');
    addP('A 6-digit code was sent to <strong>' + emailUsed + '</strong>. It expires in 2 minutes.');
    const codeIn = addInput({ inputmode: 'numeric', maxlength: 6, pattern: '[0-9]{6}', placeholder: '000000', style: 'font-size:18px;letter-spacing:.4em;text-align:center;font-weight:700' });
    addP('<strong style="color:#e0e0e8">Set a new password:</strong>');
    const pwIn = addInput({ type: 'password', placeholder: 'New password (6+ chars)' });
    const err = addErr();
    const submit = addBtn('Recover & sign in', true);
    submit.onclick = async () => {
      err.textContent = '';
      const code = (codeIn.value || '').trim();
      const pw = pwIn.value || '';
      if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code.'; return; }
      if (pw.length < 6) { err.textContent = 'Password must be 6+ characters.'; return; }
      submit.disabled = true; submit.textContent = 'Recovering\u2026';
      try {
        const r = await fetch('/api/auth/recover/complete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recovery_token: recoveryToken, code, new_password: pw }),
        });
        const d = await r.json();
        if (!r.ok) {
          err.textContent = d.error || 'Recovery failed.';
          submit.disabled = false; submit.textContent = 'Recover & sign in';
          return;
        }
        stepSuccess(d.account_key);
      } catch (e) {
        err.textContent = 'Network error.';
        submit.disabled = false; submit.textContent = 'Recover & sign in';
      }
    };
  }

  // Step 2c: fallback - email changed/inaccessible
  function stepHalfFallback() {
    clearBox();
    addH('Email changed or inaccessible');
    addP('We understand \u2014 sometimes you lose access to the email on file. Two paths forward:');
    addP('<strong style="color:#e0e0e8">A. Use your payment key</strong><br>If you have ever paid for a subscription, your <strong>payment key</strong> gives full account recovery without email verification.');
    const payInput = addInput({ placeholder: 'paste your payment key', style: 'font-family:monospace;font-size:13px' });
    const err = addErr();
    const payBtn = addBtn('Recover with payment key', true);
    payBtn.onclick = async () => {
      err.textContent = '';
      const k = (payInput.value || '').trim();
      if (k.length < 20) { err.textContent = 'That does not look like a valid payment key.'; return; }
      payBtn.disabled = true; payBtn.textContent = 'Verifying\u2026';
      try {
        const r = await fetch('/api/auth/recover/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: k }),
        });
        const d = await r.json();
        if (!r.ok || d.recognition !== 'full') {
          err.textContent = d.error || 'That payment key did not match.';
          payBtn.disabled = false; payBtn.textContent = 'Recover with payment key';
          return;
        }
        recoveryToken = d.recovery_token;
        recognition = 'full';
        stepFullReset();
      } catch (e) {
        err.textContent = 'Network error.';
        payBtn.disabled = false; payBtn.textContent = 'Recover with payment key';
      }
    };

    const moreToggle = document.createElement('details');
    moreToggle.style.cssText = 'margin-top:14px';
    const summary = document.createElement('summary');
    summary.textContent = 'More options';
    summary.style.cssText = 'color:rgba(255,255,255,.6);font-size:12px;cursor:pointer';
    moreToggle.appendChild(summary);
    const moreBox = document.createElement('div');
    moreBox.style.cssText = 'margin-top:10px;padding:10px;background:rgba(255,255,255,.04);border-radius:8px;font-size:12px;line-height:1.5;color:rgba(255,255,255,.7)';
    box.appendChild(moreToggle);
    moreToggle.appendChild(moreBox);

    moreBox.innerHTML = 'Loading email hint\u2026';
    fetch('/api/auth/recover/email-hint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recovery_token: recoveryToken }),
    }).then(r => r.json()).then(d => {
      if (d && d.hint) {
        moreBox.innerHTML = '<p style="margin:0 0 6px"><strong style="color:#e0e0e8">Hint of the email on file:</strong></p><p style="margin:0 0 6px;font-family:monospace;color:#c4b5fd;font-size:13px">' + d.hint + '</p><p style="margin:0;color:rgba(255,255,255,.55)">If this looks like an email you control \u2014 perhaps an alias or an old address you can still log into \u2014 go back and try entering the full address.</p>';
        const cantConfirm = document.createElement('button');
        cantConfirm.textContent = 'Can\u2019t confirm?';
        cantConfirm.style.cssText = 'margin-top:8px;background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.6);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit';
        moreBox.appendChild(cantConfirm);
        cantConfirm.onclick = () => stepCannotConfirm();
      } else {
        moreBox.textContent = 'No additional hints available.';
      }
    }).catch(() => { moreBox.textContent = 'Could not load email hint.'; });

    const back = addLink('\u2190 Back');
    back.onclick = (e) => { e.preventDefault(); stepHalfEmailEntry(); };
  }

  // Step 2d: cannot confirm anything
  function stepCannotConfirm() {
    clearBox();
    addH('Unable to confirm');
    addP('We are sorry. Without access to the email on file <em>and</em> without a payment key, we are unable to identify you as the account owner.');
    addP('<strong style="color:#fbbf24">What you can still do:</strong>');
    addP('\u2022 If you ever <strong>paid</strong> for a subscription, find your payment key (it was shown once during checkout) and try again.<br>\u2022 You may <strong>freeze</strong> the account so the attacker can no longer use it. We will not be able to give it to anyone, including you, until you can prove ownership.');
    const freezeBtn = addBtn('Freeze the account', true);
    freezeBtn.style.background = 'linear-gradient(135deg,#dc2626,#991b1b)';
    freezeBtn.onclick = async () => {
      if (!confirm('Freeze this account? The account will be locked and nobody (including you) can sign in until proof is provided. This will email everyone on the account.')) return;
      try {
        const r = await fetch('/api/auth/recover/freeze', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recovery_token: recoveryToken }),
        });
        const d = await r.json();
        if (!r.ok) { alert(d.error || 'Freeze failed.'); return; }
        clearBox();
        addH('Account frozen');
        addP('The account has been frozen. We have notified the email on file. To unfreeze, you will need a valid payment key.');
        const ok = addBtn('Close', true);
        ok.onclick = () => ov.remove();
      } catch (e) {
        alert('Network error.');
      }
    };
    const back = addLink('\u2190 Back');
    back.onclick = (e) => { e.preventDefault(); stepHalfFallback(); };
  }

  // Step 3 (full): just set new password
  function stepFullReset(msg) {
    clearBox();
    addH('Set a new password');
    addP(msg || 'Your <strong>payment key</strong> is verified. Set a new password and we will sign you in immediately.' + (frozen ? ' This will also <strong>unfreeze</strong> the account.' : ''));
    const pwIn = addInput({ type: 'password', placeholder: 'New password (6+ chars)' });
    const err = addErr();
    const submit = addBtn(frozen ? 'Unfreeze & sign in' : 'Sign in', true);
    submit.onclick = async () => {
      err.textContent = '';
      const pw = pwIn.value || '';
      if (pw.length < 6) { err.textContent = 'Password must be 6+ characters.'; return; }
      submit.disabled = true; submit.textContent = 'Signing in\u2026';
      try {
        const r = await fetch('/api/auth/recover/complete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recovery_token: recoveryToken, new_password: pw }),
        });
        const d = await r.json();
        if (!r.ok) {
          err.textContent = d.error || 'Recovery failed.';
          submit.disabled = false; submit.textContent = frozen ? 'Unfreeze & sign in' : 'Sign in';
          return;
        }
        stepSuccess(d.account_key);
      } catch (e) {
        err.textContent = 'Network error.';
        submit.disabled = false; submit.textContent = frozen ? 'Unfreeze & sign in' : 'Sign in';
      }
    };
  }

  // Final success step
  function stepSuccess(newAccountKey) {
    clearBox();
    addH('Recovered \u2014 you are signed in');
    const ok = addOk();
    ok.textContent = 'Your password has been reset and a fresh account key was issued.';
    if (newAccountKey) {
      addP('<strong style="color:#fbbf24">Save your new account key now:</strong>');
      const keyBox = document.createElement('div');
      keyBox.style.cssText = 'background:#0d0915;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;line-height:1.5;color:#c4b5fd;user-select:all;cursor:text;letter-spacing:.02em;margin-bottom:10px';
      keyBox.textContent = newAccountKey;
      box.appendChild(keyBox);
      const copy = addBtn('Copy new account key', false);
      copy.onclick = () => { try { navigator.clipboard.writeText(newAccountKey); copy.textContent = 'Copied!'; } catch (_) {} };
    }
    const goBtn = addBtn('Continue to chat', true);
    goBtn.onclick = () => {
      ov.remove();
      window.location.reload();
    };
  }

  stepEnterKey();
}

function showAccountKeyModal(key, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const old = document.getElementById('jq-account-key-modal');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'jq-account-key-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px)';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1a1028;border:1px solid rgba(136,65,214,.4);border-radius:16px;padding:28px 24px;max-width:520px;width:100%;color:#e0e0e8;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto';
    const title = document.createElement('h2');
    title.textContent = opts.title || t('akModalTitle');
    title.style.cssText = 'margin:0 0 12px;font-size:20px;font-weight:700;color:#a78bfa';
    box.appendChild(title);
    const warn = document.createElement('div');
    warn.style.cssText = 'margin:0 0 16px;font-size:13px;line-height:1.55;color:rgba(255,255,255,.85)';
    warn.innerHTML = '<strong style="color:#ff7a7a;font-size:14px">' + t('akWarnOnce') + '</strong>'
      + '<p style="margin:10px 0 0">' + t('akIntro') + '</p>'
      + '<p style="margin:8px 0 0"><strong>' + t('akWhatItDoes') + '</strong></p>'
      + '<ul style="margin:4px 0 0;padding-left:18px;color:rgba(255,255,255,.8)">'
      + '<li style="margin-bottom:4px">' + t('akBenefit1') + '</li>'
      + '<li style="margin-bottom:4px">' + t('akBenefit2') + '</li>'
      + '</ul>'
      + '<p style="margin:10px 0 0">' + t('akRisk') + '</p>'
      + '<p style="margin:10px 0 0;color:rgba(255,255,255,.55);font-size:12px">' + t('akStore') + '</p>';
    box.appendChild(warn);
    const keyBox = document.createElement('div');
    keyBox.style.cssText = 'background:#0d0915;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:14px 16px;font-family:monospace;font-size:14px;word-break:break-all;line-height:1.6;color:#c4b5fd;user-select:all;cursor:text;letter-spacing:.02em';
    keyBox.textContent = key;
    box.appendChild(keyBox);
    const copyBtn = document.createElement('button');
    copyBtn.textContent = t('akCopyBtn');
    copyBtn.style.cssText = 'margin-top:14px;width:100%;padding:10px;background:linear-gradient(135deg,#8841d6,#6d28d9);border:0;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit';
    copyBtn.onclick = () => {
      try {
        navigator.clipboard.writeText(key).then(() => {
          copyBtn.textContent = t('akCopiedBtn');
          setTimeout(() => { copyBtn.textContent = t('akCopyBtn'); }, 2000);
        });
      } catch (_) {}
    };
    box.appendChild(copyBtn);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = t('akSavedBtn');
    closeBtn.style.cssText = 'margin-top:8px;width:100%;padding:10px;background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:10px;font-size:13px;cursor:pointer;font-family:inherit';
    closeBtn.onclick = () => { ov.remove(); resolve(); };
    box.appendChild(closeBtn);
    const footer = document.createElement('p');
    footer.style.cssText = 'margin:14px 0 0;font-size:11px;color:rgba(255,255,255,.4);text-align:center';
    footer.textContent = opts.footer || t('akFooterDefault');
    box.appendChild(footer);
    ov.appendChild(box);
    document.body.appendChild(ov);
  });
}

function showViewAccountKeyModal() {
  const old = document.getElementById('jq-view-key-modal');
  if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'jq-view-key-modal';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px)';
  const box = document.createElement('div');
  box.style.cssText = 'position:relative;background:#1a1028;border:1px solid rgba(136,65,214,.4);border-radius:16px;padding:24px;max-width:480px;width:100%;color:#e0e0e8;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto';
  ov.appendChild(box);
  document.body.appendChild(ov);
  const closeXBtn = document.createElement('button');
  closeXBtn.textContent = '\u00D7';
  closeXBtn.style.cssText = 'position:absolute;top:6px;right:10px;background:transparent;border:0;color:rgba(255,255,255,.5);font-size:24px;cursor:pointer';
  closeXBtn.onclick = () => ov.remove();
  box.appendChild(closeXBtn);

  const title = document.createElement('h2');
  title.textContent = t('viewAccountKeyTitle');
  title.style.cssText = 'margin:0 0 12px;font-size:19px;font-weight:700;color:#a78bfa';
  box.appendChild(title);
  const desc = document.createElement('p');
  desc.style.cssText = 'margin:0 0 12px;font-size:13px;line-height:1.5;color:rgba(255,255,255,.75)';
  desc.textContent = t('viewAccountKeyDesc');
  box.appendChild(desc);
  const err = document.createElement('div');
  err.style.cssText = 'color:#ff7a7a;font-size:13px;min-height:18px;margin-bottom:8px';
  box.appendChild(err);
  const sendBtn = document.createElement('button');
  sendBtn.textContent = t('viewAccountKeySendBtn');
  sendBtn.style.cssText = 'width:100%;padding:11px;background:linear-gradient(135deg,#8841d6,#6d28d9);border:0;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:8px';
  box.appendChild(sendBtn);

  let codeIn, viewBtn;
  sendBtn.onclick = async () => {
    err.textContent = '';
    sendBtn.disabled = true; sendBtn.textContent = t('viewAccountKeySendingBtn');
    try {
      const r = await fetch('/api/auth/account-key/request-view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok) {
        err.textContent = d.error || 'Failed to send code.';
        sendBtn.disabled = false; sendBtn.textContent = t('viewAccountKeySendBtn');
        return;
      }
      sendBtn.style.display = 'none';
      if (codeIn) return;
      codeIn = document.createElement('input');
      codeIn.type = 'text'; codeIn.inputMode = 'numeric'; codeIn.maxLength = 6; codeIn.placeholder = '000000';
      codeIn.style.cssText = 'width:100%;padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:10px;font-size:18px;letter-spacing:.4em;text-align:center;font-weight:700;outline:none;box-sizing:border-box;margin-bottom:10px';
      box.insertBefore(codeIn, sendBtn);
      const sub = document.createElement('p');
      sub.textContent = t('viewAccountKeySent');
      sub.style.cssText = 'font-size:12px;color:rgba(255,255,255,.6);margin:-4px 0 8px';
      box.insertBefore(sub, codeIn);
      viewBtn = document.createElement('button');
      viewBtn.textContent = t('viewAccountKeyRevealBtn');
      viewBtn.style.cssText = sendBtn.style.cssText;
      viewBtn.style.display = '';
      box.insertBefore(viewBtn, sendBtn);
      viewBtn.onclick = async () => {
        err.textContent = '';
        const code = (codeIn.value || '').trim();
        if (!/^\d{6}$/.test(code)) { err.textContent = t('viewAccountKeyErrCode'); return; }
        viewBtn.disabled = true; viewBtn.textContent = t('viewAccountKeyVerifyingBtn');
        try {
          const r2 = await fetch('/api/auth/account-key/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
          const d2 = await r2.json();
          if (!r2.ok) { err.textContent = d2.error || 'Failed.'; viewBtn.disabled = false; viewBtn.textContent = t('viewAccountKeyRevealBtn'); return; }
          ov.remove();
          showAccountKeyModal(d2.account_key, { title: t('viewAccountKeyTitle'), footer: t('viewAccountKeyFooter') });
        } catch (e) {
          err.textContent = t('viewAccountKeyErrNetwork'); viewBtn.disabled = false; viewBtn.textContent = t('viewAccountKeyRevealBtn');
        }
      };
    } catch (e) {
      err.textContent = t('viewAccountKeyErrNetwork');
      sendBtn.disabled = false; sendBtn.textContent = t('viewAccountKeySendBtn');
    }
  };
}

function _startResendTimer(resendBtn, timerSpan) {
  let sec = 60;
  resendBtn.disabled = true;
  timerSpan.textContent = sec;
  resendBtn.textContent = `Resend code (${sec}s)`;
  const iv = setInterval(() => {
    sec--;
    if (sec <= 0) {
      clearInterval(iv);
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend code';
      return;
    }
    timerSpan.textContent = sec;
    resendBtn.textContent = `Resend code (${sec}s)`;
  }, 1000);
  return iv;
}

async function _sendVerifyCode(email, errEl) {
  const res = await fetch('/api/auth/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to send code');
  return data;
}

function bindAuth(isSignup) {
  const isRegister = !!isSignup;
  document.querySelectorAll('.auth-box .auth-switch-link').forEach(link => {
    if (link.id === 'auth-recover-link') return;
    link.addEventListener('click', (e) => { e.preventDefault(); navigateTo(link.getAttribute('href')); });
  });
  const recoverLink = document.getElementById('auth-recover-link');
  if (recoverLink) {
    recoverLink.addEventListener('click', (e) => { e.preventDefault(); showRecoveryModal(); });
  }
  const form = document.getElementById('auth-form');
  if (!form) return;
  let recaptchaWidgetId = null;
  let emailCodeSent = false;
  let emailSkipped = false;
  let resendInterval = null;
  if (isRegister) {
    loadConfig().then((config) => {
      const wrap = document.getElementById('auth-recaptcha-wrap');
      if (wrap && config?.recaptchaSiteKey) {
        loadRecaptchaAndRender(config.recaptchaSiteKey, wrap).then((id) => { recaptchaWidgetId = id; }).catch(() => {});
      }
    });
    const emailInput = form.querySelector('input[name="email"]');
    const sendCodeBtn = document.getElementById('auth-send-code');
    const verifyRow = document.getElementById('auth-verify-row');
    const skipNotice = document.getElementById('auth-verify-skip');
    const resendBtn = document.getElementById('auth-resend-code');
    const timerSpan = document.getElementById('auth-resend-timer');
    if (emailInput && sendCodeBtn) {
      sendCodeBtn.style.display = 'block';
      emailInput.addEventListener('input', () => {
        if (emailCodeSent || emailSkipped) {
          emailCodeSent = false;
          emailSkipped = false;
          if (verifyRow) verifyRow.style.display = 'none';
          if (skipNotice) skipNotice.style.display = 'none';
          sendCodeBtn.style.display = 'block';
          if (resendInterval) { clearInterval(resendInterval); resendInterval = null; }
        }
      });
      const doSend = async () => {
        const errEl = document.getElementById('auth-error');
        errEl.textContent = '';
        const email = (emailInput.value || '').trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errEl.textContent = 'Please enter a valid email address.';
          return;
        }
        sendCodeBtn.disabled = true;
        sendCodeBtn.textContent = 'Sending…';
        try {
          const data = await _sendVerifyCode(email, errEl);
          if (data && data.skipped) {
            emailSkipped = true;
            emailCodeSent = false;
            sendCodeBtn.style.display = 'none';
            if (verifyRow) verifyRow.style.display = 'none';
            if (skipNotice) skipNotice.style.display = 'block';
          } else {
            emailCodeSent = true;
            sendCodeBtn.style.display = 'none';
            if (verifyRow) verifyRow.style.display = 'block';
            if (resendBtn && timerSpan) {
              resendInterval = _startResendTimer(resendBtn, timerSpan);
            }
          }
        } catch (err) {
          errEl.textContent = err.message || 'Failed to send code';
        } finally {
          sendCodeBtn.disabled = false;
          sendCodeBtn.textContent = 'Send verification code';
        }
      };
      sendCodeBtn.addEventListener('click', doSend);
      if (resendBtn) {
        resendBtn.addEventListener('click', async () => {
          const errEl = document.getElementById('auth-error');
          errEl.textContent = '';
          const email = (emailInput.value || '').trim();
          resendBtn.disabled = true;
          try {
            await _sendVerifyCode(email, errEl);
            if (timerSpan) resendInterval = _startResendTimer(resendBtn, timerSpan);
          } catch (err) {
            errEl.textContent = err.message || 'Failed to resend code';
            resendBtn.disabled = false;
          }
        });
      }
    }
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    const form = e.target;
    errEl.textContent = '';
    if (isRegister) {
      const display_name = (form.display_name?.value || '').trim();
      const username = (form.reg_username?.value || '').trim().toLowerCase();
      const email = (form.email?.value || '').trim();
      const password = form.reg_password?.value || '';
      const confirm = form.confirm_password?.value || '';
      const email_code = (form.email_code?.value || '').trim();
      if (!display_name) { errEl.textContent = 'Display name is required'; return; }
      if (!username) { errEl.textContent = 'Username is required'; return; }
      if (!email) { errEl.textContent = 'Email is required'; return; }
      if (!emailSkipped) {
        if (!emailCodeSent) { errEl.textContent = 'Please send and enter the email verification code first.'; return; }
        if (!email_code || email_code.length !== 6) { errEl.textContent = 'Please enter the 6-digit verification code.'; return; }
      }
      if (!password) { errEl.textContent = t('passwordRequired'); return; }
      if (password !== confirm) { errEl.textContent = t('passwordsDoNotMatch'); return; }
      let recaptchaToken = null;
      if (state.recaptchaSiteKey && window.grecaptcha) {
        try {
          recaptchaToken = recaptchaWidgetId != null ? window.grecaptcha.getResponse(recaptchaWidgetId) : window.grecaptcha.getResponse();
        } catch { recaptchaToken = ''; }
      }
      if (state.recaptchaSiteKey && !recaptchaToken) {
        errEl.textContent = 'Please complete the reCAPTCHA check.';
        return;
      }
      try {
        const body = { username, email, password, display_name };
        if (!emailSkipped) body.email_code = email_code;
        if (recaptchaToken != null) body.recaptcha_token = recaptchaToken;
        const data = await doLogin(true, body);
        if (data.user) {
          state.user = data.user;
          try {
            await loadGroup();
            await loadUsers();
            await loadFriends();
            await loadBlocks();
            setTimeout(() => connectSocket(), 200);
            if (data.account_key) {
              await showAccountKeyModal(data.account_key);
            }
            navigateTo(getRedirectOrDefault());
        } catch (e) {
          state.user = null;
          state.authError = e.message || 'Session could not be established. Please try again.';
          navigateTo(authPath('login', getPath()));
        }
      } else throw new Error(data.error || 'Sign up failed');
      } catch (err) {
        errEl.textContent = err.message || 'Failed';
        if (state.recaptchaSiteKey && window.grecaptcha && recaptchaWidgetId != null) {
          try { window.grecaptcha.reset(recaptchaWidgetId); } catch (_) {}
        }
      }
      return;
    }
    const usernameOrEmail = (form.login_identifier?.value || '').trim();
    const password = form.login_password?.value || '';
    if (!usernameOrEmail) { errEl.textContent = 'Username or email is required'; return; }
    if (!password) { errEl.textContent = t('passwordRequired'); return; }
    try {
      const data = await doLogin(false, { username: usernameOrEmail, password });
      if (data.user) {
        state.user = data.user;
        try {
          await loadGroup();
          await loadUsers();
          await loadFriends();
          await loadBlocks();
          setTimeout(() => connectSocket(), 200);
          navigateTo(getRedirectOrDefault());
        } catch (e) {
          state.user = null;
          state.authError = e.message || 'Session could not be established. Please try again.';
          navigateTo(authPath('login', getPath()));
        }
      } else throw new Error(data.error || 'Login failed');
    } catch (err) {
      errEl.textContent = err.message || 'Failed';
    }
  };
}

async function doLogin(isRegister, body) {
  const url = isRegister ? '/api/auth/register' : '/api/auth/login';
  let res;
  try {
    res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  } catch (err) {
    throw new Error(err.message || 'Network error. Please check your connection.');
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(res.ok ? 'Invalid response from server.' : 'Login failed. Please try again.');
  }
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed.');
  if (data.user) state.user = data.user;
  return data;
}

function renderMain() {
  const route = parseRoute();
  const page = route.page;
  const primaryNav = getPrimaryNav(route);
  const panels = state.group?.panels || ['announcements', 'free_chat', 'support', 'problem_solving', 'rules'];
  const panelLabels = { free_chat: t('freeChat'), support: t('support'), problem_solving: t('problemSolving'), rules: t('rules'), announcements: t('announcements') };
  const isDocPanel = state.panel === 'problem_solving' || state.panel === 'rules' || state.panel === 'announcements';
  const isGroup = !!route.group;
  const expanded = state.leftBarExpanded;

  const panelExpanded = state.panelColumnExpanded;
  return `
    <div class="app-shell">
      <div class="app-shell-inner">
      <div class="panel-column ${panelExpanded ? 'panel-column-expanded' : ''}" id="panel-column">
        <button type="button" class="panel-column-toggle" id="panel-column-toggle" title="${panelExpanded ? 'Close panels' : 'Open panels'}" aria-label="${panelExpanded ? 'Close panels' : 'Open panels'}">
          <span class="left-bar-icon" aria-hidden="true">${panelExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT}</span>
        </button>
        <div class="panel-column-overlay" id="panel-column-overlay" aria-hidden="true"></div>
        <div class="panel-column-content">
        ${primaryNav === 'home' ? `
        <div class="panel-list">
          <h3 class="panel-list-title">JimmyQrg</h3>
          <ul class="panel-list-ul">
            ${panels.map(p => {
              const isChat = p === 'free_chat' || p === 'support';
              const hasNew = isChat && getNewCount('group', p) > 0;
              return `<li><a href="/chat/group/?panel=${PANEL_TO_URL[p] || p}" class="panel-list-link ${state.panel === p ? 'active' : ''}"><span class="panel-list-hash">#</span> ${escapeHtml(panelLabels[p] || p)}${hasNew ? '<span class="panel-list-badge panel-list-badge-dot" aria-label="New"></span>' : ''}</a></li>`;
            }).join('')}
          </ul>
          <div class="panel-voice-entry">
            <button type="button" id="join-voice-chat" class="panel-voice-btn ${state._voiceJoined ? 'panel-voice-btn-active' : ''}">
              <span class="panel-voice-icon">${ICON_PHONE}</span>
              <span class="panel-voice-text">${state._voiceJoined ? 'Voice Chat' : 'Join Voice Chat'}</span>
              ${state._voiceParticipantCount > 0 ? `<span class="panel-voice-count">${state._voiceParticipantCount}</span>` : ''}
            </button>
          </div>
          </div>
        ` : ''}
        ${primaryNav === 'chat' ? `
        <div class="panel-list panel-list-users">
          <div class="panel-list-header">
            <h3 class="panel-list-title">${t('chat')}</h3>
            <button type="button" class="panel-search-btn" id="panel-search-btn" title="Search users">${ICON_SEARCH}</button>
        </div>
          <div class="panel-search-bar ${state.panelSearchOpen ? 'open' : ''}" id="panel-search-bar">
            <input type="search" id="panel-user-search" placeholder="Search users…" />
          </div>
          <ul class="panel-list-ul" id="panel-user-list">
            ${(function() {
              const users = (state.users || []).filter(u => u.id !== state.user?.id && !isBlocked(u.id));
              const convId = (uid) => state.convByUserId[uid];
              const lastMessageAt = (uid) => { const fromApi = state.lastMessageAtByUserId?.[uid]; if (fromApi != null) return fromApi; const c = convId(uid); if (!c) return 0; const list = state.messages['dm:' + c]; return list?.length ? Math.max(...list.map(m => m.created_at || 0)) : 0; };
              const newCount = (uid) => { const c = convId(uid); return c ? getNewCount('dm', c) : 0; };
              const name = (u) => (u.display_name || u.username || '').toLowerCase();
              /* Private chat list order: pinned users (Helper, JimmyQrg) > last chat time (recent first) > new message count (high first) > alphabetical */
              users.sort((a, b) => {
                const pa = userSortPriority(a.id), pb = userSortPriority(b.id);
                if (pa !== pb) return pa - pb;
                const at = lastMessageAt(a.id), bt = lastMessageAt(b.id);
                if (bt !== at) return bt - at;
                const an = newCount(a.id), bn = newCount(b.id);
                if (bn !== an) return bn - an;
                return name(a).localeCompare(name(b));
              });
              return users.map(u => {
                const friend = isFriend(u.id);
                const defAv = getDefaultAvatarUrl(u.id);
                const avSrc = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : defAv;
                const n = newCount(u.id);
                const badge = n > 0 ? `<span class="panel-list-badge panel-list-badge-count" aria-label="${n} new">${n > 99 ? '99+' : n}</span>` : '';
                const chatHref = `/chat/${encodeURIComponent(u.id)}${friend ? '' : '?view=profile'}`;
                const tag = userTag(u.id);
                return `
              <li><a href="${chatHref}" class="panel-list-link ${state.dmUserId === u.id ? 'active' : ''}" data-user-id="${escapeHtml(u.id)}" data-username="${escapeHtml((u.username || '').toLowerCase())}" data-display="${escapeHtml(name(u))}" data-friend="${friend ? '1' : '0'}">
                <span class="panel-user-avatar-wrap" data-user-id="${escapeHtml(u.id)}" title="View profile"><img src="${avSrc}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="panel-user-avatar" /></span>
                <span class="panel-list-link-text">${escapeHtml(u.display_name || u.username)}</span>${tag}${badge}
              </a></li>
            `; }).join('');
            })()}
          </ul>
        </div>
      ` : ''}
        ${primaryNav === 'admin' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">${t('admin')}</h3>
          <a href="/manage?tab=action" class="panel-tab ${(route.adminTab || 'action') === 'action' ? 'active' : ''}">${t('action')}</a>
          <a href="/manage?tab=users" class="panel-tab ${route.adminTab === 'users' ? 'active' : ''}">${tx('users', 'Users')}</a>
          <a href="/manage?tab=recalled" class="panel-tab ${route.adminTab === 'recalled' ? 'active' : ''}">${t('recalled')}</a>
          ${state.user?.can_timeout ? `<a href="/manage?tab=timeout" class="panel-tab ${route.adminTab === 'timeout' ? 'active' : ''}">${t('timeout')}</a>` : ''}
          <a href="/manage?tab=moderation" class="panel-tab ${route.adminTab === 'moderation' ? 'active' : ''}">${tx('adminModeration', 'Moderation')}${(state._reportCounts?.open || 0) > 0 ? `<span class="panel-list-badge panel-list-badge-count">${state._reportCounts.open > 99 ? '99+' : state._reportCounts.open}</span>` : ''}</a>
          ${state.user?.id === 'jimmyqrg' ? `<a href="/manage?tab=export" class="panel-tab ${route.adminTab === 'export' ? 'active' : ''}">${tx('adminExportTab', 'Export')}</a>` : ''}
        </div>
        ` : ''}
        ${primaryNav === 'settings' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">${t('settings')}</h3>
          <a href="/settings?tab=general" class="panel-tab ${route.tab === 'general' ? 'active' : ''}">${t('general')}</a>
          <a href="/settings?tab=profile" class="panel-tab ${(route.tab || 'profile') === 'profile' ? 'active' : ''}">${t('profile')}</a>
          <a href="/settings?tab=notifications" class="panel-tab ${route.tab === 'notifications' ? 'active' : ''}">${t('notifications')}</a>
          <a href="/settings?tab=account" class="panel-tab ${route.tab === 'account' ? 'active' : ''}">${t('account')}</a>
        </div>
        ` : ''}
        ${primaryNav === 'inbox' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">${t('inbox')}</h3>
        </div>
        ` : ''}
        ${primaryNav === 'collections' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">${tx('collections', 'Collections')}</h3>
        </div>
        ` : ''}
        </div>
      </div>

      ${renderDmVoiceOverlay()}
      ${renderDmVoiceModals()}

      <div class="main-content">
        <div class="main-content-body">
          ${primaryNav === 'home' ? (state._voiceJoined && state.panel === 'voice_chat' ? renderVoiceChatArea() : isGroup && (state.panel === 'free_chat' || state.panel === 'support') ? renderChatArea() : isGroup && isDocPanel ? renderDocArea() : `<div class="empty-state">${t('selectPanel')}</div>`) : ''}
          ${primaryNav === 'chat' ? (state.dmUserId ? renderChatArea() : `<div class="empty-state"><i class="fas fa-comments empty-state-icon" aria-hidden="true"></i><span>${t('selectConversation')}</span></div>`) : ''}
          ${primaryNav === 'inbox' ? renderInboxContent() : ''}
          ${primaryNav === 'collections' ? renderCollectionsContent() : ''}
          ${primaryNav === 'admin' ? renderAdminContent() : ''}
          ${primaryNav === 'settings' ? renderSettingsContent() : ''}
        </div>
      </div>
      </div>

      <aside class="left-bar ${expanded ? 'left-bar-expanded' : ''}" id="left-bar">
        <div class="left-bar-avatar">
          <a href="/settings?tab=profile" class="left-bar-avatar-link" title="${t('profile')}">
            <img src="${getCurrentUserAvatarUrl()}" data-fallback="${getDefaultAvatarUrl(state.user?.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
          </a>
        </div>
        <nav class="left-bar-nav" aria-label="Main">
          <a href="/chat/group/" class="left-bar-item ${primaryNav === 'home' ? 'active' : ''}" title="Home (JimmyQrg group chat)">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_HOME}</span>${hasNewGroupMessages() ? '<span class="left-bar-badge left-bar-badge-dot" aria-label="New messages"></span>' : ''}</span>
            <span class="left-bar-label">${t('home')}</span>
          </a>
          <a href="/chat" class="left-bar-item ${primaryNav === 'chat' ? 'active' : ''}" title="${t('chat')} (private messages)">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_CHAT}</span>${(function(){ const n = getTotalNewDmCount(); return n > 0 ? `<span class="left-bar-badge left-bar-badge-count" aria-label="${n} new">${n > 99 ? '99+' : n}</span>` : ''; })()}</span>
            <span class="left-bar-label">${t('chat')}</span>
          </a>
          <a href="/inbox" class="left-bar-item ${primaryNav === 'inbox' ? 'active' : ''}" title="${t('inbox')}">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_INBOX}</span>${(function(){ const n = getUnreadInboxCount(); return n > 0 ? `<span class="left-bar-badge left-bar-badge-count" aria-label="${n} unread">${n > 99 ? '99+' : n}</span>` : ''; })()}</span>
            <span class="left-bar-label">${t('inbox')}</span>
          </a>
          <a href="/collections" class="left-bar-item ${primaryNav === 'collections' ? 'active' : ''}" title="${tx('collections', 'Collections')}">
            <span class="left-bar-icon" aria-hidden="true">${ICON_COLLECTION}</span>
            <span class="left-bar-label">${tx('collections', 'Collections')}</span>
          </a>
          ${state.user?.is_allowed ? `
          <a href="/manage" class="left-bar-item ${primaryNav === 'admin' ? 'active' : ''}" title="Admin">
            <span class="left-bar-icon" aria-hidden="true">${ICON_ADMIN}</span>
            <span class="left-bar-label">${t('admin')}</span>
          </a>
          ` : ''}
          <a href="/settings?tab=profile" class="left-bar-item ${primaryNav === 'settings' ? 'active' : ''}" title="${t('settings')}">
            <span class="left-bar-icon" aria-hidden="true">${ICON_SETTINGS}</span>
            <span class="left-bar-label">${t('settings')}</span>
          </a>
          ${isNativeApp() ? '' : `
          <a href="/install/" target="_self" class="left-bar-item" title="Install the app">
            <span class="left-bar-icon" aria-hidden="true">${ICON_DOWNLOAD}</span>
            <span class="left-bar-label">${tx('install', 'Install')}</span>
          </a>
          `}
        </nav>
        <div class="left-bar-bottom">
          <button type="button" class="left-bar-expand" id="left-bar-expand" title="${expanded ? t('collapse') : t('expand')}">
            <span class="left-bar-icon" aria-hidden="true">${expanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT}</span>
            <span class="left-bar-label">${expanded ? t('collapse') : t('expand')}</span>
          </button>
        </div>
        </aside>
      ${state._recording ? `
      <div id="recording-overlay" class="recording-overlay">
        <div class="recording-overlay-backdrop"></div>
        <div class="recording-overlay-content">
          <p class="recording-overlay-title">${t('recording')}</p>
          <div class="recording-overlay-actions">
            <button type="button" id="recording-cancel" class="btn-secondary"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${t('cancel')}</button>
            <button type="button" id="recording-send" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_SEND_SM}</span>${t('send')}</button>
          </div>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

const ICON_HOME = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
const ICON_CHAT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_INBOX = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
const ICON_ADMIN = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const ICON_SETTINGS = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-1.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h1.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v1.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-1.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICON_COLLECTION = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
// True when running inside a packaged desktop/mobile app (not the website).
// The "Install" left-bar item is hidden in native apps since the user has
// already installed it.
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  || /JimmyQrgChatMac/i.test(navigator.userAgent || '');
const ICON_CHEVRON_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_CHEVRON_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_CHEVRON_DOWN_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const ICON_SEARCH = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const ICON_MIC = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
const ICON_COMMAND = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/></svg>';
// Google Material Symbols (filled, 24dp) for the media popup controls.
const ICON_PLAY = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const ICON_PREV = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>';
const ICON_NEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
const ICON_REWIND = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';
const ICON_FORWARD = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="transform:scaleX(-1)"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';
const ICON_FULLSCREEN = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
const ICON_FULLSCREEN_EXIT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';
const ICON_CLOSE = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const ICON_ELLIPSIS_V = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
const ICON_USERS = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const ICON_SEARCH_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const ICON_TRASH = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
const ICON_EXTERNAL = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>';
const ICON_SEND = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
const ICON_CHECK_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_X_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const ICON_EDIT_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
const ICON_CHAT_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_SEND_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
const ICON_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
// Active-run dot for the session picker (SVG so it renders crisply everywhere;
// <option> can't contain markup, so the picker is a custom listbox now).
const ICON_ACTIVE_DOT = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="4"/></svg>';
const ICON_CHEVRON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

// ── Venory (helper) owner-only controls + live status ───────────────────────
// Owner id matches the server's OPENCLAW_OWNER_ID. The helper bot is the
// "Venory" assistant user. Model/effort lists mirror server/index.js
// (OPENCLAW_MODELS / OPENCLAW_EFFORTS) for the picker.
const OPENCLAW_OWNER_ID = 'jimmyqrg';
const HELPER_BOT_ID = 'helper';
const OPENCLAW_MODELS = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  // claude-cli/claude-opus-4-8 removed: the gateway rejects it for agent
  // 'main' ("not allowed"), so selecting it broke every send with a 400.
];
const OPENCLAW_EFFORTS = [
  { id: 'off', label: 'Off' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'adaptive', label: 'Adaptive' },
  { id: 'max', label: 'Max' },
  { id: 'ultra', label: 'Ultra' },
];
const ICON_USER_PLUS_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>';
const ICON_BAN_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
const ICON_KEY_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.3 9.3"/><path d="m18.5 5.5 3 3"/></svg>';
const ICON_LOG_OUT_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>';
const ICON_LOG_IN_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>';
const ICON_MOON_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
const ICON_MAP_PIN_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
const ICON_BUILDING_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>';
const ICON_CLOCK_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const ICON_MEGAPHONE_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>';
const ICON_UNLOCK_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
const ICON_USER_MINUS_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/></svg>';
const ICON_USER_CHECK_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>';
const ICON_USER_X_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/></svg>';
const ICON_ROTATE_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const ICON_BELL_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const ICON_BELL_OFF_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8c0 4.5 1.6 7 2.7 8.4"/><path d="M3 3l18 18"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M17 17H3s3-2 3-9c0-.7.1-1.4.3-2"/></svg>';
const ICON_MAIL_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
const ICON_SHIELD_X_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="9" x2="15" y1="9" y2="15"/><line x1="15" x2="9" y1="9" y2="15"/></svg>';
const ICON_PIN_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="17" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';

const ICON_MIC_ON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
const ICON_MIC_OFF = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
const ICON_CAM_ON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>';
const ICON_CAM_OFF = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/></svg>';
const ICON_SCREEN_SHARE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><polyline points="8 21 12 21 16 21"/><line x1="12" x2="12" y1="17" y2="21"/><path d="m17 8 5-5"/><path d="M17 3h5v5"/></svg>';
const ICON_SCREEN_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><polyline points="8 21 12 21 16 21"/><line x1="12" x2="12" y1="17" y2="21"/><line x1="18" x2="22" y1="3" y2="7"/><line x1="22" x2="18" y1="3" y2="7"/></svg>';
const ICON_PHONE_OFF = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/></svg>';
const ICON_USERS_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const ICON_PHONE = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
const ICON_EMOJI = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg>';

function renderProfileView(userId) {
  // Block-private view: server returned 403/private_user for both the
  // profile and the conversation endpoints. Show a notice and stop
  // loading anything else (no avatar, no display name, no username).
  if (state._privateUserView) {
    return `
      <div class="profile-view">
        <div class="profile-view-header">
          <a href="/chat/group/" class="profile-view-back">← ${t('home')}</a>
        </div>
        <div class="private-user-notice">
          <div class="private-user-notice-title">This user is private</div>
          <div class="private-user-notice-sub">You don't have permission to view this profile.</div>
        </div>
      </div>
    `;
  }
  const pv = state._profileView;
  if (!pv || pv.userId !== userId) return '<div class="profile-view-loading">' + t('loading') + '</div>';
  if (pv.error) return `<div class="profile-view-error">${escapeHtml(pv.error)}</div>`;
  if (pv.loading || !pv.profile) return '<div class="profile-view-loading">' + t('loading') + '</div>';
  const profile = pv.profile;
  const avatarUrl = (profile.avatar_url && String(profile.avatar_url).trim()) ? profile.avatar_url : getDefaultAvatarUrl(profile.id);
  const chatHref = `/chat/${encodeURIComponent(userId)}`;
  return `
    <div class="profile-view">
      <div class="profile-view-header">
        <a href="${chatHref}" class="profile-view-back">← ${t('chat')}</a>
      </div>
      <div class="profile-view-body settings-form">
        <div class="profile-view-avatar-wrap">
          <img src="${escapeHtml(avatarUrl)}" data-fallback="${getDefaultAvatarUrl(profile.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="profile-view-avatar" />
        </div>
        <div class="profile-view-field">
          <span class="profile-view-label">${t('displayName')}</span>
          <span class="profile-view-value">${escapeHtml(profile.display_name || profile.username || '')}</span>
        </div>
        <div class="profile-view-field">
          <span class="profile-view-label">${t('username')}</span>
          <span class="profile-view-value">@${escapeHtml(profile.username || '')}</span>
        </div>
        ${profile.description ? `
        <div class="profile-view-field">
          <span class="profile-view-label">${t('description')}</span>
          <span class="profile-view-value">${escapeHtml(profile.description)}</span>
        </div>
        ` : ''}
        ${profile.website ? `
        <div class="profile-view-field">
          <span class="profile-view-label">${t('website')}</span>
          <span class="profile-view-value"><a href="${escapeHtml(profile.website)}" target="_blank" rel="noopener">${escapeHtml(profile.website)}</a></span>
        </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderVoiceChatArea() {
  const participants = state._voiceParticipants || [];
  const sidePanel = state._voiceSidePanel;
  const me = participants.find(p => p.id === state.user?.id);
  const screenSharer = participants.find(p => p.media?.screen);

  const gridCount = participants.length || 1;
  let cols = 1;
  if (gridCount === 2) cols = 2;
  else if (gridCount <= 4) cols = 2;
  else if (gridCount <= 9) cols = 3;
  else cols = 4;

  const participantTiles = participants.map(p => {
    const isSelf = p.id === state.user?.id;
    const defAv = getDefaultAvatarUrl(p.id);
    const av = p.avatar_url || defAv;
    const hasVideo = isSelf ? state._voiceCamOn : p.media?.video;
    const hasScreen = p.media?.screen;
    const hasMic = isSelf ? state._voiceMicOn : p.media?.audio;
    return `
      <div class="vc-tile ${hasScreen ? 'vc-tile-screen' : ''}" data-user-id="${escapeHtml(p.id)}">
        <div class="vc-tile-video-wrap" id="voice-remote-${escapeHtml(p.id)}">
          ${isSelf ? `<video id="voice-local-video" autoplay playsinline muted style="${hasVideo ? '' : 'display:none'}"></video>` : ''}
        </div>
        <div class="vc-tile-avatar" style="${hasVideo || hasScreen ? 'display:none' : ''}">
          <img src="${av}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
        </div>
        <div class="vc-tile-bar">
          <span class="vc-tile-name">${escapeHtml(p.display_name || p.username || '')}</span>
          <span class="vc-tile-mic ${hasMic ? '' : 'vc-muted'}" aria-label="${hasMic ? 'Mic on' : 'Mic off'}">${hasMic ? ICON_MIC_ON : ICON_MIC_OFF}</span>
        </div>
      </div>`;
  }).join('');

  const voiceMessages = state._voiceChatMessages || [];
  const chatPanel = sidePanel === 'chat' ? `
    <div class="vc-side-panel vc-side-chat">
      <div class="vc-side-header">
        <span class="vc-side-title">Chat</span>
        <button type="button" class="vc-side-close" id="vc-side-close">${ICON_X_SM}</button>
      </div>
      <div class="vc-chat-messages" id="voice-chat-messages">
        ${voiceMessages.map(m => `
          <div class="vc-chat-msg">
            <span class="vc-chat-sender">${escapeHtml(m.display_name || m.username || '')}</span>
            <span class="vc-chat-text">${escapeHtml(m.content || '')}</span>
          </div>`).join('') || '<div class="vc-chat-empty">No messages yet.</div>'}
      </div>
      <div class="vc-chat-composer">
        <input type="text" id="vc-chat-input" placeholder="Send a message…" autocomplete="off" />
        <button type="button" id="vc-chat-send">${ICON_SEND}</button>
      </div>
    </div>` : '';

  const membersPanel = sidePanel === 'members' ? `
    <div class="vc-side-panel vc-side-members">
      <div class="vc-side-header">
        <span class="vc-side-title">Participants (${participants.length})</span>
        <button type="button" class="vc-side-close" id="vc-side-close">${ICON_X_SM}</button>
      </div>
      <div class="vc-members-list">
        ${participants.map(p => {
          const defAv = getDefaultAvatarUrl(p.id);
          const av = p.avatar_url || defAv;
          const hasMic = p.id === state.user?.id ? state._voiceMicOn : p.media?.audio;
          return `
          <div class="vc-member">
            <img src="${av}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="vc-member-avatar" />
            <span class="vc-member-name">${escapeHtml(p.display_name || p.username || '')}</span>
            <span class="vc-member-mic ${hasMic ? '' : 'vc-muted'}">${hasMic ? ICON_MIC_ON : ICON_MIC_OFF}</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  return `
    <div class="vc-area">
      <div class="vc-main ${sidePanel ? 'vc-main-with-panel' : ''}">
        <div class="vc-grid" style="--vc-cols:${cols}">
          ${participantTiles || '<div class="vc-empty">Waiting for participants…</div>'}
        </div>
        <div class="vc-toolbar">
          <button type="button" class="vc-btn ${state._voiceMicOn ? '' : 'vc-btn-off'}" id="vc-mic" title="${state._voiceMicOn ? 'Mute' : 'Unmute'}">
            <span class="vc-btn-icon">${state._voiceMicOn ? ICON_MIC_ON : ICON_MIC_OFF}</span>
            <span class="vc-btn-label">${state._voiceMicOn ? 'Mute' : 'Unmute'}</span>
          </button>
          <button type="button" class="vc-btn ${state._voiceCamOn ? '' : 'vc-btn-off'}" id="vc-cam" title="${state._voiceCamOn ? 'Stop camera' : 'Start camera'}">
            <span class="vc-btn-icon">${state._voiceCamOn ? ICON_CAM_ON : ICON_CAM_OFF}</span>
            <span class="vc-btn-label">${state._voiceCamOn ? 'Stop video' : 'Start video'}</span>
          </button>
          <div class="vc-btn-group">
            <button type="button" class="vc-btn ${state._voiceScreenOn ? 'vc-btn-active' : ''}" id="vc-screen" title="${state._voiceScreenOn ? 'Stop sharing' : 'Share screen'}">
              <span class="vc-btn-icon">${state._voiceScreenOn ? ICON_SCREEN_STOP : ICON_SCREEN_SHARE}</span>
              <span class="vc-btn-label">${state._voiceScreenOn ? 'Stop share' : 'Share'}</span>
            </button>
          </div>
          <button type="button" class="vc-btn ${sidePanel === 'chat' ? 'vc-btn-active' : ''}" id="vc-chat-toggle" title="Chat">
            <span class="vc-btn-icon">${ICON_CHAT}</span>
            <span class="vc-btn-label">Chat</span>
          </button>
          <button type="button" class="vc-btn ${sidePanel === 'members' ? 'vc-btn-active' : ''}" id="vc-members-toggle" title="Participants">
            <span class="vc-btn-icon">${ICON_USERS_SM}</span>
            <span class="vc-btn-label">Participants</span>
          </button>
          <button type="button" class="vc-btn vc-btn-leave" id="vc-leave" title="Leave">
            <span class="vc-btn-icon">${ICON_PHONE_OFF}</span>
            <span class="vc-btn-label">Leave</span>
          </button>
        </div>
      </div>
      ${chatPanel}${membersPanel}
    </div>`;
}

function renderDmVoiceOverlay() {
  if (!state._dmVoiceJoined) return '';
  const peerId = state._dmVoicePeerUserId;
  const peerName = peerId ? dmVoiceUserName(peerId) : '';
  const defAv = peerId ? getDefaultAvatarUrl(peerId) : '';
  const peerAvatar = peerId ? dmVoiceUserAvatar(peerId) : defAv;
  const peerHasVideo = !!state._dmVoicePeerMedia?.video;
  const peerHasScreen = !!state._dmVoicePeerMedia?.screen;
  const peerHasMic = state._dmVoicePeerMedia?.audio !== false;
  const sidePanel = state._dmVoiceSidePanel;
  const chatMessages = state._dmVoiceChatMessages || [];
  const meId = state.user?.id;

  const chatPanel = sidePanel === 'chat' ? `
    <div class="vc-side-panel vc-side-chat">
      <div class="vc-side-header">
        <span class="vc-side-title">In-call chat</span>
        <button type="button" class="vc-side-close" id="dm-vc-side-close">${ICON_X_SM}</button>
      </div>
      <div class="vc-chat-messages" id="dm-voice-chat-messages">
        ${chatMessages.map(m => `
          <div class="vc-chat-msg">
            <span class="vc-chat-sender">${escapeHtml(m.from === meId ? 'You' : (dmVoiceUserName(m.from) || 'Peer'))}</span>
            <span class="vc-chat-text">${escapeHtml(m.text || '')}</span>
          </div>`).join('') || '<div class="vc-chat-empty">No messages yet.</div>'}
      </div>
      <div class="vc-chat-composer">
        <input type="text" id="dm-vc-chat-input" placeholder="Send a message…" autocomplete="off" />
        <button type="button" id="dm-vc-chat-send">${ICON_SEND}</button>
      </div>
    </div>` : '';

  const membersPanel = sidePanel === 'members' ? `
    <div class="vc-side-panel vc-side-members">
      <div class="vc-side-header">
        <span class="vc-side-title">Participants (2)</span>
        <button type="button" class="vc-side-close" id="dm-vc-side-close">${ICON_X_SM}</button>
      </div>
      <div class="vc-members-list">
        <div class="vc-member">
          <img src="${dmVoiceUserAvatar(meId)}" alt="" class="vc-member-avatar" />
          <span class="vc-member-name">You</span>
          <span class="vc-member-mic ${state._dmVoiceMicOn ? '' : 'vc-muted'}">${state._dmVoiceMicOn ? ICON_MIC_ON : ICON_MIC_OFF}</span>
        </div>
        <div class="vc-member">
          <img src="${peerAvatar}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="vc-member-avatar" />
          <span class="vc-member-name">${escapeHtml(peerName)}</span>
          <span class="vc-member-mic ${peerHasMic ? '' : 'vc-muted'}">${peerHasMic ? ICON_MIC_ON : ICON_MIC_OFF}</span>
        </div>
      </div>
    </div>` : '';

  return `
    <div class="vc-area dm-voice-overlay">
      <div class="vc-main ${sidePanel ? 'vc-main-with-panel' : ''}">
        <div class="vc-grid" style="--vc-cols:1">
          <div class="vc-tile ${peerHasScreen ? 'vc-tile-screen' : ''}" data-user-id="${escapeHtml(peerId || 'peer')}">
            <div class="vc-tile-video-wrap" id="dm-voice-remote">
              <video id="dm-voice-local-video" autoplay playsinline muted style="display:none"></video>
            </div>
            <div class="vc-tile-avatar" style="${peerHasVideo || peerHasScreen ? 'display:none' : ''}">
              <img src="${peerAvatar}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
            </div>
            <div class="vc-tile-bar">
              <span class="vc-tile-name">${escapeHtml(peerName)}</span>
              <span class="vc-tile-mic ${peerHasMic ? '' : 'vc-muted'}" aria-label="${peerHasMic ? 'Mic on' : 'Mic off'}">${peerHasMic ? ICON_MIC_ON : ICON_MIC_OFF}</span>
            </div>
          </div>
        </div>
        <div class="vc-toolbar">
          <button type="button" class="vc-btn ${state._dmVoiceMicOn ? '' : 'vc-btn-off'}" id="dm-vc-mic" title="${state._dmVoiceMicOn ? 'Mute' : 'Unmute'}">
            <span class="vc-btn-icon">${state._dmVoiceMicOn ? ICON_MIC_ON : ICON_MIC_OFF}</span>
            <span class="vc-btn-label">${state._dmVoiceMicOn ? 'Mute' : 'Unmute'}</span>
          </button>
          <button type="button" class="vc-btn ${state._dmVoiceCamOn ? '' : 'vc-btn-off'}" id="dm-vc-cam" title="${state._dmVoiceCamOn ? 'Stop camera' : 'Start camera'}">
            <span class="vc-btn-icon">${state._dmVoiceCamOn ? ICON_CAM_ON : ICON_CAM_OFF}</span>
            <span class="vc-btn-label">${state._dmVoiceCamOn ? 'Stop video' : 'Start video'}</span>
          </button>
          <div class="vc-btn-group">
            <button type="button" class="vc-btn ${state._dmVoiceScreenOn ? 'vc-btn-active' : ''}" id="dm-vc-screen" title="${state._dmVoiceScreenOn ? 'Stop sharing' : 'Share screen'}">
              <span class="vc-btn-icon">${state._dmVoiceScreenOn ? ICON_SCREEN_STOP : ICON_SCREEN_SHARE}</span>
              <span class="vc-btn-label">${state._dmVoiceScreenOn ? 'Stop share' : 'Share'}</span>
            </button>
          </div>
          <button type="button" class="vc-btn ${sidePanel === 'chat' ? 'vc-btn-active' : ''}" id="dm-vc-chat-toggle" title="Chat">
            <span class="vc-btn-icon">${ICON_CHAT}</span>
            <span class="vc-btn-label">Chat</span>
          </button>
          <button type="button" class="vc-btn ${sidePanel === 'members' ? 'vc-btn-active' : ''}" id="dm-vc-members-toggle" title="Participants">
            <span class="vc-btn-icon">${ICON_USERS_SM}</span>
            <span class="vc-btn-label">Participants</span>
          </button>
          <button type="button" class="vc-btn vc-btn-leave" id="dm-vc-leave" title="End call">
            <span class="vc-btn-icon">${ICON_PHONE_OFF}</span>
            <span class="vc-btn-label">End</span>
          </button>
        </div>
      </div>
      ${chatPanel}${membersPanel}
    </div>`;
}

function renderDmVoiceModals() {
  const incoming = state._dmVoiceRinging;
  const outgoing = state._dmVoiceRingingOutgoing;
  if (!incoming && !outgoing) return '';
  if (incoming) {
    const defAv = getDefaultAvatarUrl(incoming.fromUserId);
    const av = incoming.fromAvatarUrl || defAv;
    return `
      <div class="dm-voice-modal-overlay" id="dm-voice-incoming-modal">
        <div class="dm-voice-modal">
          <div class="dm-voice-modal-avatar">
            <img src="${av}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
          </div>
          <div class="dm-voice-modal-name">${escapeHtml(incoming.fromDisplayName || incoming.fromUsername || incoming.fromUserId)}</div>
          <div class="dm-voice-modal-sub">is calling you…</div>
          <div class="dm-voice-modal-actions">
            <button type="button" class="dm-voice-modal-btn dm-voice-modal-decline" id="dm-voice-decline-btn">Decline</button>
            <button type="button" class="dm-voice-modal-btn dm-voice-modal-accept" id="dm-voice-accept-btn">Accept</button>
          </div>
        </div>
      </div>`;
  }
  if (outgoing) {
    const defAv = getDefaultAvatarUrl(outgoing.toUserId);
    const av = dmVoiceUserAvatar(outgoing.toUserId);
    return `
      <div class="dm-voice-modal-overlay" id="dm-voice-outgoing-modal">
        <div class="dm-voice-modal">
          <div class="dm-voice-modal-avatar">
            <img src="${av}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
          </div>
          <div class="dm-voice-modal-name">${escapeHtml(dmVoiceUserName(outgoing.toUserId))}</div>
          <div class="dm-voice-modal-sub">Calling…</div>
          <div class="dm-voice-modal-actions">
            <button type="button" class="dm-voice-modal-btn dm-voice-modal-decline" id="dm-voice-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>`;
  }
  return '';
}

// ── Venory (helper) owner controls + live status helpers ─────────────────────
function isOwner() {
  return state.user?.id === OPENCLAW_OWNER_ID;
}
function isHelperDm() {
  return state.dmUserId === HELPER_BOT_ID;
}
function helperDmKey() {
  return isHelperDm() && state.convId ? roomKey('dm', state.convId) : null;
}
function helperRun() {
  // Helper run state must never paint UIs outside the owner's helper DM
  // (group chats, other DMs, profile views) — even when a session view or
  // picker selection is still set in state.
  if (!isOwner() || !isHelperDm()) return null;
  // Session view: show the run state of the session being VIEWED, never the DM's.
  const viewKey = state.agentSessionView?.key;
  if (viewKey) {
    const srun = state.sessionRuns[viewKey];
    const entry = (state.agentSessions || []).find((s) => s.key === viewKey);
    const active = !!(entry?.hasActiveRun);
    return {
      busy: active || !!(srun?.busy),
      working: active || !!(srun?.working),
      done: !active && !!(srun?.done),
      tools: (srun?.tools || []).slice(),
    };
  }
  const key = helperDmKey();
  return key ? (state.helperRuns[key] || null) : null;
}
function isHelperBusy() {
  return !!(helperRun()?.busy);
}
function agentOptsForSend() {
  return (isOwner() && isHelperDm())
    ? { agent_model: state.agentModel, agent_effort: state.agentEffort }
    : {};
}

// Load (or refresh) the owner's Venory routing mode from the server. Called
// once on connect and again after a mode switch. Non-owner users never call it.
async function loadAgentMode() {
  if (!isOwner()) return;
  try {
    const data = await apiGet('/api/agent-mode');
    state.agentMode = data?.mode === 'basic' ? 'basic' : 'openclaw';
    state.agentBridgeOnline = !!data?.bridgeOnline;
    state.agentBridgeEnabled = !!data?.bridgeEnabled;
  } catch (_) {
    // Keep current state on failure (e.g. bridge/session hiccup).
  }
  updateHelperUiInPlace();
}

// Persist a mode switch to the server and refresh local state from the reply.
async function setAgentMode(mode) {
  if (mode !== 'openclaw' && mode !== 'basic') return;
  const prev = state.agentMode;
  state.agentMode = mode; // optimistic — reflect the click immediately
  updateHelperUiInPlace();
  try {
    const data = await apiPost('/api/agent-mode', { mode });
    state.agentMode = data?.mode === 'basic' ? 'basic' : 'openclaw';
    state.agentBridgeOnline = !!data?.bridgeOnline;
    state.agentBridgeEnabled = !!data?.bridgeEnabled;
  } catch (_) {
    state.agentMode = prev; // revert on failure
  }
  updateHelperUiInPlace();
}

// Auto-update: poll /api/version; when it changes a new deploy is live, so
// reload and pick up the fresh assets. Drafts survive via localStorage and
// polling pauses while the tab is hidden.
function initAutoUpdate() {
  const CHECK_MS = 60000;
  const RELOAD_DELAY_MS = 4000;
  let updating = false;
  const check = async () => {
    if (updating || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    try {
      const res = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      const v = typeof data?.version === 'string' ? data.version : '';
      if (!v) return;
      if (!state.appVersion) { state.appVersion = v; return; } // first read = baseline
      if (v === state.appVersion) return;
      updating = true;
      showToast(tx('appUpdated', 'New version available — reloading…'), 'info');
      setTimeout(() => location.reload(), RELOAD_DELAY_MS);
    } catch (_) { /* transient network hiccup: keep current baseline */ }
  };
  check();
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

// Load (or refresh) the OpenClaw session list + current selection. Owner-only.
async function loadAgentSessions() {
  if (!isOwner()) return;
  try {
    const data = await apiGet('/api/agent-sessions');
    state.agentSessions = Array.isArray(data?.sessions) ? data.sessions : [];
    state.agentSession = typeof data?.current === 'string' ? data.current : '';
  } catch (_) {
    // Keep current state on failure (bridge/session hiccup).
  }
  updateHelperUiInPlace();
  syncSessionView();
}

// Persist a session switch to the server and refresh local state from the reply.
async function setAgentSession(sessionKey) {
  const key = typeof sessionKey === 'string' ? sessionKey : '';
  const prev = state.agentSession;
  state.agentSession = key; // optimistic
  updateHelperUiInPlace();
  try {
    const data = await apiPost('/api/agent-session', { sessionKey: key });
    state.agentSession = typeof data?.current === 'string' ? data.current : '';
  } catch (_) {
    state.agentSession = prev; // revert on failure
  }
  updateHelperUiInPlace();
  syncSessionView(true);
}

// ── OpenClaw session view (page replacement) ────────────────────────────────
// When the owner picks a session in the picker, the DM page is replaced by
// that session's chat history (fetched from the Mac gateway via the bridge).
// The session keeps running on the Mac — switching views never stops it.

function sessionLabelForKey(key) {
  const s = (state.agentSessions || []).find((x) => x.key === key);
  if (s?.label) return s.label;
  const m = String(key || '').match(/^agent:main:(.+)$/);
  const base = m ? m[1] : String(key || '');
  return base.length > 28 ? `${base.slice(0, 25)}…` : base;
}

/** Compact token formatting for the control-bar size badge: 264618 → 264.6k. */
function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Size info for the currently viewed agent session (picker selection, or
 *  the owner's own DM when nothing is selected). */
function sessionSizeInfo() {
  const list = state.agentSessions || [];
  const s = state.agentSession
    ? list.find((x) => x.key === state.agentSession)
    : list.find((x) => x.isDm);
  const total = typeof s?.totalTokens === 'number' ? s.totalTokens : 0;
  const ctx = typeof s?.contextTokens === 'number' && s.contextTokens > 0 ? s.contextTokens : 0;
  const budget = typeof s?.contextTokenBudget === 'number' && s.contextTokenBudget > 0 ? s.contextTokenBudget : 0;
  const limit = budget || ctx; // OpenClaw style: total / context budget
  const label = state.agentSession ? sessionLabelForKey(state.agentSession) : 'This DM (jchat)';
  return { total, ctx, budget, limit, label };
}

/** Gateway session key the Compact button should target. */
function currentAgentSessionKey() {
  if (state.agentSession) return state.agentSession;
  const dm = (state.agentSessions || []).find((x) => x.isDm);
  if (dm?.key) return dm.key;
  return `agent:main:openai-user:jchat:dm:${state.convId || ''}`;
}

/** The gateway session key of the owner's own DM (the jchat conversation).
 *  It's the default "This DM (jchat)" target — shown as the DM view, not a
 *  separate session view. */
function dmSessionKeyFor() {
  return state.convId ? `agent:main:openai-user:jchat:dm:${state.convId}` : '';
}

function isDmSessionKey(key) {
  const dm = dmSessionKeyFor();
  return !!dm && key === dm;
}

/** Keep the page in sync with the selected session: load its history when a
 *  session is selected (replacing the DM view), clear the view otherwise.
 *  The DM session itself always stays on the normal DM view. force=true
 *  always refetches (picker change, even re-selecting the same session). */
function syncSessionView(force) {
  const key = state.agentSession || '';
  const viewing = state.agentSessionView?.key || '';
  if (key && !isDmSessionKey(key)) {
    if (force || key !== viewing || !state.agentSessionView?.loadedAt) {
      loadAgentSessionHistory(key);
    }
  } else if (viewing) {
    state.agentSessionView = null;
    render();
  }
}

let _agentHistoryFetchKey = null;   // in-flight history fetch (key)
let _agentHistoryRefetchTimer = null; // debounced catch-up refetch

async function loadAgentSessionHistory(key) {
  if (!key || !isOwner()) return;
  if (_agentHistoryFetchKey === key) return; // already fetching this session
  const view = state.agentSessionView;
  const isRefresh = view?.key === key && !!view?.loadedAt;
  state.agentSessionView = {
    key,
    label: view?.key === key ? (view.label || sessionLabelForKey(key)) : sessionLabelForKey(key),
    messages: isRefresh ? (view.messages || []) : [],
    loading: !isRefresh,
    refreshing: isRefresh,
    error: '',
    loadedAt: view?.key === key ? view.loadedAt : 0,
    updatedAt: view?.key === key ? (view.updatedAt || 0) : 0,
    _pendingUpdatedAt: view?.key === key ? (view._pendingUpdatedAt || 0) : 0,
    _fetchStartedAt: Date.now(),
  };
  if (!isRefresh) render();
  _agentHistoryFetchKey = key;
  try {
    const data = await apiGet(`/api/agent-session-history?key=${encodeURIComponent(key)}`);
    if (!data?.ok) throw new Error(data?.error || 'Failed to load history');
    if (state.agentSession !== key) return; // switched away meanwhile
    const cur = state.agentSessionView;
    const fetched = normalizeSessionHistory(data.messages || []);
    const fetchStart = cur?._fetchStartedAt || 0;
    // Live messages that arrived after the fetch started may not be in the
    // snapshot — keep them (deduped against the fetched history).
    const pendingLive = (cur?.messages || []).filter((m) => m._live && (m.created_at || 0) > fetchStart);
    state.agentSessionView = {
      key,
      label: sessionLabelForKey(key),
      messages: mergeSessionMessages(fetched, pendingLive),
      loading: false,
      refreshing: false,
      error: '',
      loadedAt: Date.now(),
      updatedAt: Math.max(cur?.updatedAt || 0, cur?._pendingUpdatedAt || 0),
      _pendingUpdatedAt: 0,
      _fetchStartedAt: 0,
    };
  } catch (err) {
    if (state.agentSession !== key) return;
    state.agentSessionView = {
      ...(state.agentSessionView || {}),
      key,
      loading: false,
      refreshing: false,
      error: err?.message || 'Failed to load history',
    };
  } finally {
    if (_agentHistoryFetchKey === key) _agentHistoryFetchKey = null;
  }
  renderKeepingScroll();
}

/** Merge a fresh history snapshot with recently-arrived live messages that
 *  might not be in it yet. Live messages already present in the snapshot
 *  (same role+text within a minute) are dropped. */
function mergeSessionMessages(fetched, pendingLive) {
  if (!pendingLive.length) return fetched;
  const kept = [];
  for (const m of pendingLive) {
    const dup = fetched.some((f) =>
      f._role === m._role && f.content === m.content && Math.abs((f.created_at || 0) - (m.created_at || 0)) < 60000
    );
    if (dup) continue;
    kept.push(m);
  }
  if (!kept.length) return fetched;
  return [...fetched, ...kept].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

/** Debounced catch-up refetch of the viewed session's history. The live
 *  stream covers immediacy; this re-syncs after gaps (bridge reconnects,
 *  subscription races). Keeps re-arming while a fetch would be throttled. */
function scheduleAgentHistoryRefresh() {
  if (_agentHistoryRefetchTimer) clearTimeout(_agentHistoryRefetchTimer);
  const tryRefresh = () => {
    _agentHistoryRefetchTimer = null;
    const view = state.agentSessionView;
    if (!view?.key || view.loading || view.refreshing) return;
    const pending = view._pendingUpdatedAt || 0;
    if (pending <= (view.updatedAt || 0)) return;
    if (view.loadedAt && Date.now() - view.loadedAt < 8000) {
      _agentHistoryRefetchTimer = setTimeout(tryRefresh, 10000); // retry after the throttle window
      return;
    }
    state.agentSessionView._pendingUpdatedAt = 0;
    loadAgentSessionHistory(view.key);
  };
  _agentHistoryRefetchTimer = setTimeout(tryRefresh, 1500);
}

/** Re-render without yanking the user's scroll position (used for live
 *  appends / background refreshes while the user is reading history). */
function renderKeepingScroll() {
  const wrap = document.querySelector('.messages-wrap[data-agent-session-view="1"]');
  if (!wrap) { render(); return; }
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
  if (nearBottom) { render(); return; }
  const prevHeight = wrap.scrollHeight;
  const prevTop = wrap.scrollTop;
  render();
  requestAnimationFrame(() => {
    const w = document.querySelector('.messages-wrap[data-agent-session-view="1"]');
    if (w) w.scrollTop = prevTop + (w.scrollHeight - prevHeight);
  });
}

/** Mirror the owner's own DM text message into the viewed session view
 *  immediately (the gateway echo arrives via the live ring and is deduped). */
function mirrorOwnDmToSessionView(msg) {
  if (!msg || msg.room_type !== 'dm') return;
  if (!isOwner() || !isHelperDm()) return;
  if (!state.agentSessionView?.key) return;
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!content) return;
  // File/image messages mirror as the file itself so the viewed session
  // shows the real attachment, not a text placeholder.
  if (content.startsWith('/file ') && ['image', 'video', 'audio', 'file'].includes(msg.msg_type)) {
    appendAgentSessionLive({ role: 'user', text: '', fileRef: content, msgType: msg.msg_type }, { optimistic: true });
    return;
  }
  if (msg.msg_type !== 'text') return;
  appendAgentSessionLive({ role: 'user', text: content }, { optimistic: true });
}

/** Map gateway transcript messages (role/text/seq/at) to jchat-shaped
 *  message objects so the existing bubble renderer can draw them. */
function helperAvatarUrl() {
  const helperUser = (state.users || []).find((u) => u.id === HELPER_BOT_ID);
  const avatar = (helperUser?.avatar_url && String(helperUser.avatar_url).trim())
    ? helperUser.avatar_url : null;
  if (!avatar) {
    // fallback: any delivered helper DM message carries the joined avatar_url
    const dmKey = state.convId ? roomKey('dm', state.convId) : '';
    const msgs = dmKey ? (state.messages?.[dmKey] || []) : [];
    const hit = [...msgs].reverse().find((m) => m?.sender_id === HELPER_BOT_ID && m?.avatar_url);
    return hit?.avatar_url || '';
  }
  return avatar;
}

function normalizeSessionHistory(messages) {
  const out = [];
  const seenSeqs = new Set();
  let fallbackId = 1;
  const venoryAvatar = helperAvatarUrl();
  const ownAvatar = state.user?.avatar_url || '';
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === 'user' || m?.role === 'assistant' ? m.role : '';
    const text = typeof m?.text === 'string' ? m.text.trim() : '';
    const fileRef = (typeof m?.fileRef === 'string' && m.fileRef.trim().startsWith('/file ')) ? m.fileRef.trim() : '';
    if (!role || (!text && !fileRef)) continue;
    const seq = typeof m?.seq === 'number' ? m.seq : 0;
    if (seq > 0) {
      if (seenSeqs.has(seq)) continue;
      seenSeqs.add(seq);
    }
    const isAssistant = role === 'assistant';
    out.push({
      id: `ags-${seq || fallbackId++}`,
      sender_id: isAssistant ? HELPER_BOT_ID : OPENCLAW_OWNER_ID,
      username: isAssistant ? 'Venory' : (state.user?.username || 'you'),
      display_name: isAssistant ? 'Venory' : (state.user?.display_name || state.user?.username || 'You'),
      avatar_url: isAssistant ? venoryAvatar : ownAvatar,
      content: fileRef || text,
      created_at: typeof m?.at === 'number' && m.at > 0 ? m.at : Date.now(),
      msg_type: fileRef ? (['image', 'video', 'audio', 'file'].includes(m?.msgType) ? m.msgType : 'file') : 'text',
      reactions: [],
    });
  }
  return out;
}

function renderAgentSessionView() {
  const view = state.agentSessionView;
  const key = state.agentSession || '';
  const list = view?.messages || [];
  const loading = !!view?.loading;
  const error = view?.error || '';
  const label = view?.label || sessionLabelForKey(key);
  const emptyContent = loading
    ? Array(5).fill(0).map((_, i) => `
        <div class="message-skeleton" key="${i}">
          <div class="message-skeleton-avatar"></div>
          <div class="message-skeleton-body">
            <div class="message-skeleton-line message-skeleton-line-short"></div>
            <div class="message-skeleton-line"></div>
            <div class="message-skeleton-line message-skeleton-line-medium"></div>
          </div>
        </div>
      `).join('')
    : error
      ? `<div class="messages-empty">Couldn't load this session: ${escapeHtml(error)}</div>`
      : list.length === 0
        ? '<div class="messages-empty">No messages yet in this session.</div>'
        : renderAgentSessionMessages(list);
  const typingHtml = renderTypingIndicator('dm', state.convId);
  const draft = state.dmUserId ? getDraft('dm', state.dmUserId) : '';
  return `
    <div class="chat-area">
      <div class="chat-main">
        <div class="chat-header">
          <div class="chat-header-title">${escapeHtml(label)}</div>
          <span class="chat-header-subtitle"><span class="presence-summary">OpenClaw session on your Mac · DMs here route to it · pick “This DM (jchat)” to return</span></span>
        </div>
        <div class="messages-wrap" data-agent-session-view="1" data-room-type="dm" data-room-id="${escapeHtml(state.convId || '')}">
          ${emptyContent}
        </div>
        <div class="typing-indicator-slot" data-typing-indicator-slot data-room-type="dm" data-room-id="${escapeHtml(state.convId || '')}">${typingHtml}</div>
        <button type="button" class="scroll-to-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" style="display:none">
          <span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></span>
        </button>
        ${renderHelperControlBar()}
        <div class="composer composer-safe-area" id="composer-drop-zone" data-can-send-files="true">
          <div class="composer-row">
            <div class="composer-input-wrap">
              <textarea id="composer-input" placeholder="Message…" rows="1">${escapeHtml(draft)}</textarea>
            </div>
            <div class="composer-actions">
              <button type="button" id="composer-mic" title="Record voice message"><span class="icon" aria-hidden="true">${ICON_MIC}</span></button>
              <button type="button" id="attach-file" title="Attach file"><span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span></button>
              <button type="button" id="composer-emoji" title="Emoji" aria-label="Insert emoji"><span class="icon" aria-hidden="true">${ICON_EMOJI}</span></button>
              <input type="file" id="file-input" class="hidden-input" accept="image/*,video/*,audio/*,*/*" />
            </div>
            ${renderSendButton()}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAgentSessionMessages(list) {
  const todayStr = new Date().toDateString();
  let lastTs = null;
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const t = m.created_at || 0;
    const isToday = t && new Date(t).toDateString() === todayStr;
    const intervalMs = isToday ? TS_INTERVAL_MS : TS_INTERVAL_DAY_MS;
    if (t && (lastTs == null || t - lastTs >= intervalMs)) {
      parts.push(renderTimestamp(t));
      lastTs = t;
    } else if (t) lastTs = t;
    parts.push(renderMessage(m, 'dm', state.convId, { agentSessionView: true }));
  }
  return parts.join('');
}

const _agentSessionLiveDedup = []; // { role, text, at } — recent live msgs
function appendAgentSessionLive({ role, text, fileRef, msgType }, opts = {}) {
  const view = state.agentSessionView;
  if (!view) return;
  const now = Date.now();
  const recent = _agentSessionLiveDedup.filter((x) => now - x.at < 10000);
  _agentSessionLiveDedup.length = 0;
  _agentSessionLiveDedup.push(...recent);
  const key = fileRef || text;
  if (!opts.optimistic && recent.some((x) => x.role === role && x.key === key)) return; // re-emit on reconnect
  _agentSessionLiveDedup.push({ role, key, at: now });
  const isAssistant = role === 'assistant';
  view.messages.push({
    id: `ags-live-${now}-${_agentSessionLiveDedup.length}`,
    sender_id: isAssistant ? HELPER_BOT_ID : OPENCLAW_OWNER_ID,
    username: isAssistant ? 'Venory' : (state.user?.username || 'you'),
    display_name: isAssistant ? 'Venory' : (state.user?.display_name || state.user?.username || 'You'),
    avatar_url: isAssistant ? helperAvatarUrl() : (state.user?.avatar_url || ''),
    content: fileRef || text,
    created_at: now,
    msg_type: fileRef ? (['image', 'video', 'audio', 'file'].includes(msgType) ? msgType : 'file') : 'text',
    reactions: [],
    _live: true,
    _role: role,
  });
  if (view.messages.length > 500) view.messages.splice(0, view.messages.length - 500);
  renderKeepingScroll();
}

function renderHelperControlBar() {
  const run = helperRun();
  const mode = state.agentMode === 'basic' ? 'basic' : 'openclaw';
  const bridgeOnline = state.agentBridgeOnline;
  const modelOptions = OPENCLAW_MODELS.map((m) =>
    `<option value="${m.id}" ${state.agentModel === m.id ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
  ).join('');
  const effortOptions = OPENCLAW_EFFORTS.map((e) =>
    `<option value="${e.id}" ${state.agentEffort === e.id ? 'selected' : ''}>${escapeHtml(e.label)}</option>`
  ).join('');
  const tools = run?.tools || [];
  const busy = !!run?.busy;
  const done = !!run?.done;
  const statusLabel = busy ? (done ? 'Done' : 'Working…') : 'Idle';
  const statusClass = busy ? (done ? 'hc-status-done' : 'hc-status-working') : 'hc-status-idle';
  const toolsHtml = tools.length
    ? tools.map((t) =>
        `<span class="hc-tool ${t.status === 'running' ? 'hc-tool-running' : 'hc-tool-done'}" title="${escapeHtml(t.title || '')}">${escapeHtml(t.name || 'tool')}</span>`
      ).join('')
    : (busy ? '<span class="hc-tool hc-tool-none">thinking…</span>' : '');

  // Model/effort + live agent status only apply to the full assistant.
  // "This DM (jchat)" is the owner's own DM session, included in the live
  // list like any other session. Active-run ● dots were removed from the
  // options (stale run state made them misleading).
  const dmKey = dmSessionKeyFor();
  const dmEntry = dmKey ? (state.agentSessions || []).find((s) => s.key === dmKey) : null;
  const dmActive = !!(dmEntry?.hasActiveRun);
  const sessionItems = [
    { key: '', label: 'This DM (jchat)', active: dmActive, title: dmEntry?.preview || '' },
    ...(state.agentSessions || [])
      .filter((s) => !(dmKey && s.key === dmKey))
      .map((s) => ({ key: s.key, label: s.label || s.key, active: !!s.hasActiveRun, title: s.preview || s.key })),
  ];
  const sessionItemsHtml = sessionItems.map((it) => {
    const sel = state.agentSession === it.key;
    return `
        <button type="button" role="option" class="hc-session-opt${sel ? ' is-selected' : ''}" data-key="${escapeHtml(it.key)}" aria-selected="${sel ? 'true' : 'false'}"${it.title ? ` title="${escapeHtml(it.title)}"` : ''}>
          <span class="hc-session-dot" aria-hidden="true">${it.active ? ICON_ACTIVE_DOT : ''}</span>
          <span class="hc-session-opt-label">${escapeHtml(it.label)}</span>
        </button>`;
  }).join('');
  const sessionCurrent = state.agentSession ? sessionLabelForKey(state.agentSession) : 'This DM (jchat)';
  const sessionCurrentActive = !state.agentSession
    ? dmActive
    : !!((state.agentSessions || []).find((s) => s.key === state.agentSession)?.hasActiveRun);
  const sessionPickerHtml = `
        <span class="hc-session-picker">
          <button type="button" class="hc-session-trigger" id="agent-session-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="Session" title="${escapeHtml(sessionCurrent)}">
            <span class="hc-session-dot hc-session-dot-current" aria-hidden="true">${sessionCurrentActive ? ICON_ACTIVE_DOT : ''}</span>
            <span class="hc-session-trigger-label">${escapeHtml(sessionCurrent)}</span>
            <span class="icon icon-sm hc-session-caret" aria-hidden="true">${ICON_CHEVRON_DOWN}</span>
          </button>
          <span class="hc-session-menu" role="listbox" hidden>${sessionItemsHtml}
          </span>
        </span>`;
  const openclawRow = mode === 'openclaw' ? `
      <div class="hc-row hc-row-detail">
        <label class="hc-label">Model
          <select id="agent-model-select" class="hc-select">${modelOptions}</select>
        </label>
        <label class="hc-label">Effort
          <select id="agent-effort-select" class="hc-select">${effortOptions}</select>
        </label>
        <span class="hc-status ${statusClass}" id="helper-status-badge"><span class="hc-status-dot" aria-hidden="true"></span>${escapeHtml(statusLabel)}</span>
      </div>
      <div class="hc-row">
        <span class="hc-label">Session</span>
        ${sessionPickerHtml}
        ${state.agentSession ? `<span class="hc-note">Viewing <b>${escapeHtml(state.agentSession.split(':').pop())}</b> — DMs here route to it; pick “This DM (jchat)” to return</span>` : ''}
      </div>
      <div class="hc-tools" id="helper-tools-list">${toolsHtml}</div>` : '';

  const bridgeBadge = state.agentBridgeEnabled
    ? `<span class="hc-bridge ${bridgeOnline ? '' : 'hc-bridge-off'}" id="helper-bridge-badge">${bridgeOnline ? 'bridge online' : 'bridge offline'}</span>`
    : '';
  // Content size + Compact for the currently viewed session (updates when
  // switching via the picker — updateHelperUiInPlace re-renders this bar).
  const size = sessionSizeInfo();
  const sizeText = size.total ? (size.limit
    ? `${fmtTokens(size.total)}/${fmtTokens(size.limit)} (${Math.round((size.total / size.limit) * 100)}%)`
    : fmtTokens(size.total) + ' tok') : '';
  const sizeTitle = `${size.label} — content size ${size.total ? size.total.toLocaleString('en-US') + ' tokens' : 'unknown'}${size.limit ? ` of ${size.limit.toLocaleString('en-US')} budget` : ''}${size.ctx ? ` · context window ${size.ctx.toLocaleString('en-US')}` : ''}`;
  const sizeBadge = `<span class="hc-size-badge" id="helper-size-badge" title="${escapeHtml(sizeTitle)}">${sizeText || '—'}</span>`;
  const compactBtn = mode === 'openclaw'
    ? `<button type="button" class="hc-compact-btn${state.helperCompacting ? ' is-busy' : ''}" id="helper-compact-btn" title="Compact the session context">${state.helperCompacting ? 'Compacting…' : 'Compact'}</button>`
    : '';

  return `
    <div class="helper-control-bar" id="helper-control-bar">
      <div class="hc-row">
        <span class="hc-label">Venory</span>
        <div class="hc-mode-toggle" id="agent-mode-toggle" role="radiogroup" aria-label="Venory mode">
          <button type="button" class="hc-mode-opt ${mode === 'openclaw' ? 'is-active' : ''}" data-mode="openclaw">OpenClaw</button>
          <button type="button" class="hc-mode-opt ${mode === 'basic' ? 'is-active' : ''}" data-mode="basic">basic</button>
        </div>
        ${bridgeBadge}
        ${sizeBadge}
        ${compactBtn}
      </div>${openclawRow}
    </div>
  `;
}

function renderSendButton() {
  const busy = isHelperBusy();
  if (busy) {
    return `<button type="button" class="composer-send composer-stop" id="send-btn" title="Stop" aria-label="Stop"><span class="icon" aria-hidden="true">${ICON_STOP}</span></button>`;
  }
  const disabled = (state._spamBlockedUntil && Date.now() < state._spamBlockedUntil) ? 'disabled' : '';
  return `<button type="button" class="composer-send" id="send-btn" title="${t('send')}" ${disabled}><span class="icon" aria-hidden="true">${ICON_SEND}</span></button>`;
}

/** Lightweight in-place update of the helper control bar + send button so
 *  live `helper:busy` / `helper:status` events don't trigger a full render
 *  (which would steal focus and break in-progress typing). Mutates the
 *  existing send button (keeps its click listener) instead of replacing it. */
function updateHelperUiInPlace(key) {
  const cur = helperDmKey();
  if (!cur || (key && key !== cur)) return;
  if (isOwner() && isHelperDm()) {
    const bar = document.getElementById('helper-control-bar');
    if (bar) bar.outerHTML = renderHelperControlBar();
  }
  const btn = document.getElementById('send-btn');
  if (btn) {
    const busy = isHelperBusy();
    const isStop = btn.classList.contains('composer-stop');
    if (isStop !== busy) {
      btn.classList.toggle('composer-stop', busy);
      btn.title = busy ? 'Stop' : t('send');
      btn.setAttribute('aria-label', busy ? 'Stop' : t('send'));
      btn.innerHTML = `<span class="icon" aria-hidden="true">${busy ? ICON_STOP : ICON_SEND}</span>`;
      if (busy) {
        btn.removeAttribute('disabled');
      } else if (state._spamBlockedUntil && Date.now() < state._spamBlockedUntil) {
        btn.setAttribute('disabled', '');
      } else {
        btn.removeAttribute('disabled');
      }
    }
  }
}

// Persist owner's model/effort picks (delegated so it survives the in-place
// control-bar re-render above).
if (typeof document !== 'undefined') {
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.id === 'agent-model-select') {
      state.agentModel = t.value;
      try { localStorage.setItem('agent_model', t.value); } catch (_) {}
    } else if (t && t.id === 'agent-effort-select') {
      state.agentEffort = t.value;
      try { localStorage.setItem('agent_effort', t.value); } catch (_) {}
    }
  });
  // Owner's Venory mode switch (OpenClaw ↔ basic) + custom session picker
  // (listbox: options can't contain SVG, so the session dot icon needs a
  // custom dropdown). Delegated so both survive in-place re-renders.
  const closeSessionMenus = () => {
    document.querySelectorAll('.hc-session-menu').forEach((m) => { m.hidden = true; });
    document.querySelectorAll('.hc-session-trigger').forEach((t) => t.setAttribute('aria-expanded', 'false'));
  };
  // Keep the session dropdown fully on screen: measure the trigger against
  // the viewport and flip above / right-align / cap height as needed.
  // MENU_GAP must match the CSS top/bottom offset (4px) of .hc-session-menu,
  // and the inline cap must never EXCEED the CSS max-height (260px) or the
  // menu grows instead of shrinking.
  const positionSessionMenu = (picker, menu) => {
    menu.classList.remove('hc-session-menu-flip', 'hc-session-menu-right');
    menu.style.maxHeight = '';
    menu.style.maxWidth = '';
    menu.style.right = '';
    const trigger = picker.querySelector('.hc-session-trigger');
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const MENU_GAP = 4;
    const EDGE = 8;
    const cssMaxH = parseFloat(getComputedStyle(menu).maxHeight) || 260;
    const cssMaxW = parseFloat(getComputedStyle(menu).maxWidth) || 320;
    const width = menu.offsetWidth;
    const height = Math.min(menu.offsetHeight, cssMaxH);
    // The menu lives inside .chat-main (overflow: hidden), so it must fit
    // the CONTAINER, not the viewport — otherwise the app's left bar (wide
    // screens) or bottom bar (phones) covers/clips part of the menu.
    const host = picker.closest('.chat-main');
    const hr = host ? host.getBoundingClientRect() : null;
    const L = hr ? hr.left : 0;
    const R = hr ? hr.right : window.innerWidth;
    const T = hr ? hr.top : 0;
    const B = hr ? hr.bottom : window.innerHeight;
    // Horizontal: right-align when left-anchored would spill off the right
    // edge; cap the width when neither anchoring fits the container.
    if (r.left + width > R - EDGE) {
      if (r.right - width >= L + EDGE) {
        menu.classList.add('hc-session-menu-right');
      } else {
        // Too wide for the space around the trigger: cap the width to the
        // container, then re-measure before deciding the anchor.
        const wMax = Math.max(96, (R - L) - 2 * EDGE);
        if (wMax < cssMaxW) menu.style.maxWidth = wMax + 'px';
        const capped = Math.min(menu.offsetWidth, wMax);
        if (r.left + capped > R - EDGE) {
          menu.classList.add('hc-session-menu-right');
          // Nudge right so the menu's left edge clears the container (the
          // left bar) without pushing the right edge off-screen.
          const leftEdge = r.right - capped;
          const shift = (L + EDGE) - leftEdge;
          if (shift > 0 && r.right + shift <= R - EDGE) {
            menu.style.right = `-${shift}px`;
          }
        }
      }
    }
    // Vertical: flip upward when it would overflow the container's bottom;
    // cap height so the menu never extends under the app nav or header.
    if (r.bottom + height + MENU_GAP + EDGE > B) {
      menu.classList.add('hc-session-menu-flip');
      const avail = r.top - T - MENU_GAP - EDGE;
      if (avail < height) menu.style.maxHeight = Math.max(96, avail) + 'px';
    } else if (B - r.bottom - MENU_GAP - EDGE < height) {
      menu.style.maxHeight = Math.max(96, B - r.bottom - MENU_GAP - EDGE) + 'px';
    }
  };
  document.addEventListener('click', (e) => {
    const target = e.target && e.target.closest ? e.target : null;
    const picker = target && target.closest ? target.closest('.hc-session-picker') : null;
    const opt = target && target.closest ? target.closest('.hc-session-opt') : null;
    if (opt && picker) {
      setAgentSession(opt.dataset.key || '');
      closeSessionMenus();
      return;
    }
    const trigger = target && target.closest ? target.closest('.hc-session-trigger') : null;
    if (trigger && picker) {
      const menu = picker.querySelector('.hc-session-menu');
      const open = menu && !menu.hidden;
      closeSessionMenus();
      if (!open && menu) {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        positionSessionMenu(picker, menu);
      }
      return;
    }
    if (!picker) closeSessionMenus();
    const modeOpt = target && target.closest ? target.closest('.hc-mode-opt') : null;
    if (!modeOpt || !modeOpt.dataset?.mode) return;
    const mode = modeOpt.dataset.mode;
    if (mode === state.agentMode) return;
    setAgentMode(mode);
  });
  // Compact button on the helper control bar → gateway sessions.compact for
  // the currently viewed session. Result toast via helper:compact:result.
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    const btn = t && t.closest ? t.closest('#helper-compact-btn') : null;
    if (!btn || state.helperCompacting || state.agentMode !== 'openclaw') return;
    const key = currentAgentSessionKey();
    if (!key) return;
    state.helperCompacting = true;
    updateHelperUiInPlace();
    state.socket?.emit('helper:compact', { sessionKey: key });
  });
  // ask_user question panel: tappable options + multi-select send.
  // Delegated so in-place panel refreshes keep working.
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const opt = t.closest ? t.closest('[data-hq-record][data-hq-question][data-hq-value]') : null;
    if (opt) {
      const rec = state.helperQuestions[opt.dataset.hqRecord];
      const q = rec && (Array.isArray(rec.questions) ? rec.questions : []).find((x) => x.questionId === opt.dataset.hqQuestion);
      if (!rec || !q) return;
      const key = `${rec.recordId}:${q.questionId}`;
      if (state.helperQuestionSending[key]) return;
      if (q.multiSelect) {
        const sel = state.helperQuestionSelections[key] || [];
        const i = sel.indexOf(opt.dataset.hqValue);
        if (i >= 0) sel.splice(i, 1);
        else sel.push(opt.dataset.hqValue);
        state.helperQuestionSelections[key] = sel;
        updateHelperQuestionPanel();
        return;
      }
      state.helperQuestionSending[key] = true;
      state.helperQuestionErrors[key] = '';
      state.helperQuestionSelections[key] = [opt.dataset.hqValue];
      updateHelperQuestionPanel();
      state.socket?.emit('helper:answer', { recordId: rec.recordId, questionId: q.questionId, values: [opt.dataset.hqValue] });
      return;
    }
    const send = t.closest ? t.closest('button.hq-send[data-hq-record][data-hq-question]') : null;
    if (send) {
      const rec = state.helperQuestions[send.dataset.hqRecord];
      const q = rec && (Array.isArray(rec.questions) ? rec.questions : []).find((x) => x.questionId === send.dataset.hqQuestion);
      if (!rec || !q) return;
      const key = `${rec.recordId}:${q.questionId}`;
      const values = (state.helperQuestionSelections[key] || []).slice();
      if (!values.length || state.helperQuestionSending[key]) return;
      state.helperQuestionSending[key] = true;
      state.helperQuestionErrors[key] = '';
      updateHelperQuestionPanel();
      state.socket?.emit('helper:answer', { recordId: rec.recordId, questionId: q.questionId, values });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSessionMenus();
  });
}

/** ask_user question panel (owner's helper DM): renders gateway questions
 *  as tappable option buttons above the composer. Ephemeral — questions
 *  live in state.helperQuestions while pending and vanish on resolve/expiry. */
function helperQuestionPanelHtml() {
  if (!isOwner() || !isHelperDm()) return '';
  const now = Date.now();
  const records = Object.values(state.helperQuestions || {})
    .filter((r) => !r.convId || r.convId === state.convId)
    .filter((r) => !(r.expiresAtMs && r.expiresAtMs <= now));
  if (!records.length) return '';
  const cards = records.map((rec) => (Array.isArray(rec.questions) ? rec.questions : []).map((q) => {
    const key = `${rec.recordId}:${q.questionId}`;
    const sel = state.helperQuestionSelections[key] || [];
    const sending = !!state.helperQuestionSending[key];
    const err = state.helperQuestionErrors[key] || '';
    const opts = (Array.isArray(q.options) ? q.options : []).map((o) => {
      const active = sel.includes(o.label);
      return `<button type="button" class="hq-opt${active ? ' is-selected' : ''}" data-hq-record="${escapeHtml(rec.recordId)}" data-hq-question="${escapeHtml(q.questionId)}" data-hq-value="${escapeHtml(o.label)}" ${sending ? 'disabled' : ''}>${escapeHtml(o.label)}${o.description ? `<span class="hq-opt-desc">${escapeHtml(o.description)}</span>` : ''}</button>`;
    }).join('');
    const sendBtn = q.multiSelect
      ? `<button type="button" class="hq-send" data-hq-record="${escapeHtml(rec.recordId)}" data-hq-question="${escapeHtml(q.questionId)}" ${!sel.length || sending ? 'disabled' : ''}>${sending ? '…' : 'Send'}</button>`
      : '';
    return `<div class="hq-card">
      ${q.header ? `<div class="hq-head">${escapeHtml(q.header)}</div>` : ''}
      <div class="hq-text">${escapeHtml(q.question)}</div>
      <div class="hq-opts">${opts}</div>
      ${q.multiSelect ? `<div class="hq-sendrow">${sendBtn}</div>` : ''}
      ${err ? `<div class="hq-err">${escapeHtml(err)}</div>` : ''}
    </div>`;
  }).join('')).join('');
  return `<div class="helper-question-panel" id="helper-question-panel" role="group" aria-label="Question"><div class="hq-title">❓ ${tx('question', 'Question')}</div>${cards}</div>`;
}

/** Insert/refresh/remove the question panel in the current DM view. Called
 *  after every render() and on live question events. */
function updateHelperQuestionPanel() {
  const panel = document.getElementById('helper-question-panel');
  if (!isOwner() || !isHelperDm()) {
    if (panel) panel.remove();
    return;
  }
  const chatMain = document.querySelector('.chat-main');
  if (!chatMain) return;
  const html = helperQuestionPanelHtml();
  if (!html) {
    if (panel) panel.remove();
    return;
  }
  if (panel) {
    panel.outerHTML = html;
  } else {
    const wrap = chatMain.querySelector('.messages-wrap');
    if (wrap) wrap.insertAdjacentHTML('afterend', html);
  }
}

function renderChatArea() {
  const route = parseRoute();
  const isProfileView = route.dmUserId && route.view === 'profile';
  if (isProfileView) {
    const profileContent = renderProfileView(route.dmUserId);
    return `
    <div class="chat-area chat-area-profile-view">
    <div class="messages-wrap messages-wrap-profile-view" data-room-type="dm" data-room-id="${state.convId || ''}">
      ${profileContent}
    </div>
    ${`
    <div class="composer composer-safe-area composer-profile-view ${!isFriend(route.dmUserId) ? 'composer-no-files' : ''}" id="composer-drop-zone" data-can-send-files="${isFriend(route.dmUserId)}">
      <div class="composer-row">
        <div class="composer-input-wrap">
          <textarea id="composer-input" placeholder="Message…" rows="1">${escapeHtml(getDraft('dm', route.dmUserId))}</textarea>
        </div>
        <div class="composer-actions">
          <button type="button" id="composer-mic" title="Record voice message" ${!isFriend(route.dmUserId) ? 'disabled' : ''}><span class="icon" aria-hidden="true">${ICON_MIC}</span></button>
          <button type="button" id="attach-file" title="Attach file"><span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span></button>
          <input type="file" id="file-input" class="hidden-input" accept="image/*,video/*,audio/*,*/*" />
        </div>
        ${renderSendButton()}
      </div>
    </div>
    `}
    </div>
    `;
  }

  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  const draftRoomId = state.dmUserId || state.panel;
  const key = roomKey(roomType, state.dmUserId ? state.convId : state.panel);
  const list = state.messages[key] || [];
  const replyPreview = state.replyTo ? getReplyPreview(state.replyTo) : null;
  const hasMore = !!state._hasMoreMessages?.[key];
  const loadingOlder = !!state._loadingOlderMessages?.[key];
  const sidePanelOpen = !!state._chatSidePanelOpen;

  // Session view: when the owner has selected another OpenClaw session in
  // the picker, replace the DM page with that session's conversation
  // (fetched from the Mac gateway; the session keeps running untouched).
  // The DM session itself always renders as the normal DM chat.
  if (roomType === 'dm' && isHelperDm() && isOwner() && state.agentSession && !isDmSessionKey(state.agentSession) && state.agentSessionView?.key === state.agentSession) {
    return renderAgentSessionView();
  }

  // If the DM target is a private user, the server already 403'd when we
  // tried to open the conversation. Replace the message list + composer
  // with the notice so nothing else leaks.
  if (roomType === 'dm' && state.dmUserId && state._privateUserView) {
    return `
      <div class="chat-area">
        <div class="messages-wrap" data-room-type="dm" data-room-id="">
          <div class="private-user-notice">
            <div class="private-user-notice-title">This user is private</div>
            <div class="private-user-notice-sub">You don't have permission to message this user.</div>
          </div>
        </div>
      </div>
    `;
  }

  const loading = state._loadingMessages?.[key];
  const accessDenied = roomType === 'group' && state.blacklisted;
  const emptyContent = accessDenied
    ? '<div class="messages-access-denied">Access denied. You are blacklisted from group chat. You can only private chat with JimmyQrg or allowed users.</div>'
    : loading
      ? Array(5).fill(0).map((_, i) => `
        <div class="message-skeleton" key="${i}">
          <div class="message-skeleton-avatar"></div>
          <div class="message-skeleton-body">
            <div class="message-skeleton-line message-skeleton-line-short"></div>
            <div class="message-skeleton-line"></div>
            <div class="message-skeleton-line message-skeleton-line-medium"></div>
          </div>
        </div>
      `).join('')
      : list.length === 0
        ? '<div class="messages-empty">No messages yet.</div>'
        : renderMessagesWithTimestamps(list, roomType, roomId);

  const deletedUserBanner = roomType === 'dm' && state.dmUserId && isUserDeleted(state.dmUserId)
    ? '<div class="deleted-user-banner">This account has been deleted.</div>'
    : '';

  const dmTimeoutBanner = (roomType === 'dm' && state.dmUserId && state.dmUserId !== 'jimmyqrg' && hasDmTimeout())
    ? (() => {
        const to = getActiveDmTimeout();
        const until = to?.expires_at ? formatTime(to.expires_at) : '';
        const msg = until
          ? tx('dmTimeoutBannerUntil', "You're timed out from private chat until {until}. You can still message jimmyqrg.").replace('{until}', until)
          : tx('dmTimeoutBannerForever', "You're timed out from private chat. You can still message jimmyqrg.");
        return `<div class="dm-timeout-banner">${escapeHtml(msg)}</div>`;
      })()
    : '';

  const pinKey = roomKey(roomType, roomId);
  const pinned = state._pinnedMessage?.[pinKey];
  const pinnedText = pinned ? (pinned.msg_type && pinned.msg_type !== 'text'
    ? `[${pinned.msg_type === 'image' ? 'Image' : pinned.msg_type === 'video' ? 'Video' : pinned.msg_type === 'audio' ? 'Audio' : 'File'}]`
    : (pinned.content || '').slice(0, 120) + ((pinned.content || '').length > 120 ? '…' : '')) : '';
  const pinnedBanner = pinned ? `
    <div class="pinned-message-banner" data-msg-id="${escapeHtml(pinned.message_id)}">
      <span class="pinned-message-icon" aria-hidden="true">${ICON_PIN_SM}</span>
      <div class="pinned-message-body">
        <span class="pinned-message-sender">${escapeHtml(pinned.display_name || pinned.username || '')}</span>
        <span class="pinned-message-text">${escapeHtml(pinnedText)}</span>
      </div>
      ${state.user?.can_pin_messages ? `<button type="button" class="pinned-message-unpin" title="${tx('unpinMessage', 'Unpin message')}" aria-label="${tx('unpinMessage', 'Unpin message')}"><span class="icon" aria-hidden="true">${ICON_X_SM}</span></button>` : ''}
    </div>` : '';

  const headerSubtitle = (() => {
    if (roomType === 'group') {
      const onlineCount = (state.users || []).filter((u) => u.id !== state.user?.id && getPresence(u.id)?.state === 'online').length + (getPresence(state.user?.id)?.state === 'online' ? 1 : 0);
      const totalCount = (state.users || []).filter((u) => !u.deleted_at).length;
      return `<span class="chat-header-subtitle"><span class="presence-summary">${tx('chatHeaderUsers', '{online} online · {total} members')
        .replace('{online}', onlineCount)
        .replace('{total}', totalCount)}</span></span>`;
    }
    if (roomType === 'dm' && state.dmUserId) {
      const presence = getPresence(state.dmUserId);
      const status = presence ? presenceLabel(presence) : tx('presenceOffline', 'Offline');
      return `<span class="chat-header-subtitle">${presenceDot(state.dmUserId)} <span class="presence-label">${escapeHtml(status)}</span></span>`;
    }
    return '';
  })();
  const typingHtml = renderTypingIndicator(roomType, roomId);

  return `
    <div class="chat-area">
      <div class="chat-main ${sidePanelOpen ? 'chat-main-with-side-panel' : ''}">
        <div class="chat-header">
          <div class="chat-header-title">${escapeHtml(getChatHeaderTitle(roomType, roomId))}</div>
          ${headerSubtitle}
          <button type="button" class="chat-header-menu-btn" id="chat-header-menu-btn" title="${tx('more', 'More')}" aria-expanded="${sidePanelOpen}"><span class="icon" aria-hidden="true">${ICON_ELLIPSIS_V}</span></button>
        </div>
        ${pinnedBanner}
        ${deletedUserBanner}
        ${dmTimeoutBanner}
        <div class="messages-wrap" data-room-type="${roomType}" data-room-id="${roomId}">
          ${loadingOlder ? '<div class="messages-loading-older">Loading more…</div>' : ''}${hasMore && !loadingOlder ? '<div class="messages-load-more-hint">Scroll up to load more</div>' : ''}${emptyContent}
        </div>
        <div class="typing-indicator-slot" data-typing-indicator-slot data-room-type="${roomType}" data-room-id="${roomId}">${typingHtml}</div>
        <button type="button" class="scroll-to-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" style="display:none">
          <span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></span>
        </button>
        ${roomType === 'group' && state.panel === 'support' && !localStorage.getItem('__jqrg_support_tip_hidden') ? `
        <div class="support-helper-tip" id="support-helper-tip">
          <span class="support-helper-tip-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></span>
          <span class="support-helper-tip-text">@Venory to get immediate assistance</span>
          <button type="button" class="support-helper-tip-close" id="support-helper-tip-close" aria-label="Dismiss"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
        </div>
        ` : ''}
        ${!accessDenied && ((roomType === 'group' && (state.panel === 'free_chat' || state.panel === 'support')) || roomType === 'dm') ? `
        ${isOwner() && isHelperDm() ? renderHelperControlBar() : ''}
        <div class="composer composer-safe-area ${roomType === 'dm' && !isFriend(state.dmUserId) ? 'composer-no-files' : ''}" id="composer-drop-zone" data-can-send-files="${roomType === 'dm' ? isFriend(state.dmUserId) : true}">
          ${replyPreview ? `
            <div class="composer-reply">
              <button type="button" class="composer-reply-jump" data-reply-jump data-reply-to-id="${escapeHtml(String(replyPreview.id || ''))}" title="${tx('jumpToMessage', 'Jump to message')}">
                <span class="composer-reply-sender">${escapeHtml(replyPreview.sender)}</span>
                <span class="composer-reply-snippet">${escapeHtml(replyPreview.snippet || '')}</span>
              </button>
              <button type="button" id="cancel-reply" class="cancel-reply-x" title="${t('cancel')}"><span class="icon" aria-hidden="true">${ICON_CLOSE}</span></button>
            </div>
          ` : ''}
          ${state._pendingFile ? `
            <div class="composer-pending-file" id="pending-file-indicator">
              <span>Attached: ${escapeHtml(state._pendingFile.name)}</span>
              <button type="button" id="clear-pending-file" title="Remove"><span class="icon icon-sm" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></span></button>
            </div>
          ` : ''}
          <div class="upload-progress" id="upload-progress" style="display:none">
            <div class="upload-progress-info">
              <span class="upload-progress-label">Uploading…</span>
              <span class="upload-progress-pct" id="upload-progress-pct">0%</span>
            </div>
            <div class="upload-progress-track">
              <div class="upload-progress-bar" id="upload-progress-bar"></div>
            </div>
          </div>
          <div class="composer-row">
            <div class="composer-input-wrap">
              <textarea id="composer-input" placeholder="Message…" rows="1">${escapeHtml(getDraft(roomType, draftRoomId))}</textarea>
            </div>
            <div class="composer-actions">
              ${'' /* command-mode toggle removed — commands are always on */}
              <button type="button" id="composer-mic" title="Record voice message" ${(roomType === 'dm' && !isFriend(state.dmUserId)) ? 'disabled' : ''}><span class="icon" aria-hidden="true">${ICON_MIC}</span></button>
              <button type="button" id="attach-file" title="Attach file"><span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span></button>
              <button type="button" id="composer-emoji" title="Emoji" aria-label="Insert emoji"><span class="icon" aria-hidden="true">${ICON_EMOJI}</span></button>
              <input type="file" id="file-input" class="hidden-input" accept="image/*,video/*,audio/*,*/*" />
            </div>
            ${renderSendButton()}
          </div>
        </div>
        ` : ''}
      </div>
      ${renderChatSidePanel(roomType, roomId)}
    </div>
  `;
}

function getReplyPreview(msg) {
  if (!msg) return null;
  return {
    id: msg.id,
    sender: msg.display_name || msg.username || 'Unknown user',
    snippet: summarizeMessageForReply(msg),
  };
}

/** One-line textual summary of a message suitable for reply previews. */
function summarizeMessageForReply(msg) {
  if (!msg) return '';
  if (msg.recalled_at) return tx('recalled', '[recalled message]');
  if (msg.deleted_by_admin) return tx('deletedByAdmin', '[deleted by admin]');
  if (msg.msg_type && msg.msg_type !== 'text') {
    const labels = {
      image: tx('attachImage', '[Image]'),
      video: tx('attachVideo', '[Video]'),
      audio: tx('attachAudio', '[Audio]'),
      voice: tx('attachVoice', '[Voice]'),
      gif: tx('attachGif', '[GIF]'),
      file: tx('attachFile', '[File]'),
    };
    return labels[msg.msg_type] || `[${msg.msg_type}]`;
  }
  const raw = String(msg.content || '').replace(/\s+/g, ' ').trim();
  return raw || tx('noContent', '[no content]');
}

/** Build a preview for an inline message reply block given the parent message. */
function getReplyInfoForMessage(m) {
  if (!m?.reply_to_id) return null;
  if (m.reply_to) {
    return {
      id: m.reply_to.id,
      sender: m.reply_to.sender_display_name || m.reply_to.sender_username || tx('unknownUser', 'Unknown user'),
      snippet: summarizeMessageForReply({
        content: m.reply_to.content,
        msg_type: m.reply_to.msg_type,
        recalled_at: m.reply_to.recalled ? Date.now() : null,
        deleted_by_admin: m.reply_to.deleted ? 1 : 0,
      }),
    };
  }
  const list = Object.values(state.messages || {}).flat();
  const parent = list.find((x) => x && x.id === m.reply_to_id);
  if (parent) return getReplyPreview(parent);
  return { id: m.reply_to_id, sender: tx('unknownUser', 'Unknown user'), snippet: tx('replyUnavailable', 'Original message unavailable') };
}

const TS_INTERVAL_MS = 15 * 60 * 1000; // today: 15 min
const TS_INTERVAL_DAY_MS = 24 * 60 * 60 * 1000; // other days: 1 day

function formatTimestampForDivider(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderTimestamp(ts) {
  const text = escapeHtml(formatTimestampForDivider(ts));
  return `
    <div class="message-timestamp">
      <span class="message-timestamp-line"></span>
      <span class="message-timestamp-text">${text}</span>
      <span class="message-timestamp-line"></span>
    </div>
  `;
}

/** Parse file ref: /file <id> → { fileId, url }. /uploads/<id> only for legacy file messages (msg_type file/image/video/audio). */
function parseFileRef(content, msgType) {
  const s = (content || '').trim();
  if (s.startsWith('/file ')) {
    const fileId = s.slice(6).trim();
    if (fileId) return { fileId, url: `/uploads/${fileId}` };
  }
  const isLegacyFile = /^(file|image|video|audio|gif)$/i.test(msgType || '');
  if (isLegacyFile && s.startsWith('/uploads/')) {
    const fileId = s.slice('/uploads/'.length).split(/[?#]/)[0].trim();
    if (fileId) return { fileId, url: `/uploads/${fileId}` };
  }
  return null;
}

function isFileMessage(m) {
  return !!parseFileRef(m.content, m.msg_type);
}

function isMediaMessage(m) {
  const ref = parseFileRef(m.content, m.msg_type);
  if (!ref) return false;
  const k = getFileKind(m, ref.url);
  return k === 'video' || k === 'image' || k === 'gif';
}
function getMediaMessageIds(list) {
  return (list || []).filter(isMediaMessage).map(m => m.id);
}

function getFileKind(msg, urlOverride) {
  const type = (msg.msg_type || '').toLowerCase();
  const url = (urlOverride || msg.content || '').toLowerCase();
  if (type === 'whisper') return 'text';
  if (type === 'video' || /\.(mp4|webm|mov|ogg)(\?|$)/.test(url)) return 'video';
  if (type === 'audio' || type === 'voice' || /\.(mp3|wav|ogg|webm|m4a)(\?|$)/.test(url)) return 'audio';
  if (type === 'image' || type === 'gif' || /\.(gif|jpg|jpeg|png|webp)(\?|$)/.test(url)) return url.includes('.gif') ? 'gif' : 'image';
  return 'file';
}

function renderFileBlock(msg, mediaContext) {
  const ref = parseFileRef(msg.content, msg.msg_type);
  if (!ref) return `<div class="message-content">${escapeHtml((msg.content || '').trim())}</div>`;
  const url = ref.url;
  const kind = getFileKind(msg, url);
  const safeUrl = escapeHtml(url).replace(/"/g, '&quot;');
  const { mediaIds = [], currentIndex = -1 } = mediaContext || {};
  const prevId = currentIndex > 0 ? mediaIds[currentIndex - 1] : null;
  const nextId = currentIndex >= 0 && currentIndex < mediaIds.length - 1 ? mediaIds[currentIndex + 1] : null;

  if (kind === 'video') {
    return `
      <div class="message-file message-file-video" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}"
           data-prev-media-id="${prevId || ''}" data-next-media-id="${nextId || ''}" role="button" tabindex="0">
        <video class="message-file-video-thumb" src="${safeUrl}" preload="metadata" muted playsinline></video>
        <span class="message-file-video-play" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
        <a href="${safeUrl}" download class="message-file-download message-file-download-video" onclick="event.stopPropagation()" title="Download">${ICON_DOWNLOAD}</a>
      </div>`;
  }
  if (kind === 'image' || kind === 'gif') {
    return `
      <div class="message-file message-file-image" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}"
           data-prev-media-id="${prevId || ''}" data-next-media-id="${nextId || ''}" role="button" tabindex="0">
        <img class="message-file-image-img" src="${safeUrl}" alt="" loading="lazy" />
        <a href="${safeUrl}" download class="message-file-download message-file-download-image" onclick="event.stopPropagation()" title="Download">${ICON_DOWNLOAD}</a>
      </div>`;
  }
  if (kind === 'audio') {
    return `
      <div class="message-file message-file-audio" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}">
        <div class="message-file-audio-wrap">
          <audio class="message-file-audio-el" src="${safeUrl}" preload="metadata"></audio>
          <div class="message-file-audio-progress-wrap">
            <input type="range" class="message-file-audio-progress" min="0" max="100" value="0" title="Seek" />
          </div>
          <p class="message-file-audio-time">Current: <span class="message-file-audio-current">00:00</span> / Total: <span class="message-file-audio-total">00:00</span></p>
          <a href="${safeUrl}" download class="message-file-audio-download" title="Download">${ICON_DOWNLOAD}</a>
        </div>
      </div>`;
  }
  return `
    <div class="message-file message-file-other" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}">
      <div class="message-file-other-wrap">
        <button type="button" class="message-file-other-icon" title="View file content" aria-label="View file">${ICON_FILE}</button>
        <a href="${safeUrl}" download class="message-file-other-download" title="Download">${ICON_DOWNLOAD}</a>
      </div>
    </div>`;
}

const ICON_DOWNLOAD = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
const ICON_FILE = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>';
const MESSAGE_RENDER_WINDOW = 250;
const MESSAGE_RENDER_WINDOW_STEP = 250;

function renderMessagesWithTimestamps(list, roomType, roomId) {
  const key = roomKey(roomType, roomId);
  const fullList = list || [];
  const existingLimit = state._messageRenderLimitByRoom?.[key];
  const limit = existingLimit || Math.min(MESSAGE_RENDER_WINDOW, fullList.length || MESSAGE_RENDER_WINDOW);
  if (!state._messageRenderLimitByRoom) state._messageRenderLimitByRoom = {};
  state._messageRenderLimitByRoom[key] = limit;
  const hiddenCount = Math.max(0, fullList.length - limit);
  const viewList = hiddenCount > 0 ? fullList.slice(hiddenCount) : fullList;
  let lastTs = null;
  const mediaIds = getMediaMessageIds(viewList);
  const parts = [];
  if (hiddenCount > 0) {
    const label = (t('showEarlierMessages') || 'Show {count} earlier loaded messages').replace('{count}', String(hiddenCount));
    parts.push(`<div class="message-virtualize-notice"><button type="button" class="btn-small message-virtualize-show-more" data-room-type="${escapeHtml(roomType)}" data-room-id="${escapeHtml(roomId)}">${escapeHtml(label)}</button></div>`);
  }
  const todayStr = new Date().toDateString();
  for (let i = 0; i < viewList.length; i++) {
    const m = viewList[i];
    const t = m.created_at || 0;
    const isToday = t && new Date(t).toDateString() === todayStr;
    const intervalMs = isToday ? TS_INTERVAL_MS : TS_INTERVAL_DAY_MS;
    if (t && (lastTs == null || t - lastTs >= intervalMs)) {
      parts.push(renderTimestamp(t));
      lastTs = t;
    } else if (t) lastTs = t;
    const mediaIndex = mediaIds.indexOf(m.id);
    parts.push(renderMessage(m, roomType, roomId, { mediaIds, mediaIndex }));
  }
  return parts.join('');
}

function renderMessage(m, roomType, roomId, context = {}) {
  const isOwn = m.sender_id === state.user?.id;
  const isAgentView = !!context.agentSessionView; // session-view rows: read-only, no like/react actions
  const isWhisper = m.msg_type === 'whisper';
  const isFileMessage = !!parseFileRef(m.content, m.msg_type);
  // Pull a recipient user record from cached state.users when possible
  // so we can render the recipient's display name + handle in the badge.
  const recipientUser = isWhisper ? (state.users || []).find(u => u.id === m.recipient_user_id) : null;
  const reactionSummary = (m.reactions || []).map((r) => `
    <button type="button" class="message-reaction-chip" data-msg-id="${m.id}" data-emoji="${escapeHtml(r.emoji)}">
      <span class="message-reaction-emoji">${escapeHtml(r.emoji)}</span>
      <span class="message-reaction-count">${r.count}</span>
    </button>
  `).join('');

  if (m.deleted_by_admin) {
    return `
      <div class="message message-system" data-msg-id="${m.id}" data-sender-id="${m.sender_id || ''}">
        <span class="message-system-text">Message deleted</span>
      </div>
    `;
  }

  if (m.recalled_at) {
    const name = escapeHtml(m.display_name || m.username || 'Unknown user');
    return `
      <div class="message message-system message-recalled-line" data-msg-id="${m.id}" data-sender-id="${m.sender_id || ''}">
        <span class="message-system-text"><span class="message-recalled-name">${name}</span> recalled a message</span>
      </div>
    `;
  }

  const versions = [...(m.edit_history || []).map(h => h.content), m.content || ''];
  const versionIndex = Math.max(0, Math.min((state.messageVersionIndex[m.id] ?? versions.length - 1), versions.length - 1));
  const displayContent = versions[versionIndex];
  const mediaContext = { mediaIds: context.mediaIds || [], currentIndex: context.mediaIndex ?? -1 };
  const content = isFileMessage ? renderFileBlock(m, mediaContext) : renderMessageContent(displayContent || '');
  const replyInfo = getReplyInfoForMessage(m);
  const replyBlock = m.reply_to_id ? `
    <button type="button" class="message-reply-preview" data-reply-to="${escapeHtml(String(m.reply_to_id))}" title="${tx('jumpToMessage', 'Jump to message')}">
      <span class="message-reply-sender">${escapeHtml(replyInfo?.sender || tx('unknownUser', 'Unknown user'))}</span>
      <span class="message-reply-snippet">${escapeHtml(replyInfo?.snippet || tx('replyUnavailable', 'Original message unavailable'))}</span>
    </button>` : '';
  const likeCount = (m.likes || 0) > 0 ? `<span class="message-like-count">${m.likes}</span>` : '';
  const likeIcon = `<button type="button" class="message-like-btn" data-msg-id="${m.id}" title="Like" aria-label="Like"><span class="message-like-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></span></button>`;
  const reactionPickerBtn = `<button type="button" class="message-reaction-picker-btn" data-msg-id="${m.id}" title="React" aria-label="React"><span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg></span></button>`;

  const chevronLeft = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>`;
  const chevronRight = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>`;
  const editHistoryUI = !isFileMessage && versions.length > 1
    ? `<span class="message-edit-history" data-msg-id="${m.id}">
        <button type="button" class="message-edit-history-btn" data-msg-id="${m.id}" data-dir="prev" title="Older version" aria-label="Older version" ${versionIndex <= 0 ? 'disabled' : ''}>${chevronLeft}</button>
        <span class="message-edit-history-label">${versionIndex + 1}/${versions.length}</span>
        <button type="button" class="message-edit-history-btn" data-msg-id="${m.id}" data-dir="next" title="Newer version" aria-label="Newer version" ${versionIndex >= versions.length - 1 ? 'disabled' : ''}>${chevronRight}</button>
      </span>`
    : '';

  const isEditing = !isFileMessage && state.editingMessageId === m.id;
  const contentBlock = isEditing
    ? `<div class="message-edit-area">
        <textarea class="message-edit-input" data-msg-id="${m.id}" rows="3">${escapeHtml(m.content || '')}</textarea>
        <div class="message-edit-actions">
          <button type="button" class="message-edit-save" data-msg-id="${m.id}"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>Save</button>
          <button type="button" class="message-edit-cancel" data-msg-id="${m.id}"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>Cancel</button>
        </div>
      </div>`
    : `<div class="message-content message-content-file">${content}</div>`;

  const defaultAvatar = getDefaultAvatarUrl(m.sender_id);
  const avatarSrc = (m.avatar_url && String(m.avatar_url).trim()) ? m.avatar_url : defaultAvatar;
  const senderName = escapeHtml(m.display_name || m.username || 'Unknown user') + userTag(m.sender_id);
  const cbStyle = m.chatbox_style || 'default';
  const cbMeta = state._chatboxStyles.find(s => s.id === cbStyle);
  const useSvgBubble = !isFileMessage && cbMeta?.type === 'svg';
  const hasTail = cbMeta?.tail;
  const cbSvg = useSvgBubble
    ? `/assets/chatboxes/${escapeHtml(cbStyle)}/${isOwn ? 'own' : 'other'}.svg`
    : '';
  const bodyClasses = ['message-body'];
  if (isFileMessage) bodyClasses.push('message-body-file');
  if (useSvgBubble) bodyClasses.push('message-body-svg');
  if (useSvgBubble && hasTail) bodyClasses.push('message-body-tail');
  if (!useSvgBubble && cbStyle !== 'default') bodyClasses.push(`chatbox-${cbStyle}`);
  if (isWhisper) bodyClasses.push('message-body-whisper');
  const whisperBadge = isWhisper ? `<span class="message-whisper-badge" title="Private message: only you, the recipient, jimmyqrg, and admins with the See whispers permission can see this.">Whisper to @${escapeHtml(recipientUser ? recipientUser.username : (m.recipient_user_id || ''))}</span>` : '';
  return `
    <div class="message-row ${isWhisper ? 'message-row-whisper' : ''}" data-msg-id="${m.id}">
      <div class="message ${isOwn ? 'own' : ''} ${isWhisper ? 'message-whisper' : ''}" data-msg-id="${m.id}" data-sender-id="${m.sender_id}">
        <div class="message-header"><span class="message-sender">${senderName}</span>${whisperBadge}</div>
        <div class="message-inline">
          <div class="message-avatar-wrap" data-sender-id="${escapeHtml(m.sender_id || '')}" title="View profile" role="button" tabindex="0">
            <img class="message-avatar" src="${avatarSrc}" data-fallback="${defaultAvatar.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
          </div>
          <div class="${bodyClasses.join(' ')}"${useSvgBubble ? ` style="--bubble-svg:url('${cbSvg}')"` : ''}>
            ${replyBlock}
            ${contentBlock}
            ${reactionSummary ? `<div class="message-reactions">${reactionSummary}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="message-like-wrap">
        ${isAgentView ? '' : `${editHistoryUI}
        ${reactionPickerBtn}
        ${likeIcon}
        ${likeCount}`}
      </div>
    </div>
  `;
}

function renderDocArea() {
  const docKey = state.panel;
  const canEdit = state.user?.can_edit_docs;
  const isEditing = canEdit && state.editingDocKey === docKey;
  const supportId = state.supportMessageIdForSolve || '';
  const content = state._docContent ?? '';
  if (isEditing) {
  return `
    <div class="doc-panel" data-doc-key="${docKey}">
      <div class="doc-toolbar">
        <button type="button" id="save-doc" class="doc-save"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>Save</button>
        <button type="button" id="cancel-doc-edit" class="doc-cancel"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>Cancel</button>
      </div>
      <div class="doc-editor">
        <textarea id="doc-content" placeholder="${t('loading')}">${escapeHtml(content)}</textarea>
      </div>
      <input type="hidden" id="doc-support-msg-id" value="${escapeHtml(supportId)}" />
    </div>
  `;
  }
  return `
    <div class="doc-panel" data-doc-key="${docKey}">
      ${canEdit ? `
      <div class="doc-toolbar">
        <button type="button" id="start-doc-edit" class="doc-edit-btn"><span class="icon" aria-hidden="true">${ICON_EDIT_SM}</span>${t('edit')}</button>
      </div>
      ` : ''}
      <div class="doc-view doc-markdown">${markdownToHtml(content)}</div>
      <input type="hidden" id="doc-support-msg-id" value="${escapeHtml(supportId)}" />
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function userTag(userId) {
  if (userId === 'helper') return '<span class="user-tag user-tag-helper">Assistance</span>';
  if (userId === 'jimmyqrg') return '<span class="user-tag user-tag-owner">Owner</span>';
  if (!userId) return '';
  const u = (state.users || []).find((x) => x.id === userId);
  if (u?.is_allowed) return '<span class="user-tag user-tag-admin">Admin</span>';
  return '';
}

function userSortPriority(userId) {
  if (userId === 'helper') return 0;
  if (userId === 'jimmyqrg') return 1;
  return 2;
}

/** Parse $ [\] [ ](language|lang)=[ ]"name" ... \$ blocks. Supports $\language=, $\ lang=, $\ language =, etc. */
function parseLanguageBlocks(str) {
  if (str == null || str === '') return [{ type: 'text', content: '' }];
  const s = String(str);
  const re = /\$\s*\\?\s*(?:language|lang)\s*=\s*"([^"]+)"\s*\n([\s\S]*?)\\\$/g;
  const segments = [];
  let lastEnd = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastEnd) {
      segments.push({ type: 'text', content: s.slice(lastEnd, m.index) });
    }
    let lang = m[1].trim().toLowerCase();
    if (lang === 'md') lang = 'markdown';
    segments.push({ type: 'block', language: lang, content: m[2].replace(/\n$/, '') });
    lastEnd = re.lastIndex;
  }
  if (lastEnd < s.length) {
    segments.push({ type: 'text', content: s.slice(lastEnd) });
  }
  return segments.length ? segments : [{ type: 'text', content: s }];
}

/** Sanitize HTML to a safe subset of tags (no script, no event handlers). */
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const allowedTags = new Set(['p', 'div', 'span', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const allowedAttrs = { a: ['href', 'target'] };
  function serialize(n) {
    if (n.nodeType === Node.TEXT_NODE) return escapeHtml(n.textContent);
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = n.tagName.toLowerCase();
    if (!allowedTags.has(tag)) return Array.from(n.childNodes).map(serialize).join('');
    const attrs = allowedAttrs[tag];
    let attrStr = '';
    if (attrs && tag === 'a') {
      const href = n.getAttribute('href');
      if (href) attrStr = ' href="' + escapeHtml(href).replace(/"/g, '&quot;') + '"';
      const target = (n.getAttribute('target') || '').toLowerCase();
      if (target === '_blank' || target === 'blank') attrStr += ' target="_blank" rel="noopener"';
    }
    const inner = Array.from(n.childNodes).map(serialize).join('');
    if (tag === 'br') return '<br>';
    return '<' + tag + attrStr + '>' + inner + '</' + tag + '>';
  }
  return Array.from(doc.body.childNodes).map(serialize).join('');
}

/** Render LaTeX block to HTML using KaTeX if available. */
function renderLatexBlock(latex) {
  if (typeof window.renderKatex === 'function') {
    try {
      return window.renderKatex(latex, true);
    } catch (e) {
      return '<pre class="language-block-error">' + escapeHtml(latex) + '</pre>';
    }
  }
  return '<pre class="language-block-latex"><code>' + escapeHtml(latex) + '</code></pre>';
}

/** Process message content: apply language blocks then markdown.
 * Supports /plaintext: everything below that line is rendered as plain text.
 */
function renderMessageContent(raw) {
  if (raw == null || raw === '') return '';
  const lineSeparator = /\r\n|\r|\n/;
  const lines = String(raw).split(lineSeparator);
  const plaintextLineIndex = lines.findIndex((l) => {
    const t = l.trim().toLowerCase();
    return t === '/plaintext';
  });
  if (plaintextLineIndex >= 0) {
    const above = lines.slice(0, plaintextLineIndex).join('\n');
    const below = lines.slice(plaintextLineIndex + 1).join('\n');
    const aboveHtml = above ? renderMessageContentInner(above) : '';
    const belowHtml = below ? '<div class="message-content-plaintext">' + escapeHtml(below) + '</div>' : '';
    return aboveHtml + belowHtml;
  }
  return renderMessageContentInner(raw);
}

function renderMessageContentInner(raw) {
  if (raw == null || raw === '') return '';
  const segments = parseLanguageBlocks(raw);
  const parts = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      parts.push(markdownToHtml(seg.content));
    } else {
      const lang = seg.language;
      const content = seg.content;
      if (lang === 'markdown') {
        parts.push(markdownToHtml(content));
      } else if (lang === 'html') {
        parts.push('<div class="language-block-html">' + sanitizeHtml(content) + '</div>');
      } else if (lang === 'latex') {
        parts.push('<div class="language-block-latex">' + renderLatexBlock(content) + '</div>');
      } else {
        parts.push('<pre class="language-block-raw"><code>' + escapeHtml(content) + '</code></pre>');
      }
    }
  }
  return parts.join('');
}

/** Render Markdown to safe HTML (no raw HTML execution). Supports # headers, **bold**, *italic*, `code`, > blockquote, -, * lists, ``` blocks, [links](url). */
function markdownToHtml(md) {
  if (md == null || md === '') return '';
  const mathTokens = [];
  const lines = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  let inBlock = false;
  let blockContent = [];
  let blockLang = '';
  let listItems = [];
  let listOrdered = false;
  let listStartNum = 1;
  let blockquoteLines = [];

  const copySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  function flushBlock() {
    if (blockContent.length) {
      const code = escapeHtml(blockContent.join('\n'));
      const langLabel = escapeHtml(blockLang || 'code');
      out.push(`<pre class="chat-codeblock"><div class="chat-codeblock-head"><span class="chat-codeblock-lang">${langLabel}</span><button class="chat-codeblock-copy" type="button" title="Copy code">${copySvg}</button></div><code>${code}</code></pre>`);
      blockContent = [];
      blockLang = '';
    }
    inBlock = false;
  }
  function flushList() {
    if (listItems.length) {
      const tag = listOrdered ? 'ol' : 'ul';
      const startAttr = listOrdered && listStartNum > 1 ? ` start="${listStartNum}"` : '';
      out.push(`<${tag}${startAttr}><li>${listItems.join(`</li><li>`)}</li></${tag}>`);
      listItems = [];
      listStartNum = 1;
    }
  }
  function flushBlockquote() {
    if (blockquoteLines.length) {
      const html = blockquoteLines.map(l => `<p>${inlineMarkdown(l)}</p>`).join('');
      out.push(`<blockquote>${html}</blockquote>`);
      blockquoteLines = [];
    }
  }
  function linkifyPlainText(segment) {
    if (!segment || /^<a\s|^<\/a>/.test(segment)) return segment;
    const safeHref = (u) => u.replace(/"/g, '&quot;');
    // Linkify only plain text: split by existing <a>...</a>, process each text part, rejoin (avoids double-linking)
    const linkTag = /<a\s[^>]*>.*?<\/a>/g;
    const linkifyClass = ' class="linkify-link"';
    const applyToPlainParts = (html, fn) => {
      const parts = html.split(linkTag);
      const tags = html.match(linkTag) || [];
      let result = fn(parts[0] || '');
      for (let i = 0; i < tags.length; i++) result += tags[i] + fn(parts[i + 1] || '');
      return result;
    };
    const mkLink = (url, label) => `<a href="${safeHref('https://' + url)}"${linkifyClass} target="_blank" rel="noopener">${label || url}</a>`;
    const linkifyPlainOnly = (text) => {
      if (!text) return text;
      let out = text;
      // Run the generic domain+path matcher first so a URL like
      // "github.com/perfectnip.github.io" is captured as ONE link. If the
      // github.io-specific rule ran first it would split it into two.
      out = applyToPlainParts(out, t => t.replace(/(?<![\/">])(www\.[^\s<>"']+)/g, (_, u) => mkLink(u)));
      out = applyToPlainParts(out, t => t.replace(/(?<![\/"':@\w.-])((?:[a-zA-Z0-9][-a-zA-Z0-9_]*\.)+[a-zA-Z0-9][-a-zA-Z0-9_]*(?::\d+)?(?:\/[^\s<>"']*)?)/g, (_, url) => {
        // Trim trailing punctuation that's almost never part of a URL.
        let trimmed = url;
        let suffix = '';
        while (trimmed && /[.,;:!?)\]}>]$/.test(trimmed)) {
          suffix = trimmed.slice(-1) + suffix;
          trimmed = trimmed.slice(0, -1);
        }
        const tldMatch = trimmed.match(/\.(com|org|net|io|co|edu|gov|dev|app|ai|site|xyz|test|local|internal)(?:\/|:\d+|\?|#|$)/i);
        if (!tldMatch) return url;
        if (trimmed === 'github.io') return url;
        return mkLink(trimmed) + suffix;
      }));
      // Fallback specific to *.github.io hosts when the generic pass doesn't fire.
      out = applyToPlainParts(out, t => t.replace(/\b([a-zA-Z0-9][-a-zA-Z0-9_]*\.github\.io(?:\/[^\s<>"']*)?)/g, (_, u) => mkLink(u)));
      out = applyToPlainParts(out, t => t.replace(/\b(localhost(?::\d+)?(?:\/[^\s<>"']*)?)/gi, (_, u) => mkLink(u)));
      out = applyToPlainParts(out, t => t.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?(?:\/[^\s<>"']*)?)/g, (_, u) => mkLink(u)));
      return out;
    };
    const linkifyOne = (text) => {
      if (!text) return text;
      const withScheme = text.replace(/(https?:\/\/[^\s<>"']+)/g, (_, url) =>
        `<a href="${safeHref(url)}"${linkifyClass} target="_blank" rel="noopener">${url}</a>`);
      const parts = withScheme.split(linkTag);
      const links = withScheme.match(linkTag) || [];
      let out = linkifyPlainOnly(parts[0]);
      for (let i = 0; i < links.length; i++) {
        out += links[i] + linkifyPlainOnly(parts[i + 1]);
      }
      return out;
    };
    const parts = segment.split(linkTag);
    const links = segment.match(linkTag) || [];
    let out = linkifyOne(parts[0]);
    for (let i = 0; i < links.length; i++) {
      out += links[i] + linkifyOne(parts[i + 1]);
    }
    return out;
  }

  function inlineMarkdown(s) {
    const escaped = escapeHtml(s);
    // Dollar math ($...$ / $$...$$) → KaTeX, protected from the inline
    // markdown pass via tokens (so **bold** can span math, and invalid
    // TeX like "$5 and $10" stays literal text).
    let tokenized = escaped;
    if (typeof window.renderKatex === 'function') {
      tokenized = escaped.replace(/(\$\$[^$]+\$\$|\$[^$\n]+\$)/g, (m) => {
        const display = m.startsWith('$$');
        const body = display ? m.slice(2, -2) : m.slice(1, -1);
        // Skip money/plain-dollar text: only treat as math when it carries
        // math syntax (\, ^, _, {}, =, <, >, +, -, *, /).
        if (!/[\\^_{}=<>+\-*/]/.test(body)) return m;
        try {
          const html = window.renderKatex(body, display);
          if (html.includes('katex-error')) return m;
          mathTokens.push(html);
          return '\u0000M' + (mathTokens.length - 1) + '\u0000';
        } catch (_) { return m; }
      });
    }
    const withMarkdown = tokenized
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/`([^`]*)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const parts = withMarkdown.split(/(<a\s[^>]*>|<\/a>)/g);
    let inAnchor = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (/^<a\s/i.test(part)) {
        inAnchor = true;
        continue;
      }
      if (/^<\/a>/i.test(part)) {
        inAnchor = false;
        continue;
      }
      if (!inAnchor && part) {
        parts[i] = linkifyPlainText(part);
      }
    }
    let result = parts.join('');
    if (mathTokens.length) {
      result = result.replace(/\u0000M(\d+)\u0000/g, (_, i) => mathTokens[+i] || '');
    }
    return result;
  }

  function flushTable() {
    if (!tableRows.length) return;
    // A lone pipe line without a separator row isn't a real table — render
    // it as normal text (e.g. shell pipes like "cat x | grep y").
    if (tableRows.length === 1) {
      out.push(`<p>${inlineMarkdown(tableRows[0])}</p>`);
      tableRows = [];
      return;
    }
    const headerRow = tableRows[0];
    const sepRow = tableRows.length > 1 ? tableRows[1] : '';
    const bodyRows = tableRows.slice(2);

    const headers = parseTableCells(headerRow).map(c => `<th>${inlineMarkdown(c.trim())}</th>`).join('');

    let alignAttrs = '';
    if (sepRow) {
      const cells = parseTableCells(sepRow);
      alignAttrs = cells.map(c => {
        const t = c.trim();
        if (t.startsWith(':') && t.endsWith(':')) return ' align="center"';
        if (t.endsWith(':')) return ' align="right"';
        return ' align="left"';
      }).join('');
    }

    const rowsHtml = bodyRows.map(row => {
      const cells = parseTableCells(row).map(c => `<td${alignAttrs}>${inlineMarkdown(c.trim())}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    out.push(`<table class="md-table"><thead><tr>${headers}</tr></thead><tbody>${rowsHtml}</tbody></table>`);
    tableRows = [];
  }

  function parseTableCells(row) {
    // Split on |, trimming surrounding whitespace
    return row.split('|').map(c => c.trim()).filter(c => c !== '');
  }

  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('```')) {
      flushBlockquote();
      flushList();
      flushTable();
      if (inBlock) {
        flushBlock();
      } else {
        inBlock = true;
        blockLang = trimmed.slice(3).trim();
      }
      continue;
    }
    if (inBlock) {
      blockContent.push(line);
      continue;
    }
    if (blockquoteLines.length && !trimmed.startsWith('>')) {
      flushBlockquote();
    }
    const blockquoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (blockquoteMatch) {
      flushList();
      flushTable();
      blockquoteLines.push(blockquoteMatch[1]);
      continue;
    }
    // Table handling (GFM-style): a pipe line only starts a table when the
    // NEXT line is a separator row; sep/data rows extend it; any non-pipe
    // line ends it. Prevents shell pipes and "a | b" text from becoming
    // tables, and keeps body rows in the table.
    const pipeCells = (l) => l.split('|').map((c) => c.trim()).filter((c) => c !== '');
    const cells = pipeCells(trimmed);
    if (tableRows.length === 0) {
      if (cells.length >= 2) {
        const next = i + 1 < lines.length ? lines[i + 1].trimEnd() : '';
        const nextCells = pipeCells(next);
        const nextIsSep = nextCells.length >= 2 && /^[:\|\-\s]+$/.test(nextCells.join(''));
        if (nextIsSep) {
          flushList();
          flushBlockquote();
          tableRows.push(trimmed);
          continue;
        }
      }
      // Not a table: fall through to normal rendering.
    } else {
      if (cells.length >= 2) {
        tableRows.push(trimmed);
        continue;
      }
      flushTable();
    }
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (olMatch) {
      if (listItems.length && !listOrdered) flushList();
      listOrdered = true;
      listStartNum = parseInt(olMatch[1], 10);
      listItems.push(inlineMarkdown(olMatch[2]));
      continue;
    }
    if (ulMatch) {
      if (listItems.length && listOrdered) flushList();
      listOrdered = false;
      listStartNum = 1;
      listItems.push(inlineMarkdown(ulMatch[1]));
      continue;
    }
    flushList();
    if (trimmed.startsWith('### ')) {
      out.push(`<h3>${inlineMarkdown(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      out.push(`<h2>${inlineMarkdown(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      out.push(`<h1>${inlineMarkdown(trimmed.slice(2))}</h1>`);
      continue;
    }
    if (/^-{3,}$|^\*{3,}$|^_{3,}$/.test(trimmed)) {
      flushList();
      out.push('<hr>');
      continue;
    }
    if (trimmed === '') {
      out.push('<p></p>');
      continue;
    }
    out.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }
  flushBlock();
  flushList();
  flushBlockquote();
  flushTable();
  return out.join('\n');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Returns true if `err` is the server's "private user" response (status 403
// with { private_user: true }). Callers use this to swap a generic "this
// user is private" notice in for the usual profile / DM UI so nothing else
// (display name, avatar, online status) leaks.
function isPrivateUserError(err) {
  return !!(err && err.data && err.data.private_user === true);
}

/** Show a one-line "This user is private" notice inside any container.
 *  Used when the server blocks a profile/DM view because the target is
 *  is_private=1 and the viewer is not jimmyqrg. */
function renderPrivateUserNotice(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="private-user-notice">
      <div class="private-user-notice-title">This user is private</div>
      <div class="private-user-notice-sub">You don't have permission to view this profile.</div>
    </div>
  `;
}

async function showProfileModal(userId) {
  if (!userId) return;
  document.querySelectorAll('.profile-modal-overlay').forEach((el) => el.remove());
  try {
    const { profile } = await apiGet(`/api/users/${encodeURIComponent(userId)}/profile`);
    const isSelf = userId === state.user?.id;
    const friend = isFriend(userId);
    const pendingFriend = isFriendRequestPending(userId);
    const blocked = isBlocked(userId);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay profile-modal-overlay';
    overlay.innerHTML = `
      <div class="modal profile-modal">
        <button type="button" class="profile-modal-close" aria-label="Close"><span class="icon" aria-hidden="true">${ICON_CLOSE}</span></button>
        <div class="profile-modal-scroll">
        <div class="profile-modal-header">
          <img src="${(profile.avatar_url && String(profile.avatar_url).trim()) ? profile.avatar_url : getDefaultAvatarUrl(profile.id)}" data-fallback="${getDefaultAvatarUrl(profile.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="profile-modal-avatar" />
          <h3 class="profile-modal-name">${escapeHtml(profile.display_name || profile.username)}</h3>
          <p class="profile-modal-username">@${escapeHtml(profile.username)}</p>
          ${profile.description ? `<p class="profile-modal-description">${escapeHtml(profile.description)}</p>` : ''}
          ${profile.website ? `<p class="profile-modal-website"><a href="${escapeHtml(profile.website)}" target="_blank" rel="noopener">${escapeHtml(profile.website)}</a></p>` : ''}
        </div>
        ${!isSelf ? `<div class="profile-modal-actions">
          <button type="button" class="btn-primary profile-btn-message"><span class="icon" aria-hidden="true">${ICON_CHAT_SM}</span>${t('sendMessage')}</button>
          ${!friend ? `<button type="button" class="btn-secondary profile-btn-friend-request" ${pendingFriend ? 'disabled' : ''}><span class="icon" aria-hidden="true">${ICON_USER_PLUS_SM}</span>${pendingFriend ? t('requestPending') : t('sendFriendRequest')}</button>` : ''}
          <button type="button" class="btn-secondary profile-btn-block" data-blocked="${blocked}"><span class="icon" aria-hidden="true">${ICON_BAN_SM}</span>${blocked ? t('unblock') : t('block')}</button>
        </div>` : ''}
        </div>
      </div>
    `;
    const onEscape = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onEscape);
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.profile-modal-close')?.addEventListener('click', close);
    document.addEventListener('keydown', onEscape);
    overlay.querySelector('.profile-btn-message')?.addEventListener('click', () => { overlay.remove(); navigateTo(`/chat/${encodeURIComponent(userId)}`); });
    const blockBtn = overlay.querySelector('.profile-btn-block');
    if (blockBtn) {
      blockBtn.addEventListener('click', async () => {
        try {
          const blocked = blockBtn.dataset.blocked === 'true';
          if (blocked) {
            await apiDelete(`/api/blocks/${encodeURIComponent(userId)}`);
            state.blocked_ids = (state.blocked_ids || []).filter(id => id !== userId);
            blockBtn.textContent = t('block');
            blockBtn.dataset.blocked = 'false';
          } else {
            await apiPost('/api/blocks', { user_id: userId });
            state.blocked_ids = [...(state.blocked_ids || []), userId];
            blockBtn.textContent = t('unblock');
            blockBtn.dataset.blocked = 'true';
          }
        } catch (err) {
          showToast(err.message || 'Failed');
        }
      });
    }
    const frBtn = overlay.querySelector('.profile-btn-friend-request');
    if (frBtn) {
      frBtn.addEventListener('click', async () => {
        try {
          await apiPost('/api/friends/request', { to_user_id: userId });
          if (!state.pending_friend_ids.includes(userId)) state.pending_friend_ids.push(userId);
          await loadPendingFriendRequests();
          frBtn.textContent = t('requestPending');
          frBtn.disabled = true;
        } catch (err) {
          showToast(err.message || 'Failed to send friend request');
        }
      });
    }
    document.body.appendChild(overlay);
  } catch (err) {
    if (isPrivateUserError(err)) {
      // Show a modal with the private-user notice. Same shape as the
      // profile modal so the close button + Escape behave the same.
      document.querySelectorAll('.profile-modal-overlay').forEach((el) => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay profile-modal-overlay';
      const modal = document.createElement('div');
      modal.className = 'modal profile-modal';
      renderPrivateUserNotice(modal);
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'profile-modal-close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.innerHTML = `<span class="icon" aria-hidden="true">${ICON_CLOSE}</span>`;
      modal.appendChild(closeBtn);
      overlay.appendChild(modal);
      const onEscape = (e) => { if (e.key === 'Escape') overlay.remove(); };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      closeBtn.addEventListener('click', () => overlay.remove());
      document.addEventListener('keydown', onEscape);
      document.body.appendChild(overlay);
      return;
    }
    showToast(err.message || 'Could not load profile');
  }
}

function showWordleModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay wordle-modal-overlay';
  overlay.innerHTML = `
    <div class="wordle-modal">
      <button type="button" class="wordle-modal-close" aria-label="Close"><span class="icon" aria-hidden="true">${ICON_CLOSE}</span></button>
      <iframe src="https://perfectnip.github.io/wordle" title="Wordle" class="wordle-iframe"></iframe>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.wordle-modal-close')?.addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

/** Seek step (seconds) for the media popup, based on video duration:
 *  <1 min → 5s, 1–3 min → 10s, 3 min–1 h → 15s, >1 h → 20s. */
function getStepOptions(durationSeconds) {
  const d = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  if (d < 60) return 5;
  if (d < 180) return 10;
  if (d <= 3600) return 15;
  return 20;
}

function openMediaPopup(msgId, url, kind, prevId, nextId, roomType, roomId) {
  const existing = document.querySelector('.media-popup-overlay');
  if (existing) existing.remove();
  const list = state.messages[roomKey(roomType, roomId)] || [];
  const mediaList = list.filter(isMediaMessage);
  const safeUrl = (u) => escapeHtml(u || '').replace(/"/g, '&quot;');
  const overlay = document.createElement('div');
  overlay.className = 'media-popup-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  let currentMsg = null;

  function setMedia(msg) {
    if (!msg) return;
    currentMsg = msg;
    // Uploaded files are stored as "/file <id>", so resolve to a real URL first.
    const ref = parseFileRef(msg.content, msg.msg_type);
    const u = (ref?.url || msg.content || '').trim();
    const k = getFileKind(msg);
    const prev = mediaList[mediaList.findIndex(m => m.id === msg.id) - 1];
    const next = mediaList[mediaList.findIndex(m => m.id === msg.id) + 1];
    const prevId = prev?.id || '';
    const nextId = next?.id || '';
    const contentEl = overlay.querySelector('.media-popup-content');
    const controlsEl = overlay.querySelector('.media-popup-controls');
    const imageOverlayEl = overlay.querySelector('.media-popup-image-overlay');
    const popupEl = overlay.querySelector('.media-popup');
    if (!contentEl || !controlsEl) return;
    contentEl.innerHTML = '';
    controlsEl.classList.remove('media-popup-image-ui');
    controlsEl.style.opacity = '';
    if (popupEl) popupEl.classList.toggle('media-popup--video', k === 'video');
    if (imageOverlayEl) imageOverlayEl.style.display = k === 'video' ? 'none' : '';
    // Fullscreen targets the whole popup (keeps custom controls visible);
    // the video branch overrides this to the <video> element.
    overlay._fsTarget = popupEl || overlay.querySelector('.media-popup');

    const statusEl = document.createElement('div');
    statusEl.className = 'media-popup-status';
    statusEl.textContent = t('mediaLoading');
    contentEl.appendChild(statusEl);

    const setStatus = (text, isError = false) => {
      statusEl.textContent = text || '';
      statusEl.classList.toggle('media-popup-status--error', !!isError);
      statusEl.style.display = text ? '' : 'none';
    };

    const clearImageHandlers = () => {
      overlay._imageShowUI = null;
      overlay._imageHideUI = null;
      overlay._imageZoomBy = null;
      overlay._imagePanBy = null;
      overlay._imageReset = null;
    };

    if (k === 'video') {
      const stepBtn = (dir, sec) => dir === 'back'
        ? `<button type="button" class="media-popup-step" data-sec="${sec}" title="Back ${sec}s" aria-label="Back ${sec}s"><span class="icon icon-sm">${ICON_REWIND}</span><span class="media-popup-step-sec">${sec}</span></button>`
        : `<button type="button" class="media-popup-step-fwd" data-sec="${sec}" title="Forward ${sec}s" aria-label="Forward ${sec}s"><span class="icon icon-sm">${ICON_FORWARD}</span><span class="media-popup-step-sec">${sec}</span></button>`;
      // Duration-based step: 5s (<1 min) / 10s (1–3 min) / 15s (3 min–1 h) / 20s (>1 h).
      const defaultStep = getStepOptions(NaN);
      const vid = document.createElement('video');
      vid.className = 'media-popup-video';
      vid.src = u;
      vid.controls = false;
      vid.playsInline = true;
      contentEl.appendChild(vid);
      // Fullscreen target stays on the popup element (custom controls remain
      // visible; the <video> has controls=false).
      controlsEl.innerHTML = `
        <div class="media-popup-controls-row">
          <button type="button" class="media-popup-prev" ${!prevId ? 'disabled' : ''} data-msg-id="${prevId}" title="Previous" aria-label="Previous"><span class="icon icon-sm">${ICON_PREV}</span></button>
          ${stepBtn('back', defaultStep)}
          <button type="button" class="media-popup-play" title="Play (K)" aria-label="Play"><span class="icon icon-sm media-popup-play-icon">${ICON_PLAY}</span></button>
          ${stepBtn('fwd', defaultStep)}
          <button type="button" class="media-popup-next" ${!nextId ? 'disabled' : ''} data-msg-id="${nextId}" title="Next" aria-label="Next"><span class="icon icon-sm">${ICON_NEXT}</span></button>
          <a href="${safeUrl(u)}" download class="media-popup-download" title="Download" aria-label="Download"><span class="icon icon-sm">${ICON_DOWNLOAD}</span></a>
          <span class="media-popup-kb-hint">${escapeHtml(t('mediaKbHintVideo'))}</span>
        </div>
      `;
      overlay.querySelector('.media-popup-prev')?.addEventListener('click', () => { if (prev) setMedia(prev); });
      overlay.querySelector('.media-popup-next')?.addEventListener('click', () => { if (next) setMedia(next); });
      overlay.querySelector('.media-popup-play')?.addEventListener('click', () => { vid.paused ? vid.play() : vid.pause(); });
      const bindStep = (sel, dir) => {
        overlay.querySelector(sel)?.addEventListener('click', () => {
          const sec = parseInt(overlay.querySelector(sel)?.dataset.sec || '5', 10);
          if (dir === 'back') vid.currentTime = Math.max(0, vid.currentTime - sec);
          else vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + sec);
        });
      };
      bindStep('.media-popup-step', 'back');
      bindStep('.media-popup-step-fwd', 'fwd');
      vid.addEventListener('loadedmetadata', () => {
        const sec = getStepOptions(vid.duration);
        for (const [sel, dir] of [['.media-popup-step', 'Back'], ['.media-popup-step-fwd', 'Forward']]) {
          const btn = overlay.querySelector(sel);
          if (!btn) continue;
          btn.dataset.sec = sec;
          btn.title = `${dir} ${sec}s`;
          btn.setAttribute('aria-label', `${dir} ${sec}s`);
          const label = btn.querySelector('.media-popup-step-sec');
          if (label) label.textContent = sec;
        }
      });
      vid.addEventListener('loadeddata', () => setStatus(''));
      vid.addEventListener('error', () => setStatus(t('mediaLoadError'), true));
      vid.addEventListener('play', () => {
        const b = overlay.querySelector('.media-popup-play');
        const icon = b?.querySelector('.media-popup-play-icon');
        if (icon) icon.innerHTML = ICON_PAUSE;
        if (b) b.setAttribute('aria-label', 'Pause');
      });
      vid.addEventListener('pause', () => {
        const b = overlay.querySelector('.media-popup-play');
        const icon = b?.querySelector('.media-popup-play-icon');
        if (icon) icon.innerHTML = ICON_PLAY;
        if (b) b.setAttribute('aria-label', 'Play');
      });
      clearImageHandlers();
    } else {
      controlsEl.innerHTML = `
        <div class="media-popup-image-ui media-popup-controls-row" role="toolbar">
          <button type="button" class="media-popup-prev" ${!prevId ? 'disabled' : ''} data-msg-id="${prevId}" title="Previous" aria-label="Previous"><span class="icon icon-sm">${ICON_PREV}</span></button>
          <button type="button" class="media-popup-next" ${!nextId ? 'disabled' : ''} data-msg-id="${nextId}" title="Next" aria-label="Next"><span class="icon icon-sm">${ICON_NEXT}</span></button>
          <a href="${safeUrl(u)}" download class="media-popup-download" title="Download" aria-label="Download"><span class="icon icon-sm">${ICON_DOWNLOAD}</span></a>
          <span class="media-popup-kb-hint">${escapeHtml(t('mediaKbHintImage'))}</span>
        </div>
      `;
      controlsEl.classList.add('media-popup-image-ui');
      controlsEl.style.opacity = '0';
      const img = document.createElement('img');
      img.className = 'media-popup-image';
      img.src = u;
      img.alt = '';
      contentEl.appendChild(img);
      let scale = 1;
      let tx = 0;
      let ty = 0;
      let baseW = 0;
      let baseH = 0;
      let uiTimer = null;
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const pointers = new Map();
      let pinchStartDist = 0;
      let pinchStartScale = 1;

      function measureBase() {
        const r = img.getBoundingClientRect();
        baseW = r.width || baseW;
        baseH = r.height || baseH;
      }
      function clampPan() {
        if (!contentEl) return;
        const maxX = Math.max(0, (baseW * scale - contentEl.clientWidth) / 2);
        const maxY = Math.max(0, (baseH * scale - contentEl.clientHeight) / 2);
        tx = Math.max(-maxX, Math.min(maxX, tx));
        ty = Math.max(-maxY, Math.min(maxY, ty));
      }
      function updateTransform() {
        clampPan();
        img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        img.style.cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in';
      }
      function setScale(next, centerX, centerY) {
        const prevScale = scale;
        scale = Math.max(1, Math.min(5, next));
        if (scale === prevScale) return;
        if (typeof centerX === 'number' && typeof centerY === 'number') {
          const rect = contentEl.getBoundingClientRect();
          const cx = centerX - rect.left - rect.width / 2;
          const cy = centerY - rect.top - rect.height / 2;
          const ratio = scale / prevScale;
          tx = (tx - cx) * ratio + cx;
          ty = (ty - cy) * ratio + cy;
        }
        updateTransform();
      }
      function zoomBy(delta) {
        setScale(scale + delta);
      }
      function panBy(dx, dy) {
        tx += dx;
        ty += dy;
        updateTransform();
      }
      function resetView() {
        scale = 1;
        tx = 0;
        ty = 0;
        updateTransform();
      }
      function showUI() {
        controlsEl.style.opacity = '1';
        if (uiTimer) clearTimeout(uiTimer);
        uiTimer = setTimeout(hideUI, 2000);
      }
      function hideUI() {
        controlsEl.style.opacity = '0';
        if (uiTimer) clearTimeout(uiTimer);
      }
      overlay._imageShowUI = showUI;
      overlay._imageHideUI = hideUI;
      overlay._imageZoomBy = zoomBy;
      overlay._imagePanBy = panBy;
      overlay._imageReset = resetView;
      overlay.querySelector('.media-popup-image-overlay')?.addEventListener('click', showUI);
      contentEl.addEventListener('click', showUI);
      contentEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        setScale(scale + (e.deltaY > 0 ? -0.12 : 0.12), e.clientX, e.clientY);
      }, { passive: false });
      img.style.touchAction = 'none';
      img.addEventListener('load', () => {
        setStatus('');
        requestAnimationFrame(() => {
          measureBase();
          resetView();
          showUI();
        });
      });
      img.addEventListener('error', () => setStatus(t('mediaLoadError'), true));
      img.addEventListener('pointerdown', (e) => {
        showUI();
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          dragging = scale > 1;
          lastX = e.clientX;
          lastY = e.clientY;
          if (dragging) img.setPointerCapture?.(e.pointerId);
        } else if (pointers.size === 2) {
          const arr = [...pointers.values()];
          pinchStartDist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y) || 1;
          pinchStartScale = scale;
          dragging = false;
        }
        updateTransform();
      });
      img.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const arr = [...pointers.values()];
          const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y) || 1;
          const centerX = (arr[0].x + arr[1].x) / 2;
          const centerY = (arr[0].y + arr[1].y) / 2;
          setScale(pinchStartScale * (d / pinchStartDist), centerX, centerY);
          return;
        }
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        panBy(dx, dy);
      });
      const endPointer = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchStartDist = 0;
        if (pointers.size === 0) {
          dragging = false;
          updateTransform();
        }
      };
      img.addEventListener('pointerup', endPointer);
      img.addEventListener('pointercancel', endPointer);
      img.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (scale > 1.05) resetView();
        else setScale(2, e.clientX, e.clientY);
      });
      overlay.querySelector('.media-popup-prev')?.addEventListener('click', () => { if (prev) setMedia(prev); });
      overlay.querySelector('.media-popup-next')?.addEventListener('click', () => { if (next) setMedia(next); });
    }
  }

  const initialMsg = list.find(m => m.id === msgId) || { content: url, msg_type: kind === 'video' ? 'video' : 'image' };
  const isVideo = kind === 'video';
  const fsSupported = !!(document.documentElement?.requestFullscreen || document.documentElement?.webkitRequestFullscreen);
  overlay.innerHTML = `
    <div class="media-popup">
      <button type="button" class="media-popup-close" aria-label="Close"><span class="icon" aria-hidden="true">${ICON_CLOSE}</span></button>
      ${fsSupported ? `<button type="button" class="media-popup-fullscreen" aria-label="Fullscreen" title="Fullscreen"><span class="icon" aria-hidden="true">${ICON_FULLSCREEN}</span></button>` : ''}
      <div class="media-popup-content"></div>
      <div class="media-popup-image-overlay"></div>
      <div class="media-popup-controls"></div>
    </div>
  `;
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const requestFs = (el) => {
    const r = el?.requestFullscreen || el?.webkitRequestFullscreen;
    if (r) { try { r.call(el); } catch (_) {} }
  };
  const exitFs = () => {
    const x = document.exitFullscreen || document.webkitExitFullscreen;
    if (x) { try { x.call(document); } catch (_) {} }
  };
  const updateFsIcon = () => {
    const b = overlay.querySelector('.media-popup-fullscreen');
    const ic = b?.querySelector('.icon');
    if (b && ic) {
      const inFs = !!fsElement();
      ic.innerHTML = inFs ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN;
      b.setAttribute('aria-label', inFs ? 'Exit fullscreen' : 'Fullscreen');
      b.title = inFs ? 'Exit fullscreen' : 'Fullscreen';
    }
  };
  const onFsChange = () => updateFsIcon();
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  overlay.querySelector('.media-popup-fullscreen')?.addEventListener('click', () => {
    if (fsElement()) exitFs();
    else requestFs(overlay._fsTarget || overlay.querySelector('.media-popup'));
  });
  const close = () => {
    overlay.querySelector('.media-popup-video')?.pause();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
  };
  const isTypingInEditable = () => {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = (ae.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (ae.isContentEditable) return true;
    return false;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (isTypingInEditable()) return;
    if (e.key === 'ArrowLeft') {
      const prevBtn = overlay.querySelector('.media-popup-prev');
      if (prevBtn && !prevBtn.disabled) prevBtn.click();
      return;
    }
    if (e.key === 'ArrowRight') {
      const nextBtn = overlay.querySelector('.media-popup-next');
      if (nextBtn && !nextBtn.disabled) nextBtn.click();
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      const v = overlay.querySelector('.media-popup-video');
      if (v) {
        e.preventDefault();
        v.paused ? v.play() : v.pause();
      }
      return;
    }
    if (e.key === 'k' || e.key === 'K') {
      const v = overlay.querySelector('.media-popup-video');
      if (v) { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    }
    if (e.key === '+' || e.key === '=' || e.key === 'NumpadAdd') {
      overlay._imageZoomBy?.(0.15);
      return;
    }
    if (e.key === '-' || e.key === '_' || e.key === 'NumpadSubtract') {
      overlay._imageZoomBy?.(-0.15);
      return;
    }
    if (e.key === '0') {
      overlay._imageReset?.();
      return;
    }
    if (e.key === 'ArrowUp') {
      overlay._imagePanBy?.(0, 35);
      return;
    }
    if (e.key === 'ArrowDown') {
      overlay._imagePanBy?.(0, -35);
      return;
    }
  };
  overlay.querySelector('.media-popup-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('.media-popup-close')) close(); });
  document.addEventListener('keydown', onKey);
  setMedia(initialMsg);
  if (isVideo) {
    const v = overlay.querySelector('.media-popup-video');
    if (v) v.play().catch(() => {});
  }
  overlay.addEventListener('keydown', () => { overlay._imageShowUI?.(); });
  overlay.addEventListener('mousemove', (e) => {
    if (e.target.closest('.media-popup-content') || e.target.closest('.media-popup-controls')) overlay._imageShowUI?.();
  });
  overlay.addEventListener('mouseleave', () => {
    if (!('ontouchstart' in window)) overlay._imageHideUI?.();
  });
  document.body.appendChild(overlay);
}

async function openFileContentModal(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    const text = await res.text();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay file-content-modal-overlay';
    overlay.innerHTML = `
      <div class="modal file-content-modal">
        <button type="button" class="file-content-modal-close" aria-label="Close"><span class="icon" aria-hidden="true">${ICON_CLOSE}</span></button>
        <pre class="file-content-modal-body">${escapeHtml(text)}</pre>
        <a href="${escapeHtml(url).replace(/"/g, '&quot;')}" download class="file-content-modal-download"><span class="icon" aria-hidden="true">${ICON_DOWNLOAD}</span> Download</a>
      </div>
    `;
    const onEscape = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEscape); } };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onEscape); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.file-content-modal-close')?.addEventListener('click', close);
    document.addEventListener('keydown', onEscape);
    document.body.appendChild(overlay);
  } catch (e) {
    showToast('Could not load file content');
  }
}

/* ====================================================================
 * Slash-commands: /fall /joke /grumm /jimmyqrg /whisper
 *
 * Each is dispatched by the composer's send() closure when the typed text
 * starts with `/`. Returning `'kept'` means the helper deliberately leaves
 * the composer text as-is (currently no command uses this); returning
 * `true` means send() should clear the input + return; returning a
 * non-truthy value means the command didn't match, so the regular send
 * path proceeds. This makes it safe for unknown slash commands to fall
 * through to legacy group commands below.
 * ==================================================================*/

const PREFERS_REDUCED_MOTION = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * /fall <text>: send a "rain" of falling letters over the room. The
 * command is server-side: the server broadcasts a `fall:start` event to
 * every socket in the room, and every connected client (including the
 * sender) renders the animation locally. Default count is 100 letters.
 *
 * Why server-side: every viewer should see the rain fall in their own
 * viewport — that's a room-wide effect. Doing it client-only would mean
 * the sender sees rain and nobody else does.
 */
function sendFallRain(text, ctx, count = 100) {
  if (!text) return;
  // Trim to the server-side cap so we don't ship 200KB of text.
  const trimmed = String(text).trim().slice(0, 120);
  const payload = { text: trimmed, count, roomType: ctx.roomType, roomId: ctx.roomId };
  if (state.socket && state.socket.connected) {
    state.socket.emit('fall:start', payload, (res) => {
      if (res && res.error) showToast(res.error);
    });
  } else {
    // HTTP fallback: POST a multipart-free body to the room endpoint via
    // a dedicated query? We don't have one. Easiest: render locally only.
    renderFallRain({ text: trimmed, count });
  }
}

/**
 * Render a fall-rain animation locally. Called both from the
 * server-broadcast listener (every connected socket) and from the HTTP
 * fallback path. Rain starts immediately at the top of the viewport
 * (no delay) so the rain feels like a burst of confetti, then drifts
 * down with a small random horizontal offset per letter.
 */
function renderFallRain({ text, count }) {
  if (PREFERS_REDUCED_MOTION()) {
    const flash = document.createElement('div');
    flash.className = 'fall-overlay';
    flash.setAttribute('aria-hidden', 'true');
    flash.style.background = 'linear-gradient(180deg, color-mix(in srgb, var(--purple) 18%, transparent) 0%, transparent 60%)';
    flash.style.opacity = '1';
    flash.style.transition = 'opacity 0.5s ease-out';
    document.body.appendChild(flash);
    setTimeout(() => { flash.style.opacity = '0'; }, 60);
    setTimeout(() => { flash.remove(); }, 600);
    return;
  }
  if (typeof count !== 'number' || count < 10) count = 100;
  if (count > 200) count = 200;
  const W = Math.max(window.innerWidth, 320);
  const baseDelay = 0;
  // Fall everything after the /fall command as a WHOLE unit: each falling
  // piece shows the full string, not a random single character. Assigning
  // the whole string via textContent also means every character falls
  // correctly (emoji, astral-plane, any Unicode) -- unlike charAt() which
  // would split surrogate pairs.
  const label = String(text || '').trim() || '*';
  const overlay = document.createElement('div');
  overlay.className = 'fall-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  document.body.appendChild(overlay);
  // Two passes per item so it stays inside CSS transform compositing.
  for (let i = 0; i < count; i++) {
    const span = document.createElement('span');
    span.className = 'fall-word';
    span.textContent = label;
    const startX = Math.random() * Math.max(1, W - 40);
    const drift = (Math.random() - 0.5) * 24;
    const dur = 5000 + Math.random() * 4000;
    // Stagger the very first ~150 letters across 0-1.5s so they
    // visibly cascade from the top, but later letters in the burst
    // arrive together. The user said "immediately" so we keep this
    // small — only enough to feel like a rain, not a synchronized blink.
    const delay = baseDelay + (i < 60 ? Math.random() * 1500 : Math.random() * 400);
    span.style.left = startX + 'px';
    span.style.top = '-10vh';
    span.style.setProperty('--drift', drift.toFixed(1) + 'px');
    span.style.setProperty('--dur', dur + 'ms');
    span.style.setProperty('--delay', delay + 'ms');
    span.style.fontSize = (22 + Math.random() * 22) + 'px';
    overlay.appendChild(span);
  }
  // Hard safety cleanup — even if animations don't fire (background tab).
  setTimeout(() => overlay.remove(), 14_000);
}

/** Install the inbound `fall:start` socket listener once. */
if (typeof window !== 'undefined' && !window.__fallInboxInstalled) {
  window.__fallInboxInstalled = true;
  // Connect at any time: we re-bind whenever a new socket is created.
  const tryBind = () => {
    if (!state.socket) return;
    if (state.socket.__fallBound) return;
    state.socket.__fallBound = true;
    state.socket.on('fall:start', (payload) => {
      try { renderFallRain(payload || {}); } catch (_) {}
    });
  };
  // Run once now and again after each reconnect.
  tryBind();
  // Watch for socket replacement.
  setInterval(() => {
    if (state.socket && !state.socket.__fallBound) tryBind();
  }, 2000);
}

/** /grumm [/grumm] /GRUMM /grumm_: flip the entire #app vertically. A
 *  click anywhere on the page reverts. */
function triggerGrumm() {
  if (PREFERS_REDUCED_MOTION()) {
    showToast('Flipping is disabled in reduced-motion mode');
    return;
  }
  // Don't flip if any modal is open — would visually invert it.
  for (const m of document.querySelectorAll('.modal-overlay')) {
    const cs = getComputedStyle(m);
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.01) {
      showToast('Close any open modal first');
      return;
    }
  }
  const app = document.getElementById('app');
  if (!app) return;
  if (app.classList.contains('grumm-flipped')) return; // idempotent
  app.classList.add('grumm-flipped');
  // Floating "Flip Back" pill.
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'grumm-flip-back';
  pill.textContent = 'Flip back';
  document.body.appendChild(pill);
  const revert = (ev) => {
    if (pill.contains(ev.target)) return; // let the pill handle itself
    app.classList.remove('grumm-flipped');
    pill.remove();
    document.removeEventListener('click', revert, true);
  };
  pill.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    app.classList.remove('grumm-flipped');
    pill.remove();
    document.removeEventListener('click', revert, true);
  });
  // Defer attaching the click-away listener so the click that triggered
  // /grumm doesn't immediately revert.
  setTimeout(() => document.addEventListener('click', revert, true), 0);
}

/** /jimmyqrg: open the official sister site in a new tab. */
function openJimmyqrgSite() {
  try { window.open('https://perfectnip.github.io', '_blank', 'noopener,noreferrer'); }
  catch (_) { showToast('Pop-up blocked'); }
}

/** /joke: fetch a random joke and send it as a regular text message in
 *  the current room, as the sender's own message. */
async function handleJokeCommand({ roomType, roomId, replyTo }) {
  let data;
  try {
    data = await apiGet('/api/jokes/random');
  } catch (err) {
    showToast(err?.message || 'Failed to fetch a joke');
    return true; // we consumed the input
  }
  const joke = (data && data.joke) ? String(data.joke) : '';
  if (!joke) {
    showToast('No jokes available');
    return true;
  }
  const reply_to_id = replyTo?.id || null;
  const socketReady = !!(state.socket && state.socket.connected);
  const sendOverSocket = () => new Promise((resolve) => {
    state.socket.emit('message:send', { roomType, roomId, content: joke, msg_type: 'text', reply_to_id }, (res) => {
      if (!res || res.error) {
        if (res?.error === 'AI_MOD_BLOCK') showAiModerationModal(res.reason || '');
        else if (res?.error) showToast(res.error);
        return resolve();
      }
      if (res.message) addMessageLocal(res.message);
      setState({ replyTo: null });
      resolve();
    });
  });
  state._sendingMessage = true;
  try {
    if (socketReady) await sendOverSocket();
    else {
      const path = roomType === 'dm'
        ? `/api/conversations/${roomId}/messages`
        : `/api/rooms/${roomType}/${roomId}/messages`;
      try {
        const body = { content: joke, msg_type: 'text' };
        if (reply_to_id) body.reply_to_id = reply_to_id;
        const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
        const json = await res.json().catch(() => ({}));
        if (json && json.message) addMessageLocal(json.message);
        setState({ replyTo: null });
      } catch (err) {
        showToast(err?.message || 'Failed to send joke');
      }
    }
  } finally {
    state._sendingMessage = false;
  }
  return true;
}

/** /whisper [/msg] [/tell]: parse user → resolve → modal → send. Returns
 *  true on completion (input always cleared). */
async function handleWhisperCommand(text, ctx) {
  // Strip the leading `/cmd ` to get `<name> <text>`.
  const m = text.match(/^\/(whisper|msg|tell)\s+(.+)$/i);
  if (!m) return false;
  const tail = m[2].trim();
  if (!tail) { showToast('Usage: /whisper <username> <message>'); return true; }
  // First token is the recipient; strip a leading '@' and lowercase it.
  const sp = tail.split(/\s+/);
  const rawName = sp[0].replace(/^@/, '');
  const message = sp.slice(1).join(' ').trim();
  if (!message) {
    showToast('Usage: /whisper <username> <message>');
    return true;
  }
  let recipient;
  try {
    const search = await apiGet(`/api/users/mention-search?q=${encodeURIComponent(rawName)}&limit=5`);
    const users = (search && Array.isArray(search.users)) ? search.users : [];
    if (users.length === 0) {
      showToast(`No matching user for "${rawName}"`);
      return true;
    }
    if (users.length === 1) recipient = users[0];
    else {
      const picked = await pickWhisperRecipient(users, rawName);
      if (!picked) return true; // user cancelled
      recipient = picked;
    }
  } catch (err) {
    showToast(err?.message || 'Failed to look up user');
    return true;
  }
  const audience = await pickWhisperAudience(recipient);
  if (!audience) return true;
  if (ctx.roomType !== 'group' && ctx.roomType !== 'dm') {
    showToast('Cannot whisper from this room');
    return true;
  }
  const payload = {
    roomType: ctx.roomType,
    roomId: ctx.roomId,
    content: message,
    msg_type: 'whisper',
    recipient_user_id: recipient.id,
    audience,
    reply_to_id: ctx.replyTo?.id || null,
  };
  state._sendingMessage = true;
  try {
    const socketReady = !!(state.socket && state.socket.connected);
    if (socketReady) {
      await new Promise((resolve) => {
        state.socket.emit('message:send', payload, (res) => {
          if (!res || res.error) {
            if (res?.error === 'AI_MOD_BLOCK') showAiModerationModal(res.reason || '');
            else if (res?.error) showToast(res.error);
            return resolve();
          }
          if (res.message) addMessageLocal(res.message);
          setState({ replyTo: null });
          resolve();
        });
      });
    } else {
      const path = payload.roomType === 'dm'
        ? `/api/conversations/${payload.roomId}/messages`
        : `/api/rooms/${payload.roomType}/${payload.roomId}/messages`;
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json?.error === 'AI_MOD_BLOCK') showAiModerationModal(json.reason || '');
        else showToast(json?.error || res.statusText);
      } else if (json && json.message) addMessageLocal(json.message);
      setState({ replyTo: null });
    }
  } finally {
    state._sendingMessage = false;
  }
  return true;
}

/** Modal: pick a single recipient when mention-search returned >1. */
function pickWhisperRecipient(users, query) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay whisper-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal whisper-modal" role="dialog" aria-modal="true" aria-labelledby="whisper-recipient-title">
        <div class="modal-header">
          <h2 id="whisper-recipient-title">Choose recipient</h2>
          <button type="button" class="modal-close" aria-label="Close">${ICON_X_SM}</button>
        </div>
        <div class="whisper-modal-body">
          <p>Multiple users match "<strong>${escapeHtml(query)}</strong>". Pick one:</p>
          <div class="whisper-recipient-list" role="listbox" aria-label="Matching users"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="modal-close whisper-modal-cancel">Cancel</button>
        </div>
      </div>
    `;
    // The .modal-overlay class is what gives the dim backdrop and the
    // centred flex layout. We piggy-back on it instead of inlining styles.
    overlay.classList.add('modal-overlay');
    overlay.removeAttribute('style');
    document.body.appendChild(overlay);
    const close = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    function onKey(ev) {
      if (ev.key === 'Escape') close(null);
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const opts = overlay.querySelectorAll('.whisper-recipient-option');
        if (!opts.length) return;
        const focused = document.activeElement;
        const idx = Array.from(opts).indexOf(focused);
        const next = ev.key === 'ArrowDown'
          ? (idx + 1) % opts.length
          : (idx <= 0 ? opts.length - 1 : idx - 1);
        opts[next].focus();
      }
    }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.modal-header .modal-close').addEventListener('click', (e) => { e.stopPropagation(); close(null); });
    overlay.querySelector('.whisper-modal-cancel').addEventListener('click', (e) => { e.stopPropagation(); close(null); });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    const list = overlay.querySelector('.whisper-recipient-list');
    for (const u of users) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'whisper-recipient-option';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');
      btn.innerHTML = `
        <span class="whisper-recipient-text">
          <span class="whisper-recipient-name">${escapeHtml(u.display_name || u.username)}</span>
          <span class="whisper-recipient-handle">@${escapeHtml(u.username)}</span>
        </span>
      `;
      btn.addEventListener('click', (e) => { e.stopPropagation(); close(u); });
      list.appendChild(btn);
    }
    const first = overlay.querySelector('.whisper-recipient-option');
    if (first) first.focus();
  });
}

/** Modal: choose 'hidden' or 'placeholder' for the whisper. */
function pickWhisperAudience(recipient) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay whisper-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const username = recipient && recipient.username ? recipient.username : 'user';
    overlay.innerHTML = `
      <div class="modal whisper-modal" role="document">
        <div class="modal-header">
          <h2 id="whisper-audience-title">Whisper to @${escapeHtml(username)}</h2>
          <button type="button" class="modal-close" aria-label="Close">${ICON_X_SM}</button>
        </div>
        <div class="whisper-modal-body">
          <p>Whispering sends a private message only visible to <strong>you</strong>, <strong>@${escapeHtml(username)}</strong>, <strong>jimmyqrg</strong>, and any admin with the <em>See whispers</em> permission.</p>
          <p>Choose how others see this message:</p>
          <div class="whisper-audience-options" role="radiogroup" aria-labelledby="whisper-audience-title">
            <button type="button" class="whisper-audience-option" data-audience="hidden" role="radio" aria-checked="false">
              <strong>Hidden</strong>
              <span class="option-desc">Don't show anything to other viewers. Recommended.</span>
            </button>
            <button type="button" class="whisper-audience-option" data-audience="placeholder" role="radio" aria-checked="false">
              <strong>Show as placeholder</strong>
              <span class="option-desc">Show a small "[private message]" stub to other viewers.</span>
            </button>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="modal-close whisper-modal-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    function onKey(ev) {
      if (ev.key === 'Escape') close(null);
      else if (ev.key === 'Enter') {
        const hiddenBtn = overlay.querySelector('button[data-audience="hidden"]');
        hiddenBtn && hiddenBtn.click();
      }
    }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.modal-header .modal-close').addEventListener('click', (e) => { e.stopPropagation(); close(null); });
    overlay.querySelector('.whisper-modal-cancel').addEventListener('click', (e) => { e.stopPropagation(); close(null); });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.querySelectorAll('.whisper-audience-option').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        overlay.querySelectorAll('.whisper-audience-option').forEach(b => b.setAttribute('aria-checked', 'false'));
        btn.setAttribute('aria-checked', 'true');
        close(btn.dataset.audience || 'hidden');
      });
    });
    overlay.querySelector('button[data-audience="hidden"]').focus();
  });
}

/**
 * True only when the first `/` of `text` actually begins a slash-command
 * at the message level — i.e. NOT enclosed by an inline code span,
 * fenced code block, raw HTML tag, or a `$\language="" $` KaTeX flag.
 *
 * Implementation: returns false if, at the offset where the leading `/`
 * appears, the text on that line is already inside an unclosed span /
 * block of any of those delimiters. We keep this intentionally narrow
 * so a normal "/joke" at the start of a line always qualifies.
 */
function textIsTopLevelSlash(text) {
  if (!text) return false;
  if (text[0] !== '/') return false;
  // Unclosed spans/fences on the leading line. Returns true if nothing
  // wraps the leading `/`.
  return isSlashUnblocked(text);
}
function isSlashUnblocked(text) {
  // Walk char-by-char tracking the most recent opener of any of: code
  // fence (```...``` or ~~~...~~~), inline backticks (`x`), HTML tag
  // (<...>... — we just track the open brace), or LaTeX math ($...$ /
  // $$...$$). If the leading `/` sits inside any of those, the command
  // shouldn't fire.
  let inFence = false; // ``` or ~~~
  let fenceMarker = null;
  let fenceLen = 0;
  let inInlineCode = false;
  let inMath = false;       // single-$ ... $
  let inDisplayMath = false; // $$ ... $$
  let inHtmlTag = false;     // <...>
  let i = 0;
  // Detect a fenced code block at the very start of the message first.
  const fenceStart = text.match(/^(\s*)(`{3,}|~{3,})/);
  if (fenceStart) {
    const marker = fenceStart[2][0];
    inFence = true;
    fenceMarker = marker;
    fenceLen = fenceStart[2].length;
    i = fenceStart[0].length;
  }
  // Slashes only count as commands at the start of the message; we
  // already checked text[0] === '/'. The question is: is that leading /
  // wrapped in any of the contexts above? It can only be wrapped by a
  // fence opened before it on the same line — backticks, math, or HTML
  // would have to span a preceding portion of the same line that opened
  // with an unclosed delimiter. The simple check: scan the very leading
  // substring before the `/` for any unclosed delimiter.
  const head = text.slice(0, 0); // we already know /  is at index 0
  // Same-line only — backticks / $ / < before the / on this line.
  // If the first char is / and there's no preceding content on this
  // line, it's necessarily top-level.
  let lineStart = 0;
  // The slash is at index 0 so there's no prefix on the same line;
  // there's nothing to unwrap. The only enclosing context would be a
  // fence that opened BEFORE lineStart — but a fence must start a line.
  // So if we're inside a fence, the / must be on a later line — already
  // checked by fence-detect at the top.
  // The remaining trick: a leading `$\language="..."$\` block — the
  // user's literal example. `$...$` is inline math. If the message
  // begins with `$/...$` we'd treat it as math; but our dispatches look
  // at the literal leading `/`. Treat `$\language="..."\$ ...` as an
  // explicit "math-flag block" — if the first 3 chars are `$\\` or
  // `$\l` it's a language-tag block, return false. The user's example
  // shows `$\language=""$\\` for a KaTeX language flag, which begins
  // with `$\\`. The safe heuristic: if the leading line starts with
  // `$\` (backslash), treat it as a math block opener and skip.
  if (text.startsWith('$\\')) return false;
  return true;
}

/**
 * If the typed text is wrapped in a math/code/HTML block of any kind at
 * its top, returns the raw text minus any language-flag prefix. Otherwise
 * returns null. Used to make commands inert inside content blocks.
 */
function extractPlaintextBypass(text) {
  // User prefix: literally `/plaintext ` or `/plaintext\n` etc. Anything
  // after the prefix is sent verbatim as a text message — leading slashes
  // preserved. We deliberately do NOT echo the literal "/plaintext" into
  // the message body.
  const m = text.match(/^\/plaintext\b\s*([\s\S]*)$/i);
  if (m) return m[1];
  return null;
}

/**
 * Returns true when `text` contains a "/plaintext" line on its own line
 * (case-insensitive, trimmed). This is the highest-priority directive:
 * everything below that line is sent verbatim as plain text, bypassing
 * ALL slash-command dispatch. The line itself stays in the stored message
 * so renderMessageContent() can split on it and escape the lines below.
 */
function hasPlaintextLine(text) {
  if (text == null) return false;
  return String(text).split(/\r\n|\r|\n/).some((l) => l.trim().toLowerCase() === '/plaintext');
}

/** Dispatcher used by the composer send closure. */
async function handleSlashCommand(text, ctx) {
  if (!text || !textIsTopLevelSlash(text)) return false;
  const lower = text.toLowerCase();
  // /fall <anything>: server-side broadcast. The handler attaches a
  // `fall:start` listener that runs the actual animation. Text + count
  // are forwarded verbatim so the server can rate-limit centrally.
  if (lower.startsWith('/fall ')) {
    const payload = text.slice(6).trim();
    sendFallRain(payload, { roomType: ctx.roomType, roomId: ctx.roomId }, 100);
    return true;
  }
  // /grumm variants. Accept /grumm, /grumm_, /GRUMM, etc.
  if (lower === '/grumm' || lower === '/grumm_' || lower === '/grumm.' || lower === '/grumm!' || lower === '/grumm?') {
    triggerGrumm();
    return true;
  }
  if (lower === '/jimmyqrg' || lower === '/jimmyqrg.' || lower === '/jimmyqrg!' || lower === '/jimmyqrg?') {
    openJimmyqrgSite();
    return true;
  }
  if (lower === '/joke' || lower === '/joke.' || lower === '/joke!' || lower === '/joke?') {
    return await handleJokeCommand(ctx);
  }
  if (lower.startsWith('/whisper ') || lower.startsWith('/msg ') || lower.startsWith('/tell ')) {
    return await handleWhisperCommand(text, ctx);
  }
  return false;
}

function bindMain() {
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.chat-codeblock-copy');
    if (!copyBtn) return;
    const pre = copyBtn.closest('.chat-codeblock');
    const code = pre?.querySelector('code');
    if (!code) return;
    navigator.clipboard?.writeText(code.textContent || '');
    const orig = copyBtn.innerHTML;
    copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    copyBtn.style.color = '#4ade80';
    setTimeout(() => { copyBtn.innerHTML = orig; copyBtn.style.color = ''; }, 1500);
  });

  document.querySelector('.panel-column-content')?.addEventListener('click', (e) => {
    if (e.target.closest('a') && state.panelColumnExpanded) {
      state.panelColumnExpanded = false;
      setState({});
    }
  });

  document.getElementById('panel-search-btn')?.addEventListener('click', () => {
    setState({ panelSearchOpen: !state.panelSearchOpen });
  });

  // Voice chat bindings
  document.getElementById('join-voice-chat')?.addEventListener('click', async () => {
    if (!state._voiceJoined) {
      await voiceJoin();
      state.panel = 'voice_chat';
      render();
    } else {
      state.panel = 'voice_chat';
      render();
    }
  });
  document.getElementById('vc-mic')?.addEventListener('click', voiceToggleMic);
  document.getElementById('vc-cam')?.addEventListener('click', voiceToggleCam);
  document.getElementById('vc-screen')?.addEventListener('click', () => {
    if (state._voiceScreenOn) { voiceStopScreenShare(); return; }
    const existing = document.querySelector('.vc-screen-menu');
    if (existing) { existing.remove(); return; }
    const btn = document.getElementById('vc-screen');
    const rect = btn?.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'vc-screen-menu';
    menu.style.left = (rect ? rect.left : 0) + 'px';
    menu.style.bottom = (rect ? window.innerHeight - rect.top + 8 : 60) + 'px';
    menu.innerHTML = `
      <button data-surface="browser">Browser tab</button>
      <button data-surface="window">Application window</button>
      <button data-surface="monitor">Entire screen</button>
      <label class="vc-screen-audio-opt"><input type="checkbox" id="vc-screen-audio" /> Share system audio</label>`;
    document.body.appendChild(menu);
    menu.querySelectorAll('button[data-surface]').forEach(b => {
      b.addEventListener('click', () => {
        const systemAudio = document.getElementById('vc-screen-audio')?.checked || false;
        menu.remove();
        voiceShareScreen({ displaySurface: b.dataset.surface, systemAudio });
      });
    });
    const closeMenu = (e) => { if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', closeMenu); } };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  });
  document.getElementById('vc-chat-toggle')?.addEventListener('click', () => {
    state._voiceSidePanel = state._voiceSidePanel === 'chat' ? null : 'chat';
    render();
    if (state._voiceSidePanel === 'chat') {
      requestAnimationFrame(() => {
        document.getElementById('vc-chat-input')?.focus();
        const wrap = document.getElementById('voice-chat-messages');
        if (wrap) wrap.scrollTop = wrap.scrollHeight;
      });
    }
  });
  document.getElementById('vc-members-toggle')?.addEventListener('click', () => {
    state._voiceSidePanel = state._voiceSidePanel === 'members' ? null : 'members';
    render();
  });
  document.getElementById('vc-side-close')?.addEventListener('click', () => {
    state._voiceSidePanel = null;
    render();
  });
  document.getElementById('vc-leave')?.addEventListener('click', voiceLeave);
  document.getElementById('vc-chat-send')?.addEventListener('click', () => {
    const input = document.getElementById('vc-chat-input');
    if (input?.value?.trim()) { voiceSendChatMessage(input.value); input.value = ''; }
  });
  document.getElementById('vc-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input = e.target;
      if (input.value?.trim()) { voiceSendChatMessage(input.value); input.value = ''; }
    }
  });

  // DM voice chat bindings
  document.getElementById('dm-voice-call-btn')?.addEventListener('click', () => {
    if (!state.dmUserId || !state.convIdToUserId || !state.convByUserId) return;
    const convId = state.convByUserId[state.dmUserId];
    if (!convId) { showToast('Open a conversation first'); return; }
    if (state._dmVoiceJoined) { showToast('You are already in a call'); return; }
    if (state._dmVoiceRingingOutgoing) { dmVoiceCancelInvite(); return; }
    dmVoiceInvite(state.dmUserId, convId);
  });
  document.getElementById('dm-vc-mic')?.addEventListener('click', dmVoiceToggleMic);
  document.getElementById('dm-vc-cam')?.addEventListener('click', dmVoiceToggleCam);
  document.getElementById('dm-vc-screen')?.addEventListener('click', () => {
    if (state._dmVoiceScreenOn) { dmVoiceStopScreenShare(); return; }
    const existing = document.querySelector('.vc-screen-menu');
    if (existing) { existing.remove(); return; }
    const btn = document.getElementById('dm-vc-screen');
    const rect = btn?.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'vc-screen-menu';
    menu.style.left = (rect ? rect.left : 0) + 'px';
    menu.style.bottom = (rect ? window.innerHeight - rect.top + 8 : 60) + 'px';
    menu.innerHTML = `
      <button data-surface="browser">Browser tab</button>
      <button data-surface="window">Application window</button>
      <button data-surface="monitor">Entire screen</button>
      <label class="vc-screen-audio-opt"><input type="checkbox" id="dm-vc-screen-audio" /> Share system audio</label>`;
    document.body.appendChild(menu);
    menu.querySelectorAll('button[data-surface]').forEach(b => {
      b.addEventListener('click', () => {
        const systemAudio = document.getElementById('dm-vc-screen-audio')?.checked || false;
        menu.remove();
        dmVoiceShareScreen({ displaySurface: b.dataset.surface, systemAudio });
      });
    });
    const closeMenu = (e) => { if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', closeMenu); } };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  });
  document.getElementById('dm-vc-chat-toggle')?.addEventListener('click', () => {
    state._dmVoiceSidePanel = state._dmVoiceSidePanel === 'chat' ? null : 'chat';
    render();
    if (state._dmVoiceSidePanel === 'chat') {
      requestAnimationFrame(() => {
        document.getElementById('dm-vc-chat-input')?.focus();
        const wrap = document.getElementById('dm-voice-chat-messages');
        if (wrap) wrap.scrollTop = wrap.scrollHeight;
      });
    }
  });
  document.getElementById('dm-vc-members-toggle')?.addEventListener('click', () => {
    state._dmVoiceSidePanel = state._dmVoiceSidePanel === 'members' ? null : 'members';
    render();
  });
  document.getElementById('dm-vc-side-close')?.addEventListener('click', () => {
    state._dmVoiceSidePanel = null;
    render();
  });
  document.getElementById('dm-vc-leave')?.addEventListener('click', dmVoiceLeave);
  document.getElementById('dm-vc-chat-send')?.addEventListener('click', () => {
    const input = document.getElementById('dm-vc-chat-input');
    if (input?.value?.trim()) { dmVoiceSendChatMessage(input.value); input.value = ''; }
  });
  document.getElementById('dm-vc-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input = e.target;
      if (input.value?.trim()) { dmVoiceSendChatMessage(input.value); input.value = ''; }
    }
  });
  document.getElementById('dm-voice-accept-btn')?.addEventListener('click', () => {
    const r = state._dmVoiceRinging;
    if (r) dmVoiceAccept(r.fromUserId, r.convId);
  });
  document.getElementById('dm-voice-decline-btn')?.addEventListener('click', () => {
    const r = state._dmVoiceRinging;
    if (r) dmVoiceDecline(r.fromUserId, r.convId);
  });
  document.getElementById('dm-voice-cancel-btn')?.addEventListener('click', dmVoiceCancelInvite);

  function bindUserListSearch(inputId, listId) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return;
    input.addEventListener('input', () => {
      const q = (input.value || '').trim().toLowerCase();
      list.querySelectorAll('a.panel-list-link').forEach((a) => {
        const match = !q || (a.dataset.username || '').includes(q) || (a.dataset.display || '').includes(q);
        a.closest('li').style.display = match ? '' : 'none';
      });
    });
    list.addEventListener('contextmenu', (e) => {
      const a = e.target.closest('a.panel-list-link[data-user-id]');
      if (!a) return;
      e.preventDefault();
      const userId = a.dataset.userId;
      const friend = a.dataset.friend === '1';
      const pending = isFriendRequestPending(userId);
      const isSelf = userId === state.user?.id;
      // Each admin shortcut is gated on its OWN power so admins only see what
      // they can actually do. Never offer them on yourself or on jimmyqrg.
      const targetable = !!userId && userId !== 'jimmyqrg' && !isSelf;
      const canQuickTimeout = targetable && !!state.user?.can_timeout;
      const canRemoveAccount = targetable && !!state.user?.can_kick;

      const items = [];
      // ── Group 1: navigation
      items.push({ label: t('profile'), action: 'profile' });
      items.push({ label: t('chat'), action: 'chat' });

      // ── Group 2: relationship (friend / block)
      if (!isSelf) {
        items.push({ separator: true });
        if (!friend) items.push({ label: pending ? t('requestPending') : t('sendFriendRequest'), action: 'friend-request', disabled: pending });
        items.push({ label: t('block'), action: 'block', danger: true });
      }

      // ── Group 3: timeout shortcuts — requires can_timeout
      if (canQuickTimeout) {
        items.push({ separator: true });
        items.push({ label: tx('timeout10m', 'Timeout 10 min') + ' (group)', action: 'timeout:10 minute:group' });
        items.push({ label: tx('timeout30m', 'Timeout 30 min') + ' (group)', action: 'timeout:30 minute:group' });
        items.push({ label: tx('timeout1h', 'Timeout 1 h') + ' (group)', action: 'timeout:1 hour:group' });
        items.push({ label: tx('timeoutForever', 'Timeout forever') + ' (group)', action: 'timeout:forever:group', danger: true });
        items.push({ separator: true });
        items.push({ label: tx('timeout10m', 'Timeout 10 min') + ' (DM)', action: 'timeout:10 minute:dm' });
        items.push({ label: tx('timeout30m', 'Timeout 30 min') + ' (DM)', action: 'timeout:30 minute:dm' });
        items.push({ label: tx('timeout1h', 'Timeout 1 h') + ' (DM)', action: 'timeout:1 hour:dm' });
        items.push({ label: tx('timeoutForever', 'Timeout forever') + ' (DM)', action: 'timeout:forever:dm', danger: true });
      }

      // ── Group 4: account-level admin actions — requires can_kick
      if (canRemoveAccount) {
        items.push({ separator: true });
        items.push({ label: t('adminRemoveAccount'), action: 'remove-account', danger: true });
      }

      showContextMenu(e.clientX, e.clientY, items, async (action) => {
        if (typeof action === 'string' && action.startsWith('timeout:')) {
          const [, duration, scope] = action.split(':');
          quickTimeoutUser(userId, duration, scope || 'group');
          return;
        }
        if (action === 'remove-account') return removeAccount(userId);
        if (action === 'profile') navigateTo(`/chat/${encodeURIComponent(userId)}?view=profile`);
        else if (action === 'chat') navigateTo(`/chat/${encodeURIComponent(userId)}`);
        else if (action === 'friend-request') {
          if (pending) return;
          try {
            await apiPost('/api/friends/request', { to_user_id: userId });
            if (!state.pending_friend_ids.includes(userId)) state.pending_friend_ids.push(userId);
            await loadPendingFriendRequests();
            await loadFriends();
            render();
          } catch (err) { showToast(err.message || 'Failed to send friend request'); }
        } else if (action === 'block') {
          try {
            await apiPost('/api/blocks', { user_id: userId });
            state.blocked_ids = [...(state.blocked_ids || []), userId];
            await loadFriends();
            render();
          } catch (err) { showToast(err.message); }
        }
      });
    });
  }
  bindUserListSearch('panel-user-search', 'panel-user-list');
  bindUserListSearch('chat-side-user-search', 'chat-side-user-list');
  document.getElementById('chat-side-user-list')?.addEventListener('click', (e) => {
    const link = e.target.closest('.panel-list-link');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const uid = link.dataset.userId;
      if (uid) showProfileModal(uid);
    }
  });

  document.getElementById('cancel-reply')?.addEventListener('click', () => setState({ replyTo: null }));
  document.getElementById('support-helper-tip-close')?.addEventListener('click', () => {
    try { localStorage.setItem('__jqrg_support_tip_hidden', '1'); } catch (_) {}
    document.getElementById('support-helper-tip')?.remove();
  });
  document.querySelector('[data-reply-jump]')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const targetId = btn.dataset.replyToId;
    if (!targetId) return;
    const ctx = getCurrentRoomContext();
    if (!ctx) return;
    try {
      await jumpToMessageInCurrentChat(targetId, state.replyTo?.created_at || null, ctx.roomType, ctx.roomId);
    } catch (err) {
      showToast(err.message || 'Could not jump to message');
    }
  });
  document.querySelector('.pinned-message-banner')?.addEventListener('click', (e) => {
    if (e.target.closest('.pinned-message-unpin')) return;
    const msgId = e.currentTarget.dataset.msgId;
    if (msgId) {
      const el = document.querySelector(`.message[data-msg-id="${msgId}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('message-highlight'); setTimeout(() => el.classList.remove('message-highlight'), 2000); }
    }
  });
  document.querySelector('.pinned-message-unpin')?.addEventListener('click', () => {
    const roomType = state.dmUserId ? 'dm' : 'group';
    const roomId = state.dmUserId ? state.convId : state.panel;
    apiDelete(`/api/admin/pin/${roomType}/${roomId}`).catch((err) => showToast(err.message || 'Failed to unpin'));
  });
  document.getElementById('chat-header-menu-btn')?.addEventListener('click', (e) => {
    const isDm = !!state.dmUserId;
    if (isDm) {
      // DM: open a real dropdown menu anchored to the button.
      const btn = e.currentTarget;
      const rect = btn.getBoundingClientRect();
      const isFriendTarget = isFriend(state.dmUserId);
      const items = [];
      if (isFriendTarget) {
        items.push({
          label: 'Voice Call',
          action: 'voice-call',
        });
      }
      items.push({
        label: 'Search Message',
        action: 'search-message',
      });
      items.push({
        label: 'View Profile',
        action: 'view-profile',
      });
      // Anchor the menu to the bottom-right of the button; showContextMenu
      // clamps to viewport.
      const x = rect.right;
      const y = rect.bottom + 4;
      showContextMenu(x, y, items, (action) => {
        if (action === 'voice-call') {
          dmVoiceInvite(state.dmUserId, state.convByUserId?.[state.dmUserId] || state.convId);
        } else if (action === 'search-message') {
          state._chatSidePanelOpen = true;
          state._chatSidePanelTab = 'search';
          render();
          requestAnimationFrame(() => document.getElementById('chat-search-query')?.focus());
        } else if (action === 'view-profile') {
          navigateTo(`/chat/${encodeURIComponent(state.dmUserId)}?view=profile`);
        }
      });
      return;
    }
    // Group: keep existing side-panel toggle behavior.
    state._chatSidePanelOpen = !state._chatSidePanelOpen;
    if (state._chatSidePanelOpen && !state._chatSidePanelTab) state._chatSidePanelTab = 'users';
    render();
    if (state._chatSidePanelOpen && state._chatSidePanelTab === 'users') {
      requestAnimationFrame(() => {
        document.getElementById('chat-side-user-search')?.focus();
      });
    }
  });
  document.querySelectorAll('[data-chat-side-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state._chatSidePanelOpen = true;
      state._chatSidePanelTab = btn.dataset.chatSideTab || 'users';
      render();
      if (state._chatSidePanelTab === 'search') {
        requestAnimationFrame(() => {
          document.getElementById('chat-search-query')?.focus();
        });
      }
    });
  });
  document.getElementById('chat-side-panel-close')?.addEventListener('click', () => {
    state._chatSidePanelOpen = false;
    render();
  });

  const wrap = document.querySelector('.messages-wrap');
  const scrollBtn = document.querySelector('.scroll-to-bottom');
  const roomType = wrap?.dataset.roomType;
  const roomId = wrap?.dataset.roomId;
  if (wrap && roomType && roomId) {
    requestAnimationFrame(() => {
      const preserve = state._preserveScrollAfterPrepend;
      const key = roomKey(roomType, roomId);
      if (state._scrollToMessageId) {
        const row = document.querySelector(`.message-row[data-msg-id="${state._scrollToMessageId}"]`);
        if (row) {
          row.scrollIntoView({ block: 'center', behavior: 'smooth' });
          row.classList.add('message-row-highlight');
          setTimeout(() => row.classList.remove('message-row-highlight'), 1800);
        }
        state._scrollToMessageId = null;
      } else if (preserve && preserve.key === key) {
        wrap.scrollTop = Math.max(0, wrap.scrollHeight - preserve.prevHeight);
        if (!state._loadingOlderMessages?.[key]) {
          state._preserveScrollAfterPrepend = null;
        }
      } else {
        wrap.scrollTop = wrap.scrollHeight;
      }
    });
    function updateScrollToBottomVisibility() {
      if (!scrollBtn) return;
      const threshold = 80;
      const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < threshold;
      scrollBtn.style.display = nearBottom ? 'none' : 'flex';
    }
    wrap.addEventListener('scroll', async () => {
      updateScrollToBottomVisibility();
      const key = roomKey(roomType, roomId);
      if (!state._hasMoreMessages?.[key] || state._loadingOlderMessages?.[key]) return;
      if (wrap.scrollTop > 40) return;
      const list = state.messages[key] || [];
      const oldest = list[0]?.created_at;
      if (!oldest) return;
      try {
        state._preserveScrollAfterPrepend = { key, prevHeight: wrap.scrollHeight };
        await loadMessagesPage(roomType, roomId, { appendTop: true, before: oldest });
        render();
      } catch (err) {
        state._preserveScrollAfterPrepend = null;
        showToast(err.message || 'Failed to load older messages');
      }
    });
    updateScrollToBottomVisibility();
    scrollBtn?.addEventListener('click', () => {
      wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
    });
    wrap.addEventListener('contextmenu', (e) => {
      const msgEl = e.target.closest('.message[data-msg-id]');
      if (!msgEl) return;
      e.preventDefault();
      const msgId = msgEl.dataset.msgId;
      const senderId = msgEl.dataset.senderId;
      const list = state.messages[roomKey(roomType, roomId)] || [];
      const msg = list.find(m => m.id === msgId);
      if (!msg) return;
      const isOwn = msg.sender_id === state.user?.id;
      const withinTimeLimit = msg.created_at && (Date.now() - msg.created_at) <= 2 * 60 * 1000;
      const hasUnlimited = !!state.user?.can_unlimited_edit_recall;
      const isSupport = roomType === 'group' && roomId === 'support';
      const canSolve = state.user?.can_edit_docs && isSupport;

      const canRecallEditOwn = isOwn && (withinTimeLimit || hasUnlimited);
      let canRecallEditOther = false;
      if (!isOwn && hasUnlimited) {
        if (state.user?.id === 'jimmyqrg') {
          canRecallEditOther = true;
        } else {
          const targetUser = (state.users || []).find(u => u.id === msg.sender_id);
          canRecallEditOther = !targetUser?.can_unlimited_edit_recall;
        }
      }

      const items = [];

      // ── Group 1: basic message actions (copy / reply / file id)
      items.push({ label: t('copy'), action: 'copy' });
      if (msg.msg_type !== 'whisper') {
        items.push({ label: t('reply'), action: 'reply' });
      }
      const fileRef = parseFileRef(msg.content, msg.msg_type);
      if (fileRef) items.push({ label: t('getFileId'), action: 'get-file-id' });
      if (msg.msg_type !== 'whisper') {
        items.push({ label: tx('addToCollection', 'Add to collection'), action: 'add-to-collection' });
      }

      // ── Group 2: own-message edit / recall / delete
      if (canRecallEditOwn || canRecallEditOther) {
        items.push({ separator: true });
        items.push({ label: t('recall'), action: 'recall' });
        items.push({ label: t('edit'), action: 'edit' });
      }
      if (isOwn) {
        if (!(canRecallEditOwn || canRecallEditOther)) items.push({ separator: true });
        items.push({ label: t('delete'), action: 'delete', danger: true });
      }

      // ── Group 3: moderation (pin, solve, admin delete)
      const moderationItems = [];
      if (state.user?.can_pin_messages && roomType === 'group') {
        const isPinned = state._pinnedMessage?.[roomKey(roomType, roomId)]?.message_id === msgId;
        moderationItems.push({ label: isPinned ? tx('unpinMessage', 'Unpin message') : tx('pinMessage', 'Pin message'), action: isPinned ? 'unpin' : 'pin' });
      }
      if (canSolve) moderationItems.push({ label: t('solve'), action: 'solve' });
      if (state.user?.can_delete_messages && !isOwn && senderId !== 'jimmyqrg') {
        moderationItems.push({ label: t('adminDeleteAdmin'), action: 'delete', danger: true });
      }
      if (moderationItems.length) {
        items.push({ separator: true });
        items.push(...moderationItems);
      }

      // ── Group 4: timeout shortcuts (admin only, non-own, not jimmyqrg)
      const canQuickTimeout = !!state.user?.can_timeout && !isOwn && senderId && senderId !== 'jimmyqrg';
      if (canQuickTimeout) {
        const timeoutScope = roomType === 'dm' ? 'dm' : 'group';
        items.push({ separator: true });
        items.push({ label: tx('timeout10m', 'Timeout 10 min'), action: `timeout:10 minute:${timeoutScope}` });
        items.push({ label: tx('timeout30m', 'Timeout 30 min'), action: `timeout:30 minute:${timeoutScope}` });
        items.push({ label: tx('timeout1h', 'Timeout 1 h'), action: `timeout:1 hour:${timeoutScope}` });
        items.push({ label: tx('timeoutForever', 'Timeout forever'), action: `timeout:forever:${timeoutScope}`, danger: true });
      }

      // ── Group 5: account-level admin actions
      if (state.user?.can_kick && senderId !== 'jimmyqrg' && !isOwn) {
        items.push({ separator: true });
        items.push({ label: t('adminRemoveAccount'), action: 'remove-account', danger: true });
      }

      // ── Group 6: report (always last)
      if (!isOwn && senderId !== 'jimmyqrg') {
        items.push({ separator: true });
        items.push({ label: tx('reportMessage', 'Report message'), action: 'report', danger: true });
      }

      showContextMenu(e.clientX, e.clientY, items, (action) => {
        if (action === 'get-file-id' && fileRef) {
          if (fileRef.fileId && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(fileRef.fileId).then(() => {}).catch(() => {});
          }
          return;
        }
        if (action === 'copy') {
          if (navigator.clipboard?.writeText) {
            const versions = [...(msg.edit_history || []).map(h => h.content), msg.content || ''];
            const versionIndex = Math.max(0, Math.min((state.messageVersionIndex[msg.id] ?? versions.length - 1), versions.length - 1));
            const text = versions[versionIndex] != null ? String(versions[versionIndex]) : '';
            navigator.clipboard.writeText(text).then(() => {}).catch(() => {});
          }
          return;
        }
        if (action === 'recall') {
          if (confirm('Are you sure you want to recall this message?')) state.socket?.emit('message:recall', msgId, () => {});
        } else if (action === 'edit') startInlineEdit(msg);
        else if (action === 'delete') {
          if (confirm('Are you sure you want to delete this message?')) state.socket?.emit('message:delete', msgId, () => {});
        } else if (action === 'add-to-collection') {
          apiPost('/api/collections', { message_id: msgId }).then(() => {
            showToast(tx('addedToCollection', 'Added to collection'), 'success');
          }).catch((err) => showToast(err.message || 'Failed to add to collection'));
        }
        if (action === 'pin') {
          apiPost('/api/admin/pin', { message_id: msgId, room_type: roomType, room_id: roomId }).catch((err) => showToast(err.message || 'Failed to pin'));
        }
        if (action === 'unpin') {
          apiDelete(`/api/admin/pin/${roomType}/${roomId}`).catch((err) => showToast(err.message || 'Failed to unpin'));
        }
        if (typeof action === 'string' && action.startsWith('timeout:')) {
          const [, duration, scope] = action.split(':');
          quickTimeoutUser(senderId, duration, scope || 'group');
          return;
        }
        if (action === 'remove-account') removeAccount(senderId);
        if (action === 'solve') {
          state.supportMessageIdForSolve = msgId;
          navigateTo('/chat/group/?panel=problem');
        }
        if (action === 'reply') {
          if (msg && msg.msg_type === 'whisper') {
            showToast('Cannot reply to a private message');
            return;
          }
          setState({ replyTo: msg });
        }
        if (action === 'report') showReportMessageModal(msg);
      });
    });
  }

  const runSearch = async () => {
    const roomTypeNow = state.dmUserId ? 'dm' : 'group';
    const roomIdNow = state.dmUserId ? state.convId : state.panel;
    state._chatSearchQuery = document.getElementById('chat-search-query')?.value || '';
    state._chatSearchFromUser = document.getElementById('chat-search-from')?.value || '';
    state._chatSearchDateRange = document.getElementById('chat-search-daterange')?.value || 'any';
    state._chatSearchAttachmentType = document.getElementById('chat-search-attachment')?.value || '';
    if (state._chatSearchDateRange === 'custom') {
      state._chatSearchAfter = document.getElementById('chat-search-after')?.value || '';
      state._chatSearchBefore = document.getElementById('chat-search-before')?.value || '';
    }
    state._chatSearchFilter = buildChatSearchFilterString();
    state._chatSearchLoading = true;
    render();
    try {
      const params = new URLSearchParams({
        roomType: roomTypeNow,
        roomId: roomIdNow,
        q: state._chatSearchQuery || '',
        filter: state._chatSearchFilter || '',
      });
      if (state._chatSearchAttachmentType) params.set('attachment_type', state._chatSearchAttachmentType);
      const { messages } = await apiGet(`/api/search/messages?${params.toString()}`);
      state._chatSearchResults = messages || [];
    } catch (err) {
      showToast(err.message || 'Search failed');
      state._chatSearchResults = [];
    } finally {
      state._chatSearchLoading = false;
      render();
    }
  };
  document.querySelector('.chat-search-run')?.addEventListener('click', runSearch);
  document.getElementById('chat-search-query')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
  document.getElementById('chat-search-from')?.addEventListener('change', () => runSearch());
  document.getElementById('chat-search-attachment')?.addEventListener('change', () => runSearch());
  document.getElementById('chat-search-daterange')?.addEventListener('change', (e) => {
    state._chatSearchDateRange = e.target.value || 'any';
    if (state._chatSearchDateRange !== 'custom') {
      state._chatSearchAfter = '';
      state._chatSearchBefore = '';
      runSearch();
    } else {
      render();
      requestAnimationFrame(() => document.getElementById('chat-search-after')?.focus());
    }
  });
  const customChange = () => {
    state._chatSearchAfter = document.getElementById('chat-search-after')?.value || '';
    state._chatSearchBefore = document.getElementById('chat-search-before')?.value || '';
    if (state._chatSearchAfter || state._chatSearchBefore) runSearch();
  };
  document.getElementById('chat-search-after')?.addEventListener('change', customChange);
  document.getElementById('chat-search-before')?.addEventListener('change', customChange);
  document.querySelector('.chat-search-reset')?.addEventListener('click', () => {
    state._chatSearchQuery = '';
    state._chatSearchFromUser = '';
    state._chatSearchDateRange = 'any';
    state._chatSearchAfter = '';
    state._chatSearchBefore = '';
    state._chatSearchAttachmentType = '';
    state._chatSearchFilter = '';
    state._chatSearchResults = [];
    render();
  });
  document.querySelector('.chat-search-results')?.addEventListener('click', async (e) => {
    const result = e.target.closest('.chat-search-result[data-msg-id]');
    if (!result) return;
    const msgId = result.dataset.msgId;
    const room = getCurrentRoomContext();
    const msg = (state._chatSearchResults || []).find((m) => m.id === msgId);
    if (!msg || !room) return;
    try {
      await jumpToMessageInCurrentChat(msgId, msg.created_at, room.roomType, room.roomId);
    } catch (err) {
      showToast(err.message || 'Could not jump to message');
    }
  });

  wrap?.addEventListener('click', (e) => {
    const showMoreBtn = e.target.closest('.message-virtualize-show-more');
    if (showMoreBtn) {
      e.preventDefault();
      e.stopPropagation();
      const rType = showMoreBtn.dataset.roomType || roomType;
      const rId = showMoreBtn.dataset.roomId || roomId;
      const key = roomKey(rType, rId);
      const current = state._messageRenderLimitByRoom?.[key] || MESSAGE_RENDER_WINDOW;
      state._messageRenderLimitByRoom[key] = current + MESSAGE_RENDER_WINDOW_STEP;
      render();
      return;
    }
    const reactionChip = e.target.closest('.message-reaction-chip');
    if (reactionChip) {
      e.preventDefault();
      e.stopPropagation();
      state.socket?.emit('message:reaction:toggle', { id: reactionChip.dataset.msgId, emoji: reactionChip.dataset.emoji }, () => {});
      return;
    }
    const replyJump = e.target.closest('.message-reply-preview[data-reply-to]');
    if (replyJump) {
      e.preventDefault();
      e.stopPropagation();
      const targetId = replyJump.dataset.replyTo;
      if (targetId) {
        const ctx = getCurrentRoomContext();
        const parent = (state.messages[roomKey(ctx.roomType, ctx.roomId)] || []).find((m) => m.id === targetId);
        jumpToMessageInCurrentChat(targetId, parent?.created_at || null, ctx.roomType, ctx.roomId)
          .catch((err) => showToast(err.message || 'Could not jump to message'));
      }
      return;
    }
    const reactionPickerBtn = e.target.closest('.message-reaction-picker-btn');
    if (reactionPickerBtn) {
      e.preventDefault();
      e.stopPropagation();
      const msgId = reactionPickerBtn.dataset.msgId;
      const emojis = ['👍', '❤️', '😂', '😮', '😢', '🔥'].map((emoji) => ({ label: emoji, action: emoji }));
      showContextMenu(e.clientX, e.clientY, emojis, (emoji) => {
        state.socket?.emit('message:reaction:toggle', { id: msgId, emoji }, () => {});
      });
      return;
    }
    const videoEl = e.target.closest('.message-file-video');
    if (videoEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openMediaPopup(videoEl.dataset.msgId, videoEl.dataset.url, 'video', videoEl.dataset.prevMediaId || null, videoEl.dataset.nextMediaId || null, roomType, roomId);
      return;
    }
    const imageEl = e.target.closest('.message-file-image');
    if (imageEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openMediaPopup(imageEl.dataset.msgId, imageEl.dataset.url, 'image', imageEl.dataset.prevMediaId || null, imageEl.dataset.nextMediaId || null, roomType, roomId);
      return;
    }
    const otherIcon = e.target.closest('.message-file-other-icon');
    if (otherIcon) {
      e.preventDefault();
      e.stopPropagation();
      const url = otherIcon.closest('.message-file-other')?.dataset?.url;
      if (url) openFileContentModal(url);
      return;
    }
    const likeBtn = e.target.closest('.message-like-btn');
    if (likeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const msgId = likeBtn.dataset.msgId;
      state.socket?.emit('message:like', msgId, () => {});
      return;
    }
    const saveBtn = e.target.closest('.message-edit-save');
    if (saveBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (saveBtn.disabled) return;
      const msgId = saveBtn.dataset.msgId;
      const textarea = document.querySelector(`.message-edit-input[data-msg-id="${msgId}"]`);
      const newContent = textarea?.value?.trim() ?? '';
      if (!newContent) return;
      state.socket?.emit('message:edit', { id: msgId, content: newContent }, () => {});
      setState({ editingMessageId: null });
      return;
    }
    const cancelBtn = e.target.closest('.message-edit-cancel');
    if (cancelBtn) {
      e.preventDefault();
      e.stopPropagation();
      setState({ editingMessageId: null });
      return;
    }
    const historyBtn = e.target.closest('.message-edit-history-btn');
    if (historyBtn && !historyBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      const msgId = historyBtn.dataset.msgId;
      const dir = historyBtn.dataset.dir;
      const list = state.messages[roomKey(roomType, roomId)] || [];
      const msg = list.find(m => m.id === msgId);
      if (!msg) return;
      const versions = [...(msg.edit_history || []).map(h => h.content), msg.content || ''];
      const current = state.messageVersionIndex[msgId] ?? versions.length - 1;
      const next = dir === 'prev' ? Math.max(0, current - 1) : Math.min(versions.length - 1, current + 1);
      setState({ messageVersionIndex: { ...state.messageVersionIndex, [msgId]: next } });
    }
  });

  wrap?.addEventListener('loadedmetadata', (e) => {
    if (e.target.classList?.contains('message-file-audio-el')) {
      const el = e.target;
      const totalSpan = el.closest('.message-file-audio')?.querySelector('.message-file-audio-total');
      if (totalSpan) totalSpan.textContent = formatAudioTime(el.duration);
    }
  });
  wrap?.addEventListener('timeupdate', (e) => {
    if (e.target.classList?.contains('message-file-audio-el')) {
      const el = e.target;
      const block = el.closest('.message-file-audio');
      const currentSpan = block?.querySelector('.message-file-audio-current');
      const progress = block?.querySelector('.message-file-audio-progress');
      if (currentSpan) currentSpan.textContent = formatAudioTime(el.currentTime);
      if (progress && Number.isFinite(el.duration)) progress.value = (el.currentTime / el.duration) * 100;
    }
  });
  wrap?.addEventListener('input', (e) => {
    if (e.target.classList?.contains('message-file-audio-progress')) {
      const range = e.target;
      const block = range.closest('.message-file-audio');
      const audio = block?.querySelector('.message-file-audio-el');
      if (audio && Number.isFinite(audio.duration)) audio.currentTime = (Number(range.value) / 100) * audio.duration;
    }
  });

  if (state.editingMessageId) {
    requestAnimationFrame(() => {
      const ta = document.querySelector(`.message-edit-input[data-msg-id="${state.editingMessageId}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        const saveBtn = ta.closest('.message-edit-area')?.querySelector('.message-edit-save');
        const updateSaveState = () => {
          if (!saveBtn) return;
          const hasContent = ta.value.trim().length > 0;
          saveBtn.disabled = !hasContent;
        };
        updateSaveState();
        ta.addEventListener('input', updateSaveState);
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setState({ editingMessageId: null });
            ta.removeEventListener('keydown', onKey);
            ta.removeEventListener('input', updateSaveState);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            const newContent = ta.value.trim();
            if (!newContent) {
              e.preventDefault();
              return;
            }
            e.preventDefault();
            state.socket?.emit('message:edit', { id: state.editingMessageId, content: newContent }, () => {});
            setState({ editingMessageId: null });
            ta.removeEventListener('keydown', onKey);
            ta.removeEventListener('input', updateSaveState);
          }
        };
        ta.addEventListener('keydown', onKey);
      }
    });
  }

  const sendBtn = document.getElementById('send-btn');
  const input = document.getElementById('composer-input');
  const emojiBtn = document.getElementById('composer-emoji');
  const COMPOSER_MAX_HEIGHT = 200;
  function resizeComposerInput() {
    if (!input) return;
    input.style.height = '0';
    const h = Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT);
    input.style.height = Math.max(22, h) + 'px';
  }

  // Curated emoji set. Organized into rows visually by category in the picker.
  // Kept small (around 60) for fast scanning and tiny payload.
  const EMOJI_LIST = [
    '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
    '😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨',
    '😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕',
    '👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️',
    '❤️','💔','💖','💯','🔥','✨','🎉','🎊','🎁','🎈','🎂','🍰','🍕','🍔','🍟','☕',
  ];
  function openEmojiPicker(btn) {
    const existing = document.getElementById('emoji-picker');
    if (existing) {
      existing.remove();
      document.removeEventListener('click', existing._close);
      if (btn._pickerOpen === existing) btn._pickerOpen = null;
      // If the same button was clicked while open, just close — don't reopen.
      if (btn._lastClicked === btn) return;
    }
    btn._lastClicked = btn;
    const rect = btn.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.id = 'emoji-picker';
    pop.className = 'emoji-picker';
    // Build a 12-col grid.
    const cols = 12;
    pop.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    const closePicker = () => {
      pop.remove();
      document.removeEventListener('click', pop._close);
      if (btn._pickerOpen === pop) btn._pickerOpen = null;
      input?.focus();
    };
    EMOJI_LIST.forEach((emoji) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'emoji-picker-cell';
      cell.textContent = emoji;
      cell.setAttribute('aria-label', `Insert ${emoji}`);
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        insertAtCursor(input, emoji);
        resizeComposerInput();
        closePicker();
      });
      pop.appendChild(cell);
    });
    // Header bar with a close X so users can dismiss the picker without
    // picking an emoji (works whether or not they click an emoji cell).
    const header = document.createElement('div');
    header.className = 'emoji-picker-header';
    const headerTitle = document.createElement('span');
    headerTitle.className = 'emoji-picker-title';
    headerTitle.textContent = 'Emoji';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'emoji-picker-close';
    closeBtn.setAttribute('aria-label', 'Close emoji picker');
    closeBtn.title = 'Close';
    closeBtn.innerHTML = ICON_X_SM;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closePicker();
    });
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    pop.insertBefore(header, pop.firstChild);
    document.body.appendChild(pop);
    // Default position: above the button, right-aligned.
    let x = rect.right;
    let y = rect.top - 8;
    pop.style.visibility = 'hidden';
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    requestAnimationFrame(() => {
      const pad = 6;
      const pr = pop.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Clamp inside viewport.
      if (pr.right > vw - pad) x = Math.max(pad, vw - pr.width - pad);
      if (pr.left < pad) x = pad;
      if (pr.top < pad) {
        // Flip below the button.
        y = rect.bottom + 8;
      }
      if (y + pr.height > vh - pad) y = Math.max(pad, vh - pr.height - pad);
      pop.style.left = x + 'px';
      pop.style.top = y + 'px';
      pop.style.visibility = '';
    });
    const close = (ev) => {
      if (pop.contains(ev?.target)) return;
      pop.remove();
      document.removeEventListener('click', close);
      if (btn._pickerOpen === pop) btn._pickerOpen = null;
    };
    pop._close = close;
    btn._pickerOpen = pop;
    setTimeout(() => document.addEventListener('click', close), 0);
  }
  function insertAtCursor(textarea, text) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + text + after;
    const caret = start + text.length;
    textarea.selectionStart = textarea.selectionEnd = caret;
    textarea.focus();
  }
  emojiBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openEmojiPicker(emojiBtn);
  });
  if (sendBtn && input) {
    const send = async () => {
      if (state._sendingMessage) return;
      // Venory is responding: the send button is a stop button right now, so
      // block normal sends until the current response is stopped.
      if (isHelperBusy()) return;
      const text = input.value.trim();
      if (!text && !state._pendingFile) return;
      const roomType = state.dmUserId ? 'dm' : 'group';
      const roomId = state.dmUserId ? state.convId : state.panel;
      const draftRoomId = state.dmUserId || state.panel;

      // /plaintext has the highest priority: a "/plaintext" line makes
      // everything below it plain text and skips ALL slash-command
      // dispatch. Send the raw text verbatim (the /plaintext line stays in
      // the stored message so renderMessageContent escapes the lines below
      // it). This must run before any command handling below.
      if (hasPlaintextLine(text)) {
        const reply_to_id = state.replyTo?.id || null;
        state._sendingMessage = true;
        sendMessageResilient({ roomType, roomId, text, reply_to_id, ...agentOptsForSend() })
          .then((res) => {
            state._sendingMessage = false;
            if (res?.error) {
              if (res.error === 'AI_MOD_BLOCK') {
                showAiModerationModal(res.reason || '');
                return;
              }
              showToast(res.error);
              if (res.error === 'NO SPAMMING!') {
                state._spamBlockedUntil = Date.now() + 5000;
                setState({});
                setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
              }
              return;
            }
            if (res?.message) addMessageLocal(res.message);
            mirrorOwnDmToSessionView(res.message);
            clearDraft(roomType, draftRoomId);
            input.value = '';
            resizeComposerInput();
            setState({ replyTo: null });
          })
          .catch((err) => {
            state._sendingMessage = false;
            showToast(err?.message || tx('sendFailed', 'Message could not be sent. Try again.'));
          });
        return;
      }

      // `/plaintext <whatever>` strips the prefix and re-puts the body in the
      // composer so the user can edit + press Enter to send plain text.
      // (We don't auto-submit to avoid recursive send() calls.)
      const plaintextBody = extractPlaintextBypass(text);
      if (plaintextBody !== null) {
        input.value = plaintextBody;
        resizeComposerInput();
        input.focus();
        return;
      }

      if (text.toLowerCase().startsWith('/memorymessagelength')) {
        const numStr = text.split(/\s+/)[1];
        const num = parseInt(numStr, 10);
        if (isNaN(num) || num < 1 || num > 100) {
          showToast('Usage: /memorymessagelength <1-100>');
        } else {
          apiPatch(`/api/users/me`, { memory_message_length: num }).then(() => {
            showToast(`Memory message length set to ${num}`);
            input.value = '';
            resizeComposerInput();
          }).catch((err) => showToast(err.message || 'Failed to save setting'));
        }
        return;
      }

      // Slash-commands: /fall, /joke, /grumm, /jimmyqrg, /whisper (also
      // /msg, /tell). These always fire on a leading `/`, regardless of
      // `state.commandMode` (which now only governs the legacy
      // /games /wordle /request-admin /file group commands below).
      if (text.startsWith('/')) {
        const handled = await handleSlashCommand(text, { roomType, roomId, replyTo: state.replyTo });
        if (handled) {
          // Only clear for commands that consumed the input (fall/joke/etc).
          // /grumm + /jimmyqrg have already cleaned up inside the helper.
          if (handled !== 'kept') {
            input.value = '';
            resizeComposerInput();
          }
          return;
        }
      }

      // All commands — legacy (/games /wordle /request-admin /file
      // /memorymessagelength) and new (/fall /joke /grumm /jimmyqrg
      // /whisper) — work in both group rooms AND DMs. Always-on, no
      // `state.commandMode` gate, no toggle button. The leading slash
      // is the user's intent signal; the in-helper `textIsTopLevelSlash`
      // rule makes sure the slash isn't inside a code/HTML/LaTeX block.
      // The old command-mode block intentionally no longer lives here;
      // each legacy command has its own matching branch in
      // handleSlashCommand() so the new cross-room scope applies uniformly.
      if (textIsTopLevelSlash(text)) {
        // 1) Legacy /memorymessagelength — DM-only kept for back-compat.
        if (text.toLowerCase().startsWith('/memorymessagelength')) {
          const numStr = text.split(/\s+/)[1];
          const num = parseInt(numStr, 10);
          if (isNaN(num) || num < 1 || num > 100) {
            showToast('Usage: /memorymessagelength <1-100>');
          } else {
            apiPatch(`/api/users/me`, { memory_message_length: num }).then(() => {
              showToast(`Memory message length set to ${num}`);
              input.value = '';
              resizeComposerInput();
            }).catch((err) => showToast(err.message || 'Failed to save setting'));
          }
          return;
        }
        // 2) Legacy group commands — now available in DMs too.
        const cmd = text.split(/\s/)[0].toLowerCase();
        if (cmd === '/games') {
          window.open('https://perfectnip.github.io/page');
          input.value = '';
          resizeComposerInput();
          return;
        }
        if (cmd === '/wordle') {
          showWordleModal();
          input.value = '';
          resizeComposerInput();
          return;
        }
        if (cmd === '/request-admin') {
          apiPost('/api/inbox/request-admin').then(() => {
            input.value = '';
            resizeComposerInput();
          }).catch((err) => showToast(err.message || 'Request failed'));
          return;
        }
        if (cmd === '/file') {
          const fileId = text.slice(5).trimStart();
          if (!fileId) {
            showToast('Usage: /file <file_id>');
            return;
          }
          state._sendingMessage = true;
          const reply_to_id = state.replyTo?.id || null;
          state.socket?.emit('message:send', { roomType, roomId, content: `/file ${fileId}`, msg_type: 'file', reply_to_id }, (res) => {
            state._sendingMessage = false;
            if (res?.error) {
              if (res.error === 'AI_MOD_BLOCK') {
                showAiModerationModal(res.reason || '');
                return;
              }
              showToast(res.error);
              return;
            }
            if (res?.message) addMessageLocal(res.message);
            setState({ replyTo: null });
            input.value = '';
            resizeComposerInput();
          });
          return;
        }
      }

      const reply_to_id = state.replyTo?.id || null;
      if (state._spamBlockedUntil && Date.now() < state._spamBlockedUntil) {
        showToast('NO SPAMMING!');
        return;
      }
      const contentToCheck = text || '';
      const mentionedDeleted = roomType === 'group' ? getMentionedDeletedUsers(contentToCheck) : [];
      if (mentionedDeleted.length) {
        showToast(t('mentionDeletedUsers') + mentionedDeleted.join(', '));
      }

      state._sendingMessage = true;
      const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
      const done = () => { state._sendingMessage = false; };
      if (state._pendingFile) {
        if (!canSendFiles) {
          showToast('Add as friend to send files');
          state._pendingFile = null;
          render();
          state._sendingMessage = false;
          return;
        }
        // Bail out before the upload starts if the user is timed out for the
        // current scope. This avoids burning bandwidth on a request the
        // server will reject anyway, and clears the pending file pill so the
        // user can't keep retrying the same file in a tight loop.
        if (maybeBlockTimeoutUpload({ roomType, dmUserId: state.dmUserId })) {
          state._sendingMessage = false;
          return;
        }
        const form = new FormData();
        form.append('file', state._pendingFile);
        form.append('content', text);
        form.append('msg_type', state._pendingFile.type.startsWith('image/') ? 'image' : state._pendingFile.type.startsWith('video/') ? 'video' : state._pendingFile.type.startsWith('audio/') ? 'audio' : 'file');
        if (reply_to_id) form.append('reply_to_id', reply_to_id);
        const uploadPath = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;

        const progressEl = document.getElementById('upload-progress');
        const progressBar = document.getElementById('upload-progress-bar');
        const progressPct = document.getElementById('upload-progress-pct');
        const pendingEl = document.getElementById('pending-file-indicator');
        if (pendingEl) pendingEl.style.display = 'none';
        if (progressEl) progressEl.style.display = '';
        uploadFormWithRetry({
          uploadPath,
          form,
          maxRetries: 2,
          onProgress: (p) => {
            if (progressBar && progressPct) {
              const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
            progressBar.style.width = pct + '%';
            progressPct.textContent = pct + '%';
          }
          },
        }).then((data) => {
          if (data?.error) {
            showToast(data.error);
            if (data.error === 'NO SPAMMING!') {
              state._spamBlockedUntil = Date.now() + 5000;
              setState({});
              setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
            }
          }
          if (data?.message) addMessageLocal(data.message);
          state._pendingFile = null;
          clearDraft(roomType, draftRoomId);
          input.value = '';
          resizeComposerInput();
          setState({ replyTo: null });
          if (roomType === 'dm') loadMessages('dm', roomId).then(render);
          done();
        }).catch((err) => {
          done();
          // AI moderator blocked the upload caption. Keep the staged file
          // and the typed text so the user can edit and try again.
          if (err?.code === 'AI_MOD_BLOCK') {
            const pendingEl = document.getElementById('pending-file-indicator');
            const progressEl = document.getElementById('upload-progress');
            if (progressEl) progressEl.style.display = 'none';
            if (pendingEl) pendingEl.style.display = '';
            showAiModerationModal(err.reason || err.data?.reason || '');
            return;
          }
          showToast(err?.message || t('uploadFailedRetry') || 'Upload failed after retries. Please try again.');
        });
        return;
      }
      sendMessageResilient({ roomType, roomId, text, reply_to_id, ...agentOptsForSend() })
        .then((res) => {
          done();
          if (res?.error) {
            // AI moderator blocked the message. Keep the user's draft so they
            // can edit and try again.
            if (res.error === 'AI_MOD_BLOCK') {
              showAiModerationModal(res.reason || '');
              return;
            }
            showToast(res.error);
            if (res.error === 'NO SPAMMING!') {
              state._spamBlockedUntil = Date.now() + 5000;
              setState({});
              setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
            }
            return;
          }
          if (res?.message) addMessageLocal(res.message);
          mirrorOwnDmToSessionView(res.message);
          clearDraft(roomType, draftRoomId);
          input.value = '';
          resizeComposerInput();
          setState({ replyTo: null });
        })
        .catch((err) => {
          done();
          showToast(err?.message || tx('sendFailed', 'Message could not be sent. Try again.'));
        });
    };
    sendBtn.addEventListener('click', () => {
      const roomType = state.dmUserId ? 'dm' : 'group';
      const roomId = state.dmUserId ? state.convId : state.panel;
      // Stop instead of send while Venory is responding.
      if (isHelperBusy()) {
        // Always name the session whose run is visible so the bridge can
        // abort the actual gateway run, not just the in-flight HTTP request.
        const viewKey = state.agentSessionView?.key;
        const stopPayload = { roomType, roomId, sessionKey: viewKey || dmSessionKeyFor() };
        state.socket?.emit('helper:stop', stopPayload);
        // The busy state may come from the sessions list (hasActiveRun), which
        // can be stale after an abort; refresh it so the stop lands visibly.
        loadAgentSessions();
        return;
      }
      emitTypingStop(roomType, roomId);
      send();
    });
    input.addEventListener('keydown', (e) => {
      if (state._mentionAutocomplete && e.key === 'Escape') {
        e.preventDefault();
        state._mentionAutocomplete = null;
        renderMentionAutocomplete();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // On phones Enter adds a new line by default (send via the Send
        // button); enable "Enter key sends" in Settings to send with Enter.
        if (isMobile() && !state.enterToSend) return;
        e.preventDefault();
        // Block Enter-send while Venory is responding (must stop first).
        if (isHelperBusy()) return;
        const roomType = state.dmUserId ? 'dm' : 'group';
        const roomId = state.dmUserId ? state.convId : state.panel;
        emitTypingStop(roomType, roomId);
        send();
      }
    });
    input.addEventListener('input', () => {
      resizeComposerInput();
      const roomType = state.dmUserId ? 'dm' : 'group';
      const roomId = state.dmUserId ? state.convId : state.panel;
      const draftRoomId = state.dmUserId || state.panel;
      saveDraft(roomType, draftRoomId, input.value);
      emitTypingActivity(roomType, roomId);
      maybeOpenMentionAutocomplete(input);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!document.activeElement?.closest('.mention-autocomplete')) {
          state._mentionAutocomplete = null;
          renderMentionAutocomplete();
        }
      }, 120);
    });
    requestAnimationFrame(resizeComposerInput);
  }

  const fileInput = document.getElementById('file-input');
  const attachBtn = document.getElementById('attach-file');
  const canSendFiles = document.getElementById('composer-drop-zone')?.dataset.canSendFiles !== 'false';
  if (fileInput) fileInput.disabled = !canSendFiles;
  if (attachBtn) {
    attachBtn.disabled = !canSendFiles;
    attachBtn.title = canSendFiles ? 'Attach file' : 'Add as friend to send files';
  }
  document.getElementById('attach-file')?.addEventListener('click', () => {
    if (!canSendFiles) {
      showToast('Add as friend to send files');
      return;
    }
    // Don't even open the system file picker if the user is currently timed
    // out — surface the toast immediately so they understand why.
    const composerRoomType = state.dmUserId ? 'dm' : 'group';
    if (maybeBlockTimeoutUpload({ roomType: composerRoomType, dmUserId: state.dmUserId, clearPending: false })) return;
    document.getElementById('file-input')?.click();
  });
  document.getElementById('file-input')?.addEventListener('change', async (e) => {
    if (!canSendFiles) return;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // Belt-and-braces: even if the picker was opened (e.g. before the
    // timeout fired or via keyboard shortcut) drop the chosen file once we
    // know the user is timed out instead of staging something we won't be
    // allowed to send.
    const composerRoomType = state.dmUserId ? 'dm' : 'group';
    if (maybeBlockTimeoutUpload({ roomType: composerRoomType, dmUserId: state.dmUserId, clearPending: false })) return;
    const prepared = await prepareFileForUpload(file);
    if (!prepared) return;
    state._pendingFile = prepared;
    render();
  });
  document.getElementById('clear-pending-file')?.addEventListener('click', () => {
    state._pendingFile = null;
    render();
  });

  // /composer-command-mode toggle removed — commands are always active.
  const micBtn = document.getElementById('composer-mic');
  const beginRecording = async () => {
    if (state._recording) return;
    const roomType = state.dmUserId ? 'dm' : 'group';
    const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
    if (!canSendFiles) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state._recordingStream = stream;
      state._recordingChunks = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size) state._recordingChunks.push(e.data); };
      recorder.start();
      state._recordingRecorder = recorder;
      setState({ _recording: true });
    } catch (err) {
      console.error('Microphone access failed', err);
    }
  };
  // Hold-to-record on touch devices: hold the mic button to record, release to send.
  if (micBtn && isMobile() && !micBtn._holdRecBound) {
    micBtn._holdRecBound = true;
    let holdTriggered = false;
    let holdTimer = null;
    const sendNow = () => {
      const sendBtn = document.getElementById('recording-send');
      if (sendBtn) sendBtn.click();
    };
    micBtn.addEventListener('touchstart', (e) => {
      if (state._recording) return;
      e.preventDefault();
      holdTriggered = false;
      micBtn.classList.add('composer-mic-pressed');
      holdTimer = setTimeout(() => {
        holdTriggered = true;
        beginRecording();
      }, 220);
    }, { passive: false });
    const release = (e) => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      micBtn.classList.remove('composer-mic-pressed');
      if (state._recording && holdTriggered) {
        e?.preventDefault?.();
        setTimeout(sendNow, 120);
      }
    };
    micBtn.addEventListener('touchend', release);
    micBtn.addEventListener('touchcancel', release);
  }
  micBtn?.addEventListener('click', async (e) => {
    if (isMobile() && (e.detail === 0 || e.pointerType === 'touch' || e.button === 0 && state._recording)) {
      // Tap on touch devices is handled via touchstart/end; ignore the synthesized click.
      if (state._recording) return;
    }
    if (state._recording) return;
    try {
      await beginRecording();
    } catch (err) {
      console.error('Microphone access failed', err);
    }
  });

  function stopRecording(discard = true) {
    if (state._recordingKeydownHandler) {
      document.removeEventListener('keydown', state._recordingKeydownHandler);
      state._recordingKeydownHandler = null;
    }
    if (state._recordingRecorder && state._recordingRecorder.state !== 'inactive') {
      state._recordingRecorder.stop();
    }
    if (state._recordingStream) {
      state._recordingStream.getTracks().forEach((t) => t.stop());
    }
    state._recording = false;
    state._recordingStream = null;
    state._recordingRecorder = null;
    const chunks = state._recordingChunks || [];
    state._recordingChunks = [];
    setState({});
    return discard ? null : chunks;
  }

  document.getElementById('recording-send')?.addEventListener('click', () => {
    const chunks = stopRecording(false);
    if (!chunks || chunks.length === 0) return;
    const roomType = state.dmUserId ? 'dm' : 'group';
    const roomId = state.dmUserId ? state.convId : state.panel;
    const reply_to_id = state.replyTo?.id || null;
    const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
    if (!canSendFiles) return;
    // Cancel the upload if the user got timed out while recording (otherwise
    // the recording would be uploaded, the server would reject it, and the
    // captured audio would be silently discarded with no UX feedback).
    if (maybeBlockTimeoutUpload({ roomType, dmUserId: state.dmUserId, clearPending: false })) return;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
    const form = new FormData();
    form.append('file', file);
    form.append('content', '');
    form.append('msg_type', 'voice');
    if (reply_to_id) form.append('reply_to_id', reply_to_id);
    const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
    uploadFormWithRetry({ uploadPath: path, form, maxRetries: 2 }).then((data) => {
      if (data?.error) {
        showToast(data.error);
        if (data.error === 'NO SPAMMING!') {
          state._spamBlockedUntil = Date.now() + 5000;
          setState({});
          setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
        }
      }
      if (data.message) addMessageLocal(data.message);
      setState({ replyTo: null });
      if (roomType === 'dm') loadMessages('dm', roomId).then(render);
    }).catch((err) => {
      if (err?.code === 'AI_MOD_BLOCK') {
        showAiModerationModal(err.reason || err.data?.reason || '');
        return;
      }
      showToast(err.message || t('uploadFailedRetry') || 'Upload failed after retries. Please try again.');
    });
  });

  document.getElementById('recording-cancel')?.addEventListener('click', () => {
    stopRecording(true);
  });

  const recordingOverlay = document.getElementById('recording-overlay');
  if (recordingOverlay && !state._recordingKeydownHandler) {
    const keydown = (e) => {
      if (!state._recording) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        stopRecording(true);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('recording-send')?.click();
      }
    };
    state._recordingKeydownHandler = keydown;
    document.addEventListener('keydown', keydown);
  }

  const dropZone = document.getElementById('composer-drop-zone');
  if (dropZone) {
    ['dragenter', 'dragover'].forEach((ev) => {
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files') && canSendFiles) dropZone.classList.add('composer-drag-over');
      });
    });
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('composer-drag-over');
    });
    dropZone.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file') {
          if (!canSendFiles) {
            e.preventDefault();
            showToast('Add as friend to send files');
            return;
          }
          // Block staging the pasted file if the user is timed out — same
          // rule as Send: don't even let them attach something we'll have to
          // throw away.
          const pasteRoomType = state.dmUserId ? 'dm' : 'group';
          if (maybeBlockTimeoutUpload({ roomType: pasteRoomType, dmUserId: state.dmUserId, clearPending: false })) {
            e.preventDefault();
            return;
          }
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            e.stopPropagation();
            (async () => {
              const prepared = await prepareFileForUpload(file);
              if (!prepared) return;
              state._pendingFile = prepared;
            render();
            })();
          }
          break;
        }
      }
    });
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('composer-drag-over');
      if (!canSendFiles) {
        showToast('Add as friend to send files');
        return;
      }
      const rawFile = e.dataTransfer.files?.[0];
      if (!rawFile) return;
      const roomType = state.dmUserId ? 'dm' : 'group';
      // Drag-drop uploads directly without going through the composer pill,
      // so this is the right place to bail out when the user is timed out.
      if (maybeBlockTimeoutUpload({ roomType, dmUserId: state.dmUserId, clearPending: false })) return;
      const file = await prepareFileForUpload(rawFile);
      if (!file) return;
      const roomId = state.dmUserId ? state.convId : state.panel;
      const reply_to_id = state.replyTo?.id || null;
      const msgType = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
      const form = new FormData();
      form.append('file', file);
      form.append('content', '');
      form.append('msg_type', msgType);
      if (reply_to_id) form.append('reply_to_id', reply_to_id);
      const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
      state._sendingMessage = true;
      uploadFormWithRetry({
        uploadPath: path,
        form,
        maxRetries: 2,
      }).then((data) => {
          if (data?.error) {
            showToast(data.error);
            if (data.error === 'NO SPAMMING!') {
              state._spamBlockedUntil = Date.now() + 5000;
              setState({});
              setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
            }
          }
          if (data?.message) addMessageLocal(data.message);
          setState({ replyTo: null });
          if (roomType === 'dm') loadMessages('dm', roomId).then(render);
        })
        .catch((err) => {
          if (err?.code === 'AI_MOD_BLOCK') {
            showAiModerationModal(err.reason || err.data?.reason || '');
            return;
          }
          showToast(err.message || t('uploadFailedRetry') || 'Upload failed after retries. Please try again.');
        })
        .finally(() => { state._sendingMessage = false; });
    });
  }

  const saveDocBtn = document.getElementById('save-doc');
  const docContent = document.getElementById('doc-content');
  const docSupportId = document.getElementById('doc-support-msg-id');
  if (saveDocBtn && docContent) {
    saveDocBtn.addEventListener('click', async () => {
      const docKey = document.querySelector('.doc-panel')?.dataset.docKey;
      if (!docKey) return;
      const content = docContent.value;
      const support_message_id = docSupportId?.value || null;
      try {
        await saveDoc(docKey, content, support_message_id || undefined);
        state.supportMessageIdForSolve = null;
        const { doc: fresh } = await loadDoc(docKey);
        state._docContent = fresh?.content ?? content;
        state.editingDocKey = null;
        setState({});
      } catch (e) {
        showToast(e.message);
      }
    });
  }

  const cancelDocEdit = document.getElementById('cancel-doc-edit');
  if (cancelDocEdit) {
    cancelDocEdit.addEventListener('click', () => {
      state.editingDocKey = null;
      setState({});
    });
  }

  const startDocEdit = document.getElementById('start-doc-edit');
  if (startDocEdit) {
    startDocEdit.addEventListener('click', () => {
      const docKey = document.querySelector('.doc-panel')?.dataset.docKey;
      if (docKey) {
        state.editingDocKey = docKey;
        setState({});
      }
    });
  }

  if (state._docContent !== undefined && docContent && !docContent.value) docContent.value = state._docContent;
}

function showContextMenu(x, y, items, onSelect) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.visibility = 'hidden';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  // Collapse duplicate/leading/trailing separators so the menu never renders
  // two dividers in a row when groups are conditionally hidden.
  const normalizedItems = [];
  items.forEach((item) => {
    if (!item) return;
    if (item.separator) {
      const prev = normalizedItems[normalizedItems.length - 1];
      if (normalizedItems.length === 0 || (prev && prev.separator)) return;
      normalizedItems.push(item);
      return;
    }
    normalizedItems.push(item);
  });
  while (normalizedItems.length && normalizedItems[normalizedItems.length - 1].separator) {
    normalizedItems.pop();
  }
  normalizedItems.forEach((item) => {
    if (item.separator) {
      const hr = document.createElement('hr');
      hr.className = 'context-menu-separator';
      menu.appendChild(hr);
      return;
    }
    const { label, action, danger, disabled } = item;
    const btn = document.createElement('button');
    btn.textContent = label;
    if (danger) btn.classList.add('danger');
    if (disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';
    } else {
      btn.addEventListener('click', () => { onSelect(action); menu.remove(); });
    }
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  const pad = 6;
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + rect.width > vw - pad) x = Math.max(pad, vw - rect.width - pad);
  if (y + rect.height > vh - pad) y = Math.max(pad, vh - rect.height - pad);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.visibility = '';
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function startInlineEdit(msg) {
  setState({ editingMessageId: msg.id });
}

async function removeAccount(userId) {
  if (!confirm(t('adminRemoveAccountConfirm'))) return;
  try {
    await apiPost('/api/admin/remove-account', { user_id: userId });
    await loadUsers();
    render();
    bindAdmin();
  } catch (err) { showToast(err.message); }
}

/** Quick-timeout shortcut used by the right-click context menus. Sends the
 *  duration in the same format the admin UI already uses. `scope` defaults
 *  to 'group' for group-chat contexts; pass 'dm' for DM contexts. */
async function quickTimeoutUser(userId, duration, scope = 'group') {
  if (!userId) return;
  if (userId === 'jimmyqrg') {
    showToast(tx('cannotTimeoutJimmy', 'jimmyqrg cannot be timed out'));
    return;
  }
  try {
    await apiPost('/api/admin/timeout', { user_id: userId, duration, scope });
    const scopeLabel = scope === 'dm'
      ? tx('adminTimeoutScopeDmBadge', 'Private messages')
      : tx('adminTimeoutScopeGroupBadge', 'Group chat');
    const durationLabel = duration === 'forever'
      ? tx('adminTimeoutForever', 'Forever')
      : duration;
    showToast(tx('timeoutAppliedToast', 'Timeout applied: {duration} ({scope})')
      .replace('{duration}', durationLabel)
      .replace('{scope}', scopeLabel), 'success');
    loadAdminTimeouts?.();
  } catch (err) { showToast(err?.message || 'Failed to apply timeout'); }
}

async function restoreAccount(userId) {
  try {
    await apiPost('/api/admin/restore-account', { user_id: userId });
    await loadUsers();
    render();
    bindAdmin();
  } catch (err) { showToast(err.message); }
}

function showDeletePermanentlyModal(userId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay profile-modal-overlay';
  overlay.innerHTML = `
    <div class="modal profile-modal admin-delete-modal">
      <button type="button" class="profile-modal-close" aria-label="Close"><span class="icon" aria-hidden="true">${ICON_CLOSE}</span></button>
      <h3>${t('adminDeleteAccountTitle')}</h3>
      <p>${t('adminDeleteAccountDesc')}</p>
      <label class="admin-delete-msgs-label"><input type="checkbox" id="admin-delete-msgs-cb" checked /> ${t('adminDeleteGroupMessages')}</label>
      <div class="admin-delete-modal-actions">
        <button type="button" class="btn-small" id="admin-delete-cancel"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${t('cancel')}</button>
        <button type="button" class="btn-small btn-danger" id="admin-delete-confirm"><span class="icon" aria-hidden="true">${ICON_TRASH}</span>${t('adminDeletePermanently')}</button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.profile-modal-close') || e.target.id === 'admin-delete-cancel') overlay.remove();
  });
  overlay.querySelector('#admin-delete-confirm')?.addEventListener('click', async () => {
    const cb = overlay.querySelector('#admin-delete-msgs-cb');
    overlay.remove();
    try {
      await apiPost('/api/admin/delete-account-permanently', { user_id: userId, delete_group_messages: cb?.checked !== false });
      await loadUsers();
      render();
      bindAdmin();
    } catch (err) { showToast(err.message); }
  });
  document.body.appendChild(overlay);
}

async function deleteAccountPermanently(userId, deleteGroupMessages = true) {
  try {
    await apiPost('/api/admin/delete-account-permanently', { user_id: userId, delete_group_messages: deleteGroupMessages });
    await loadUsers();
    render();
    bindAdmin();
  } catch (err) { showToast(err.message); }
}

async function toggleBlacklist(userId, isBlacklisted) {
  try {
    if (isBlacklisted) {
      await apiDelete(`/api/admin/blacklist/${userId}`);
    } else {
      await apiPost('/api/admin/blacklist', { user_id: userId });
    }
    state.adminBlacklistedIds = isBlacklisted
      ? (state.adminBlacklistedIds || []).filter(id => id !== userId)
      : [...(state.adminBlacklistedIds || []), userId];
    if (!replaceAdminUserCardInPlace(userId)) {
      render();
      bindAdmin();
    }
  } catch (err) { showToast(err.message); }
}

const ADMIN_PERM_KEYS = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout', 'can_pin_messages', 'can_unlimited_edit_recall', 'can_see_whispers'];

function getAdminPermLabels() {
  return {
    can_send_inbox: t('adminPermSendMail'),
    can_broadcast: t('adminPermBroadcast'),
    can_edit_docs: t('adminPermEditDocs'),
    can_kick: t('adminPermRemoveAccount'),
    can_delete_messages: t('adminPermDeleteMessages'),
    can_manage_users: t('adminPermManageUsers'),
    can_timeout: t('adminPermTimeout'),
    can_pin_messages: tx('adminPermPinMessages', 'Pin messages'),
    can_unlimited_edit_recall: tx('adminPermUnlimitedEditRecall', 'Unlimited edit & recall'),
    can_see_whispers: tx('adminPermSeeWhispers', 'See whispers'),
  };
}

/** HTML for the inner contents of a single admin user card (everything inside `.admin-user-card`). */
function renderAdminUserCardInner(u) {
  const canManage = state.user?.can_manage_users;
  const permLabels = getAdminPermLabels();
  const isAdmin = u.id === 'jimmyqrg';
  const showPerms = canManage && !isAdmin && u.is_allowed;
  const defAvU = getDefaultAvatarUrl(u.id);
  const avSrcU = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : defAvU;
  const email = canManage && u.email ? String(u.email) : '';
  const blacklisted = (state.adminBlacklistedIds || []).includes(u.id);
  return `
    <img src="${avSrcU}" data-fallback="${defAvU.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="admin-user-avatar" />
    <div class="admin-user-info">
      <span class="admin-user-name">${escapeHtml(u.display_name || u.username)}${userTag(u.id)}</span>
      <span class="admin-user-handle">@${escapeHtml(u.username || u.id)}</span>
      ${email ? `<span class="admin-user-email" title="${escapeHtml(email)}"><span class="icon" aria-hidden="true">${ICON_MAIL_SM}</span>${escapeHtml(email)}</span>` : ''}
      <span class="admin-user-meta">${isAdmin ? t('adminRoleAdmin') : u.deleted_at ? t('adminRoleDeleted') : (u.is_allowed ? t('adminRoleOnList') : t('adminRoleMember'))}</span>
    </div>
    ${!isAdmin ? `
    <div class="admin-user-actions">
      ${canManage ? `<button type="button" class="btn-small" data-action="allowed" data-user-id="${u.id}" data-allowed="${u.is_allowed ? '1' : '0'}"><span class="icon" aria-hidden="true">${u.is_allowed ? ICON_USER_MINUS_SM : ICON_USER_CHECK_SM}</span>${u.is_allowed ? t('adminRemoveFromList') : t('adminAddToList')}</button>` : ''}
      ${state.user?.can_kick ? (u.deleted_at
        ? `<button type="button" class="btn-small" data-action="restore" data-user-id="${u.id}"><span class="icon" aria-hidden="true">${ICON_ROTATE_SM}</span>${t('adminRestore')}</button>
           ${state.user?.id === 'jimmyqrg' ? `<button type="button" class="btn-small btn-danger" data-action="delete-permanently" data-user-id="${u.id}"><span class="icon" aria-hidden="true">${ICON_TRASH}</span>${t('adminDeletePermanently')}</button>` : ''}`
        : `<button type="button" class="btn-small btn-danger" data-action="remove-account" data-user-id="${u.id}"><span class="icon" aria-hidden="true">${ICON_USER_X_SM}</span>${t('adminRemoveAccount')}</button>
           <button type="button" class="btn-small" data-action="blacklist" data-user-id="${u.id}" data-blacklisted="${blacklisted ? '1' : '0'}"><span class="icon" aria-hidden="true">${ICON_SHIELD_X_SM}</span>${blacklisted ? t('adminUnblacklist') : t('adminBlacklist')}</button>`) : ''}
    </div>
    ${showPerms ? `
    <div class="admin-user-perms">
      ${ADMIN_PERM_KEYS.map(k => `<label class="admin-perm-check"><input type="checkbox" data-action="perm" data-user-id="${u.id}" data-perm="${k}" ${u[k] ? 'checked' : ''} /> ${escapeHtml(permLabels[k])}</label>`).join('')}
    </div>
    ` : ''}
    ` : ''}
  `;
}

function replaceAdminUserCardInPlace(userId) {
  const card = document.querySelector(`.admin-user-card[data-user-id="${CSS.escape(userId)}"]`);
  if (!card) return false;
  const u = (state.users || []).find((x) => x.id === userId);
  if (!u) return false;
  card.innerHTML = renderAdminUserCardInner(u);
  return true;
}

/* Preset durations the admin can pick with one click. Values are in the format
 * the server's parseDuration() understands ("<n> <unit>" or "forever"). */
const TIMEOUT_DURATION_PRESETS = [
  { value: '5 minute', labelKey: 'adminTimeoutPreset5min', defaultLabel: '5 min' },
  { value: '10 minute', labelKey: 'adminTimeoutPreset10min', defaultLabel: '10 min' },
  { value: '30 minute', labelKey: 'adminTimeoutPreset30min', defaultLabel: '30 min' },
  { value: '1 hour', labelKey: 'adminTimeoutPreset1h', defaultLabel: '1 hour' },
  { value: '6 hour', labelKey: 'adminTimeoutPreset6h', defaultLabel: '6 hours' },
  { value: '12 hour', labelKey: 'adminTimeoutPreset12h', defaultLabel: '12 hours' },
  { value: '1 day', labelKey: 'adminTimeoutPreset1day', defaultLabel: '1 day' },
  { value: '3 day', labelKey: 'adminTimeoutPreset3day', defaultLabel: '3 days' },
  { value: '1 week', labelKey: 'adminTimeoutPreset1week', defaultLabel: '1 week' },
  { value: 'forever', labelKey: 'adminTimeoutForever', defaultLabel: 'Forever' },
];

function getTimeoutFormState() {
  if (!state._adminTimeoutForm) {
    state._adminTimeoutForm = {
      userId: '',
      duration: '',
      customNum: '',
      customUnit: 'minute',
      scope: 'group',
    };
  }
  return state._adminTimeoutForm;
}

/* Build the label shown on a duration chip when it's a preset. The chip's
 * text comes from translations so it stays consistent across languages. */
function getTimeoutPresetLabel(preset) {
  return tx(preset.labelKey, preset.defaultLabel);
}

/* Render the searchable user picker + duration chips form used by both the
 * Action tab and the dedicated Timeout sub-tab. `suffix` differentiates the
 * DOM ids and radio names so both forms can co-exist if ever rendered side by
 * side. State lives on state._adminTimeoutForm so selections persist across
 * the socket-driven re-renders that fire while the admin is interacting. */
function renderTimeoutForm(suffix, eligibleUsers) {
  const sfx = suffix || '';
  const candidates = (eligibleUsers || []).filter((u) => u && u.id);
  const formState = getTimeoutFormState();
  const userId = String(formState.userId || '');
  const selected = userId ? candidates.find((u) => u.id === userId) : null;
  const duration = String(formState.duration || '');
  const isCustom = duration === 'custom';
  const customNum = String(formState.customNum || '');
  const customUnit = ['minute', 'hour', 'day', 'week'].includes(formState.customUnit) ? formState.customUnit : 'minute';
  const scope = formState.scope === 'dm' ? 'dm' : 'group';
  const presetButtons = TIMEOUT_DURATION_PRESETS.map((p) => {
    const active = duration === p.value;
    const extra = p.value === 'forever' ? ' admin-duration-chip-forever' : '';
    return `<button type="button" class="admin-duration-chip${active ? ' active' : ''}${extra}" data-duration="${escapeHtml(p.value)}">${escapeHtml(getTimeoutPresetLabel(p))}</button>`;
  }).join('');

  const triggerInner = selected
    ? `<img class="admin-user-picker-trigger-avatar" src="${escapeHtml((selected.avatar_url && String(selected.avatar_url).trim()) ? selected.avatar_url : getDefaultAvatarUrl(selected.id))}" data-fallback="${escapeHtml(getDefaultAvatarUrl(selected.id))}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
       <span class="admin-user-picker-trigger-label">
         <span class="admin-user-picker-trigger-name">${escapeHtml(selected.display_name || selected.username || selected.id)}</span>
         <span class="admin-user-picker-trigger-handle">@${escapeHtml(selected.username || selected.id)}</span>
       </span>`
    : `<span class="admin-user-picker-trigger-icon" aria-hidden="true">${ICON_USERS}</span>
       <span class="admin-user-picker-trigger-label admin-user-picker-trigger-empty">${escapeHtml(tx('adminTimeoutPickUser', 'Pick a user'))}</span>`;

  return `
    <div class="admin-form admin-timeout-form" data-suffix="${escapeHtml(sfx)}">
      <label class="admin-form-label">${t('users')}</label>
      <div class="admin-user-picker">
        <button type="button" class="admin-user-picker-trigger${selected ? ' admin-user-picker-trigger-filled' : ''}" data-action="timeout-open-picker" aria-haspopup="listbox" aria-expanded="false">
          ${triggerInner}
          <span class="admin-user-picker-trigger-caret" aria-hidden="true">${ICON_CHEVRON_DOWN_SM}</span>
        </button>
        <div class="admin-user-picker-panel" hidden>
          <div class="admin-user-picker-search">
            <span class="admin-user-picker-search-icon" aria-hidden="true">${ICON_SEARCH_SM}</span>
            <input type="search" class="admin-user-picker-search-input" data-action="timeout-search-users" placeholder="${escapeHtml(tx('adminTimeoutSearchUsers', 'Search users…'))}" autocomplete="off" />
          </div>
          <div class="admin-user-picker-list" role="listbox">
            ${candidates.map((u) => {
              const av = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : getDefaultAvatarUrl(u.id);
              const fallback = getDefaultAvatarUrl(u.id);
              const haystack = [u.id, u.username, u.display_name, u.email].filter(Boolean).join(' ').toLowerCase();
              return `<button type="button" class="admin-user-picker-item${userId === u.id ? ' active' : ''}" role="option" aria-selected="${userId === u.id}" data-user-id="${escapeHtml(u.id)}" data-haystack="${escapeHtml(haystack)}">
                <img class="admin-user-picker-item-avatar" src="${escapeHtml(av)}" data-fallback="${escapeHtml(fallback)}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
                <span class="admin-user-picker-item-meta">
                  <span class="admin-user-picker-item-name">${escapeHtml(u.display_name || u.username || u.id)}</span>
                  <span class="admin-user-picker-item-handle">@${escapeHtml(u.username || u.id)}</span>
                </span>
                ${userId === u.id ? `<span class="admin-user-picker-item-check" aria-hidden="true">${ICON_CHECK_SM}</span>` : ''}
              </button>`;
            }).join('')}
            <p class="admin-user-picker-empty" hidden>${escapeHtml(tx('adminTimeoutNoUserMatch', 'No user matches your search.'))}</p>
          </div>
        </div>
      </div>
      <input type="hidden" id="admin-timeout-user${sfx}" value="${escapeHtml(userId)}" />
      <label class="admin-form-label">${tx('adminTimeoutScopeLabel', 'Apply timeout to')}</label>
      <div class="admin-timeout-scope" role="radiogroup">
        <label class="admin-timeout-scope-option">
          <input type="radio" name="admin-timeout-scope${sfx}" value="group" data-action="timeout-scope" ${scope === 'group' ? 'checked' : ''} />
          <span>${tx('adminTimeoutScopeGroup', 'Group chat')}</span>
        </label>
        <label class="admin-timeout-scope-option">
          <input type="radio" name="admin-timeout-scope${sfx}" value="dm" data-action="timeout-scope" ${scope === 'dm' ? 'checked' : ''} />
          <span>${tx('adminTimeoutScopeDm', 'Private messages')}</span>
        </label>
      </div>
      <p class="admin-section-subhint">${tx('adminTimeoutScopeHint', 'Private-chat timeouts still let the user message jimmyqrg.')}</p>
      <label class="admin-form-label">${t('adminDuration')}</label>
      <div class="admin-duration-chips" role="radiogroup">
        ${presetButtons}
        <button type="button" class="admin-duration-chip admin-duration-chip-custom${isCustom ? ' active' : ''}" data-duration="custom">${escapeHtml(tx('adminTimeoutCustom', 'Custom…'))}</button>
      </div>
      <div class="admin-duration-custom" ${isCustom ? '' : 'hidden'}>
        <input type="number" min="1" step="1" class="admin-duration-custom-num" data-action="timeout-custom-num" placeholder="${escapeHtml(tx('adminTimeoutCustomNumber', 'Number'))}" value="${escapeHtml(customNum)}" />
        <select class="admin-duration-custom-unit" data-action="timeout-custom-unit">
          <option value="minute"${customUnit === 'minute' ? ' selected' : ''}>${escapeHtml(tx('adminTimeoutCustomUnitMinute', 'minutes'))}</option>
          <option value="hour"${customUnit === 'hour' ? ' selected' : ''}>${escapeHtml(tx('adminTimeoutCustomUnitHour', 'hours'))}</option>
          <option value="day"${customUnit === 'day' ? ' selected' : ''}>${escapeHtml(tx('adminTimeoutCustomUnitDay', 'days'))}</option>
          <option value="week"${customUnit === 'week' ? ' selected' : ''}>${escapeHtml(tx('adminTimeoutCustomUnitWeek', 'weeks'))}</option>
        </select>
      </div>
      <input type="hidden" id="admin-timeout-duration${sfx}" value="${escapeHtml(duration)}" />
      ${state.user?.id === 'jimmyqrg' ? `<label class="admin-timeout-locked"><input type="checkbox" id="admin-timeout-locked${sfx}" /> ${t('adminOnlyICanRelease')}</label>` : ''}
      <button type="button" id="admin-timeout-submit${sfx}" class="btn-primary admin-timeout-submit" data-action="timeout-submit"><span class="icon" aria-hidden="true">${ICON_CLOCK_SM}</span>${t('adminPermTimeout')}</button>
    </div>
  `;
}

/* Resolve the user-friendly duration the picker is currently set to into the
 * exact string the server expects (e.g. "15 minute" or "forever"). Returns
 * null if the admin hasn't picked a duration yet, or if "Custom" is active
 * but the number input is empty/invalid. */
function resolveTimeoutDurationFromState() {
  const f = getTimeoutFormState();
  if (!f.duration) return null;
  if (f.duration !== 'custom') return f.duration;
  const num = parseInt(String(f.customNum || '').trim(), 10);
  if (!Number.isFinite(num) || num < 1) return null;
  const unit = ['minute', 'hour', 'day', 'week'].includes(f.customUnit) ? f.customUnit : 'minute';
  return `${num} ${unit}`;
}

/* Submit the timeout form. Called from the click delegation. The button is
 * inside a .admin-timeout-form so we use it to scope DOM lookups (locked
 * checkbox, hidden inputs) which differ between the action tab and the
 * dedicated timeout sub-tab. */
async function submitTimeoutForm(submitBtn) {
  const form = submitBtn.closest('.admin-timeout-form');
  if (!form) return;
  const formState = getTimeoutFormState();
  const userIdInput = form.querySelector('input[id^="admin-timeout-user"]');
  const userId = String(userIdInput?.value || formState.userId || '').trim();
  if (!userId) {
    showToast(t('adminTimeoutPickUser') || tx('adminTimeoutPickUser', 'Pick a user'));
    return;
  }
  if (userId === 'jimmyqrg') {
    showToast(tx('cannotTimeoutJimmy', 'jimmyqrg cannot be timed out'));
    return;
  }
  const duration = resolveTimeoutDurationFromState();
  if (!duration) {
    if (formState.duration === 'custom') {
      showToast(tx('adminTimeoutCustomInvalid', 'Enter a valid number for the custom duration.'));
    } else {
      showToast(tx('adminTimeoutPickDuration', 'Pick a duration first.'));
    }
    return;
  }
  const lockedCheckbox = form.querySelector('input[id^="admin-timeout-locked"]');
  const locked = !!lockedCheckbox?.checked;
  const scopeRadio = form.querySelector('input[data-action="timeout-scope"]:checked');
  const scope = (scopeRadio?.value === 'dm') ? 'dm' : (formState.scope || 'group');
  submitBtn.disabled = true;
  submitBtn.classList.add('is-loading');
  try {
    await apiPost('/api/admin/timeout', { user_id: userId, duration, locked_release: locked, scope });
    const u = (state.users || []).find((x) => x.id === userId);
    const userLabel = u ? (u.display_name || u.username || u.id) : userId;
    const scopeLabel = scope === 'dm'
      ? tx('adminTimeoutScopeDmBadge', 'Private messages')
      : tx('adminTimeoutScopeGroupBadge', 'Group chat');
    const durationLabel = duration === 'forever' ? tx('adminTimeoutForever', 'Forever') : duration;
    showToast(tx('adminTimeoutAppliedToast', '{user} timed out for {duration} ({scope})')
      .replace('{user}', userLabel)
      .replace('{duration}', durationLabel)
      .replace('{scope}', scopeLabel), 'success');
    // Reset duration but keep the picked user — admins often issue several
    // timeouts in a row for the same person.
    formState.duration = '';
    formState.customNum = '';
    const customRow = form.querySelector('.admin-duration-custom');
    if (customRow) customRow.setAttribute('hidden', '');
    form.querySelectorAll('.admin-duration-chip.active').forEach((c) => c.classList.remove('active'));
    const hiddenDur = form.querySelector('input[id^="admin-timeout-duration"]');
    if (hiddenDur) hiddenDur.value = '';
    const numInput = form.querySelector('.admin-duration-custom-num');
    if (numInput) numInput.value = '';
    if (lockedCheckbox) lockedCheckbox.checked = false;
    loadAdminTimeouts();
  } catch (err) {
    showToast(err?.message || 'Failed to apply timeout');
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove('is-loading');
  }
}

function renderAdminContent() {
  const adminTab = new URLSearchParams(window.location.search || '').get('tab') || 'action';
  const users = state.users || [];
  const otherUsers = users.filter(u => u.id !== state.user?.id);
  return `
        <div class="admin-main">
          ${adminTab === 'action' ? `
          ${state.user?.can_send_inbox ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminSendToInbox')}</h2>
            <p class="admin-section-desc">${t('adminSendToInboxDesc')}</p>
            <div class="admin-form">
              <label>${t('users')}</label>
        <select id="admin-inbox-user">
                <option value="">${t('adminSelectUser')}</option>
                ${otherUsers.map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.username)}</option>`).join('')}
        </select>
              <label>${t('adminTitle')}</label>
              <input type="text" id="admin-inbox-title" placeholder="${t('adminTitle')}" />
              <label>${t('adminBody')}</label>
              <textarea id="admin-inbox-body" placeholder="${t('adminMessageBody')}" rows="4"></textarea>
              <button type="button" id="admin-inbox-send" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_MAIL_SM}</span>${t('send')}</button>
      </div>
      </div>
          ` : ''}
          ${state.user?.can_broadcast ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminBroadcast')}</h2>
            <p class="admin-section-desc">${t('adminBroadcastDesc')}</p>
            <div class="admin-form">
              <label>${t('adminTitle')}</label>
              <input type="text" id="admin-broadcast-title" placeholder="${t('adminTitle')}" />
              <label>${t('adminBody')}</label>
              <textarea id="admin-broadcast-body" placeholder="${t('adminMessageBody')}" rows="4"></textarea>
              <button type="button" id="admin-broadcast-send" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_MEGAPHONE_SM}</span>${t('adminPermBroadcast')}</button>
      </div>
          </div>
          ` : ''}
          ${state.user?.can_timeout ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminTimeoutUser')}</h2>
            <p class="admin-section-desc">${t('adminTimeoutDurationDesc')}</p>
            ${renderTimeoutForm('', otherUsers.filter(u => u.id !== 'jimmyqrg'))}
            <div id="admin-timeout-list" class="admin-timeout-list"></div>
          </div>
          ` : ''}
          ${!state.user?.can_send_inbox && !state.user?.can_broadcast && !state.user?.can_timeout ? `<p class="admin-section-desc">${t('adminNoPermissions')}</p>` : ''}
          ` : ''}
          ${adminTab === 'recalled' ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminRecalledMessages')}</h2>
            <p class="admin-section-desc">${t('adminRecalledDesc')}</p>
            <div id="admin-recalled-list" class="admin-recalled-list"></div>
          </div>
          ` : ''}
          ${adminTab === 'timeout' ? (state.user?.can_timeout ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminTimeoutUser')}</h2>
            <p class="admin-section-desc">${t('adminTimeoutUserDesc')}</p>
            ${renderTimeoutForm('-tab', otherUsers.filter(u => u.id !== 'jimmyqrg'))}
            <div id="admin-timeout-list-tab" class="admin-timeout-list"></div>
          </div>
          ` : `<p class="admin-section-desc">${t('adminNoPermissions')}</p>`) : ''}
          ${adminTab === 'users' ? (() => {
            const userSearch = (state._adminUserSearch || '').trim().toLowerCase();
            // Render ALL user cards every time and use the `hidden` attribute
            // for filtering. This way `applyAdminUserSearchFilter` can broaden
            // a search after a re-render without missing cards. It also keeps
            // every card in the DOM so click/permission listeners on
            // #admin-user-list work for any user the admin reveals later.
            const userMatches = users.map((u) => {
              const blob = [u.id, u.username, u.display_name, u.email].filter(Boolean).join(' ').toLowerCase();
              return !userSearch || blob.includes(userSearch);
            });
            const shownCount = userMatches.filter(Boolean).length;
            return `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminUsersSection')}</h2>
            <p class="admin-section-desc">${t('adminUsersDesc')}</p>
            <div class="admin-users-toolbar">
              <input type="search" id="admin-user-search" class="admin-user-search" placeholder="${tx('adminUserSearchPlaceholder', 'Search by name, username, or email…')}" value="${escapeHtml(state._adminUserSearch || '')}" />
              <span class="admin-user-count">${tx('adminUserCount', '{shown} / {total} users')
                .replace('{shown}', shownCount)
                .replace('{total}', users.length)}</span>
            </div>
            ${shownCount === 0 && userSearch ? `<p class="admin-section-desc admin-user-empty">${tx('adminUserSearchEmpty', 'No users match your search.')}</p>` : ''}
            <div class="admin-users-list" id="admin-user-list">
              ${users.map((u, i) => `<div class="admin-user-card" data-user-id="${escapeHtml(u.id)}"${userMatches[i] ? '' : ' hidden'}>${renderAdminUserCardInner(u)}</div>`).join('')}
            </div>
            <div class="admin-audit-section">
              <h3 class="admin-section-title">${tx('adminAuditLog', 'Audit log')}</h3>
              <div class="admin-audit-toolbar">
                <input type="search" id="admin-audit-search" class="admin-audit-search" placeholder="${tx('adminAuditSearchPlaceholder', 'Search audit log…')}" value="${escapeHtml(state._adminAuditSearch || '')}" />
          </div>
              <div id="admin-audit-list" class="admin-audit-list"><p class="admin-section-desc admin-loading"><span class="admin-loading-spinner" aria-hidden="true"></span> ${t('loading')}</p></div>
            </div>
          </div>
          `;
          })() : ''}
          ${adminTab === 'moderation' ? renderModerationTab() : ''}
          ${adminTab === 'export' && state.user?.id === 'jimmyqrg' ? renderExportTab() : ''}
    </div>
  `;
}

function renderModerationTab() {
  const reports = state._modReports || { items: [], status: 'open', search: '', loading: false };
  const counts = state._reportCounts || { total: 0, open: 0, in_review: 0 };
  const statusOptions = [
    ['open', tx('modStatusOpen', 'Open')],
    ['in_review', tx('modStatusInReview', 'In review')],
    ['resolved', tx('modStatusResolved', 'Resolved')],
    ['rejected', tx('modStatusRejected', 'Rejected')],
    ['duplicate', tx('modStatusDuplicate', 'Duplicate')],
    ['all', tx('modStatusAll', 'All')],
  ];
  const items = reports.items || [];
  return `
  <div class="admin-section">
    <h2 class="admin-section-title">${tx('adminModerationQueue', 'Moderation queue')}</h2>
    <p class="admin-section-desc">${tx('adminModerationDesc', 'Review reports submitted by users. Open: {open} · In review: {in_review} · Total: {total}.')
      .replace('{open}', counts.open)
      .replace('{in_review}', counts.in_review)
      .replace('{total}', counts.total)}
    </p>
    <div class="mod-queue-toolbar">
      <div class="mod-queue-status">
        ${statusOptions.map(([id, label]) => `<button type="button" class="mod-queue-status-btn ${reports.status === id ? 'active' : ''}" data-mod-status="${id}">${escapeHtml(label)}</button>`).join('')}
      </div>
      <input type="search" id="mod-queue-search" class="mod-queue-search" placeholder="${tx('modQueueSearchPlaceholder', 'Search reason / user / message…')}" value="${escapeHtml(reports.search || '')}" />
    </div>
    ${reports.loading ? `<p class="admin-section-desc admin-loading"><span class="admin-loading-spinner" aria-hidden="true"></span> ${t('loading')}</p>` : items.length === 0
      ? `<p class="admin-section-desc">${tx('modQueueEmpty', 'No reports here.')}</p>`
      : `<div class="mod-queue-grid">
          ${items.map((r) => renderModerationCard(r)).join('')}
        </div>`}
  </div>
  `;
}

function renderModerationCard(r) {
  const reporter = r.reporter_display_name || r.reporter_username || r.reporter_id;
  const target = r.target_display_name || r.target_username || r.target_user_id || '-';
  const messagePreview = r.message_content ? escapeHtml(String(r.message_content).slice(0, 240)) : '';
  const status = escapeHtml(r.status);
  const reason = escapeHtml(r.reason);
  const resolveBtns = r.status === 'resolved' || r.status === 'rejected' || r.status === 'duplicate'
    ? ''
    : `<div class="mod-card-actions">
        <button type="button" class="btn-small" data-mod-action="claim" data-report-id="${escapeHtml(r.id)}">${tx('modActionClaim', 'Claim')}</button>
        <button type="button" class="btn-small" data-mod-action="resolve" data-report-id="${escapeHtml(r.id)}">${tx('modActionResolve', 'Mark resolved')}</button>
        <button type="button" class="btn-small" data-mod-action="reject" data-report-id="${escapeHtml(r.id)}">${tx('modActionReject', 'Reject')}</button>
        <button type="button" class="btn-small" data-mod-action="duplicate" data-report-id="${escapeHtml(r.id)}">${tx('modActionDuplicate', 'Mark duplicate')}</button>
      </div>`;
  const roomType = r.room_type === 'dm' ? 'dm' : (r.room_type || 'group');
  const roomId = r.room_id || '';
  const messageBlock = messagePreview && r.message_id
    ? `<button type="button"
              class="mod-card-message mod-card-message-jump"
              data-mod-action="jump"
              data-report-id="${escapeHtml(r.id)}"
              data-message-id="${escapeHtml(r.message_id)}"
              data-room-type="${escapeHtml(roomType)}"
              data-room-id="${escapeHtml(roomId)}"
              title="${escapeHtml(tx('modCardJumpTitle', 'Go to this message in the chat'))}">
        <span class="mod-card-message-text">${messagePreview}</span>
        <span class="mod-card-message-jump-hint">${escapeHtml(tx('modCardJumpHint', roomType === 'dm' ? 'View context' : 'Go to message'))} →</span>
      </button>`
    : (messagePreview ? `<blockquote class="mod-card-message">${messagePreview}</blockquote>` : '');
  return `
    <article class="mod-card mod-card-${status} ${r.status === 'open' ? 'mod-card-open' : ''}" data-report-id="${escapeHtml(r.id)}" data-target-id="${escapeHtml(r.target_user_id || '')}" data-reporter-id="${escapeHtml(r.reporter_id || '')}">
      <header class="mod-card-header">
        <span class="mod-card-status mod-card-status-${status}">${status.replace('_', ' ')}</span>
        <span class="mod-card-reason">${reason}</span>
        <span class="mod-card-time">${escapeHtml(formatTime(r.created_at))}</span>
      </header>
      <div class="mod-card-meta">
        <span><strong>${tx('modCardReporter', 'Reporter')}:</strong> ${escapeHtml(reporter || '-')}</span>
        <span><strong>${tx('modCardTarget', 'Target')}:</strong> ${escapeHtml(target)}</span>
        ${r.assigned_username ? `<span><strong>${tx('modCardAssignee', 'Assignee')}:</strong> ${escapeHtml(r.assigned_username)}</span>` : ''}
        <span class="mod-card-room"><strong>${tx('modCardRoom', 'Room')}:</strong> ${escapeHtml(roomType === 'dm' ? tx('modCardRoomDm', 'Private chat') : tx('modCardRoomGroup', 'Group chat'))}</span>
      </div>
      ${r.details ? `<p class="mod-card-details">${escapeHtml(String(r.details).slice(0, 480))}</p>` : ''}
      ${messageBlock}
      ${resolveBtns}
      <div class="mod-card-detail-link">
        <button type="button" class="btn-link" data-mod-action="view" data-report-id="${escapeHtml(r.id)}">${tx('modActionDetails', 'Open details / notes')}</button>
      </div>
    </article>
  `;
}

function renderExportTab() {
  const backups = state._backups || [];
  const exportRunning = state._exportRunning || null;
  const items = [
    { kind: 'messages', label: tx('exportMessages', 'Messages') },
    { kind: 'users', label: tx('exportUsers', 'Users') },
    { kind: 'audit', label: tx('exportAudit', 'Audit log') },
    { kind: 'docs', label: tx('exportDocs', 'Docs') },
    { kind: 'reports', label: tx('exportReports', 'Reports') },
  ];
  return `
  <div class="admin-section">
    <h2 class="admin-section-title">${tx('adminExportTitle', 'Manual export & backup')}</h2>
    <p class="admin-section-desc">${tx('adminExportDesc', 'Download datasets as JSON or CSV for offline records. Backups create a SQLite snapshot of the database.')}</p>
    <div class="admin-export-grid">
      ${items.map((it) => `
        <div class="admin-export-card">
          <h3>${escapeHtml(it.label)}</h3>
          <div class="admin-export-actions">
            <button type="button" class="btn-small" data-export-kind="${it.kind}" data-export-format="json" ${exportRunning === it.kind + ':json' ? 'disabled' : ''}>JSON</button>
            <button type="button" class="btn-small" data-export-kind="${it.kind}" data-export-format="csv" ${exportRunning === it.kind + ':csv' ? 'disabled' : ''}>CSV</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="admin-backup-section">
      <h3>${tx('adminBackupTitle', 'Database backup')}</h3>
      <button type="button" class="btn-primary" id="admin-backup-create">${tx('adminBackupCreate', 'Create snapshot')}</button>
      <ul class="admin-backup-list">
        ${backups.length === 0 ? `<li class="admin-section-desc">${tx('adminBackupEmpty', 'No backups yet.')}</li>` :
          backups.map((b) => `
          <li class="admin-backup-item">
            <span class="admin-backup-name">${escapeHtml(b.filename)}</span>
            <span class="admin-backup-meta">${formatTime(b.created_at)} · ${formatBytes(b.size)}</span>
            <a class="btn-small" href="/api/admin/backup/${encodeURIComponent(b.filename)}" download>${tx('adminBackupDownload', 'Download')}</a>
          </li>
        `).join('')}
      </ul>
    </div>
    </div>
  `;
}

async function loadAdminRecalled() {
  const el = document.getElementById('admin-recalled-list');
  if (!el) return;
  try {
    const { messages } = await apiGet('/api/admin/recalled-messages');
    el.innerHTML = messages.length === 0
      ? `<p class="admin-section-desc">${t('adminNoRecalledMessages')}</p>`
      : `<ul class="admin-recalled-ul">${messages.map(m => `
        <li class="admin-recalled-item">
          <strong>${escapeHtml(m.display_name || m.username || 'Unknown user')}</strong>
          <span class="admin-recalled-time">${formatTime(m.recalled_at)}</span>
          <p class="admin-recalled-content">${escapeHtml((m.content || '').slice(0, 200))}</p>
        </li>
      `).join('')}</ul>`;
  } catch (err) {
    el.innerHTML = `<p class="admin-section-desc">${t('adminFailedToLoad')}</p>`;
  }
}

async function loadAdminBlacklist() {
  if (!state.user?.can_kick) return;
  try {
    const { blacklisted_ids } = await apiGet('/api/admin/blacklist');
    state.adminBlacklistedIds = blacklisted_ids || [];
  } catch (_) { state.adminBlacklistedIds = []; }
}

async function loadAdminAudit(search = state._adminAuditSearch || '') {
  const el = document.getElementById('admin-audit-list');
  if (!el) return;
  try {
    const params = new URLSearchParams({ limit: '120' });
    if (search) params.set('q', search);
    const { logs } = await apiGet(`/api/admin/audit?${params.toString()}`);
    const items = logs || [];
    el.innerHTML = items.length === 0
      ? `<p class="admin-section-desc">${tx('adminAuditNoItems', 'No audit items yet.')}</p>`
      : `<ul class="admin-audit-ul">${items.map((a) => {
          const actor = escapeHtml(a.actor_display_name || a.actor_username || a.actor_id || 'system');
          const target = escapeHtml(a.target_display_name || a.target_username || a.target_id || '-');
          const details = a.details ? `<pre class="admin-audit-details">${escapeHtml(JSON.stringify(a.details, null, 2))}</pre>` : '';
          return `<li class="admin-audit-item">
            <div class="admin-audit-main">
              <strong>${escapeHtml(a.action)}</strong>
              <span class="admin-audit-time">${escapeHtml(formatTime(a.created_at))}</span>
            </div>
            <div class="admin-audit-meta">${tx('adminAuditBy', 'By')}: ${actor} · ${tx('adminAuditTarget', 'Target')}: ${target}</div>
            ${details}
          </li>`;
        }).join('')}</ul>`;
  } catch (err) {
    el.innerHTML = `<p class="admin-section-desc">${t('adminFailedToLoad')}</p>`;
  }
}

async function loadAdminTimeouts() {
  const el = document.getElementById('admin-timeout-list');
  const elTab = document.getElementById('admin-timeout-list-tab');
  const listEl = el || elTab;
  if (!listEl) return;
  try {
    const { timeouts } = await apiGet('/api/admin/timeouts');
    const html = timeouts.length === 0
      ? `<p class="admin-section-desc">${t('adminNoActiveTimeouts')}</p>`
      : `<ul class="admin-timeout-ul">${timeouts.map(to => {
          const scopeLabel = to.scope === 'dm'
            ? tx('adminTimeoutScopeDmBadge', 'Private messages')
            : tx('adminTimeoutScopeGroupBadge', 'Group chat');
          const scopeClass = to.scope === 'dm' ? 'admin-timeout-scope-badge-dm' : 'admin-timeout-scope-badge-group';
          return `
        <li class="admin-timeout-item">
          <span>${escapeHtml(to.display_name || to.username)}</span>
          <span class="admin-timeout-scope-badge ${scopeClass}">${escapeHtml(scopeLabel)}</span>
          <span class="admin-timeout-meta">${to.expires_at ? t('adminTimeoutUntil') + formatTime(to.expires_at) : t('adminTimeoutForever')} ${to.locked_release ? t('adminTimeoutLocked') : ''}</span>
          ${(!to.locked_release || state.user?.id === 'jimmyqrg') ? `<button type="button" class="btn-small admin-timeout-release" data-timeout-id="${to.id}"><span class="icon" aria-hidden="true">${ICON_UNLOCK_SM}</span>${t('adminRelease')}</button>` : ''}
        </li>`;
        }).join('')}</ul>`;
    if (el) el.innerHTML = html;
    if (elTab) elTab.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = `<p class="admin-section-desc">${t('adminFailedToLoad')}</p>`;
  }
}

function applyAdminUserSearchFilter(rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  const list = document.getElementById('admin-user-list');
  if (!list) return;
  const cards = list.querySelectorAll('.admin-user-card');
  const usersMap = new Map((state.users || []).map((u) => [u.id, u]));
  let shown = 0;
  cards.forEach((card) => {
    const uid = card.dataset.userId;
    const u = usersMap.get(uid);
    if (!query) {
      card.hidden = false;
      shown += 1;
      return;
    }
    const blob = [
      uid,
      u?.username,
      u?.display_name,
      u?.email,
      card.querySelector('.admin-user-email')?.textContent,
      card.querySelector('.admin-user-handle')?.textContent,
      card.querySelector('.admin-user-name')?.textContent,
    ].filter(Boolean).join(' ').toLowerCase();
    const match = blob.includes(query);
    card.hidden = !match;
    if (match) shown += 1;
  });
  const countEl = document.querySelector('.admin-users-toolbar .admin-user-count');
  if (countEl) {
    const total = (state.users || []).length || cards.length;
    countEl.textContent = tx('adminUserCount', '{shown} / {total} users')
      .replace('{shown}', shown)
      .replace('{total}', total);
  }
  const section = list.closest('.admin-section');
  if (section) {
    let emptyMsg = section.querySelector('.admin-user-empty');
    if (shown === 0 && query) {
      if (!emptyMsg) {
        emptyMsg = document.createElement('p');
        emptyMsg.className = 'admin-section-desc admin-user-empty';
        list.insertAdjacentElement('beforebegin', emptyMsg);
      }
      emptyMsg.textContent = tx('adminUserSearchEmpty', 'No users match your search.');
    } else if (emptyMsg) {
      emptyMsg.remove();
    }
  }
}

function bindAdmin() {
  const loadingHtml = `<p class="admin-section-desc admin-loading"><span class="admin-loading-spinner" aria-hidden="true"></span> ${t('loading')}</p>`;
  const getAdminScrollContainer = () =>
    document.querySelector('.main-content-body') ||
    document.querySelector('.admin-main') ||
    document.querySelector('.app-main');
  const rerenderAdminKeepScroll = () => {
    const sc = getAdminScrollContainer();
    const top = sc ? sc.scrollTop : window.scrollY;
    const left = sc ? sc.scrollLeft : window.scrollX;
    render();
    bindAdmin();
    requestAnimationFrame(() => {
      const sc2 = getAdminScrollContainer();
      if (sc2) {
        sc2.scrollTop = top;
        sc2.scrollLeft = left;
      } else {
        window.scrollTo(left, top);
      }
    });
  };
  const recalledEl = document.getElementById('admin-recalled-list');
  const timeoutEl = document.getElementById('admin-timeout-list');
  const timeoutElTab = document.getElementById('admin-timeout-list-tab');
  if (recalledEl) recalledEl.innerHTML = loadingHtml;
  if (timeoutEl) timeoutEl.innerHTML = loadingHtml;
  if (timeoutElTab) timeoutElTab.innerHTML = loadingHtml;
  loadAdminRecalled();
  loadAdminTimeouts();
  loadAdminAudit();

  // The new timeout form (user picker, duration chips, custom row, submit
  // button) is wired up via delegated listeners on #app — see init(). Those
  // listeners survive socket-driven re-renders the same way the admin search
  // does, so the form stays interactive even if presence:snapshot fires.

  document.querySelector('.admin-timeout-list')?.closest('.admin-section')?.addEventListener('click', async (e) => {
    const releaseBtn = e.target.closest('.admin-timeout-release');
    if (releaseBtn) {
      const id = releaseBtn.dataset.timeoutId;
      try {
        await apiPost(`/api/admin/timeout/${id}/release`, {});
        loadAdminTimeouts();
      } catch (err) { showToast(err.message); }
    }
  });
  document.getElementById('admin-timeout-list-tab')?.closest('.admin-section')?.addEventListener('click', async (e) => {
    const releaseBtn = e.target.closest('.admin-timeout-release');
    if (releaseBtn) {
      const id = releaseBtn.dataset.timeoutId;
      try {
        await apiPost(`/api/admin/timeout/${id}/release`, {});
        loadAdminTimeouts();
      } catch (err) { showToast(err.message); }
    }
  });

  document.getElementById('admin-user-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const userId = btn.dataset.userId;
    if (btn.dataset.action === 'remove-account') return removeAccount(userId);
    if (btn.dataset.action === 'restore') return restoreAccount(userId);
    if (btn.dataset.action === 'delete-permanently') return showDeletePermanentlyModal(userId);
    if (btn.dataset.action === 'blacklist') return toggleBlacklist(userId, btn.dataset.blacklisted === '1');
    if (btn.dataset.action === 'allowed') {
      const allowed = btn.dataset.allowed !== '1';
      try {
        await apiPost('/api/admin/users/' + userId + '/allowed', { allowed });
        const u = (state.users || []).find((x) => x.id === userId);
        if (u) u.is_allowed = allowed;
        replaceAdminUserCardInPlace(userId);
      } catch (err) { showToast(err.message); }
    }
  });
  document.getElementById('admin-user-list')?.addEventListener('change', async (e) => {
    const cb = e.target.closest('input[data-action="perm"]');
    if (!cb) return;
    const userId = cb.dataset.userId;
    const perm = cb.dataset.perm;
    const value = !!cb.checked;
    try {
      await apiPatch('/api/admin/users/' + userId + '/permissions', { [perm]: value });
      const u = (state.users || []).find((x) => x.id === userId);
      if (u) u[perm] = value;
      // checkbox already reflects the new state from the user's click — no re-render needed
    } catch (err) {
      cb.checked = !value;
      showToast(err.message);
    }
  });
  document.getElementById('admin-inbox-send')?.addEventListener('click', async () => {
    const to = document.getElementById('admin-inbox-user')?.value;
    const title = document.getElementById('admin-inbox-title')?.value ?? '';
    const body = document.getElementById('admin-inbox-body')?.value ?? '';
    if (!to) { showToast(t('adminSelectUser')); return; }
    try {
      await apiPost('/api/inbox/send', { to_user_id: to, title, body });
      showToast(t('adminSent'), 'success');
    } catch (e) { showToast(e.message); }
  });
  document.getElementById('admin-broadcast-send')?.addEventListener('click', async () => {
    const title = document.getElementById('admin-broadcast-title')?.value ?? '';
    const body = document.getElementById('admin-broadcast-body')?.value ?? '';
    try {
      await apiPost('/api/inbox/broadcast', { title, body });
      showToast(t('adminBroadcastSent'), 'success');
    } catch (e) { showToast(e.message); }
  });

  // The admin-user-search and admin-audit-search inputs use a delegated
  // listener attached once to #app in init(), so they survive re-renders
  // (e.g. socket-driven render() calls without bindAdmin()).

  // Moderation queue tab — initial fetch only; status / card actions use #app
  // delegated click handler in init() so they survive loadModerationQueue → render().
  const adminTab = new URLSearchParams(window.location.search || '').get('tab') || 'action';
  if (adminTab === 'moderation') {
    if (!state._modReports || (state._modReports.items?.length === 0 && !state._modReports.loading)) {
      loadModerationQueue();
    }
  }

  // Export tab
  if (adminTab === 'export' && state.user?.id === 'jimmyqrg') {
    if (!state._backups || state._backups.length === 0) {
      loadBackups().then(() => render());
    }
    document.querySelectorAll('[data-export-kind]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const kind = btn.dataset.exportKind;
        const format = btn.dataset.exportFormat;
        const key = `${kind}:${format}`;
        state._exportRunning = key;
        render();
        try {
          const url = `/api/admin/export/${kind}?format=${format}`;
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) throw new Error('Export failed');
          const blob = await res.blob();
          const dlUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = dlUrl;
          a.download = `${kind}-${Date.now()}.${format}`;
          a.click();
          URL.revokeObjectURL(dlUrl);
          showToast(tx('exportDone', 'Export ready.'), 'success');
        } catch (err) {
          showToast(err.message || 'Export failed');
        } finally {
          state._exportRunning = null;
          render();
        }
      });
    });
    document.getElementById('admin-backup-create')?.addEventListener('click', async () => {
      try {
        await apiPost('/api/admin/backup');
        await loadBackups();
        render();
        showToast(tx('backupCreated', 'Backup created.'), 'success');
      } catch (err) {
        showToast(err.message || 'Backup failed');
      }
    });
  }
}

async function loadAdminAuditWithSearch(search) {
  return loadAdminAudit(search);
}

function showModerationDetailModal(reportId) {
  loadModerationReportDetail(reportId).then((data) => {
    if (!data) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const r = data.report;
    const notes = data.notes || [];
    overlay.innerHTML = `
      <div class="modal mod-detail-modal" style="max-width:560px;">
        <h3>${escapeHtml(tx('modDetailTitle', 'Report details'))}</h3>
        <div class="mod-detail-section">
          <p><strong>${tx('modCardReason', 'Reason')}:</strong> ${escapeHtml(r.reason)}</p>
          <p><strong>${tx('modCardStatus', 'Status')}:</strong> ${escapeHtml(r.status)}${r.outcome ? ` — ${escapeHtml(r.outcome)}` : ''}</p>
          <p><strong>${tx('modCardReporter', 'Reporter')}:</strong> ${escapeHtml(r.reporter_username || r.reporter_id || '-')}</p>
          <p><strong>${tx('modCardTarget', 'Target')}:</strong> ${escapeHtml(r.target_username || r.target_user_id || '-')}</p>
          ${r.message_content ? `<blockquote class="mod-detail-message">${escapeHtml(r.message_content)}</blockquote>` : ''}
          ${r.details ? `<p class="mod-detail-details">${escapeHtml(r.details)}</p>` : ''}
          ${r.message_id ? `<div class="mod-detail-actions">
            <button type="button" id="mod-detail-context" class="btn-small">${escapeHtml(tx('viewContext', 'View surrounding messages'))}</button>
          </div>` : ''}
        </div>
        <div class="mod-detail-section">
          <h4>${tx('modNotesTitle', 'Notes')}</h4>
          <div class="mod-notes-list">
            ${notes.length === 0 ? `<p class="admin-section-desc">${tx('modNotesEmpty', 'No notes yet.')}</p>` :
              notes.map((n) => `<div class="mod-note">
                <span class="mod-note-meta"><strong>${escapeHtml(n.author_username || 'admin')}</strong> · ${escapeHtml(formatTime(n.created_at))}</span>
                <p>${escapeHtml(n.body)}</p>
              </div>`).join('')}
          </div>
          <textarea id="mod-note-input" placeholder="${tx('modNotePlaceholder', 'Add a note…')}" rows="3"></textarea>
          <div class="modal-actions">
            <button type="button" id="mod-note-add" class="btn-primary">${tx('modNoteAdd', 'Add note')}</button>
            <button type="button" id="mod-detail-close" class="modal-close">${t('cancel')}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#mod-detail-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#mod-detail-context')?.addEventListener('click', () => {
      showReportContextModal(reportId);
    });
    overlay.querySelector('#mod-note-add')?.addEventListener('click', async () => {
      const ta = overlay.querySelector('#mod-note-input');
      const body = ta?.value?.trim();
      if (!body) return;
      try {
        await apiPost(`/api/reports/${reportId}/notes`, { body });
        await loadModerationReportDetail(reportId);
        close();
        showModerationDetailModal(reportId);
      } catch (err) {
        showToast(err.message || 'Failed to add note');
      }
    });
  });
}

function renderSettingsPage() {
  return `<div class="settings-page-wrap">${renderSettingsContent()}</div>`;
}

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

function renderSettingsContent() {
  const tab = new URLSearchParams(window.location.search || '').get('tab') || 'profile';
  return `
        <div class="settings-page">
      ${tab === 'general' ? `
      <div class="settings-general">
        <h3 class="settings-section-title">${t('systemLanguage')}</h3>
        <p class="settings-account-desc">${t('chooseLanguage')}</p>
        <label class="settings-form-label">${t('language')}</label>
        <select id="settings-language" class="settings-select">
          ${(state.languageOptions || LANGUAGE_OPTIONS).map(o => `<option value="${o.value}" ${state.language === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>
        <h3 class="settings-section-title">${tx('chatboxStyle', 'Message Bubble Style')}</h3>
        <p class="settings-account-desc">${tx('chatboxStyleDesc', 'Choose a message bubble style visible to everyone.')}</p>
        <div class="chatbox-picker" id="chatbox-picker">
          ${(state._chatboxStyles.length ? state._chatboxStyles : [{ id: 'default', name: 'Default' }]).map(s => {
            const active = (state.user?.chatbox_style || 'default') === s.id;
            return `<button type="button" class="chatbox-picker-item ${active ? 'active' : ''}" data-style="${s.id}" title="${escapeHtml(s.description || '')}">
              <div class="chatbox-picker-preview">
                <div class="chatbox-preview-bubble chatbox-preview-other" style="background-image: url('/assets/chatboxes/${s.id}/other.svg')"></div>
                <div class="chatbox-preview-bubble chatbox-preview-own" style="background-image: url('/assets/chatboxes/${s.id}/own.svg')"></div>
              </div>
              <span class="chatbox-picker-label">${escapeHtml(s.name)}</span>
            </button>`;
          }).join('')}
        </div>
        <h3 class="settings-section-title">${tx('uiAnimation', 'UI Animation')}</h3>
        <p class="settings-account-desc">${tx('uiAnimationDesc', 'Enable or disable transitions and animations throughout the interface.')}</p>
        <label class="settings-checkbox-label">
          <input type="checkbox" id="settings-ui-animations" ${state.uiAnimations ? 'checked' : ''} />
          <span>${tx('enableUiAnimation', 'Enable UI animation')}</span>
        </label>
        <h3 class="settings-section-title">${tx('enterToSendTitle', 'Enter Key')}</h3>
        <p class="settings-account-desc">${tx('enterToSendDesc', 'On phones, the Enter key adds a new line so you can send multi-line messages. Turn this on to send with Enter instead.')}</p>
        <label class="settings-checkbox-label">
          <input type="checkbox" id="settings-enter-to-send" ${state.enterToSend ? 'checked' : ''} />
          <span>${tx('enterToSendLabel', 'Enter key sends message')}</span>
        </label>
          </div>
      ` : ''}
      ${tab === 'profile' ? `
          <form id="profile-form" class="settings-form">
        <label>${t('avatar')}</label>
        <div class="settings-avatar-drop-zone" id="settings-avatar-drop-zone">
          <img src="${state._pendingAvatarObjectUrl || getCurrentUserAvatarUrl()}" data-fallback="${getDefaultAvatarUrl(state.user?.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="avatar-preview" id="avatar-preview" />
          <span class="settings-avatar-drop-hint">${t('dropImage')}</span>
        </div>
        <label class="file-label">
          <span class="file-label-text">${t('chooseImage')}</span>
          <input type="file" name="avatar" accept="image/*" class="file-input" />
        </label>
        <label>${t('displayName')}</label>
            <input type="text" name="display_name" value="${escapeHtml(state.user?.display_name || '')}" />
        <label>${t('description')}</label>
        <textarea name="description" rows="3" placeholder="${t('descriptionPlaceholder')}">${escapeHtml(state.user?.description || '')}</textarea>
        <label>${t('website')}</label>
        <input type="url" name="website" placeholder="https://..." value="${escapeHtml(state.user?.website || '')}" />
        <button type="submit"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>${t('save')}</button>
          </form>
      ` : ''}
      ${tab === 'notifications' ? `
      <div class="settings-notifications">
        <h3 class="settings-section-title">${t('notifications')}</h3>
        <p class="settings-account-desc">${t('notificationsDesc')}</p>
        <div class="settings-form">
          <label class="settings-checkbox-label">
            <input type="checkbox" id="notif-enabled" ${state.notificationPrefs?.enabled ? 'checked' : ''} />
            <span>Enable desktop notifications</span>
          </label>
          <div id="notif-triggers" class="notif-triggers" style="${state.notificationPrefs?.enabled ? '' : 'opacity:0.5;pointer-events:none'}">
            <label class="settings-checkbox-label"><input type="checkbox" id="notif-mails" ${state.notificationPrefs?.notify_mails !== false ? 'checked' : ''} /><span>${t('notifyMails')}</span></label>
            <label class="settings-checkbox-label"><input type="checkbox" id="notif-dm" ${state.notificationPrefs?.notify_dm !== false ? 'checked' : ''} /><span>${t('notifyDm')}</span></label>
            <label class="settings-checkbox-label"><input type="checkbox" id="notif-group" ${state.notificationPrefs?.notify_group !== false ? 'checked' : ''} /><span>${t('notifyGroup')}</span></label>
        </div>
          <div id="notif-dnd" class="notif-dnd" style="${state.notificationPrefs?.enabled ? '' : 'opacity:0.5;pointer-events:none'}">
            <h4 class="settings-section-title">${t('doNotDisturb')}</h4>
            ${state.notificationPrefs?.dnd_until && Date.now() < state.notificationPrefs.dnd_until
              ? `<button type="button" id="notif-dnd-end-now" class="btn-small btn-danger"><span class="icon" aria-hidden="true">${ICON_BELL_OFF_SM}</span>${t('dndEndNow')}</button>`
              : `<button type="button" id="notif-dnd-open" class="btn-secondary"><span class="icon" aria-hidden="true">${ICON_MOON_SM}</span>${t('doNotDisturb')}</button>`}
            <label class="settings-checkbox-label" style="margin-top:0.5rem;display:block">
              <input type="checkbox" id="notif-dnd-at-night" ${state.notificationPrefs?.dnd_at_night ? 'checked' : ''} />
              <span>${t('dndAtNight')}</span>
            </label>
            ${state.notificationPrefs?.dnd_at_night ? `
            <div class="dnd-location-row" style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">
              <button type="button" id="notif-dnd-use-location" class="btn-small"><span class="icon" aria-hidden="true">${ICON_MAP_PIN_SM}</span>${t('dndUseLocation')}</button>
              <button type="button" id="notif-dnd-enter-city" class="btn-small"><span class="icon" aria-hidden="true">${ICON_BUILDING_SM}</span>${t('dndEnterCity')}</button>
      </div>
            ` : ''}
          </div>
        </div>
      </div>
      ` : ''}
      ${tab === 'account' ? `
      <div class="settings-account">
        <div class="settings-account-block">
          <h3 class="settings-section-title">${t('accountRecoveryKey')}</h3>
          <p class="settings-account-desc">${t('accountRecoveryKeyDesc')}</p>
          <button type="button" id="view-account-key-btn" class="btn-secondary"><span class="icon" aria-hidden="true">${ICON_KEY_SM}</span>${t('viewAccountKey')}</button>
        </div>
        <div class="settings-account-block">
          <h3 class="settings-section-title">${t('password')}</h3>
          <p class="settings-account-desc">${t('changePasswordDesc')}</p>
          <button type="button" id="open-password-modal" class="btn-secondary"><span class="icon" aria-hidden="true">${ICON_KEY_SM}</span>${t('changePassword')}</button>
        </div>
        <div class="settings-account-block">
          <h3 class="settings-section-title">${t('signOut')}</h3>
          <p class="settings-account-desc">${t('signOutDesc')}</p>
          <button type="button" id="sign-out-btn" class="btn-danger"><span class="icon" aria-hidden="true">${ICON_LOG_OUT_SM}</span>${t('signOut')}</button>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

function renderInboxContent() {
  const loading = state._loadingInbox === true;
  const list = state.inbox || [];
  const empty = !loading && list.length === 0;
  return `
        <div class="inbox-page">
      <h2>${t('inbox')}</h2>
          <div id="inbox-list">
        ${loading
          ? `<div class="inbox-loading"><span class="inbox-loading-spinner" aria-hidden="true"></span><span>${t('loading')}</span></div>`
          : empty
          ? `<div class="inbox-empty"><span class="inbox-empty-icon" aria-hidden="true"><i class="fas fa-inbox"></i></span><span>${t('noMailYet')}</span></div>`
          : list.map(item => {
            const extraObj = typeof item.related_extra === 'object' && item.related_extra
              ? item.related_extra
              : (typeof item.related_extra === 'string' && item.related_extra
                ? (() => { try { return JSON.parse(item.related_extra); } catch (_) { return {}; } })()
                : {});
            const extraJson = JSON.stringify(extraObj || {});
            const typeLabel = (item.type === 'mod_report')
              ? tx('inboxTypeReport', 'Report')
              : item.type;
            return `
          <div class="inbox-item ${item.read_at ? '' : 'unread'} ${item.type === 'mod_report' ? 'inbox-item-report' : ''}" data-id="${item.id}" data-type="${escapeHtml(item.type)}" data-related="${escapeHtml(item.related_id || '')}" data-extra="${escapeHtml(extraJson)}">
            <div class="inbox-item-main">
                <div class="type">${escapeHtml(typeLabel)}</div>
                <div class="title">${escapeHtml(item.title || '')}</div>
                <div class="body">${escapeHtml(item.body || '').replace(/\n/g, '<br>')}</div>
              ${item.type === 'friend_request' && !item.read_at ? `
              <div class="inbox-item-actions">
                <button type="button" class="btn-small btn-primary inbox-accept-fr" data-inbox-id="${item.id}"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>${t('accept')}</button>
                <button type="button" class="btn-small inbox-reject-fr" data-inbox-id="${item.id}"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${t('reject')}</button>
              </div>
              ` : ''}
              ${item.type === 'mod_report' ? `
              <div class="inbox-item-actions">
                ${extraObj?.message_id ? `<button type="button" class="btn-small btn-primary inbox-report-jump" data-inbox-id="${item.id}">${tx('goToMessage', 'Go to message')}</button>` : ''}
                <button type="button" class="btn-small inbox-report-open-queue" data-inbox-id="${item.id}" data-report-id="${escapeHtml(extraObj?.report_id || item.related_id || '')}">${tx('openInModeration', 'Open in moderation')}</button>
              </div>
              ` : ''}
          </div>
            <button type="button" class="inbox-item-delete" data-inbox-id="${item.id}" title="${t('delete')}" aria-label="${t('delete')}"><i class="fas fa-trash-alt" aria-hidden="true"></i></button>
              </div>
            `;
          }).join('')}
          </div>
        </div>
  `;
}

function renderCollectionsContent() {
  const items = state.collections || [];
  if (!items.length) {
    return `
      <div class="collections-page">
        <h2>${tx('collections', 'Collections')}</h2>
        <div class="collections-empty">${tx('noCollections', 'No saved messages yet.')}</div>
      </div>
    `;
  }
  return `
    <div class="collections-page">
      <h2>${tx('collections', 'Collections')}</h2>
      <div class="collections-list">
        ${items.map((c) => `
          <div class="collection-item" data-id="${c.id}" data-message-id="${c.message_id}">
            <div class="collection-meta">
              <div class="collection-sender">${escapeHtml(c.sender_display_name || c.sender_username || c.sender_id || '')}</div>
              <div class="collection-date">${escapeHtml(formatTimestampForDivider(c.message_created_at || c.created_at))}</div>
            </div>
            <div class="collection-body">${escapeHtml((c.content_snapshot || '').slice(0, 200))}${(c.content_snapshot || '').length > 200 ? '…' : ''}</div>
            <div class="collection-actions">
              <button type="button" class="icon-btn collection-open" data-message-id="${c.message_id}" title="${tx('open', 'Open')}"><span class="icon" aria-hidden="true">${ICON_EXTERNAL}</span></button>
              <button type="button" class="icon-btn icon-btn-danger collection-remove" data-id="${c.id}" title="${t('delete')}"><span class="icon" aria-hidden="true">${ICON_TRASH}</span></button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function getChatHeaderTitle(roomType, roomId) {
  if (roomType === 'group') {
    const labels = { free_chat: t('freeChat'), support: t('support') };
    return labels[roomId] || roomId;
  }
  const other = (state.users || []).find((u) => u.id === state.dmUserId);
  return other?.display_name || other?.username || t('chat');
}

function renderChatUsersView() {
  const allUsers = (state.users || []).filter((u) => !isBlocked(u.id));
  const users = allUsers.filter((u) => !u.deleted_at);
  const convId = (uid) => state.convByUserId[uid];
  const lastMessageAt = (uid) => {
    const fromApi = state.lastMessageAtByUserId?.[uid];
    if (fromApi != null) return fromApi;
    const c = convId(uid);
    if (!c) return 0;
    const list = state.messages[`dm:${c}`];
    return list?.length ? Math.max(...list.map((m) => m.created_at || 0)) : 0;
  };
  const newCount = (uid) => {
    const c = convId(uid);
    return c ? getNewCount('dm', c) : 0;
  };
  const name = (u) => (u.display_name || u.username || '').toLowerCase();
  users.sort((a, b) => {
    const pa = userSortPriority(a.id), pb = userSortPriority(b.id);
    if (pa !== pb) return pa - pb;
    const at = lastMessageAt(a.id), bt = lastMessageAt(b.id);
    if (bt !== at) return bt - at;
    const an = newCount(a.id), bn = newCount(b.id);
    if (bn !== an) return bn - an;
    return name(a).localeCompare(name(b));
  });
  const onlineUsers = users.filter((u) => getPresence(u.id)?.state === 'online');
  const idleUsers = users.filter((u) => getPresence(u.id)?.state === 'idle');
  return `
    <div class="chat-users-view">
      <div class="chat-users-summary">
        <strong class="chat-users-count">${tx('chatUsersCount', '{n} member(s)').replace('{n}', users.length)}</strong>
        <span class="chat-users-online">${tx('chatUsersOnline', '{n} online').replace('{n}', onlineUsers.length)}</span>
        ${idleUsers.length ? `<span class="chat-users-idle">${tx('chatUsersIdle', '{n} idle').replace('{n}', idleUsers.length)}</span>` : ''}
      </div>
      <div class="chat-users-search">
        <input type="search" id="chat-side-user-search" placeholder="${tx('users', 'Users')}…" />
      </div>
      <ul class="panel-list-ul chat-side-user-list" id="chat-side-user-list">
        ${users.map((u) => {
          const friend = isFriend(u.id);
          const defAv = getDefaultAvatarUrl(u.id);
          const avSrc = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : defAv;
          const n = newCount(u.id);
          const badge = n > 0 ? `<span class="panel-list-badge panel-list-badge-count" aria-label="${n} new">${n > 99 ? '99+' : n}</span>` : '';
          const chatHref = `/chat/${encodeURIComponent(u.id)}${friend ? '' : '?view=profile'}`;
          const tag = userTag(u.id);
          return `
            <li><a href="${chatHref}" class="panel-list-link ${state.dmUserId === u.id ? 'active' : ''}" data-user-id="${escapeHtml(u.id)}" data-username="${escapeHtml((u.username || '').toLowerCase())}" data-display="${escapeHtml(name(u))}" data-friend="${friend ? '1' : '0'}">
              <span class="panel-user-avatar-wrap" data-user-id="${escapeHtml(u.id)}" title="View profile"><img src="${avSrc}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="panel-user-avatar" />${presenceDot(u.id)}</span>
              <span class="panel-list-link-text">${escapeHtml(u.display_name || u.username)}</span>${tag}${badge}
            </a></li>
          `;
        }).join('')}
      </ul>
    </div>
  `;
}

function renderChatSidePanel(roomType, roomId) {
  const activeTab = state._chatSidePanelTab || (roomType === 'dm' ? 'search' : 'users');
  return `
    <aside class="chat-side-panel ${state._chatSidePanelOpen ? 'open' : ''}" id="chat-side-panel">
      <div class="chat-side-panel-header">
        <div class="chat-side-panel-tabs">
          ${roomType !== 'dm' ? `<button type="button" class="chat-side-panel-tab ${activeTab === 'users' ? 'active' : ''}" data-chat-side-tab="users"><span class="icon" aria-hidden="true">${ICON_USERS}</span> ${tx('users', 'Users')}</button>` : ''}
          <button type="button" class="chat-side-panel-tab ${activeTab === 'search' ? 'active' : ''}" data-chat-side-tab="search"><span class="icon" aria-hidden="true">${ICON_SEARCH_SM}</span> ${tx('search', 'Search')}</button>
        </div>
        <button type="button" class="chat-side-panel-close" id="chat-side-panel-close" aria-label="Close"><span class="icon" aria-hidden="true">${ICON_CLOSE}</span></button>
      </div>
      <div class="chat-side-panel-body">
        ${activeTab === 'search' ? renderChatSearchView(roomType, roomId) : (roomType === 'dm' ? renderChatSearchView(roomType, roomId) : renderChatUsersView())}
      </div>
    </aside>
  `;
}

function renderChatSearchView(roomType, roomId) {
  const results = state._chatSearchResults || [];
  const loading = !!state._chatSearchLoading;
  const attachmentType = state._chatSearchAttachmentType || '';
  const types = [
    ['', tx('searchAttachAll', 'All messages')],
    ['any', tx('searchAttachAny', 'Any attachment')],
    ['image', tx('searchAttachImage', 'Images')],
    ['video', tx('searchAttachVideo', 'Videos')],
    ['audio', tx('searchAttachAudio', 'Audio')],
    ['voice', tx('searchAttachVoice', 'Voice')],
    ['file', tx('searchAttachFile', 'Files')],
    ['gif', tx('searchAttachGif', 'GIFs')],
  ];
  const dateRanges = [
    ['any', tx('searchDateAny', 'Any time')],
    ['today', tx('searchDateToday', 'Today')],
    ['week', tx('searchDateWeek', 'Last 7 days')],
    ['month30', tx('searchDateMonth30', 'Last 30 days')],
    ['thismonth', tx('searchDateThisMonth', 'This month')],
    ['thisyear', tx('searchDateThisYear', 'This year')],
    ['custom', tx('searchDateCustom', 'Custom…')],
  ];
  const selectedRange = state._chatSearchDateRange || 'any';
  const fromUserId = state._chatSearchFromUser || '';
  const senderUsers = getChatSearchSenderOptions(roomType, roomId);
  return `
    <div class="chat-search-view" data-room-type="${roomType}" data-room-id="${roomId}">
      <div class="chat-search-top">
        <div class="chat-search-fields">
          <div class="chat-search-row">
            <input type="search" id="chat-search-query" placeholder="${tx('searchMessages', 'Search messages')}" value="${escapeHtml(state._chatSearchQuery || '')}" />
            <button type="button" class="chat-search-run icon-btn" title="${tx('search', 'Search')}"><span class="icon" aria-hidden="true">${ICON_SEARCH_SM}</span></button>
          </div>
          <div class="chat-search-filters">
            <label class="chat-search-field">
              <span class="chat-search-label">${tx('searchFromLabel', 'From')}</span>
              <select id="chat-search-from" class="chat-search-select">
                <option value="" ${fromUserId === '' ? 'selected' : ''}>${tx('searchFromAnyone', 'Anyone')}</option>
                ${senderUsers.map((u) => `<option value="${escapeHtml(u.id)}" ${fromUserId === u.id ? 'selected' : ''}>${escapeHtml(u.display_name || u.username || u.id)}${u.username ? ` (@${escapeHtml(u.username)})` : ''}</option>`).join('')}
              </select>
            </label>
            <label class="chat-search-field">
              <span class="chat-search-label">${tx('searchWhenLabel', 'When')}</span>
              <select id="chat-search-daterange" class="chat-search-select">
                ${dateRanges.map(([val, label]) => `<option value="${val}" ${val === selectedRange ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
              </select>
            </label>
            <label class="chat-search-field">
              <span class="chat-search-label">${tx('searchAttachLabel', 'Attachment')}</span>
              <select id="chat-search-attachment" class="chat-search-select">
                ${types.map(([val, label]) => `<option value="${val}" ${val === attachmentType ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
              </select>
            </label>
          </div>
          ${selectedRange === 'custom' ? `
          <div class="chat-search-filters chat-search-custom-dates">
            <label class="chat-search-field">
              <span class="chat-search-label">${tx('searchDateAfter', 'After')}</span>
              <input type="date" id="chat-search-after" value="${escapeHtml(state._chatSearchAfter || '')}" />
            </label>
            <label class="chat-search-field">
              <span class="chat-search-label">${tx('searchDateBefore', 'Before')}</span>
              <input type="date" id="chat-search-before" value="${escapeHtml(state._chatSearchBefore || '')}" />
            </label>
          </div>
          ` : ''}
          <div class="chat-search-actions">
            <button type="button" class="chat-search-reset btn-secondary btn-small" title="${tx('searchReset', 'Reset')}">${tx('searchReset', 'Reset')}</button>
          </div>
        </div>
      </div>
      <div class="chat-search-results">
        ${loading ? `<div class="chat-search-empty">${t('loading')}</div>` : ''}
        ${!loading && !results.length ? `<div class="chat-search-empty">${tx('noSearchResults', 'No messages found.')}</div>` : ''}
        ${results.map((m) => `
          <div class="chat-search-result" data-msg-id="${m.id}">
            <div class="chat-search-result-meta">
              <strong>${escapeHtml(m.display_name || m.username || 'Unknown user')}</strong>
              <span>${escapeHtml(formatTimestampForDivider(m.created_at))}</span>
            </div>
            <div class="chat-search-result-body">${escapeHtml((m.content || '').slice(0, 300))}${(m.content || '').length > 300 ? '…' : ''}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/** Build the list of users that can be selected for the "From" filter in chat search. */
function getChatSearchSenderOptions(roomType, roomId) {
  const all = state.users || [];
  if (roomType === 'dm') {
    const otherId = state.convIdToUserId?.[roomId] || state.dmUserId;
    const ids = new Set([state.user?.id, otherId].filter(Boolean));
    return all.filter((u) => ids.has(u.id));
  }
  return all.filter((u) => !u.deleted_at);
}

/** Translate structured chat-search UI fields into the backend filter string. */
function buildChatSearchFilterString() {
  const parts = [];
  const fromId = state._chatSearchFromUser || '';
  if (fromId) {
    const u = (state.users || []).find((x) => x.id === fromId);
    const uname = u?.username || fromId;
    parts.push(`from:@${uname}`);
  }
  const range = state._chatSearchDateRange || 'any';
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  };
  const now = new Date();
  if (range === 'today') {
    const day = fmt(now);
    parts.push(`${day}~${day}`);
  } else if (range === 'week') {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    parts.push(`${fmt(start)}~${fmt(now)}`);
  } else if (range === 'month30') {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    parts.push(`${fmt(start)}~${fmt(now)}`);
  } else if (range === 'thismonth') {
    parts.push(`in ${now.getFullYear()}/${now.getMonth() + 1}`);
  } else if (range === 'thisyear') {
    parts.push(`in ${now.getFullYear()}`);
  } else if (range === 'custom') {
    const after = (state._chatSearchAfter || '').replace(/-/g, '/');
    const before = (state._chatSearchBefore || '').replace(/-/g, '/');
    if (after && before) parts.push(`${after}~${before}`);
    else if (after) parts.push(`after ${after}`);
    else if (before) parts.push(`before ${before}`);
  }
  return parts.join(' ').trim();
}

function applyRoute(route) {
  if (state.user && (route.page === 'login' || route.page === 'signup')) {
    navigateTo('/chat/group/');
    return;
  }
  if (!state.user && (route.page === 'login' || route.page === 'signup')) {
    render();
    return;
  }
  if (route.page === 'settings') {
    setState({ panel: '', dmUserId: null });
    render();
    bindSettings();
    return;
  }
  if (route.page === 'inbox') {
    setState({ panel: '', dmUserId: null, _loadingInbox: true });
    render();
    loadInbox().then(() => { state._loadingInbox = false; setState({}); render(); bindInbox(); }).catch((err) => {
      console.warn('Load inbox failed', err);
      state._loadingInbox = false;
      setState({});
      render();
      bindInbox();
      showToast(err.message || 'Failed to load inbox');
    });
    return;
  }
  if (route.page === 'collections') {
    setState({ panel: '', dmUserId: null });
    loadCollections().then(() => {
      render();
    }).catch((err) => {
      showToast(err.message || 'Failed to load collections');
      render();
    });
    return;
  }
  if (route.page === 'admin') {
    if (!state.user?.is_allowed) {
          navigateTo(getRedirectOrDefault());
      return;
    }
    setState({ panel: '', dmUserId: null });
    loadAdminBlacklist().then(() => {
      render();
      bindAdmin();
    });
    return;
  }
  if (route.page === 'chat') {
    state._chatSidePanelOpen = false;
    state._chatSidePanelTab = 'users';
    state._chatSearchLoading = false;
    state._chatSearchResults = [];
    state.panel = route.panel || 'free_chat';
    state.editingDocKey = null;
    state.dmUserId = route.dmUserId || null;
    state.convId = null;
    loadConversations().then(() => {
      if (route.section === 'dms') {
        setState({});
        render();
        return;
      }
    if (route.dmUserId) {
        if (route.view === 'profile') {
          state._profileView = { userId: route.dmUserId, profile: null, loading: true, error: null };
          state._privateUserView = false;
          render();
      apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
        state.convId = conversation_id;
            state.convByUserId[route.dmUserId] = conversation_id;
            state.convIdToUserId[conversation_id] = route.dmUserId;
            state.socket?.emit('dm:join', conversation_id, () => {});
            setState({});
          }).catch((err) => {
            if (isPrivateUserError(err)) {
              state._privateUserView = true;
              setState({});
              return;
            }
            state.convId = null;
          });
          apiGet(`/api/users/${encodeURIComponent(route.dmUserId)}/profile`).then(({ profile }) => {
            state._profileView = { userId: route.dmUserId, profile, loading: false, error: null };
            setState({});
          }).catch((err) => {
            if (isPrivateUserError(err)) {
              state._privateUserView = true;
              state._profileView = null;
              setState({});
              return;
            }
            state._profileView = { userId: route.dmUserId, profile: null, loading: false, error: err.message || 'Could not load profile' };
            setState({});
          });
        } else {
          state._profileView = null;
          state._privateUserView = false;
          apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
            state.convId = conversation_id;
            state.convByUserId[route.dmUserId] = conversation_id;
            state.convIdToUserId[conversation_id] = route.dmUserId;
            return loadMessages('dm', conversation_id).then(() => {
          state.socket?.emit('dm:join', conversation_id, () => {});
          render();
            });
          }).catch((err) => {
            if (isPrivateUserError(err)) {
              // Block the chat thread from loading. Show the private-user
              // notice in place of the message list.
              state._privateUserView = true;
              state.convId = null;
              render();
              return;
            }
            console.warn('Load conversation/messages failed', err);
            render();
          });
        }
      return;
    }
    state.convId = null;
    if (state.panel === 'voice_chat') {
        if (!state._voiceJoined) voiceJoin().then(() => render());
        else render();
      } else if (state.panel === 'free_chat' || state.panel === 'support') {
        loadMessages('group', state.panel).then(() => { render(); }).catch((err) => {
          console.warn('Load messages failed', err);
          render();
        });
      } else if (state.panel === 'problem_solving' || state.panel === 'rules' || state.panel === 'announcements') {
        const loadPanelDoc = () => loadDoc(state.panel).then(({ doc }) => {
        state._docContent = doc?.content ?? '';
        render();
      });
        if (state.panel === 'announcements') {
          apiPost('/api/docs/announcements/sync').then(() => loadPanelDoc(), () => loadPanelDoc());
    } else {
          loadPanelDoc().catch((err) => {
            console.warn('Load doc failed', err);
      render();
          });
        }
      } else {
        render();
      }
    }).catch((err) => {
      console.warn('Load conversations failed', err);
      if (route.section === 'dms') { setState({}); render(); return; }
      if (route.dmUserId) {
        if (route.view === 'profile') {
          state._profileView = { userId: route.dmUserId, profile: null, loading: true, error: null };
          render();
          apiGet(`/api/users/${encodeURIComponent(route.dmUserId)}/profile`).then(({ profile }) => {
            state._profileView = { userId: route.dmUserId, profile, loading: false, error: null };
            setState({});
          }).catch((err) => {
            state._profileView = { userId: route.dmUserId, profile: null, loading: false, error: err.message || 'Could not load profile' };
            setState({});
          });
        } else {
          state._profileView = null;
          apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
            state.convId = conversation_id;
            state.convByUserId[route.dmUserId] = conversation_id;
            state.convIdToUserId[conversation_id] = route.dmUserId;
            return loadMessages('dm', conversation_id).then(() => { state.socket?.emit('dm:join', conversation_id, () => {}); render(); });
          }).catch(() => { render(); });
        }
      } else {
        render();
      }
    });
  }
}

async function init() {
  if (!state.uiAnimations) document.documentElement.classList.add('no-animations');
  await loadTranslationData();
  const loadingEl = document.querySelector('.loading-text');
  if (loadingEl) loadingEl.textContent = t('loading');

  window.addEventListener('popstate', () => applyRoute(parseRoute()));

  // Single delegated listener for in-app links (do not re-attach on every render)
  const appEl = document.getElementById('app');
  if (appEl) {
    interceptLinks(appEl);
    bindLinkPreview(appEl);
    // Delegated listeners for expand/toggle: update state + toggle class on existing DOM (no setState)
    // so first click works and CSS transition/animation run on the same element
    appEl.addEventListener('click', (e) => {
      const toggle = e.target.closest('#panel-column-toggle');
      const expand = e.target.closest('#left-bar-expand');
      const overlay = e.target.closest('#panel-column-overlay');
      if (toggle) {
        e.preventDefault();
        state.panelColumnExpanded = !state.panelColumnExpanded;
        const panel = document.getElementById('panel-column');
        if (panel) panel.classList.toggle('panel-column-expanded', state.panelColumnExpanded);
        const btn = document.getElementById('panel-column-toggle');
        if (btn) {
          btn.title = state.panelColumnExpanded ? 'Close panels' : 'Open panels';
          btn.setAttribute('aria-label', btn.title);
          const icon = btn.querySelector('.left-bar-icon');
          if (icon) icon.innerHTML = state.panelColumnExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT;
        }
      } else if (expand) {
        e.preventDefault();
        state.leftBarExpanded = !state.leftBarExpanded;
        try { localStorage.setItem('leftBarExpanded', state.leftBarExpanded ? '1' : '0'); } catch (_) {}
        const bar = document.getElementById('left-bar');
        if (bar) bar.classList.toggle('left-bar-expanded', state.leftBarExpanded);
        const expandBtn = document.getElementById('left-bar-expand');
        if (expandBtn) {
          expandBtn.title = state.leftBarExpanded ? 'Collapse' : 'Expand';
          const icon = expandBtn.querySelector('.left-bar-icon');
          const label = expandBtn.querySelector('.left-bar-label');
          if (icon) icon.innerHTML = state.leftBarExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT;
          if (label) label.textContent = state.leftBarExpanded ? 'Collapse' : 'Expand';
        }
      } else if (overlay) {
        e.preventDefault();
        state.panelColumnExpanded = false;
        const panel = document.getElementById('panel-column');
        if (panel) panel.classList.remove('panel-column-expanded');
        const btn = document.getElementById('panel-column-toggle');
        if (btn) {
          btn.title = 'Open panels';
          btn.setAttribute('aria-label', 'Open panels');
          const icon = btn.querySelector('.left-bar-icon');
          if (icon) icon.innerHTML = ICON_CHEVRON_RIGHT;
        }
      }
      const collectionsRemove = e.target.closest('.collection-remove');
      if (collectionsRemove) {
        e.preventDefault();
        const id = collectionsRemove.dataset.id;
        if (!id) return;
        apiDelete(`/api/collections/${encodeURIComponent(id)}`).then(() => {
          state.collections = (state.collections || []).filter(c => c.id !== id);
          setState({});
        }).catch((err) => showToast(err.message || 'Failed to remove from collection'));
        return;
      }
      const collectionsOpen = e.target.closest('.collection-open');
      if (collectionsOpen) {
        e.preventDefault();
        const messageId = collectionsOpen.dataset.messageId;
        const item = (state.collections || []).find((c) => c.message_id === messageId);
        if (!item) return;
        if (item.room_type === 'dm') {
          const otherId = state.convIdToUserId?.[item.room_id];
          if (otherId) navigateTo(`/chat/${encodeURIComponent(otherId)}`);
          else showToast('Open the DM from Chats first');
        } else {
          navigateTo(`/chat/group/?panel=${encodeURIComponent(PANEL_TO_URL[item.room_id] || item.room_id)}`);
        }
        return;
      }
      // Moderation queue: survives render() from loadModerationQueue (bindAdmin is not re-run each render).
      const modStatusBtn = e.target.closest('button[data-mod-status]');
      if (modStatusBtn && state.user?.is_allowed) {
        const status = modStatusBtn.dataset.modStatus;
        if (status) {
          e.preventDefault();
          loadModerationQueue(status, state._modReports?.search || '');
          return;
        }
      }
      const modActionBtn = e.target.closest('[data-mod-action]');
      if (modActionBtn && state.user?.is_allowed) {
        const action = modActionBtn.dataset.modAction;
        const reportId = modActionBtn.dataset.reportId;
        if (!action || !reportId) return;
        if (action === 'view') {
          e.preventDefault();
          showModerationDetailModal(reportId);
          return;
        }
        if (action === 'jump') {
          e.preventDefault();
          const messageId = modActionBtn.dataset.messageId;
          const rType = modActionBtn.dataset.roomType;
          const rId = modActionBtn.dataset.roomId;
          if (!messageId) return;
          const card = modActionBtn.closest('[data-report-id]');
          void navigateToReportedMessage({
            report_id: reportId,
            message_id: messageId,
            room_type: rType,
            room_id: rId,
            target_user_id: card?.dataset?.targetId || null,
            reporter_id: card?.dataset?.reporterId || null,
          });
          return;
        }
        e.preventDefault();
        void (async () => {
          try {
            if (action === 'claim') {
              await apiPatch(`/api/reports/${reportId}`, { assign_to_me: true, status: 'in_review' });
            } else if (action === 'resolve') {
              await apiPatch(`/api/reports/${reportId}`, { status: 'resolved', outcome: 'reviewed' });
            } else if (action === 'reject') {
              await apiPatch(`/api/reports/${reportId}`, { status: 'rejected', outcome: 'no_action' });
            } else if (action === 'duplicate') {
              await apiPatch(`/api/reports/${reportId}`, { status: 'duplicate', outcome: 'duplicate' });
            }
            await loadReportCounts();
            await loadModerationQueue(state._modReports?.status || 'open', state._modReports?.search || '');
            showToast(tx('modActionDone', 'Report updated.'), 'success');
          } catch (err) {
            showToast(err.message || 'Failed to update report');
          }
        })();
        return;
      }
      // Admin timeout form: searchable user picker + duration chips. All
      // interactions are delegated so they survive re-renders.
      // First, close any open picker when the user clicks outside the picker
      // (e.g. on a chip, submit button, scope radio, or empty space) so the
      // dropdown doesn't linger after the admin moves on.
      if (!e.target.closest('.admin-user-picker')) {
        const open = document.querySelectorAll('.admin-user-picker-panel:not([hidden])');
        if (open.length) {
          open.forEach((p) => p.setAttribute('hidden', ''));
          document.querySelectorAll('[data-action="timeout-open-picker"][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
        }
      }
      const pickerTrigger = e.target.closest('[data-action="timeout-open-picker"]');
      if (pickerTrigger) {
        e.preventDefault();
        const picker = pickerTrigger.closest('.admin-user-picker');
        if (!picker) return;
        const panel = picker.querySelector('.admin-user-picker-panel');
        if (!panel) return;
        const willOpen = panel.hasAttribute('hidden');
        // Close any other open pickers on the page first.
        document.querySelectorAll('.admin-user-picker-panel:not([hidden])').forEach((p) => {
          if (p !== panel) p.setAttribute('hidden', '');
        });
        document.querySelectorAll('[data-action="timeout-open-picker"][aria-expanded="true"]').forEach((b) => {
          if (b !== pickerTrigger) b.setAttribute('aria-expanded', 'false');
        });
        if (willOpen) {
          panel.removeAttribute('hidden');
          pickerTrigger.setAttribute('aria-expanded', 'true');
          const search = panel.querySelector('.admin-user-picker-search-input');
          if (search) {
            search.value = '';
            // Reset visibility from any prior filter.
            panel.querySelectorAll('.admin-user-picker-item').forEach((i) => { i.hidden = false; });
            const empty = panel.querySelector('.admin-user-picker-empty');
            if (empty) empty.hidden = true;
            requestAnimationFrame(() => { try { search.focus(); } catch (_) {} });
          }
        } else {
          panel.setAttribute('hidden', '');
          pickerTrigger.setAttribute('aria-expanded', 'false');
        }
        return;
      }
      const pickerItem = e.target.closest('.admin-user-picker-item');
      if (pickerItem) {
        e.preventDefault();
        const userId = pickerItem.dataset.userId || '';
        const formState = getTimeoutFormState();
        formState.userId = userId;
        const form = pickerItem.closest('.admin-timeout-form');
        const panel = pickerItem.closest('.admin-user-picker-panel');
        const trigger = form?.querySelector('[data-action="timeout-open-picker"]');
        const hidden = form?.querySelector('input[id^="admin-timeout-user"]');
        if (hidden) hidden.value = userId;
        if (panel) panel.setAttribute('hidden', '');
        if (trigger) {
          trigger.setAttribute('aria-expanded', 'false');
          const u = (state.users || []).find((x) => x.id === userId);
          if (u) {
            const av = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : getDefaultAvatarUrl(u.id);
            const fallback = getDefaultAvatarUrl(u.id);
            trigger.classList.add('admin-user-picker-trigger-filled');
            trigger.innerHTML = `
              <img class="admin-user-picker-trigger-avatar" src="${escapeHtml(av)}" data-fallback="${escapeHtml(fallback)}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
              <span class="admin-user-picker-trigger-label">
                <span class="admin-user-picker-trigger-name">${escapeHtml(u.display_name || u.username || u.id)}</span>
                <span class="admin-user-picker-trigger-handle">@${escapeHtml(u.username || u.id)}</span>
              </span>
              <span class="admin-user-picker-trigger-caret" aria-hidden="true">${ICON_CHEVRON_DOWN_SM}</span>
            `;
          }
        }
        // Refresh active states + check icons in the list.
        if (panel) {
          panel.querySelectorAll('.admin-user-picker-item').forEach((it) => {
            const isActive = it.dataset.userId === userId;
            it.classList.toggle('active', isActive);
            it.setAttribute('aria-selected', isActive ? 'true' : 'false');
            const existingCheck = it.querySelector('.admin-user-picker-item-check');
            if (isActive && !existingCheck) {
              const span = document.createElement('span');
              span.className = 'admin-user-picker-item-check';
              span.setAttribute('aria-hidden', 'true');
              span.innerHTML = ICON_CHECK_SM;
              it.appendChild(span);
            } else if (!isActive && existingCheck) {
              existingCheck.remove();
            }
          });
        }
        return;
      }
      const durationChip = e.target.closest('.admin-duration-chip[data-duration]');
      if (durationChip) {
        e.preventDefault();
        const value = durationChip.dataset.duration || '';
        const formState = getTimeoutFormState();
        formState.duration = value;
        const form = durationChip.closest('.admin-timeout-form');
        if (!form) return;
        form.querySelectorAll('.admin-duration-chip').forEach((c) => c.classList.toggle('active', c === durationChip));
        const hidden = form.querySelector('input[id^="admin-timeout-duration"]');
        if (hidden) hidden.value = value;
        const customRow = form.querySelector('.admin-duration-custom');
        if (customRow) {
          if (value === 'custom') {
            customRow.removeAttribute('hidden');
            requestAnimationFrame(() => { try { customRow.querySelector('.admin-duration-custom-num')?.focus(); } catch (_) {} });
          } else {
            customRow.setAttribute('hidden', '');
          }
        }
        return;
      }
      const submitBtn = e.target.closest('[data-action="timeout-submit"]');
      if (submitBtn) {
        e.preventDefault();
        submitTimeoutForm(submitBtn);
        return;
      }
    });
    // Close any open user picker on Escape.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('.admin-user-picker-panel:not([hidden])');
      if (!open.length) return;
      open.forEach((p) => p.setAttribute('hidden', ''));
      document.querySelectorAll('[data-action="timeout-open-picker"][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    });
    // Track scope radio + custom-unit select changes for the timeout form.
    appEl.addEventListener('change', (e) => {
      const scopeRadio = e.target.closest('input[data-action="timeout-scope"]');
      if (scopeRadio && scopeRadio.checked) {
        const formState = getTimeoutFormState();
        formState.scope = scopeRadio.value === 'dm' ? 'dm' : 'group';
        return;
      }
      const customUnit = e.target.closest('select[data-action="timeout-custom-unit"]');
      if (customUnit) {
        const formState = getTimeoutFormState();
        formState.customUnit = ['minute', 'hour', 'day', 'week'].includes(customUnit.value) ? customUnit.value : 'minute';
        return;
      }
    });
    // Delegated input listeners for admin search boxes. These survive re-renders
    // (e.g. socket-driven render() calls like presence:snapshot or permissions:changed)
    // because #app itself is never replaced — only its children are.
    let _adminAuditSearchTimer = null;
    let _modQueueSearchTimer = null;
    appEl.addEventListener('input', (e) => {
      const target = e.target;
      if (!target) return;
      if (target.id === 'admin-user-search') {
        const value = target.value;
        state._adminUserSearch = value;
        applyAdminUserSearchFilter(value);
        return;
      }
      if (target.id === 'admin-audit-search') {
        const value = target.value;
        state._adminAuditSearch = value;
        clearTimeout(_adminAuditSearchTimer);
        _adminAuditSearchTimer = setTimeout(() => {
          loadAdminAudit(value);
        }, 250);
        return;
      }
      if (target.id === 'mod-queue-search') {
        const value = target.value;
        if (!state._modReports) state._modReports = { items: [], status: 'open', search: '', loading: false };
        state._modReports.search = value;
        clearTimeout(_modQueueSearchTimer);
        _modQueueSearchTimer = setTimeout(() => {
          loadModerationQueue(state._modReports?.status || 'open', value);
        }, 250);
        return;
      }
      if (target.dataset?.action === 'timeout-search-users') {
        const panel = target.closest('.admin-user-picker-panel');
        if (!panel) return;
        const q = String(target.value || '').trim().toLowerCase();
        let visible = 0;
        panel.querySelectorAll('.admin-user-picker-item').forEach((item) => {
          const haystack = item.dataset.haystack || '';
          const match = !q || haystack.includes(q);
          item.hidden = !match;
          if (match) visible += 1;
        });
        const empty = panel.querySelector('.admin-user-picker-empty');
        if (empty) empty.hidden = visible !== 0;
        return;
      }
      if (target.dataset?.action === 'timeout-custom-num') {
        const formState = getTimeoutFormState();
        formState.customNum = String(target.value || '');
        return;
      }
    });
  }

  const user = await loadMe();
  const route = parseRoute();

  if (!user) {
    if (route.page !== 'login' && route.page !== 'signup') {
      navigateTo(authPath('login', getPath()));
      return;
    }
    render();
    return;
  }

  try {
  await loadGroup();
  await loadUsers();
    await loadBlocks();
    await loadInbox();
    await loadFriends();
    await loadPendingFriendRequests();
    await loadNotificationPrefs();
    bindPushLifecycle();
    syncPushSubscription().catch(() => {});
    await loadMyTimeouts();
    if (state.user?.is_allowed) loadReportCounts().catch(() => {});
  connectSocket();
    loadAgentMode();
    loadAgentSessions();
    initAutoUpdate();
    apiGet('/api/voice/participants').then(({ participants }) => {
      state._voiceParticipantCount = (participants || []).length;
    }).catch(() => {});
    apiGet('/api/chatbox-styles').then(({ styles }) => {
      state._chatboxStyles = styles || [];
      if (state.panel === 'settings') render();
    }).catch(() => {});
    maybeAskNotificationPermission();
    if (!window._notifModalCheckBound) {
      window._notifModalCheckBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') ensureNotificationPermissionModalVisible();
      });
      setInterval(ensureNotificationPermissionModalVisible, 10000);
    }

  const path = getPath();
  if (path === '/' || path === '') {
      navigateTo(getRedirectOrDefault());
    return;
  }
  applyRoute(route);
  postActiveRoomToPush();

  // Opening the chat app from Home or Contacts prompts for which link to use
  // (Primary = discord.jimmyqrg.com, Secondary = jchat.fly.dev). Shown once per
  // app open, after the shell has mounted so the modal sits above real content.
  if (!window._chooseLinkShown) {
    window._chooseLinkShown = true;
    const r = parseRoute();
    const onHomeOrContacts = r.page === 'chat' && !r.dmUserId;
    if (onHomeOrContacts) showChooseLinkModal();
  }
  } catch (err) {
    if (err?.status === 401 && typeof window !== 'undefined' && window.self !== window.top) {
      state.user = null;
      state.authError = 'App is in an iframe but the session cookie was not sent. Ensure the server allows iframe embedding (ALLOW_IFRAME is not "false") and the app is served over HTTPS. Some browsers block third-party cookies in iframes.';
      navigateTo(authPath('login', getPath()));
      return;
    }
    throw err;
  }
}

function showDndCityModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal dnd-modal" style="max-width: 320px;">
      <h3>${t('dndEnterCity')}</h3>
      <p class="modal-hint">${t('dndCityHint')}</p>
      <input type="text" id="dnd-city-input" placeholder="${t('dndCityPlaceholder')}" style="width:100%;margin:0.5rem 0;padding:0.5rem;border:var(--border-width) solid var(--border);border-radius:6px;background:var(--bg-main);color:var(--text)" />
      <div class="modal-actions">
        <button type="button" id="dnd-city-cancel" class="modal-close"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${t('dndCancel')}</button>
        <button type="button" id="dnd-city-ok" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>${t('dndSet')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#dnd-city-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#dnd-city-ok')?.addEventListener('click', async () => {
    const input = overlay.querySelector('#dnd-city-input');
    const city = input?.value?.trim();
    if (!city) return;
    const ok = await resolveDndTimezoneFromCity(city);
    overlay.remove();
    if (ok) render();
  });
  const onEscape = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEscape); } };
  document.addEventListener('keydown', onEscape);
  overlay.querySelector('#dnd-city-input')?.focus();
}

function showDndModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal dnd-modal" style="max-width: 320px;">
      <h3>${t('doNotDisturb')}</h3>
      <div class="dnd-modal-inputs">
        <label><span>${t('dndDays')}</span><input type="number" id="dnd-days" min="0" value="0" /></label>
        <label><span>${t('dndHours')}</span><input type="number" id="dnd-hours" min="0" value="0" /></label>
        <label><span>${t('dndMinutes')}</span><input type="number" id="dnd-minutes" min="0" value="0" /></label>
        <label><span>${t('dndSeconds')}</span><input type="number" id="dnd-seconds" min="0" value="0" /></label>
      </div>
      <div class="modal-actions">
        <button type="button" id="dnd-modal-cancel" class="modal-close"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${t('dndCancel')}</button>
        <button type="button" id="dnd-modal-set" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_CHECK_SM}</span>${t('dndSet')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#dnd-modal-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#dnd-modal-set')?.addEventListener('click', async () => {
    const days = Math.max(0, parseInt(overlay.querySelector('#dnd-days')?.value || '0', 10));
    const hours = Math.max(0, parseInt(overlay.querySelector('#dnd-hours')?.value || '0', 10));
    const minutes = Math.max(0, parseInt(overlay.querySelector('#dnd-minutes')?.value || '0', 10));
    const seconds = Math.max(0, parseInt(overlay.querySelector('#dnd-seconds')?.value || '0', 10));
    const totalMs = (days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000;
    if (totalMs <= 0) { overlay.remove(); return; }
    const dnd_until = Date.now() + totalMs;
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { dnd_until });
      overlay.remove();
      render();
    } catch (_) {}
  });
  const onEscape = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEscape); } };
  document.addEventListener('keydown', onEscape);
}

function showPasswordModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width: 400px;">
      <h3>${t('changePassword')}</h3>
      <p class="modal-hint">${t('changePasswordDesc')}</p>
      <form id="password-modal-form">
        <label>${t('currentPassword')}</label>
        <input type="password" name="current_password" autocomplete="current-password" placeholder="${t('currentPassword')}" />
        <label>${t('newPassword')}</label>
        <input type="password" name="new_password" autocomplete="new-password" placeholder="${t('atLeast6')}" />
        <label>${t('confirmNewPassword')}</label>
        <input type="password" name="new_password_confirm" autocomplete="new-password" placeholder="${t('confirmNewPasswordPlaceholder')}" />
        <p id="password-modal-message" class="settings-form-message" aria-live="polite"></p>
        <div class="modal-actions">
          <button type="button" id="password-modal-cancel" class="modal-close"><span class="icon" aria-hidden="true">${ICON_X_SM}</span>${t('cancel')}</button>
          <button type="submit" class="btn-primary"><span class="icon" aria-hidden="true">${ICON_KEY_SM}</span>${t('changePassword')}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#password-modal-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#password-modal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const msgEl = overlay.querySelector('#password-modal-message');
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn?.disabled) return;
    const currentInput = form.querySelector('input[name="current_password"]');
    const newInput = form.querySelector('input[name="new_password"]');
    const confirmInput = form.querySelector('input[name="new_password_confirm"]');
    const current = (currentInput?.value ?? '').trim();
    const newPass = (newInput?.value ?? '').trim();
    const confirm = (confirmInput?.value ?? '').trim();
    if (!current || !newPass) {
      if (msgEl) { msgEl.textContent = t('fillCurrentNew'); msgEl.dataset.type = 'error'; }
      return;
    }
    if (newPass.length < 6) {
      if (msgEl) { msgEl.textContent = t('newPasswordMin'); msgEl.dataset.type = 'error'; }
      return;
    }
    if (newPass !== confirm) {
      if (msgEl) { msgEl.textContent = t('newPasswordMismatch'); msgEl.dataset.type = 'error'; }
      return;
    }
    if (msgEl) msgEl.textContent = '';
    if (submitBtn) submitBtn.disabled = true;
    try {
      const payload = { current_password: current, new_password: newPass };
      await apiPatch('/api/users/password', payload);
      if (msgEl) { msgEl.textContent = t('passwordChanged'); msgEl.dataset.type = 'success'; }
      form.reset();
      setTimeout(() => overlay.remove(), 800);
    } catch (err) {
      if (msgEl) { msgEl.textContent = err.message || t('failedChangePassword'); msgEl.dataset.type = 'error'; }
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function bindSettings() {
  document.getElementById('chatbox-picker')?.addEventListener('click', async (e) => {
    const item = e.target.closest('.chatbox-picker-item');
    if (!item) return;
    const style = item.dataset.style;
    try {
      const { user } = await apiPatch('/api/users/profile', { chatbox_style: style });
      if (state.user) state.user.chatbox_style = user.chatbox_style || 'default';
      render();
      bindSettings();
    } catch (_) {}
  });
  document.getElementById('settings-language')?.addEventListener('change', (e) => {
    const lang = e.target.value;
    state.language = lang;
    if (typeof localStorage !== 'undefined') localStorage.setItem('language', lang);
    if (document.documentElement) document.documentElement.setAttribute('lang', lang);
    setState({});
    render();
  });
  document.getElementById('settings-ui-animations')?.addEventListener('change', (e) => {
    state.uiAnimations = !!e.target.checked;
    if (typeof localStorage !== 'undefined') localStorage.setItem('uiAnimations', state.uiAnimations ? '1' : '0');
    document.documentElement.classList.toggle('no-animations', !state.uiAnimations);
  });
  document.getElementById('settings-enter-to-send')?.addEventListener('change', (e) => {
    state.enterToSend = !!e.target.checked;
    if (typeof localStorage !== 'undefined') localStorage.setItem('enter_to_send', state.enterToSend ? '1' : '0');
  });
  document.getElementById('notif-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      const prefs = await apiPatch('/api/notifications/prefs', { enabled });
      state.notificationPrefs = prefs;
      document.getElementById('notif-triggers')?.style.setProperty('opacity', enabled ? '1' : '0.5');
      document.getElementById('notif-triggers')?.style.setProperty('pointer-events', enabled ? 'auto' : 'none');
      document.getElementById('notif-dnd')?.style.setProperty('opacity', enabled ? '1' : '0.5');
      document.getElementById('notif-dnd')?.style.setProperty('pointer-events', enabled ? 'auto' : 'none');
      if (enabled) Notification.requestPermission();
      syncPushSubscription().catch(() => {});
    } catch (_) {}
  });
  document.getElementById('notif-mails')?.addEventListener('change', async (e) => {
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { notify_mails: !!e.target.checked });
    } catch (_) {}
  });
  document.getElementById('notif-dm')?.addEventListener('change', async (e) => {
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { notify_dm: !!e.target.checked });
    } catch (_) {}
  });
  document.getElementById('notif-group')?.addEventListener('change', async (e) => {
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { notify_group: !!e.target.checked });
    } catch (_) {}
  });
  document.getElementById('notif-dnd-open')?.addEventListener('click', showDndModal);
  document.getElementById('notif-dnd-end-now')?.addEventListener('click', async () => {
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { dnd_until: null });
      render();
    } catch (_) {}
  });
  document.getElementById('notif-dnd-at-night')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { dnd_at_night: enabled });
      if (enabled && !getDndTimezone()) resolveDndTimezoneFromLocation().then(() => render());
    } catch (_) {}
  });
  document.getElementById('notif-dnd-use-location')?.addEventListener('click', async () => {
    const ok = await resolveDndTimezoneFromLocation();
    if (ok) render();
  });
  document.getElementById('notif-dnd-enter-city')?.addEventListener('click', showDndCityModal);
  document.getElementById('open-password-modal')?.addEventListener('click', showPasswordModal);
  document.getElementById('view-account-key-btn')?.addEventListener('click', showViewAccountKeyModal);
  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    state.user = null;
    state.socket?.disconnect();
    state.socket = null;
    navigateTo('/login');
  });
  document.getElementById('profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    if (state._pendingAvatarFile) {
      formData.set('avatar', state._pendingAvatarFile);
      state._pendingAvatarFile = null;
      if (state._pendingAvatarObjectUrl) {
        URL.revokeObjectURL(state._pendingAvatarObjectUrl);
        state._pendingAvatarObjectUrl = null;
      }
    }
    try {
      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        credentials: 'include',
        body: formData,
      });
      if (res.status === 401) {
        state.user = null;
        state.authError = 'Session expired. Please log in again.';
        navigateTo('/login');
        return;
      }
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {}
      if (!res.ok) throw new Error(data.error || res.statusText);
      state.user = data.user;
      state.user._avatarVersion = Date.now();
      setState({});
    } catch (err) {
      showToast(err.message);
    }
  });

  const profileForm = document.getElementById('profile-form');
  const avatarFileInput = profileForm?.querySelector('input[name="avatar"]');
  if (avatarFileInput) {
    avatarFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      if (state._pendingAvatarObjectUrl) URL.revokeObjectURL(state._pendingAvatarObjectUrl);
      state._pendingAvatarFile = file;
      state._pendingAvatarObjectUrl = URL.createObjectURL(file);
      const preview = document.getElementById('avatar-preview');
      if (preview) preview.src = state._pendingAvatarObjectUrl;
      setState({});
    });
  }

  const settingsAvatarDrop = document.getElementById('settings-avatar-drop-zone');
  if (settingsAvatarDrop) {
    ['dragenter', 'dragover'].forEach((ev) => {
      settingsAvatarDrop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) settingsAvatarDrop.classList.add('settings-avatar-drag-over');
      });
    });
    settingsAvatarDrop.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (!settingsAvatarDrop.contains(e.relatedTarget)) settingsAvatarDrop.classList.remove('settings-avatar-drag-over');
    });
    settingsAvatarDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      settingsAvatarDrop.classList.remove('settings-avatar-drag-over');
      const file = e.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      if (state._pendingAvatarObjectUrl) URL.revokeObjectURL(state._pendingAvatarObjectUrl);
      state._pendingAvatarFile = file;
      state._pendingAvatarObjectUrl = URL.createObjectURL(file);
      const preview = document.getElementById('avatar-preview');
      if (preview) preview.src = state._pendingAvatarObjectUrl;
      setState({});
    });
  }

}

function bindInbox() {
  document.getElementById('inbox-list')?.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.inbox-item-delete');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inboxId = deleteBtn.dataset.inboxId;
      if (!confirm(t('deleteMailConfirm'))) return;
      try {
        await apiDelete(`/api/inbox/${encodeURIComponent(inboxId)}`);
        await loadInbox();
        render();
        bindInbox();
      } catch (err) { showToast(err.message || 'Failed to delete'); }
      return;
    }
    const acceptBtn = e.target.closest('.inbox-accept-fr');
    const rejectBtn = e.target.closest('.inbox-reject-fr');
    if (acceptBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inboxId = acceptBtn.dataset.inboxId;
      try {
        await apiPost('/api/friends/accept', { inbox_id: inboxId });
        await loadInbox();
        await loadFriends();
        await loadPendingFriendRequests();
        render();
        bindInbox();
      } catch (err) { showToast(err.message); }
      return;
    }
    if (rejectBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inboxId = rejectBtn.dataset.inboxId;
      try {
        await apiPost('/api/friends/reject', { inbox_id: inboxId });
        await loadInbox();
        await loadPendingFriendRequests();
        render();
        bindInbox();
      } catch (err) { showToast(err.message); }
      return;
    }
    const reportJump = e.target.closest('.inbox-report-jump');
    const reportQueue = e.target.closest('.inbox-report-open-queue');
    if (reportJump || reportQueue) {
      e.preventDefault();
      e.stopPropagation();
      const itemEl = (reportJump || reportQueue).closest('.inbox-item');
      if (!itemEl) return;
      const inboxId = itemEl.dataset.id;
      const extraStr = itemEl.dataset.extra;
      let extra = {};
      try { extra = extraStr ? JSON.parse(extraStr) : {}; } catch (_) {}
      try { await fetch(`/api/inbox/${inboxId}/read`, { method: 'POST', credentials: 'include' }); } catch (_) {}
      if (reportJump && extra.message_id && extra.room_type && extra.room_id) {
        await navigateToReportedMessage(extra);
      } else if (reportQueue) {
        const reportId = reportQueue.dataset.reportId || extra.report_id;
        navigateTo('/chat/group/?panel=admin&tab=moderation');
        if (reportId) setTimeout(() => showModerationDetailModal?.(reportId), 200);
      }
      await loadInbox();
      return;
    }
    const item = e.target.closest('.inbox-item');
    if (!item) return;
    const id = item.dataset.id;
    const relatedId = item.dataset.related;
    const extraStr = item.dataset.extra;
    await fetch(`/api/inbox/${id}/read`, { method: 'POST', credentials: 'include' });
    await loadInbox();
    render();
    bindInbox();
    try {
      const extra = extraStr ? JSON.parse(extraStr) : {};
      if (extra.panel === 'problem_solving') navigateTo('/chat/group/?panel=problem');
      if (item.dataset.type === 'mod_report' && extra.message_id && extra.room_type && extra.room_id) {
        await navigateToReportedMessage(extra);
      }
    } catch (_) {}
  });
}

/**
 * Open the best view of a reported message for an admin.
 * - DMs: admin isn't a member of the conversation, so show a limited-scope
 *   context modal with the 10 nearest messages around the reported one.
 * - Group rooms: admin can view normally — navigate and jump to the message.
 */
async function navigateToReportedMessage(extra) {
  try {
    if (extra.room_type === 'dm') {
      if (!extra.report_id) {
        showToast('Missing report id');
        return;
      }
      await showReportContextModal(extra.report_id);
      return;
    }
    const panel = extra.room_id === 'free_chat' ? 'free_chat' : extra.room_id === 'support' ? 'support' : 'free_chat';
    navigateTo(`/chat/group/?panel=${encodeURIComponent(panel)}`);
    setTimeout(async () => {
      try {
        const ctx = getCurrentRoomContext();
        if (!ctx) return;
        await jumpToMessageInCurrentChat(extra.message_id, null, ctx.roomType, ctx.roomId);
      } catch (err) {
        showToast(err?.message || 'Could not jump to reported message');
      }
    }, 350);
  } catch (err) {
    showToast(err?.message || 'Could not open reported message');
  }
}

/** Format message content for the report context modal (short markdown + escape). */
function formatReportContextMessage(msg) {
  if (!msg) return '';
  if (msg.recalled_at) return `<em class="report-context-muted">${escapeHtml(tx('recalled', '[recalled message]'))}</em>`;
  if (msg.deleted_by_admin) return `<em class="report-context-muted">${escapeHtml(tx('deletedByAdmin', '[deleted by admin]'))}</em>`;
  if (msg.msg_type && msg.msg_type !== 'text') {
    const label = {
      image: '[Image]', video: '[Video]', audio: '[Audio]', voice: '[Voice]', gif: '[GIF]', file: '[File]',
    }[msg.msg_type] || `[${msg.msg_type}]`;
    const ref = (msg.content || '').trim();
    return `<span class="report-context-attach">${escapeHtml(label)}</span>${ref ? ` <code class="report-context-fileref">${escapeHtml(ref)}</code>` : ''}`;
  }
  return escapeHtml(msg.content || '').replace(/\n/g, '<br>');
}

function renderReportContextMessage(msg, isFocus) {
  const sender = escapeHtml(msg.display_name || msg.username || 'Unknown');
  const time = escapeHtml(formatTime(msg.created_at));
  return `
    <div class="report-context-message ${isFocus ? 'report-context-message-focus' : ''}">
      <div class="report-context-meta"><strong>${sender}</strong><span class="report-context-time">${time}</span></div>
      <div class="report-context-body">${formatReportContextMessage(msg)}</div>
    </div>
  `;
}

async function showReportContextModal(reportId) {
  let data = null;
  try {
    data = await apiGet(`/api/reports/${encodeURIComponent(reportId)}/context`);
  } catch (err) {
    showToast(err?.message || 'Failed to load report context');
    return;
  }
  if (!data) return;
  const before = data.before || [];
  const focus = data.focus;
  const after = data.after || [];
  const participants = data.conversation?.participants || [];
  const partLabel = participants
    .map((p) => p.display_name || p.username || p.id)
    .filter(Boolean)
    .join(' ↔ ');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal report-context-modal">
      <h3>${escapeHtml(tx('reportContextTitle', 'Reported message context'))}</h3>
      <p class="admin-section-desc">${escapeHtml(tx(
        'reportContextDesc',
        'Showing the 10 nearest messages around the reported one. Private DM history is not shown beyond this window.'
      ))}</p>
      ${partLabel ? `<p class="report-context-participants"><strong>${escapeHtml(tx('modCardRoom', 'Conversation'))}:</strong> ${escapeHtml(partLabel)}</p>` : ''}
      <div class="report-context-messages">
        ${before.length === 0 ? `<div class="report-context-empty">${escapeHtml(tx('reportContextNoBefore', 'No earlier messages in window.'))}</div>` : before.map((m) => renderReportContextMessage(m, false)).join('')}
        ${focus ? renderReportContextMessage(focus, true) : ''}
        ${after.length === 0 ? `<div class="report-context-empty">${escapeHtml(tx('reportContextNoAfter', 'No later messages in window.'))}</div>` : after.map((m) => renderReportContextMessage(m, false)).join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-close" id="report-context-close">${t('close') || 'Close'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#report-context-close')?.addEventListener('click', close);
  const onEsc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
  requestAnimationFrame(() => {
    const focusEl = overlay.querySelector('.report-context-message-focus');
    if (focusEl) focusEl.scrollIntoView({ block: 'center' });
  });
}

init();
