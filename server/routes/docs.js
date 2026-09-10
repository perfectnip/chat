import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, canEditDocs } from '../auth.js';
import { db } from '../db.js';
import { recordAuditLog } from '../audit.js';

const router = Router();
const EDITABLE_DOCS = ['problem_solving', 'rules', 'announcements'];

const PORTAL_ANNOUNCEMENT_URL = process.env.SYNC_KEY
  ? 'https://deepseek-proxy.ikunbeautiful.workers.dev/v1/portal-announcements'
  : 'https://perfectnip.github.io/?directly=1';

/** Grep: check if portal HTML contains the announcement sections. */
function portalHasAnnouncementContent(html) {
  return /Latest updates:\s*<\/p>[\s\S]*?<ul[^>]*>|History:?\s*<\/p>[\s\S]*?<ul[^>]*>/i.test(html);
}

/** Parse "Latest updates" and "History" list items from portal announcement HTML. Returns array of item strings (e.g. "Added Stickman Arena"). */
function parsePortalAnnouncementItems(html) {
  const items = [];
  const latestMatch = html.match(/Latest updates:\s*<\/p>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  if (latestMatch) {
    const lis = latestMatch[1].match(/<li>([\s\S]*?)<\/li>/g) || [];
    lis.forEach(li => items.push(li.replace(/<\/?li>/g, '').replace(/<[^>]+>/g, '').trim()));
  }
  const historyMatch = html.match(/History:?\s*<\/p>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  if (historyMatch) {
    const lis = historyMatch[1].match(/<li>([\s\S]*?)<\/li>/g) || [];
    lis.forEach(li => items.push(li.replace(/<\/?li>/g, '').replace(/<b>|<\/b>/gi, '**').replace(/<[^>]+>/g, '').trim()));
  }
  return items.filter(Boolean);
}

/** Extract items from a single jchat announcement entry. Handles both comma-separated names ("Added X, Y") and full-sentence items ("Fixed all games related to turbowarp, Released Magic Tiles 3"). */
function parseJchatEntryItems(entry) {
  const dateStripped = entry.replace(/^\*\*[\d/]+\*\*\s*/, '').replace(/\.$/, '').trim();
  if (!dateStripped) return [];
  return dateStripped.split(',').map(s => s.trim()).filter(Boolean);
}

/** Extract items from the first N entries in jchat announcements (newest first). Default 7 entries. */
function parseJchatEntriesItems(content, limit = 7) {
  const title = '# Announcements';
  let rest = content.startsWith(title) ? content.slice(title.length).trim() : content.trim();
  if (!rest) return [];
  const entries = rest.split(/\n\n+/).slice(0, limit);
  const allItems = [];
  for (const entry of entries) {
    allItems.push(...parseJchatEntryItems(entry));
  }
  return [...new Set(allItems)];
}

/** Check if portal item matches any jchat item. Compares both the full item text and the prefix-stripped version. */
function itemMatches(portalItem, jchatItems) {
  const full = portalItem.trim().toLowerCase();
  const stripped = portalItem.replace(/^(Added|Updated|Fixed|Released|Removed)\s+/i, '').trim().toLowerCase();
  const firstWord = stripped.split(/\s+/)[0] || '';
  return jchatItems.some(j => {
    const jn = j.toLowerCase().trim();
    const jnStripped = jn.replace(/^(added|updated|fixed|released|removed)\s+/i, '').trim();
    return full === jn || stripped === jnStripped || jn.includes(stripped) || stripped.includes(jn) || jn.includes(firstWord);
  });
}

/**
 * Core sync logic: fetches portal, diffs against current announcements doc,
 * inserts a new version if there are new items.
 * @param {string} [editorId] – user id to attribute the edit to (optional, defaults to 'system')
 * @returns {{ synced: boolean, reason?: string, version_id?: string, created_at?: number, newItems?: string[] }}
 */
export async function syncAnnouncementsFromPortal(editorId = 'system') {
  // doc_versions.editor_id has a FK to users(id). The auto-poll calls
  // us with editorId='system' (a literal string), which violates the
  // constraint and produces "FOREIGN KEY constraint failed" on every
  // poll where the portal actually has new items. Normalize: any
  // non-real-user editorId gets attributed to the seeded admin user
  // 'jimmyqrg', who has can_edit_docs and who the init-db seed already
  // uses for the same purpose.
  const SYSTEM_EDITOR = 'jimmyqrg';
  const effectiveEditor = (editorId && typeof editorId === 'string' && editorId !== 'system') ? editorId : SYSTEM_EDITOR;

  const headers = { 'User-Agent': 'JimmyQrg-Chat-Sync/1' };
  if (process.env.SYNC_KEY) headers['X-Sync-Key'] = process.env.SYNC_KEY;
  const resp = await fetch(PORTAL_ANNOUNCEMENT_URL, { headers });
  const html = await resp.text();
  if (!portalHasAnnouncementContent(html)) return { synced: false, reason: 'no_portal_content' };
  const portalItems = parsePortalAnnouncementItems(html);
  if (!portalItems.length) return { synced: false, reason: 'no_content' };

  const row = db.prepare(`
    SELECT id, content FROM doc_versions WHERE doc_key = 'announcements' ORDER BY created_at DESC LIMIT 1
  `).get();
  const currentContent = row?.content || '';
  const jchatItems = parseJchatEntriesItems(currentContent, 7);

  const newItems = portalItems.filter(p => !itemMatches(p, jchatItems));
  if (!newItems.length) return { synced: false, reason: 'already_present' };

  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyy = now.getFullYear();
  const dateLine = `**${mm}/${dd}/${yyyy}**`;
  const newEntry = `${dateLine} ${newItems.join(', ')}`;

  const title = '# Announcements\n\n';
  const rest = currentContent.startsWith(title) ? currentContent.slice(title.length) : currentContent;
  const updatedContent = title + newEntry + '\n\n' + rest;

  const id = randomUUID();
  const created = Date.now();
  db.prepare('INSERT INTO doc_versions (id, doc_key, content, editor_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'announcements', updatedContent, effectiveEditor, created);
  recordAuditLog('docs.sync_announcements', effectiveEditor, null, { new_items: newItems });
  return { synced: true, version_id: id, created_at: created, newItems };
}

/** Sync announcements doc with portal: only add NEW items not already in jchat. */
router.post('/announcements/sync', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!canEditDocs(user)) return res.status(403).json({ error: 'Not allowed to edit' });
  try {
    const result = await syncAnnouncementsFromPortal(user.id);
    res.json(result);
  } catch (err) {
    console.error('Announcements sync error:', err);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

router.get('/:docKey', requireAuth, (req, res) => {
  const { docKey } = req.params;
  if (!EDITABLE_DOCS.includes(docKey)) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare(`
    SELECT id, content, editor_id, created_at
    FROM doc_versions
    WHERE doc_key = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(docKey);
  res.json({ doc: row ? { content: row.content, version_id: row.id, editor_id: row.editor_id, created_at: row.created_at } : { content: '', version_id: null } });
});

router.put('/:docKey', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  if (!canEditDocs(user)) return res.status(403).json({ error: 'Not allowed to edit' });
  const { docKey } = req.params;
  if (!EDITABLE_DOCS.includes(docKey)) return res.status(404).json({ error: 'Not found' });
  const { content, support_message_id } = req.body || {};
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO doc_versions (id, doc_key, content, editor_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, docKey, typeof content === 'string' ? content : '', user.id, now);
  recordAuditLog('docs.edit', user.id, null, { doc_key: docKey, version_id: id, support_message_id: support_message_id || null });
  if (docKey === 'problem_solving' && support_message_id) {
    const msg = db.prepare('SELECT id, sender_id FROM messages WHERE id = ? AND room_type = ? AND room_id = ?').get(support_message_id, 'group', 'support');
    if (msg && msg.sender_id !== user.id) {
      const inboxId = randomUUID();
      db.prepare(`
        INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at)
        VALUES (?, ?, 'solved', 'Your problem is solved', 'A solution has been added to Problem Solving.', ?, ?, ?)
      `).run(inboxId, msg.sender_id, id, JSON.stringify({ panel: 'problem_solving', version_id: id, support_message_id }), now);
    }
  }
  res.json({ version_id: id, created_at: now });
});

router.get('/:docKey/versions', requireAuth, (req, res) => {
  const { docKey } = req.params;
  if (!EDITABLE_DOCS.includes(docKey)) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(`
    SELECT id, content, editor_id, created_at
    FROM doc_versions
    WHERE doc_key = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(docKey);
  res.json({ versions: rows });
});

export default router;
