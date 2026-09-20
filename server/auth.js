import session from 'express-session';
import { EventEmitter } from 'events';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { db, validateUsername, isEmailBanned } from './db.js';
import { createSessionStore } from './session-store.js';
import { resolveToken, extractToken } from './tokens.js';

/** Generate a 44-character alphanumeric recovery key with hyphens every 8
 *  chars (e.g. "aBcD1234-eFgH5678-iJkL9012-mNoP3456-qRsT7890"). 40 random
 *  chars give ~238 bits of entropy — brute-forceable only by another
 *  universe. */
export function generateAccountKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(40);
  let key = '';
  for (let i = 0; i < 40; i++) {
    if (i > 0 && i % 8 === 0) key += '-';
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

const TWO_MINUTES_MS = 2 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Ensure store has .on (express-session requires it). Use as-is if present, else wrap in EventEmitter. */
function ensureStoreWithOn(store) {
  if (store && typeof store.on === 'function') return store;
  const base = new EventEmitter();
  return Object.assign(base, store);
}

export function sessionMiddleware() {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret && process.env.NODE_ENV === 'production') {
    // Fail fast: never run production with the public dev fallback secret,
    // which would let anyone forge session cookies.
    throw new Error('SESSION_SECRET is not set. In production, set it as a Fly secret: fly secrets set SESSION_SECRET="$(openssl rand -base64 32)"');
  }
  return session({
    secret: sessionSecret || 'dev-only-jimmyqrg-chat-secret',
    store: ensureStoreWithOn(createSessionStore()),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      /* SameSite=None; Secure by default so the session cookie is sent when the app is embedded in an iframe. Set ALLOW_IFRAME=false to use SameSite=Lax instead. */
      sameSite: process.env.ALLOW_IFRAME === 'false' ? 'lax' : 'none',
      secure: process.env.COOKIE_INSECURE === 'true' ? false : (process.env.ALLOW_IFRAME === 'false' ? process.env.NODE_ENV === 'production' : true),
      maxAge: SEVEN_DAYS_MS,
      httpOnly: true,
    },
  });
}

/** Call from a route or middleware to touch the session so the cookie and store TTL are extended (use with rolling: true). */
export function touchSession(req, res, next) {
  if (req.session?.userId != null) req.session.lastActivity = Date.now();
  next();
}

/** If session is missing, try to authenticate via Bearer token and mirror the user id onto req.session.userId. */
export function tokenAuthMiddleware(req, res, next) {
  if (req.session?.userId) return next();
  const token = extractToken(req);
  if (!token) return next();
  const userId = resolveToken(token);
  if (userId) {
    try {
      if (!req.session || typeof req.session !== 'object') req.session = {};
      req.session.userId = userId;
      req.tokenAuth = { userId, token };
    } catch (_) {}
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  const token = extractToken(req);
  if (token) {
    const userId = resolveToken(token);
    if (userId) {
      if (!req.session || typeof req.session !== 'object') req.session = {};
      req.session.userId = userId;
      req.tokenAuth = { userId, token };
      return next();
    }
  }
  res.status(401).json({ error: 'Not authenticated' });
}

const PERM_COLS = 'can_send_inbox, can_broadcast, can_edit_docs, can_kick, can_delete_messages, can_manage_users, can_timeout, can_pin_messages, can_unlimited_edit_recall, can_see_whispers';

function normalizeUser(u) {
  if (!u) return null;
  return {
    ...u,
    is_allowed: !!u.is_allowed,
    can_send_inbox: !!u.can_send_inbox,
    can_broadcast: !!u.can_broadcast,
    can_edit_docs: !!u.can_edit_docs,
    can_kick: !!u.can_kick,
    can_delete_messages: !!u.can_delete_messages,
    can_manage_users: !!u.can_manage_users,
    can_timeout: !!u.can_timeout,
    can_pin_messages: !!u.can_pin_messages,
    can_unlimited_edit_recall: !!u.can_unlimited_edit_recall,
    can_see_whispers: !!u.can_see_whispers,
    chatbox_style: u.chatbox_style || 'default',
  };
}

export function getCurrentUser(req) {
  if (!req.session?.userId) return null;
  try {
    const u = db.prepare(`SELECT id, username, display_name, avatar_url, chatbox_style, email, description, is_allowed, ${PERM_COLS} FROM users WHERE id = ?`).get(req.session.userId);
    return normalizeUser(u);
  } catch {
    return null;
  }
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

const PLACEHOLDER_PASSWORD = '$2a$10$placeholder';

const RESERVED_NAMES = ['helper', 'venory'];

export async function register(username, email, password, displayName) {
  if (!validateUsername(username)) return { error: 'Username must be lowercase letters and numbers only' };
  if (RESERVED_NAMES.includes(username.toLowerCase())) return { error: 'That username is reserved' };
  if (displayName && RESERVED_NAMES.includes(displayName.trim().toLowerCase())) return { error: 'That display name is reserved' };
  if (!isValidEmail(email)) return { error: 'Valid email required' };
  if (isEmailBanned(email)) return { error: 'This email address has been permanently banned.' };
  const existingUser = db.prepare('SELECT id, password_hash, email FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  const isJimmyqrg = username.toLowerCase() === 'jimmyqrg';
  const isPlaceholder = existingUser?.password_hash === PLACEHOLDER_PASSWORD && existingUser?.email == null;
  if (existingUser && !(isJimmyqrg && isPlaceholder)) return { error: 'Username taken' };
  const existingEmail = db.prepare('SELECT id FROM users WHERE email IS NOT NULL AND LOWER(email) = LOWER(?)').get(email.trim());
  if (existingEmail) return { error: 'Email already registered' };
  const hash = bcrypt.hashSync(password, 10);
  const name = (displayName || username).slice(0, 64);
  const emailVal = email.trim().toLowerCase().slice(0, 255);
  const accountKey = generateAccountKey();
  if (isJimmyqrg && isPlaceholder) {
    db.prepare('UPDATE users SET display_name = ?, email = ?, password_hash = ?, account_key = ?, created_at = ? WHERE id = ?')
      .run(name, emailVal, hash, accountKey, Date.now(), existingUser.id);
    return { user: getNormalizedUserById(existingUser.id), accountKey };
  }
  const id = isJimmyqrg ? 'jimmyqrg' : uuidv4();
  db.prepare('INSERT INTO users (id, username, display_name, avatar_url, email, password_hash, account_key, is_allowed, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)')
    .run(id, username.toLowerCase(), name, emailVal, hash, accountKey, isJimmyqrg ? 1 : 0, Date.now());
  return { user: getNormalizedUserById(id), accountKey };
}

const DEFAULT_PLACEHOLDER_PASSWORD = 'changeme';

export async function login(usernameOrEmail, password) {
  const input = (usernameOrEmail || '').trim().toLowerCase();
  const pass = (password || '').trim();
  // Block banned emails at the login gate — whether entered directly as the
  // identifier, or resolved to a user whose stored email is banned.
  if (input.includes('@') && isEmailBanned(input)) {
    return { error: 'This email address has been permanently banned.' };
  }
  const u = db.prepare(
    'SELECT id, username, display_name, avatar_url, email, password_hash, is_allowed, deleted_at FROM users WHERE LOWER(username) = ? OR (email IS NOT NULL AND LOWER(email) = ?)'
  ).get(input, input);
  if (!u) return { error: 'Invalid credentials' };
  if (u.email && isEmailBanned(u.email)) {
    return { error: 'This email address has been permanently banned.' };
  }
  if (u.deleted_at != null) return { error: 'This account has been deleted.' };
  const isPlaceholder = u.password_hash === PLACEHOLDER_PASSWORD || (String(u.password_hash || '').includes('placeholder'));
  let validPassword = false;
  if (isPlaceholder) {
    validPassword = pass.toLowerCase() === DEFAULT_PLACEHOLDER_PASSWORD;
  } else {
    try {
      validPassword = !!pass && bcrypt.compareSync(pass, u.password_hash);
    } catch {
      validPassword = false;
    }
  }
  if (!validPassword) return { error: 'Invalid credentials' };
  return { user: getNormalizedUserById(u.id) };
}

/** Reset a user's password without knowing the current one. Used by the forgot-
 *  password flow once the reset token has been validated. Also revokes every
 *  active auth_token so any old sessions need to log in again. */
export function resetPassword(userId, newPassword) {
  if (!userId) return { error: 'User not found' };
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!u) return { error: 'User not found' };
  const newPass = (newPassword || '').trim();
  if (!newPass || newPass.length < 6) return { error: 'New password must be at least 6 characters' };
  const hash = bcrypt.hashSync(newPass, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  try { db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(userId); } catch (_) {}
  return { ok: true };
}

export async function changePassword(userId, currentPassword, newPassword) {
  const u = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(userId);
  if (!u) return { error: 'User not found' };
  const current = (currentPassword || '').trim();
  const newPass = (newPassword || '').trim();
  if (!newPass || newPass.length < 6) return { error: 'New password must be at least 6 characters' };
  const isPlaceholder = u.password_hash === PLACEHOLDER_PASSWORD || (String(u.password_hash || '').includes('placeholder'));
  let valid = false;
  if (isPlaceholder) {
    valid = current.toLowerCase() === DEFAULT_PLACEHOLDER_PASSWORD;
  } else {
    try {
      valid = !!current && bcrypt.compareSync(current, u.password_hash);
    } catch {
      valid = false;
    }
  }
  if (!valid) return { error: 'Current password is wrong' };
  const hash = bcrypt.hashSync(newPass, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  return { ok: true };
}

export function canRecallOrEdit(msg) {
  if (!msg) return false;
  const age = Date.now() - msg.created_at;
  return age <= TWO_MINUTES_MS;
}

/** Can access Manage page (on admin list). */
export function isAllowed(user) {
  return user && !!user.is_allowed;
}

/** Can add/remove users from admin list and set their permissions. */
export function canManageUsers(user) {
  return user && !!user.can_manage_users;
}

export function canSendInbox(user) {
  return user && !!user.can_send_inbox;
}

export function canBroadcast(user) {
  return user && !!user.can_broadcast;
}

export function canEditDocs(user) {
  return user && !!user.can_edit_docs;
}

export function canKick(user) {
  return user && !!user.can_kick;
}

export function canDeleteMessages(user) {
  return user && !!user.can_delete_messages;
}

export function canTimeout(user) {
  return user && !!user.can_timeout;
}

export function canPinMessages(user) {
  return user && !!user.can_pin_messages;
}

export function canUnlimitedEditRecall(user) {
  return user && !!user.can_unlimited_edit_recall;
}

export function canSeeWhispers(user) {
  return user && !!user.can_see_whispers;
}

/** Return normalized user by id (for login/register response). */
export function getNormalizedUserById(id) {
  try {
    const u = db.prepare(`SELECT id, username, display_name, avatar_url, email, description, is_allowed, ${PERM_COLS} FROM users WHERE id = ?`).get(id);
    return normalizeUser(u);
  } catch {
    return null;
  }
}
