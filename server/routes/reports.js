import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, isAllowed, canSeeWhispers } from '../auth.js';
import { db } from '../db.js';
import { recordAuditLog } from '../audit.js';

const router = Router();

const REPORT_REASONS = new Set([
  'spam',
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence',
  'self_harm',
  'illegal',
  'misinformation',
  'impersonation',
  'other',
]);

const REPORT_DETAIL_LIMIT = 1000;

function decorateReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    reporter_id: row.reporter_id,
    reporter_username: row.reporter_username || null,
    reporter_display_name: row.reporter_display_name || null,
    target_user_id: row.target_user_id || null,
    target_username: row.target_username || null,
    target_display_name: row.target_display_name || null,
    message_id: row.message_id || null,
    room_type: row.room_type || null,
    room_id: row.room_id || null,
    reason: row.reason,
    details: row.details || null,
    status: row.status,
    assigned_to: row.assigned_to || null,
    assigned_username: row.assigned_username || null,
    outcome: row.outcome || null,
    resolved_by: row.resolved_by || null,
    resolved_username: row.resolved_username || null,
    resolved_at: row.resolved_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    message_content: row.message_content ?? null,
    message_msg_type: row.message_msg_type ?? null,
    message_created_at: row.message_created_at ?? null,
    message_recalled_at: row.message_recalled_at ?? null,
    message_deleted_by_admin: row.message_deleted_by_admin === 1,
  };
}

const REPORT_SELECT = `
  SELECT r.id, r.reporter_id, r.target_user_id, r.message_id, r.room_type, r.room_id,
         r.reason, r.details, r.status, r.assigned_to, r.outcome, r.resolved_by, r.resolved_at,
         r.created_at, r.updated_at,
         reporter.username AS reporter_username, reporter.display_name AS reporter_display_name,
         target.username AS target_username, target.display_name AS target_display_name,
         assigned.username AS assigned_username, resolved.username AS resolved_username,
         m.content AS message_content, m.msg_type AS message_msg_type, m.created_at AS message_created_at,
         m.recalled_at AS message_recalled_at, m.deleted_by_admin AS message_deleted_by_admin
  FROM message_reports r
  LEFT JOIN users reporter ON reporter.id = r.reporter_id
  LEFT JOIN users target ON target.id = r.target_user_id
  LEFT JOIN users assigned ON assigned.id = r.assigned_to
  LEFT JOIN users resolved ON resolved.id = r.resolved_by
  LEFT JOIN messages m ON m.id = r.message_id
`;

function emitReportCount(req) {
  const io = req.app.get('io');
  if (!io) return;
  try {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) AS in_review
      FROM message_reports
    `).get() || { total: 0, open: 0, in_review: 0 };
    io.emit('reports:counts', {
      total: Number(counts.total) || 0,
      open: Number(counts.open) || 0,
      in_review: Number(counts.in_review) || 0,
    });
  } catch (_) {}
}

function notifyAdminsNewReport(req, report) {
  const io = req.app.get('io');
  if (!io) return;
  try {
    const admins = db.prepare(`SELECT id FROM users WHERE is_allowed = 1`).all();
    const insert = db.prepare(`
      INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at)
      VALUES (?, ?, 'mod_report', ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    const reporterName = report.reporter_display_name || report.reporter_username || report.reporter_id || 'someone';
    const targetName = report.target_display_name || report.target_username || report.target_user_id || 'a user';
    const title = `New report: ${reporterName} → ${targetName}`;
    const snippetSource = report.message_content || report.details || '';
    const snippet = String(snippetSource).replace(/\s+/g, ' ').trim().slice(0, 180);
    const bodyLines = [
      `Reporter: ${reporterName}${report.reporter_username ? ` (@${report.reporter_username})` : ''}`,
      `Target: ${targetName}${report.target_username ? ` (@${report.target_username})` : ''}`,
      `Reason: ${report.reason}`,
    ];
    if (report.details) bodyLines.push(`Details: ${String(report.details).slice(0, 200)}`);
    if (report.message_id) {
      bodyLines.push(`Message: ${snippet || '(no text)'}`);
    }
    const body = bodyLines.join('\n');
    const extra = {
      report_id: report.id,
      reporter_id: report.reporter_id,
      reporter_username: report.reporter_username || null,
      reporter_display_name: report.reporter_display_name || null,
      target_user_id: report.target_user_id,
      target_username: report.target_username || null,
      target_display_name: report.target_display_name || null,
      message_id: report.message_id || null,
      message_snippet: snippet || null,
      reason: report.reason,
      room_type: report.room_type || null,
      room_id: report.room_id || null,
    };
    const extraJson = JSON.stringify(extra);
    for (const a of admins) {
      const inboxId = randomUUID();
      insert.run(inboxId, a.id, title, body, report.id, extraJson, now);
      io.to(`user:${a.id}`).emit('inbox:item', {
        id: inboxId,
        type: 'mod_report',
        title,
        body,
        related_id: report.id,
        related_extra: extra,
        created_at: now,
      });
    }
  } catch (err) {
    console.warn('notifyAdminsNewReport failed:', err?.message || err);
  }
}

/** POST /api/reports – create a report. Reporters can only have one active report per message/target. */
router.post('/', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const { message_id, target_user_id, reason, details } = req.body || {};
  if (!reason || !REPORT_REASONS.has(reason)) return res.status(400).json({ error: 'Invalid reason' });
  if (!message_id && !target_user_id) return res.status(400).json({ error: 'message_id or target_user_id required' });

  let resolvedTargetId = target_user_id || null;
  let roomType = null;
  let roomId = null;
  if (message_id) {
    const msg = db.prepare(`SELECT id, sender_id, room_type, room_id FROM messages WHERE id = ?`).get(message_id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.sender_id === me.id) return res.status(400).json({ error: 'Cannot report your own message' });
    resolvedTargetId = resolvedTargetId || msg.sender_id;
    roomType = msg.room_type;
    roomId = msg.room_id;
  }
  if (resolvedTargetId === me.id) return res.status(400).json({ error: 'Cannot report yourself' });
  if (resolvedTargetId === 'jimmyqrg') return res.status(400).json({ error: 'Cannot report jimmyqrg' });

  const dupParams = message_id
    ? { messageId: message_id }
    : { targetUserId: resolvedTargetId };
  const dup = message_id
    ? db.prepare(`SELECT id FROM message_reports WHERE reporter_id = ? AND message_id = ? AND status IN ('open', 'in_review')`).get(me.id, message_id)
    : db.prepare(`SELECT id FROM message_reports WHERE reporter_id = ? AND target_user_id = ? AND message_id IS NULL AND status IN ('open', 'in_review')`).get(me.id, resolvedTargetId);
  if (dup) return res.status(409).json({ error: 'You already have an active report for this' });

  const id = randomUUID();
  const now = Date.now();
  const safeDetails = typeof details === 'string' ? details.slice(0, REPORT_DETAIL_LIMIT) : null;
  db.prepare(`
    INSERT INTO message_reports (
      id, reporter_id, target_user_id, message_id, room_type, room_id,
      reason, details, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(id, me.id, resolvedTargetId, message_id || null, roomType, roomId, reason, safeDetails, now, now);

  const created = db.prepare(REPORT_SELECT + ' WHERE r.id = ?').get(id);
  const report = decorateReport(created);
  notifyAdminsNewReport(req, report);
  emitReportCount(req);
  res.status(201).json({ ok: true, report });
});

/** GET /api/reports/mine – list my outgoing reports. */
router.get('/mine', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = db.prepare(REPORT_SELECT + ' WHERE r.reporter_id = ? ORDER BY r.created_at DESC LIMIT ?').all(me.id, limit);
  res.json({ reports: rows.map(decorateReport) });
});

// ── Admin moderation queue endpoints ──

function assertAdmin(req, res) {
  const user = getCurrentUser(req);
  if (!isAllowed(user)) {
    res.status(403).json({ error: 'Not allowed' });
    return null;
  }
  return user;
}

/** GET /api/reports – list reports with status/reason/search filters. Admins only. */
router.get('/', requireAuth, (req, res) => {
  const admin = assertAdmin(req, res);
  if (!admin) return;
  const status = String(req.query.status || 'open').toLowerCase();
  const allowedStatuses = new Set(['all', 'open', 'in_review', 'resolved', 'rejected', 'duplicate']);
  if (!allowedStatuses.has(status)) return res.status(400).json({ error: 'Invalid status' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const search = String(req.query.q || '').trim().toLowerCase();
  let where = '';
  const args = [];
  if (status !== 'all') {
    where += ` WHERE r.status = ?`;
    args.push(status);
  }
  let rows = db.prepare(REPORT_SELECT + where + ' ORDER BY r.created_at DESC LIMIT ?').all(...args, limit).map(decorateReport);
  if (search) {
    rows = rows.filter((r) => {
      const haystack = [
        r.reason,
        r.details,
        r.target_username,
        r.target_display_name,
        r.reporter_username,
        r.reporter_display_name,
        r.message_content,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(search);
    });
  }
  res.json({ reports: rows });
});

/** GET /api/reports/counts – open/in_review/total counts. */
router.get('/counts', requireAuth, (req, res) => {
  const admin = assertAdmin(req, res);
  if (!admin) return;
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) AS in_review
    FROM message_reports
  `).get() || { total: 0, open: 0, in_review: 0 };
  res.json({
    total: Number(counts.total) || 0,
    open: Number(counts.open) || 0,
    in_review: Number(counts.in_review) || 0,
  });
});

/** GET /api/reports/:id – single report with notes. */
router.get('/:id', requireAuth, (req, res) => {
  const admin = assertAdmin(req, res);
  if (!admin) return;
  const row = db.prepare(REPORT_SELECT + ' WHERE r.id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Report not found' });
  const notes = db.prepare(`
    SELECT n.id, n.body, n.created_at, n.author_id, u.username AS author_username, u.display_name AS author_display_name
    FROM moderation_notes n
    LEFT JOIN users u ON u.id = n.author_id
    WHERE n.report_id = ?
    ORDER BY n.created_at ASC
  `).all(req.params.id);
  res.json({ report: decorateReport(row), notes });
});

/** PATCH /api/reports/:id – update status / assignment / outcome. Admins only. */
router.patch('/:id', requireAuth, (req, res) => {
  const admin = assertAdmin(req, res);
  if (!admin) return;
  const reportId = req.params.id;
  const existing = db.prepare(`SELECT id, status, assigned_to FROM message_reports WHERE id = ?`).get(reportId);
  if (!existing) return res.status(404).json({ error: 'Report not found' });
  const body = req.body || {};
  const updates = {};
  if (typeof body.status === 'string') {
    const allowed = new Set(['open', 'in_review', 'resolved', 'rejected', 'duplicate']);
    if (!allowed.has(body.status)) return res.status(400).json({ error: 'Invalid status' });
    updates.status = body.status;
    if (body.status === 'resolved' || body.status === 'rejected' || body.status === 'duplicate') {
      updates.resolved_by = admin.id;
      updates.resolved_at = Date.now();
    } else {
      updates.resolved_by = null;
      updates.resolved_at = null;
    }
  }
  if (body.assigned_to === null || body.assigned_to === '') {
    updates.assigned_to = null;
  } else if (typeof body.assigned_to === 'string') {
    const target = db.prepare(`SELECT id, is_allowed FROM users WHERE id = ?`).get(body.assigned_to);
    if (!target || !target.is_allowed) return res.status(400).json({ error: 'Assignee must be an admin' });
    updates.assigned_to = target.id;
  } else if (body.assign_to_me) {
    updates.assigned_to = admin.id;
  }
  if (typeof body.outcome === 'string') {
    updates.outcome = body.outcome.slice(0, 96);
  } else if (body.outcome === null) {
    updates.outcome = null;
  }
  const keys = Object.keys(updates);
  if (!keys.length) return res.status(400).json({ error: 'No updates provided' });
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => updates[k]);
  values.push(Date.now());
  values.push(reportId);
  db.prepare(`UPDATE message_reports SET ${setSql}, updated_at = ? WHERE id = ?`).run(...values);
  recordAuditLog('mod.report_update', admin.id, existing.assigned_to || null, { report_id: reportId, ...updates });
  emitReportCount(req);
  const fresh = db.prepare(REPORT_SELECT + ' WHERE r.id = ?').get(reportId);
  res.json({ ok: true, report: decorateReport(fresh) });
});

/** POST /api/reports/:id/notes – add an admin note. */
router.post('/:id/notes', requireAuth, (req, res) => {
  const admin = assertAdmin(req, res);
  if (!admin) return;
  const reportId = req.params.id;
  const exists = db.prepare(`SELECT id, target_user_id, message_id FROM message_reports WHERE id = ?`).get(reportId);
  if (!exists) return res.status(404).json({ error: 'Report not found' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note body required' });
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO moderation_notes (id, report_id, target_user_id, message_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, reportId, exists.target_user_id || null, exists.message_id || null, admin.id, body.slice(0, 4000), now);
  recordAuditLog('mod.report_note', admin.id, exists.target_user_id || null, { report_id: reportId });
  res.status(201).json({ ok: true, note: { id, body, created_at: now, author_id: admin.id } });
});

/**
 * GET /api/reports/:id/context – nearest 10 messages around the reported message.
 * Returns { before: [...], focus: {...}, after: [...], room_type, room_id, conversation }.
 * Used by admins to review the context of a reported DM without exposing the whole
 * private chat history.
 */
router.get('/:id/context', requireAuth, (req, res) => {
  const admin = assertAdmin(req, res);
  if (!admin) return;
  const reportId = req.params.id;
  const report = db.prepare(`SELECT id, message_id, room_type, room_id FROM message_reports WHERE id = ?`).get(reportId);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (!report.message_id) return res.status(400).json({ error: 'Report is not tied to a message' });
  const focus = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id,
           m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at, m.recipient_user_id,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(report.message_id);
  if (!focus) return res.status(404).json({ error: 'Reported message not found' });
  // Hide the focus body from admins without can_see_whispers so they can't
  // peek at a whisper through the moderation queue.
  if (focus.msg_type === 'whisper' && admin.id !== 'jimmyqrg' && !canSeeWhispers(admin)) {
    return res.status(404).json({ error: 'Reported message not found' });
  }

  const WINDOW = 5;
  // Strip whispers from the context window regardless of admin perm — the
  // focus is what the admin is investigating; surrounding whispers are
  // private to their audience.
  const before = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id,
           m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_type = ? AND m.room_id = ?
      AND m.msg_type != 'whisper'
      AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(focus.room_type, focus.room_id, focus.created_at, focus.created_at, focus.id, WINDOW).reverse();

  const after = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id,
           m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_type = ? AND m.room_id = ?
      AND m.msg_type != 'whisper'
      AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT ?
  `).all(focus.room_type, focus.room_id, focus.created_at, focus.created_at, focus.id, WINDOW);

  let conversation = null;
  if (focus.room_type === 'dm') {
    const conv = db.prepare(`
      SELECT c.id, c.user1_id, c.user2_id,
             u1.username AS u1_username, u1.display_name AS u1_display_name,
             u2.username AS u2_username, u2.display_name AS u2_display_name
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      WHERE c.id = ?
    `).get(focus.room_id);
    if (conv) {
      conversation = {
        id: conv.id,
        participants: [
          { id: conv.user1_id, username: conv.u1_username, display_name: conv.u1_display_name },
          { id: conv.user2_id, username: conv.u2_username, display_name: conv.u2_display_name },
        ],
      };
    }
  }

  const decoratedBefore = decorateMessagesForReport(before);
  const decoratedFocus = decorateMessagesForReport([focus])[0];
  const decoratedAfter = decorateMessagesForReport(after);

  recordAuditLog('mod.report_view_context', admin.id, report.target_user_id || null, {
    report_id: reportId, room_type: focus.room_type, room_id: focus.room_id, message_id: focus.id,
  });

  res.json({
    room_type: focus.room_type,
    room_id: focus.room_id,
    conversation,
    focus_message_id: focus.id,
    before: decoratedBefore,
    focus: decoratedFocus,
    after: decoratedAfter,
  });
});

/** Minimal decorator: parses edit_history JSON so the client can render nicely. */
function decorateMessagesForReport(rows) {
  return rows.map((row) => ({
    ...row,
    edit_history: row.edit_history ? safeJsonParse(row.edit_history) : null,
  }));
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

export default router;
