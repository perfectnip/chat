import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../data');
const dbPath = join(dataDir, 'chat.db');

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbPath);

// Ensure permission columns exist (migration for older DBs)
const PERM_COLS = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout', 'can_pin_messages', 'can_unlimited_edit_recall', 'can_see_whispers'];
for (const col of PERM_COLS) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {}
}
// Backfill: give existing admins new permissions
try { db.exec(`UPDATE users SET can_pin_messages = 1 WHERE is_allowed = 1 AND can_pin_messages = 0`); } catch (_) {}
try { db.exec(`UPDATE users SET can_unlimited_edit_recall = 1 WHERE id = 'jimmyqrg' AND can_unlimited_edit_recall = 0`); } catch (_) {}
// Safety net: jimmyqrg must ALWAYS retain every admin power. Without this,
// an upgrade from an old DB schema could leave jimmyqrg unable to moderate
// during an incident. Runs on every startup and is idempotent.
try {
  db.exec(`UPDATE users SET
    is_allowed = 1,
    can_send_inbox = 1,
    can_broadcast = 1,
    can_edit_docs = 1,
    can_kick = 1,
    can_delete_messages = 1,
    can_manage_users = 1,
    can_timeout = 1,
    can_pin_messages = 1,
    can_unlimited_edit_recall = 1,
    can_see_whispers = 1,
    deleted_at = NULL
  WHERE id = 'jimmyqrg'`);
} catch (err) { console.error('[db.boot] Failed to ensure jimmyqrg admin powers:', err?.message || err); }
try { db.exec('ALTER TABLE users ADD COLUMN website TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN profile_links TEXT'); } catch (_) {} // JSON array of {label, url}
try { db.exec('ALTER TABLE users ADD COLUMN description TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN chatbox_style TEXT DEFAULT 'default'"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN chatbox_color TEXT"); } catch (_) {}
// Custom-color style was removed (2026-09-20): reset anyone still on it.
try { db.exec("UPDATE users SET chatbox_style = 'default' WHERE chatbox_style = 'custom'"); } catch (_) {}

// Premium tier cache. The Stripe subscription lives on the Cloudflare Worker
// (keyed by chat user id); this row is the last tier we resolved for a user so
// sending a message never has to wait on the network.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS user_tiers (
    user_id    TEXT PRIMARY KEY,
    tier       TEXT NOT NULL DEFAULT 'free',
    source     TEXT,
    checked_at INTEGER NOT NULL DEFAULT 0
  )`);
} catch (err) { console.error('[db.boot] user_tiers:', err?.message || err); }

// Daily Venory (helper) message counts, one row per user per day. Free users
// get 30/day, Premium 100/day, Premium Plus unlimited.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS helper_daily_usage (
    user_id  TEXT NOT NULL,
    day      TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`);
} catch (err) { console.error('[db.boot] helper_daily_usage:', err?.message || err); }
try { db.exec('ALTER TABLE users ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

// Whispers: per-row audience for /whisper messages. The sender is implicit
// via messages.sender_id; rows here list only the extra viewers (recipient,
// jimmyqrg, admins with the can_see_whispers perm at the time of send).
// Admins granted the perm AFTER a whisper was sent will NOT retroactively
// see it — audience is locked at send time.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN recipient_user_id TEXT`);
} catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whisper_audience (
      message_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (user_id)    REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_whisper_audience_msg  ON whisper_audience(message_id);
    CREATE INDEX IF NOT EXISTS idx_whisper_audience_user ON whisper_audience(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient    ON messages(recipient_user_id);
  `);
} catch (err) { console.error('[db.boot] whisper schema setup failed:', err?.message || err); }

/** Build the WHERE-clause fragment that hides whispers from non-audience
 *  viewers. Caller appends `AND (...sql...)` to their `messages` SELECT.
 *  Returns `{ sql, params }` so callers can `.all(...params)`.
 *
 *  Viewer can see a whisper iff: they sent it, it's addressed to them,
 *  they're jimmyqrg, or they're listed in whisper_audience. Empty params
 *  when no viewer id was supplied (always-hide). */
export function whisperVisibleClause(viewer) {
  if (!viewer || !viewer.id) {
    return { sql: `m.msg_type != 'whisper'`, params: [] };
  }
  return {
    sql: `(m.msg_type != 'whisper' OR m.sender_id = ? OR m.recipient_user_id = ? OR ? = 'jimmyqrg' OR EXISTS(SELECT 1 FROM whisper_audience wa WHERE wa.message_id = m.id AND wa.user_id = ?))`,
    params: [viewer.id, viewer.id, viewer.id, viewer.id],
  };
}

// Seed: private user account for jimmyqrg. Runs on every server boot,
// idempotent. Placed here (not in scripts/init-db.js) so the seed
// actually runs in the Fly container — the CMD never invokes the
// init-db script; it only starts gunicorn + node. Without this guard
// here, the private user would only exist on a fresh dev box.
try {
  const SEZI_HASH = '$2a$10$WpE8OGrBQK6ZsA7kaPQecOnjm7fhs.ZpFRjpBQad5OwpV7QuNJ7Ue';
  // Email must be unique across all users because the login() query
  // matches on LOWER(email) — a collision would let someone log into the
  // wrong account by email. The @chat.local suffix avoids colliding with
  // real public emails.
  const SEZI_EMAIL = 'sezitoushangyibadao@chat.local';
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get('sezitoushangyibadao');
  if (!existing) {
    db.prepare(
      `INSERT INTO users (id, username, display_name, avatar_url, email, password_hash, is_allowed, is_private, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, 0, 1, ?)`
    ).run('sezitoushangyibadao', 'sezitoushangyibadao', '色字头上一把刀', SEZI_EMAIL, SEZI_HASH, Date.now());
  } else {
    // Backfill / correct fields in case the row predates a code change.
    db.prepare(`UPDATE users SET email = ?, is_private = 1 WHERE id = 'sezitoushangyibadao' AND (email IS NULL OR email != ? OR is_private = 0)`).run(SEZI_EMAIL, SEZI_EMAIL);
  }
} catch (err) {
  console.error('[db.boot] Failed to ensure sezitoushangyibadao private user:', err?.message || err);
}

// Friendships and friend-request rate limits
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friendships (
      user1_id TEXT NOT NULL,
      user2_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user1_id, user2_id),
      CHECK (user1_id < user2_id),
      FOREIGN KEY (user1_id) REFERENCES users(id),
      FOREIGN KEY (user2_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user1_id, user2_id);
  `);
} catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friend_request_log (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_id) REFERENCES users(id),
      FOREIGN KEY (to_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_friend_request_log_from_to ON friend_request_log(from_id, to_id);
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
  `);
} catch (_) {}

// Group timeouts (mute in JimmyQrg group or in private chat)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_timeouts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      room_type TEXT NOT NULL,
      room_id TEXT NOT NULL,
      expires_at INTEGER,
      locked_release INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      released_at INTEGER,
      released_by TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_timeouts_user_room ON group_timeouts(user_id, room_type, room_id);
  `);
} catch (_) {}

// Add scope column (group | dm) so admins can pick where the mute applies.
// We surface any migration errors explicitly so a botched migration isn't
// silent — a failed migration means new timeouts can't be created or checked.
try {
  const cols = db.prepare("PRAGMA table_info(group_timeouts)").all();
  const hasScope = cols.some((c) => c.name === 'scope');
  if (!hasScope) {
    db.exec(`ALTER TABLE group_timeouts ADD COLUMN scope TEXT NOT NULL DEFAULT 'group'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_group_timeouts_scope_user ON group_timeouts(scope, user_id)`);
  }
  // Backfill: older rows with NULL scope should be treated as group-scope timeouts.
  db.exec(`UPDATE group_timeouts SET scope = 'group' WHERE scope IS NULL OR scope = ''`);
} catch (err) {
  console.error('[db migrate] group_timeouts.scope migration failed:', err?.message || err);
}

// Per-message likes (heart/reaction count). Created here as a migration fallback
// so DBs initialized before message_likes existed still pick it up.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_likes (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_likes_message ON message_likes(message_id);
  `);
} catch (_) {}

// Personal inbox (system messages sent to a user).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      body TEXT,
      related_id TEXT,
      related_extra TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox(user_id);
  `);
} catch (_) {}

// Kicked (per-room eject tracker).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kicked (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      room_type TEXT NOT NULL,
      room_id TEXT NOT NULL,
      kicked_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (kicked_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_kicked_user_room ON kicked(user_id, room_type, room_id);
  `);
} catch (_) {}

// Blocked users (blocker_id blocks blocked_id)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      user_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, blocked_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (blocked_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_blocked_users_user ON blocked_users(user_id);
  `);
} catch (_) {}

// Notification preferences
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_notification_prefs (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      notify_mails INTEGER NOT NULL DEFAULT 1,
      notify_dm INTEGER NOT NULL DEFAULT 1,
      notify_group INTEGER NOT NULL DEFAULT 1,
      dm_allow_list TEXT,
      dm_block_list TEXT,
      dnd_until INTEGER,
      dnd_at_night INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}
try { db.exec('ALTER TABLE user_notification_prefs ADD COLUMN dnd_at_night INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE user_notification_prefs ADD COLUMN dnd_timezone TEXT'); } catch (_) {}

// Web Push subscriptions: one row per browser/device PushManager subscription.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      user_id TEXT NOT NULL,
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}

// Blacklist: blacklisted user cannot access group chat, only DM with jimmyqrg or allowed users
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blacklist (
      user_id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
} catch (_) {}

// users.deleted_at: soft delete (timestamp) or null (active). Permanently deleted users are removed from DB.
try { db.exec('ALTER TABLE users ADD COLUMN deleted_at INTEGER'); } catch (_) {}

// Pinned messages: one pinned message per room
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pinned_messages (
      room_type TEXT NOT NULL,
      room_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      pinned_by TEXT NOT NULL,
      pinned_at INTEGER NOT NULL,
      PRIMARY KEY (room_type, room_id),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (pinned_by) REFERENCES users(id)
    )
  `);
} catch (_) {}

// Admin audit log
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor_id TEXT,
      target_id TEXT,
      details TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES users(id),
      FOREIGN KEY (target_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);
  `);
} catch (_) {}

// Message reports & moderation queue.
// Status lifecycle: 'open' -> 'in_review' -> 'resolved' | 'rejected' | 'duplicate'.
// outcome holds the resolution detail (e.g. 'no_action', 'message_deleted', 'user_timed_out', 'user_blacklisted').
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      target_user_id TEXT,
      message_id TEXT,
      room_type TEXT,
      room_id TEXT,
      reason TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_to TEXT,
      outcome TEXT,
      resolved_by TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (reporter_id) REFERENCES users(id),
      FOREIGN KEY (target_user_id) REFERENCES users(id),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id),
      FOREIGN KEY (resolved_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_reports_status ON message_reports(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_reports_target ON message_reports(target_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_reports_message ON message_reports(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_reports_reporter ON message_reports(reporter_id, created_at DESC);
  `);
} catch (_) {}

// Moderation notes attached to reports/users/messages by admins.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS moderation_notes (
      id TEXT PRIMARY KEY,
      report_id TEXT,
      target_user_id TEXT,
      message_id TEXT,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (report_id) REFERENCES message_reports(id),
      FOREIGN KEY (target_user_id) REFERENCES users(id),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (author_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_moderation_notes_report ON moderation_notes(report_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_moderation_notes_target ON moderation_notes(target_user_id, created_at DESC);
  `);
} catch (_) {}

// Upload references: tracks which messages reference which uploaded files for cleanup.
// `referenced` flips to 0 when the message is deleted; the GC script removes files that
// have only `referenced = 0` rows older than the threshold.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_refs (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      message_id TEXT,
      uploaded_by TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      original_name TEXT,
      referenced INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_upload_refs_filename ON upload_refs(filename);
    CREATE INDEX IF NOT EXISTS idx_upload_refs_message ON upload_refs(message_id);
    CREATE INDEX IF NOT EXISTS idx_upload_refs_referenced ON upload_refs(referenced, created_at);
  `);
} catch (_) {}

// Messages indexes that help search filename/attachment-type lookups efficiently.
try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_msg_type ON messages(msg_type, created_at DESC)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(sender_id, created_at DESC)'); } catch (_) {}

const USERNAME_RE = /^[a-z0-9]+$/;
export function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username) && username.length >= 1 && username.length <= 32;
}

export const GROUP_ID = 'JimmyQrg';
export const PANELS = ['announcements', 'free_chat', 'support', 'problem_solving', 'rules'];
export const HELPER_USER_ID = 'helper';
export const HELPER_AVATAR_URL = '/assets/helper/avatar.png';

try {
  db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, avatar_url, email, password_hash, is_allowed, created_at)
    VALUES (?, 'helper', 'Venory', ?, NULL, '$2a$10$placeholder', 0, ?)`).run(HELPER_USER_ID, HELPER_AVATAR_URL, Date.now());
  db.prepare(`UPDATE users SET display_name = 'Venory', avatar_url = COALESCE(NULLIF(avatar_url,''), ?) WHERE id = ?`)
    .run(HELPER_AVATAR_URL, HELPER_USER_ID);
} catch (_) {}

export function isBlacklisted(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT 1 FROM blacklist WHERE user_id = ?').get(userId);
  return !!row;
}

export function isUserDeleted(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(userId);
  return row && row.deleted_at != null;
}

// Banned emails — addresses that cannot register, log in, or be set as a
// user's email. Matched case-insensitively. Used for hard permanent bans
// that survive account deletion / re-registration.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS banned_emails (
      email TEXT PRIMARY KEY,
      reason TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
  `);
} catch (err) {
  console.error('[db migrate] banned_emails migration failed:', err?.message || err);
}

// Helper bot running context summaries: per-room compacted history so the
// basic Venory keeps long conversations within its token budget without
// dropping (clearing) older messages. `through_created_at` is the created_at
// of the newest message folded into the summary.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS helper_context_summaries (
      room_key TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      through_created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
} catch (err) {
  console.error('[db migrate] helper_context_summaries migration failed:', err?.message || err);
}

// Password reset tokens. One token = one reset attempt. Tokens are invalidated
// either by use, by expiry, or by superseded request (only the most recent
// outstanding token for a user remains valid).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      ip TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at);
  `);
} catch (err) {
  console.error('[db migrate] password_reset_tokens migration failed:', err?.message || err);
}

/** Check whether a given email is on the permanent ban list. */
export function isEmailBanned(email) {
  if (!email) return false;
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return false;
  try {
    const row = db.prepare('SELECT 1 FROM banned_emails WHERE LOWER(email) = ?').get(normalized);
    return !!row;
  } catch (err) {
    console.warn('[isEmailBanned] query failed:', err?.message || err);
    return false;
  }
}

/** Add an email to the permanent ban list and delete any existing account using it. */
export function banEmail(email, { reason = null, actorId = null } = {}) {
  if (!email) return false;
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return false;
  try {
    db.prepare('INSERT OR REPLACE INTO banned_emails (email, reason, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(normalized, reason, actorId, Date.now());
    // Soft-delete any account currently using this email so they can no
    // longer log in. We keep their record for audit/restore purposes.
    db.prepare('UPDATE users SET deleted_at = COALESCE(deleted_at, ?) WHERE email IS NOT NULL AND LOWER(email) = ?')
      .run(Date.now(), normalized);
    // Revoke any active bearer tokens for affected accounts.
    try {
      const affected = db.prepare('SELECT id FROM users WHERE email IS NOT NULL AND LOWER(email) = ?').all(normalized);
      for (const u of affected) {
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(u.id);
      }
    } catch (_) {}
    return true;
  } catch (err) {
    console.error('[banEmail] failed:', err?.message || err);
    return false;
  }
}

// Seed the initial permanent ban for weeee@outlook.com. INSERT OR IGNORE
// keeps this idempotent across restarts.
try {
  banEmail('weeee@outlook.com', { reason: 'Admin-requested permanent ban', actorId: 'jimmyqrg' });
} catch (_) {}

// Email verification codes for registration. 6-digit codes with 2-minute TTL.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_verify_email ON email_verification_codes(email, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_verify_expires ON email_verification_codes(expires_at);
  `);
} catch (_) {}

// Account recovery key generated at signup. One per user. Stored plaintext;
// access from outside the user's session is gated by an email-delivered code.
try { db.exec('ALTER TABLE users ADD COLUMN account_key TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN account_frozen INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_account_key ON users(account_key)'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN memory_message_length INTEGER'); } catch (_) {}

// Generic short-lived 6-digit codes used for: account-key reveal, recovery
// email verification, and any other email-second-factor flow. The `purpose`
// column scopes the code so a code issued for one flow cannot be reused for
// another.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_email_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_email_codes_lookup
      ON auth_email_codes(LOWER(email), purpose, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_auth_email_codes_expires
      ON auth_email_codes(expires_at);
  `);
} catch (_) {}

// Server-side recovery sessions. The user gets a `recovery_token` only after
// proving they have an account or payment key; subsequent steps require
// presenting the same token. Stage tracks the user's progress through the
// flow so the client can never skip a step by lying.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      recognition TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      claimed_email TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_sessions_user
      ON recovery_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_recovery_sessions_expires
      ON recovery_sessions(expires_at);
  `);
} catch (_) {}

// Audit trail of every recovery attempt (success and failure) so we can
// notify all addresses on the account and show admins what happened.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_attempts_user
      ON recovery_attempts(user_id, created_at DESC);
  `);
} catch (_) {}

// Game / app progress saves. A generic per-user key/value store used by perfectnip.github.io
// games to persist save data to the server. The `origin` column namespaces keys across
// different sites/games (typically 'jimmyqrg' or 'chat') so one account can hold data for many apps.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_saves (
      user_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'localStorage',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, origin, key, kind),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_saves_user_updated ON user_saves(user_id, updated_at DESC);
  `);
} catch (_) {}

// Long-lived bearer tokens for cross-origin clients that can't use session cookies
// (third-party cookie blocking makes cookies unreliable from perfectnip.github.io).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);
  `);
} catch (_) {}

// Saved message collections (per-user saved messages for quick access)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_collections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      room_type TEXT NOT NULL,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_username TEXT,
      sender_display_name TEXT,
      content_snapshot TEXT,
      msg_type TEXT,
      message_created_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );
    CREATE INDEX IF NOT EXISTS idx_collections_user_created ON message_collections(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_collections_message ON message_collections(message_id);
  `);
} catch (_) {}

// AI moderation flags. Per-user severity score (0=neutral, 10=severe repeat
// offender). The AI moderator reads this score when judging borderline
// messages so that users with a clean record get the benefit of the doubt
// while users with a long history of violations are evaluated more strictly.
// `recent_reasons` stores the most recent block reasons (pipe-delimited)
// purely for admin context; the score itself is what the AI sees.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_moderation_flags (
      user_id TEXT PRIMARY KEY,
      severity INTEGER NOT NULL DEFAULT 0,
      total_violations INTEGER NOT NULL DEFAULT 0,
      last_violation_at INTEGER,
      recent_reasons TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_moderation_flags_severity
      ON user_moderation_flags(severity DESC, last_violation_at DESC);
  `);
} catch (err) {
  console.error('[db migrate] user_moderation_flags migration failed:', err?.message || err);
}

/** Read a user's current AI-moderation severity (0-10). 0 by default. */
export function getUserModerationSeverity(userId) {
  if (!userId) return 0;
  try {
    const row = db.prepare('SELECT severity FROM user_moderation_flags WHERE user_id = ?').get(userId);
    return Math.max(0, Math.min(10, Number(row?.severity || 0)));
  } catch {
    return 0;
  }
}

/** Read the full moderation row (severity + reasons) for admin/staff view. */
export function getUserModerationRow(userId) {
  if (!userId) return null;
  try {
    return db.prepare('SELECT * FROM user_moderation_flags WHERE user_id = ?').get(userId) || null;
  } catch {
    return null;
  }
}

/** Increase a user's severity score and remember the most recent reason.
 *  Severity is clamped to [0, 10]. Pass a positive `delta` (e.g. 1 for a
 *  minor block, 3 for severe). */
export function bumpUserModerationSeverity(userId, delta, reason = '') {
  if (!userId) return 0;
  const d = Math.max(0, Math.min(10, Number(delta) || 0));
  if (d <= 0) return getUserModerationSeverity(userId);
  const now = Date.now();
  try {
    const existing = db.prepare('SELECT severity, total_violations, recent_reasons FROM user_moderation_flags WHERE user_id = ?').get(userId);
    const cleanReason = String(reason || '').slice(0, 200);
    if (existing) {
      const next = Math.max(0, Math.min(10, (existing.severity || 0) + d));
      const total = (existing.total_violations || 0) + 1;
      const list = (existing.recent_reasons || '').split('||').filter(Boolean);
      list.push(cleanReason);
      while (list.length > 5) list.shift();
      db.prepare(`
        UPDATE user_moderation_flags
        SET severity = ?, total_violations = ?, last_violation_at = ?, recent_reasons = ?, updated_at = ?
        WHERE user_id = ?
      `).run(next, total, now, list.join('||'), now, userId);
      return next;
    }
    db.prepare(`
      INSERT INTO user_moderation_flags (user_id, severity, total_violations, last_violation_at, recent_reasons, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(userId, d, now, cleanReason, now);
    return d;
  } catch (err) {
    console.warn('[bumpUserModerationSeverity] failed:', err?.message || err);
    return getUserModerationSeverity(userId);
  }
}

/** Decay a user's severity by `amount` (default 1). Called when admins want
 *  to give a user a clean slate, or by a future scheduled job. */
export function decayUserModerationSeverity(userId, amount = 1) {
  if (!userId) return 0;
  try {
    const row = db.prepare('SELECT severity FROM user_moderation_flags WHERE user_id = ?').get(userId);
    if (!row) return 0;
    const next = Math.max(0, Math.min(10, (row.severity || 0) - Math.max(0, Number(amount) || 0)));
    db.prepare('UPDATE user_moderation_flags SET severity = ?, updated_at = ? WHERE user_id = ?')
      .run(next, Date.now(), userId);
    return next;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Private users
// ---------------------------------------------------------------------------
// A "private" user is hidden from everyone except jimmyqrg. Profile view,
// search results, new DMs, friend adds, group @-mentions as clickable
// links, and group member rosters all block unless the viewer is jimmyqrg.
// Group message text is NOT filtered — if a private user posts in a group,
// normal members still see the message (they just can't click through to
// a profile). Helpers below enforce this at every gate.

/** True if `userId` has is_private=1. */
export function isPrivateUser(userId) {
  if (!userId) return false;
  try {
    const row = db.prepare('SELECT is_private FROM users WHERE id = ?').get(userId);
    return !!(row && row.is_private);
  } catch {
    return false;
  }
}

/** True if `viewer` is allowed to see/interact with private user
 *  `targetId`. jimmyqrg always sees. Everyone else never does. */
export function canSeePrivateUser(viewer, targetId) {
  if (!targetId) return true;
  if (!isPrivateUser(targetId)) return true;
  if (!viewer) return false;
  return viewer.id === 'jimmyqrg';
}

// Simple key/value store for server-wide flags (e.g. the owner's Venory
// agent routing mode). Values are short strings; keys are namespaced by
// convention (lower_snake_case).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
} catch (_) {}

/** Standard 403 payload for blocked private-user access. Routes should use
 *  `res.status(403).json(PRIVATE_USER_BLOCKED)` to keep the message
 *  identical everywhere. */
export const PRIVATE_USER_BLOCKED = Object.freeze({
  error: 'This user is private',
  private_user: true,
});
