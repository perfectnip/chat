import { Router } from 'express';
import { requireAuth, getCurrentUser, changePassword, canManageUsers } from '../auth.js';
import { db, GROUP_ID, isEmailBanned, isPrivateUser, canSeePrivateUser, PRIVATE_USER_BLOCKED } from '../db.js';
import { selectableChatboxStyles } from '../chatbox-styles.js';
import { upload } from '../upload.js';

const router = Router();
const PERM_COLS = 'can_send_inbox, can_broadcast, can_edit_docs, can_kick, can_delete_messages, can_manage_users, can_timeout, can_pin_messages, can_unlimited_edit_recall, can_see_whispers';

router.get('/', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const canSeeAllowed = me?.is_allowed;
  const canSeePerms = canManageUsers(me);
  const canSeeEmail = canSeePerms;
  const list = db.prepare(`
    SELECT id, username, display_name, avatar_url, chatbox_style, deleted_at${canSeeAllowed ? ', is_allowed' : ''}${canSeeEmail ? ', email' : ''}${canSeePerms ? `, ${PERM_COLS}` : ''}
    FROM users
    ORDER BY username
  `).all();
  // Drop private users unless the viewer is jimmyqrg. We do this in JS
  // (not SQL) so the response shape and field-stripping logic below stay
  // unchanged.
  const visible = (me?.id === 'jimmyqrg') ? list : list.filter((u) => !isPrivateUser(u.id));
  const users = visible.map(u => {
    const out = { ...u };
    out.deleted_at = u.deleted_at || null;
    if (!canSeeAllowed) delete out.is_allowed;
    else out.is_allowed = !!u.is_allowed;
    if (!canSeeEmail) delete out.email;
    if (canSeePerms) {
      out.can_send_inbox = !!u.can_send_inbox;
      out.can_broadcast = !!u.can_broadcast;
      out.can_edit_docs = !!u.can_edit_docs;
      out.can_kick = !!u.can_kick;
      out.can_delete_messages = !!u.can_delete_messages;
      out.can_manage_users = !!u.can_manage_users;
      out.can_timeout = !!u.can_timeout;
      out.can_pin_messages = !!u.can_pin_messages;
      out.can_unlimited_edit_recall = !!u.can_unlimited_edit_recall;
      out.can_see_whispers = !!u.can_see_whispers;
    } else {
      PERM_COLS.split(', ').forEach(c => delete out[c]);
    }
    return out;
  });
  res.json({ users });
});

router.get('/profile', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user });
});

/** GET /api/users/mention-search?q=&room_type=&limit= — autocomplete for @ mentions. */
router.get('/mention-search', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 10);
  let rows = db.prepare(`
    SELECT id, username, display_name, avatar_url, is_allowed
    FROM users
    WHERE deleted_at IS NULL AND id != ?
    ORDER BY username
  `).all(me?.id || '');
  // Private users don't appear in @-mention autocomplete for anyone but jimmyqrg.
  if (me?.id !== 'jimmyqrg') rows = rows.filter((u) => !isPrivateUser(u.id));
  if (q) {
    rows = rows.filter((u) => {
      const uname = String(u.username || '').toLowerCase();
      const dname = String(u.display_name || '').toLowerCase();
      return uname.startsWith(q) || dname.includes(q);
    });
  }
  const trimmed = rows.slice(0, limit).map((u) => ({
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    is_allowed: !!u.is_allowed,
  }));
  const tokens = [];
  if (!q || 'all'.startsWith(q)) tokens.push({ token: 'all', label: 'Everyone in this room' });
  if (!q || 'admins'.startsWith(q)) tokens.push({ token: 'admins', label: 'All admins' });
  res.json({ users: trimmed, tokens });
});

/** Public profile for viewing another user (id, username, display_name, avatar_url, website, profile_links). */
router.get('/:id/profile', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  if (!canSeePrivateUser(me, req.params.id)) {
    return res.status(403).json(PRIVATE_USER_BLOCKED);
  }
  const target = db.prepare(
    'SELECT id, username, display_name, avatar_url, chatbox_style, website, profile_links, description FROM users WHERE id = ?'
  ).get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const profile = {
    id: target.id,
    username: target.username,
    display_name: target.display_name,
    avatar_url: target.avatar_url,
    website: target.website || null,
    profile_links: target.profile_links ? JSON.parse(target.profile_links) : null,
    description: target.description || null,
    chatbox_style: target.chatbox_style || 'default'
  };
  res.json({ profile });
});

router.patch('/profile', requireAuth, upload.single('avatar'), (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { display_name, website, profile_links, description, chatbox_style, email } = req.body || {};
  let avatar_url = user.avatar_url;
  if (req.file) avatar_url = `/uploads/${req.file.filename}`;
  const RESERVED_NAMES = ['helper', 'venory'];
  const name = typeof display_name === 'string' && display_name.trim() ? display_name.trim().slice(0, 64) : null;
  if (name !== null && RESERVED_NAMES.includes(name.toLowerCase())) return res.status(400).json({ error: 'That display name is reserved' });
  const web = typeof website === 'string' ? website.trim().slice(0, 512) : null;
  const links = profile_links != null ? (typeof profile_links === 'string' ? profile_links : JSON.stringify(profile_links)) : null;
  const desc = description !== undefined ? (typeof description === 'string' ? description.trim().slice(0, 1024) : null) : undefined;
  const cbStyle = typeof chatbox_style === 'string' ? chatbox_style.trim().slice(0, 64) : null;
  // Chatbox style gate: only styles the requesting user may select are
  // accepted (experimental styles are jimmyqrg-only while in testing).
  if (cbStyle !== null && !selectableChatboxStyles(user).includes(cbStyle)) {
    return res.status(400).json({ error: 'That chatbox style is not available' });
  }
  // Email is opt-in: only treated as an update when the client explicitly sends
  // the field. An empty string clears it; anything else has to look like an
  // email and not collide with another account. Existing chat accounts that
  // pre-date the email column have NULL stored here, so this lets the games-
  // site profile UI fill in the gap and unblock email-based sign-in.
  let mail = undefined;
  if (typeof email === 'string') {
    const trimmed = email.trim();
    if (trimmed === '') {
      mail = null;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'Valid email required' });
    } else if (isEmailBanned(trimmed)) {
      return res.status(400).json({ error: 'This email address has been permanently banned.' });
    } else {
      const lower = trimmed.toLowerCase().slice(0, 255);
      const existing = db.prepare('SELECT id FROM users WHERE email IS NOT NULL AND LOWER(email) = LOWER(?) AND id != ?').get(lower, user.id);
      if (existing) return res.status(400).json({ error: 'Email already registered to another account' });
      mail = lower;
    }
  }
  if (name !== null || req.file || web !== null || links !== null || desc !== undefined || cbStyle !== null || mail !== undefined) {
    const updates = [];
    const values = [];
    if (name !== null) { updates.push('display_name = ?'); values.push(name); }
    if (req.file || avatar_url !== undefined) { updates.push('avatar_url = ?'); values.push(avatar_url || null); }
    if (web !== null) { updates.push('website = ?'); values.push(web); }
    if (links !== null) { updates.push('profile_links = ?'); values.push(links); }
    if (desc !== undefined) { updates.push('description = ?'); values.push(desc); }
    if (cbStyle !== null) { updates.push('chatbox_style = ?'); values.push(cbStyle); }
    if (mail !== undefined) { updates.push('email = ?'); values.push(mail); }
    if (updates.length) {
      values.push(user.id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
  }
  const updated = db.prepare('SELECT id, username, display_name, avatar_url, chatbox_style, website, profile_links, description, email, is_allowed FROM users WHERE id = ?').get(user.id);
  const out = { ...updated, is_allowed: !!updated.is_allowed };
  if (out.profile_links && typeof out.profile_links === 'string') out.profile_links = JSON.parse(out.profile_links);
  res.json({ user: out });
});

router.patch('/password', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const current_password = typeof body.current_password === 'string' ? body.current_password.trim() : '';
  const new_password = typeof body.new_password === 'string' ? body.new_password.trim() : '';
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current password and new password required' });
  const result = await changePassword(user.id, current_password, new_password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

router.patch('/me', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { memory_message_length } = body;
  if (memory_message_length !== undefined) {
    const num = parseInt(memory_message_length, 10);
    if (isNaN(num) || num < 1 || num > 100) {
      return res.status(400).json({ error: 'memory_message_length must be between 1 and 100' });
    }
    db.prepare('UPDATE users SET memory_message_length = ? WHERE id = ?').run(num, user.id);
  }
  const updated = db.prepare('SELECT id, username, display_name, avatar_url, memory_message_length FROM users WHERE id = ?').get(user.id);
  res.json({ user: updated });
});

export default router;
