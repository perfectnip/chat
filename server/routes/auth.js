import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { register, login, resetPassword, getCurrentUser, sessionMiddleware, requireAuth, generateAccountKey } from '../auth.js';
import { issueToken, revokeToken, extractToken, resolveToken } from '../tokens.js';
import { db, isEmailBanned } from '../db.js';
import { sendEmail, buildResetEmail, buildVerificationCodeEmail, buildAccountKeyViewEmail, buildRecoveryCodeEmail, buildRecoveryAttemptEmail, getPublicBaseUrl } from '../email.js';
import { recordAuditLog } from '../audit.js';
import { refreshUserTier } from '../premium.js';

const router = Router();

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const VERIFY_CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const VERIFY_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds between resends
const RECOVERY_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const RECOVERY_ATTEMPT_LIMIT_PER_HOUR = 8;
// Per-IP / per-identifier rate limiter keyed in memory. Resets on restart.
const _resetLimiter = new Map();
function rateLimitKey(req, identifier) {
  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip || 'unknown').trim();
  return `${ip}::${(identifier || '').toLowerCase()}`;
}
function shouldThrottleReset(req, identifier) {
  const key = rateLimitKey(req, identifier);
  const now = Date.now();
  const arr = (_resetLimiter.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  // No more than 5 reset attempts per identifier+IP per hour.
  if (arr.length >= 5) return true;
  arr.push(now);
  _resetLimiter.set(key, arr);
  return false;
}

function generateResetToken() {
  // 32 random bytes -> 64-char hex token. Cryptographically secure.
  return randomBytes(32).toString('hex');
}

/** Verify reCAPTCHA v2 token with Google. Returns { success: boolean, error?: string }.
 *  Set RECAPTCHA_SITE_KEY (public, for frontend) and RECAPTCHA_SECRET_KEY (secret, for server).
 *  If RECAPTCHA_SECRET_KEY is not set, registration does not require reCAPTCHA. */
async function verifyRecaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret || !token) return { success: false, error: 'recaptcha_missing' };
  try {
    const q = new URLSearchParams({ secret, response: token });
    const res = await fetch(`https://www.google.com/recaptcha/api/siteverify?${q}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) return { success: true };
    return { success: false, error: data['error-codes']?.[0] || 'verification_failed' };
  } catch (e) {
    return { success: false, error: 'network_error' };
  }
}

/** True when the caller looks like an off-origin client (e.g. perfectnip.github.io). Such clients
 *  cannot reliably use session cookies because browsers block third-party cookies, so we also
 *  hand back a bearer token they can store and send via `Authorization: Bearer ...`. */
function wantsToken(req) {
  if (req.query?.want_token === '1' || req.body?.want_token) return true;
  const origin = String(req.headers?.origin || '');
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    if (host === req.headers?.host) return false;
  } catch {}
  return true;
}

function generateVerifyCode() {
  const n = randomBytes(4).readUInt32BE(0) % 1000000;
  return String(n).padStart(6, '0');
}

/** Email addresses the owner allow-listed to skip verification (exact match). */
const EMAIL_VERIFY_SKIP_EMAILS = ['jlsniperelite4@outlook.com'];

/**
 * Email domains where verification is skipped. Two cases are combined here:
 *  - the organization blocks external mail, so a code could never be delivered;
 *  - the owner has allow-listed the domain to skip verification entirely.
 * Keep this in sync with the games-site signup UI (`js/jqrg-auth-ui.js`
 * `BLOCKED_DOMAINS` + `VERIFY_SKIP_DOMAINS`).
 */
const EMAIL_VERIFY_SKIP_DOMAINS = [
  'student.auhsd.us',
  'chehalisschools.org',
  'kcusd.net',
  'sidmouthcollege.devon.sch.uk',
  'sjacstudent.qld.edu.au',
  'abpat.qld.edu.au',
  'student.cms.k12.nc.us',
  'panthers.pequannock.org',
  'pickettk12.net',
  'student.sfx.vic.edu.au',
  'go.tahomasd.us',
  'student.medwayschools.org',
  'arcatasd.org',
  'indyde.org',
  'jcpsnj.org',
  'forsythk12.org',
  'seattleschools.org',
  'students.lindenps.org',
  'student.acsssd.net',
  'thegodsofpika.com',
  'glencoveschools.org',
  'theslender.org',
  'educ.dpcdsb.org',
  'students.cnusd.k12.ca.us',
  'student.minaret.vic.edu.au',
  'churchie.com.au',
  'pausd.us',
  'asdk12.net',
  'denipl.com',
  'schools.sfx.vic.edu.au',
  'student.mfis.nsw.edu.au',
  'judd.kent.sch.uk',
  'proton.me',
  'ddsbstudent.ca',
  'fommie.com',
  'arker.college',
  'ggusd.net',
  'student.hampton.k12.va.us',
  'student.bmg.vic.edu.au',
  'nsseo.org',
  'comsewogue.k12.ny.us',
  'palmdalesd.org',
  'perrytonisd.com',
  's.acsdsc.org',
  'sstrojans.org',
  'cross.edu.pl',
  'lompocschools.org',
  'acsd.org.com',
  'lwsd.org',
  'student.vic.sfx.edu.au',
  'ahschools.us',
  'stratfordschools.net',
  'acsd.org',
  'my.cuhsd.org',
  'agustibarbera.cat',
  'st.homercenter.org',
];

function emailVerifySkipped(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  if (EMAIL_VERIFY_SKIP_EMAILS.includes(normalized)) return true;
  const domain = normalized.split('@')[1];
  return !!domain && EMAIL_VERIFY_SKIP_DOMAINS.includes(domain);
}

router.post('/send-code', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const normalized = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (isEmailBanned(normalized)) {
      return res.status(403).json({ error: 'This email address has been permanently banned.' });
    }
    if (emailVerifySkipped(normalized)) {
      return res.json({ ok: true, skipped: true, reason: 'blocked_domain' });
    }
    const existingUser = db.prepare(
      'SELECT id FROM users WHERE email IS NOT NULL AND LOWER(email) = ?'
    ).get(normalized);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const now = Date.now();
    const lastSent = db.prepare(
      'SELECT created_at FROM email_verification_codes WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1'
    ).get(normalized);
    if (lastSent && (now - lastSent.created_at) < VERIFY_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((VERIFY_RESEND_COOLDOWN_MS - (now - lastSent.created_at)) / 1000);
      return res.status(429).json({ error: `Please wait ${wait} seconds before requesting another code.`, retry_after: wait });
    }

    const code = generateVerifyCode();
    const expiresAt = now + VERIFY_CODE_TTL_MS;
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip || '').trim() || null;

    db.prepare('UPDATE email_verification_codes SET used = 1 WHERE LOWER(email) = ? AND used = 0')
      .run(normalized);
    db.prepare(
      'INSERT INTO email_verification_codes (email, code, created_at, expires_at, used, ip) VALUES (?, ?, ?, ?, 0, ?)'
    ).run(normalized, code, now, expiresAt, ip);

    const { html, text } = buildVerificationCodeEmail({ code });
    const result = await sendEmail({
      to: normalized,
      subject: `${code} — JimmyQrg Chat verification code`,
      html,
      text,
    });
    if (!result.ok) {
      console.error('[send-code] email delivery failed:', result.error);
      return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
    }
    res.json({ ok: true, expires_in: Math.round(VERIFY_CODE_TTL_MS / 1000) });
  } catch (err) {
    console.error('[send-code] error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/report-blocked-email', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const normalized = String(email).trim().toLowerCase();
    const domain = normalized.split('@')[1] || '';
    await sendEmail({
      to: 'ikunbeautiful@gmail.com',
      subject: 'Blocked email report: ' + normalized,
      html: '<p>A user reported they cannot receive mail at: <strong>' + normalized + '</strong></p><p>Domain: <strong>' + domain + '</strong></p><p>If their organization blocks external mail, consider adding this domain to the blocked-email bypass list.</p>',
      text: 'A user reported they cannot receive mail at: ' + normalized + '\nDomain: ' + domain,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[report-blocked-email]', err);
    res.status(500).json({ error: 'Failed to send report.' });
  }
});

router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password, display_name, recaptcha_token, email_code } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'Username, email and password required' });
    if (process.env.RECAPTCHA_SECRET_KEY && !wantsToken(req)) {
      const recaptcha = await verifyRecaptcha(recaptcha_token);
      if (!recaptcha.success) {
        return res.status(400).json({ error: 'Please complete the reCAPTCHA check.' });
      }
    }

    const normalized = String(email).trim().toLowerCase();
    if (!emailVerifySkipped(normalized)) {
      if (!email_code) return res.status(400).json({ error: 'Verification code is required' });
      const codeRow = db.prepare(
        'SELECT rowid, code, expires_at, used FROM email_verification_codes WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1'
      ).get(normalized);
      if (!codeRow || codeRow.used) {
        return res.status(400).json({ error: 'No verification code found. Please request a new one.' });
      }
      if (Date.now() > codeRow.expires_at) {
        return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
      }
      if (String(email_code).trim() !== codeRow.code) {
        return res.status(400).json({ error: 'Incorrect verification code.' });
      }
      db.prepare('UPDATE email_verification_codes SET used = 1 WHERE rowid = ?').run(codeRow.rowid);
    }

    const result = await register(username, email, password, display_name);
    if (result.error) return res.status(400).json({ error: result.error });
    req.session.userId = result.user.id;
    const extras = wantsToken(req) ? { token: issueToken(result.user.id, 'register') } : {};
    req.session.save(() => res.json({ user: result.user, account_key: result.accountKey, ...extras }));
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, email, identifier, login_id, password } = req.body || {};
    const usernameOrEmail = (identifier || login_id || username || email || '').toString().trim();
    if (!usernameOrEmail || !password) return res.status(400).json({ error: 'Username or email and password required' });
    const result = await login(usernameOrEmail, password);
    if (result.error) return res.status(200).json({ error: result.error });
    const frozen = db.prepare('SELECT account_frozen FROM users WHERE id = ?').get(result.user.id);
    if (frozen && frozen.account_frozen) {
      return res.status(200).json({ error: 'This account is frozen. Use Recover Account with your payment key to unfreeze it.', frozen: true });
    }
    req.session.userId = result.user.id;
    // Refresh the premium tier in the background so the first Venory message of
    // the session already sees the right limits (a stale/missing cache would
    // otherwise apply the free tier until the next refresh).
    refreshUserTier(result.user).catch(() => {});
    const extras = wantsToken(req) ? { token: issueToken(result.user.id, 'login') } : {};
    req.session.save(() => res.json({ user: result.user, ...extras }));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  const token = extractToken(req);
  if (token) revokeToken(token);
  req.session.destroy(() => res.json({ ok: true }));
});

/** Explicit token exchange for clients that started with a cookie session or want a fresh token. */
router.post('/token', requireAuth, (req, res) => {
  const label = (req.body?.label || '').toString().slice(0, 64) || 'api';
  const token = issueToken(req.session.userId, label);
  res.json({ token });
});

/** SSO handoff from an external site (e.g. perfectnip.github.io). Presenting a valid bearer token
 *  elevates this request into a first-party session cookie so the chat SPA then works normally.
 *  POST form is for fetch() handoff from the SPA; GET form is a full-page redirect landing. */
router.post('/sso', (req, res) => {
  const token = (req.body?.token || '').toString();
  if (!token) return res.status(400).json({ error: 'token required' });
  const userId = resolveToken(token);
  if (!userId) return res.status(401).json({ error: 'invalid token' });
  req.session.userId = userId;
  req.session.save(() => res.json({ ok: true, userId }));
});

router.get('/sso', (req, res) => {
  const token = (req.query?.sso || req.query?.token || '').toString();
  const next = (req.query?.next || '/').toString();
  const safeNext = typeof next === 'string' && next.startsWith('/') ? next : '/';
  if (!token) return res.redirect(safeNext);
  const userId = resolveToken(token);
  if (!userId) return res.redirect(safeNext);
  req.session.userId = userId;
  req.session.save(() => res.redirect(safeNext));
});

router.get('/me', (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user: user || null });
});

/**
 * Request a password reset link by email or username.
 *
 * Returns 200 with a generic success message in every case (whether or not
 * an account exists with the given identifier). This avoids leaking which
 * usernames / emails are registered. Real errors (bad input shape, server
 * error) still return non-200 so the client can show them.
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { identifier, recaptcha_token } = req.body || {};
    const trimmed = String(identifier || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Username or email required' });
    if (process.env.RECAPTCHA_SECRET_KEY) {
      const recaptcha = await verifyRecaptcha(recaptcha_token);
      if (!recaptcha.success) {
        return res.status(400).json({ error: 'Please complete the reCAPTCHA check.' });
      }
    }
    if (shouldThrottleReset(req, trimmed)) {
      return res.status(429).json({ error: 'Too many reset requests. Try again later.' });
    }

    const lowered = trimmed.toLowerCase();
    if (lowered.includes('@') && isEmailBanned(lowered)) {
      // Banned emails get the same generic response so they can't probe the ban list.
      return res.json({ ok: true, sent: false, generic: true });
    }

    const user = db.prepare(
      `SELECT id, username, display_name, email, deleted_at FROM users
        WHERE LOWER(username) = ? OR (email IS NOT NULL AND LOWER(email) = ?)`
    ).get(lowered, lowered);

    // Always respond the same way externally so a stranger can't enumerate
    // accounts. Only act internally when we have a real user with an email.
    if (user && user.email && !user.deleted_at) {
      try {
        // Invalidate any prior outstanding tokens for this user so each
        // request supersedes the last one.
        db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
          .run(Date.now(), user.id);

        const token = generateResetToken();
        const now = Date.now();
        const expiresAt = now + RESET_TOKEN_TTL_MS;
        const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip || '').trim() || null;
        db.prepare(`
          INSERT INTO password_reset_tokens (token, user_id, email, created_at, expires_at, used_at, ip)
          VALUES (?, ?, ?, ?, ?, NULL, ?)
        `).run(token, user.id, user.email, now, expiresAt, ip);

        const baseUrl = getPublicBaseUrl(req);
        const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        const { html, text } = buildResetEmail({
          displayName: user.display_name || user.username,
          resetUrl,
          expiresMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
        });
        const sendResult = await sendEmail({
          to: user.email,
          subject: 'Reset your JimmyQrg Chat password',
          html,
          text,
        });
        recordAuditLog('password.reset_requested', user.id, user.id, {
          email: user.email,
          delivered: sendResult.ok,
          provider: sendResult.provider,
          ip,
        });
        if (!sendResult.ok) {
          // Log the link so jimmyqrg can forward it manually until SMTP/Resend is set up.
          console.warn(`[forgot-password] Email NOT delivered (${sendResult.error}). Manual reset link for ${user.username} (${user.email}): ${resetUrl}`);
        }
      } catch (err) {
        console.error('[forgot-password] failed to issue token for', user?.id, err);
      }
    }

    res.json({ ok: true, sent: true, generic: true });
  } catch (err) {
    console.error('[forgot-password] error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Validate a reset token and return whose account it belongs to (so the UI
 *  can show a friendly "Resetting password for X" header). */
router.get('/reset-password/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Token required' });
  const row = db.prepare(`
    SELECT t.token, t.user_id, t.email, t.expires_at, t.used_at,
           u.username, u.display_name, u.deleted_at
    FROM password_reset_tokens t
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.token = ?
  `).get(token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (row.used_at) return res.status(410).json({ error: 'This link has already been used' });
  if (row.expires_at <= Date.now()) return res.status(410).json({ error: 'This link has expired' });
  if (row.deleted_at) return res.status(410).json({ error: 'This account has been deleted' });
  res.json({
    ok: true,
    username: row.username,
    display_name: row.display_name,
    email_hint: row.email ? row.email.replace(/^(.).+(@.+)$/, '$1***$2') : null,
  });
});

/** Apply a password reset using a previously emailed token. */
router.post('/reset-password', async (req, res) => {
  const { token, password, recaptcha_token } = req.body || {};
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return res.status(400).json({ error: 'Token required' });
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (process.env.RECAPTCHA_SECRET_KEY) {
    const recaptcha = await verifyRecaptcha(recaptcha_token);
    if (!recaptcha.success) {
      return res.status(400).json({ error: 'Please complete the reCAPTCHA check.' });
    }
  }
  const row = db.prepare(`
    SELECT t.token, t.user_id, t.expires_at, t.used_at, u.deleted_at, u.username
    FROM password_reset_tokens t
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.token = ?
  `).get(cleanToken);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (row.used_at) return res.status(410).json({ error: 'This link has already been used' });
  if (row.expires_at <= Date.now()) return res.status(410).json({ error: 'This link has expired' });
  if (row.deleted_at) return res.status(410).json({ error: 'This account has been deleted' });

  const result = resetPassword(row.user_id, String(password));
  if (result.error) return res.status(400).json({ error: result.error });
  db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token = ?').run(Date.now(), cleanToken);
  // Invalidate every other outstanding token for this user — only the most
  // recent reset attempt should remain valid.
  db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .run(Date.now(), row.user_id);
  recordAuditLog('password.reset_completed', row.user_id, row.user_id, { username: row.username });
  res.json({ ok: true });
});

/* ====================================================================
 * Account-key view (logged-in user, gated by 6-digit email code)
 * ==================================================================*/

function requestIp(req) {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip || '').trim() || null;
}
function requestUa(req) {
  return String(req.headers['user-agent'] || '').slice(0, 255) || null;
}

/** For users whose account predates the recovery-key feature `account_key`
 *  is NULL. Generate one transparently on first request. The atomic
 *  UPDATE … WHERE account_key IS NULL guards against two concurrent
 *  requests racing to overwrite each other. */
function ensureAccountKeyExists(userId) {
  const row = db.prepare('SELECT account_key FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  if (row.account_key) return row.account_key;
  const newKey = generateAccountKey();
  const result = db.prepare('UPDATE users SET account_key = ? WHERE id = ? AND account_key IS NULL').run(newKey, userId);
  if (result.changes > 0) return newKey;
  // Lost a race: another request generated one in parallel. Re-read.
  const fresh = db.prepare('SELECT account_key FROM users WHERE id = ?').get(userId);
  return fresh ? fresh.account_key : null;
}

router.post('/account-key/request-view', async (req, res) => {
  try {
    const userId = req.session?.userId
      || (extractToken(req) ? resolveToken(extractToken(req)) : null);
    if (!userId) return res.status(401).json({ error: 'Sign in to view your account key.' });
    const user = db.prepare('SELECT id, username, email, account_key FROM users WHERE id = ?').get(userId);
    if (!user || !user.email) return res.status(400).json({ error: 'No email on file for this account.' });
    // Backfill key for legacy accounts (account_key column was added later).
    // We do this BEFORE sending the code so that even if the user closes
    // the page after the email arrives the key is already persisted.
    if (!user.account_key) {
      const ensured = ensureAccountKeyExists(userId);
      if (!ensured) return res.status(500).json({ error: 'Failed to provision account key.' });
    }

    const ip = requestIp(req);
    const lastSent = db.prepare(
      "SELECT created_at FROM auth_email_codes WHERE user_id = ? AND purpose = 'view_account_key' ORDER BY created_at DESC LIMIT 1"
    ).get(userId);
    if (lastSent && (Date.now() - lastSent.created_at) < VERIFY_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((VERIFY_RESEND_COOLDOWN_MS - (Date.now() - lastSent.created_at)) / 1000);
      return res.status(429).json({ error: `Please wait ${wait} seconds before requesting another code.`, retry_after: wait });
    }

    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    const now = Date.now();
    db.prepare("UPDATE auth_email_codes SET used_at = ? WHERE user_id = ? AND purpose = 'view_account_key' AND used_at IS NULL")
      .run(now, userId);
    db.prepare('INSERT INTO auth_email_codes (user_id, email, code, purpose, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, user.email, code, 'view_account_key', now, now + VERIFY_CODE_TTL_MS, ip);

    const { html, text } = buildAccountKeyViewEmail({ code });
    const r = await sendEmail({
      to: user.email,
      subject: `${code} \u2014 view your JimmyQrg account key`,
      html, text,
    });
    if (!r.ok) {
      console.error('[account-key/request-view] email failed:', r.error);
      return res.status(500).json({ error: 'Failed to send verification email.' });
    }
    res.json({ ok: true, expires_in: Math.round(VERIFY_CODE_TTL_MS / 1000) });
  } catch (err) {
    console.error('[account-key/request-view]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/account-key/view', async (req, res) => {
  try {
    const userId = req.session?.userId
      || (extractToken(req) ? resolveToken(extractToken(req)) : null);
    if (!userId) return res.status(401).json({ error: 'Sign in to view your account key.' });
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });

    const row = db.prepare(
      "SELECT id, code, expires_at, used_at FROM auth_email_codes WHERE user_id = ? AND purpose = 'view_account_key' ORDER BY created_at DESC LIMIT 1"
    ).get(userId);
    if (!row || row.used_at) return res.status(400).json({ error: 'No code request found. Please request a new code.' });
    if (Date.now() > row.expires_at) return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    if (row.code !== code) return res.status(400).json({ error: 'Incorrect code.' });
    db.prepare('UPDATE auth_email_codes SET used_at = ? WHERE id = ?').run(Date.now(), row.id);

    const key = ensureAccountKeyExists(userId);
    if (!key) return res.status(404).json({ error: 'No account key.' });
    res.json({ ok: true, account_key: key });
  } catch (err) {
    console.error('[account-key/view]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/* ====================================================================
 * Account recovery flow
 * ==================================================================*/

const _recoveryRateLimiter = new Map();
function recoveryThrottled(req) {
  const ip = requestIp(req) || 'unknown';
  const now = Date.now();
  const arr = (_recoveryRateLimiter.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (arr.length >= RECOVERY_ATTEMPT_LIMIT_PER_HOUR) return true;
  arr.push(now);
  _recoveryRateLimiter.set(ip, arr);
  return false;
}

function recordAttempt({ userId, kind, outcome, req, detail }) {
  try {
    db.prepare('INSERT INTO recovery_attempts (user_id, kind, outcome, ip, user_agent, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId || null, kind, outcome, requestIp(req), requestUa(req), detail ? JSON.stringify(detail) : null, Date.now());
  } catch (_) {}
}

async function notifyAccountEmails({ userId, outcome, kind, req }) {
  try {
    const user = db.prepare('SELECT email, username FROM users WHERE id = ?').get(userId);
    if (!user || !user.email) return;
    const { html, text } = buildRecoveryAttemptEmail({
      outcome, kind, ip: requestIp(req), ua: requestUa(req), username: user.username,
    });
    await sendEmail({
      to: user.email,
      subject: outcome === 'success'
        ? `JimmyQrg: your account was recovered`
        : `JimmyQrg: failed account recovery attempt`,
      html, text,
    });
  } catch (err) {
    console.warn('[notifyAccountEmails] failed:', err?.message || err);
  }
}

function newRecoverySession({ userId, recognition, req, claimedEmail = null }) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO recovery_sessions (token, user_id, stage, recognition, created_at, expires_at, ip, claimed_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(token, userId, recognition === 'full' ? 'awaiting_password' : 'awaiting_email_code', recognition, now, now + RECOVERY_SESSION_TTL_MS, requestIp(req), claimedEmail);
  return token;
}

function loadRecoverySession(token) {
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare('SELECT token, user_id, stage, recognition, expires_at, claimed_email FROM recovery_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    try { db.prepare('DELETE FROM recovery_sessions WHERE token = ?').run(token); } catch (_) {}
    return null;
  }
  return row;
}

/** Mask an email like ikunbeautiful@gmail.com -> i**********ul@gmail.com.
 *  Always shows last 2 chars of the local part. Domain shown only if it is
 *  a well-known provider (so attackers don't get hints for niche domains). */
const COMMON_EMAIL_DOMAINS = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'me.com', 'aol.com', 'protonmail.com', 'proton.me', 'live.com',
  'msn.com', 'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com',
  'yandex.com', 'yandex.ru', 'mail.com', 'gmx.com', 'gmx.de',
  'fastmail.com', 'tutanota.com', 'zoho.com', 'duck.com',
]);
function maskEmail(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  let visibleLocal;
  if (local.length <= 2) {
    visibleLocal = '*'.repeat(local.length);
  } else {
    visibleLocal = local[0] + '*'.repeat(Math.max(1, local.length - 3)) + local.slice(-2);
  }
  const showDomain = COMMON_EMAIL_DOMAINS.has(domain);
  return showDomain ? `${visibleLocal}@${domain}` : `${visibleLocal}@***`;
}

async function tryPaymentKey(rawKey) {
  const url = process.env.WORKER_BASE_URL;
  const secret = process.env.WORKER_RECOVERY_SECRET;
  if (!url || !secret) return null;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/v1/payment-key/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Recovery-Secret': secret,
      },
      body: JSON.stringify({ key: rawKey }),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d || !d.valid || !d.user_id) return null;
    return d.user_id;
  } catch {
    return null;
  }
}

router.post('/recover/start', async (req, res) => {
  try {
    if (recoveryThrottled(req)) return res.status(429).json({ error: 'Too many recovery attempts. Try again later.' });
    const rawKey = String(req.body?.key || '').trim();
    if (!rawKey || rawKey.length < 20 || rawKey.length > 80) {
      return res.status(400).json({ error: 'That does not look like a valid recovery key.' });
    }

    // Always cross-check against the worker so a key that happens to be a
    // valid payment key (full recognition) wins over an account-key match
    // (half recognition), even though collisions between 40-char random
    // keys are computationally impossible. This is defense-in-depth: every
    // key submission is validated by BOTH backends.
    const paymentUserId = await tryPaymentKey(rawKey);

    const accountUser = db.prepare(
      'SELECT id, username, email, account_frozen, deleted_at FROM users WHERE account_key = ?'
    ).get(rawKey);

    if (accountUser && paymentUserId && accountUser.id === paymentUserId) {
      // Same user matches both keys: prefer full recognition.
      if (accountUser.deleted_at) {
        recordAttempt({ userId: accountUser.id, kind: 'payment_key', outcome: 'failure', req, detail: { reason: 'account_deleted' } });
        return res.status(410).json({ error: 'This account has been deleted.' });
      }
      const token = newRecoverySession({ userId: accountUser.id, recognition: 'full', req });
      return res.json({
        recognition: 'full',
        recovery_token: token,
        username: accountUser.username,
        frozen: !!accountUser.account_frozen,
        message: 'Payment key accepted. You can immediately set a new password.',
      });
    }

    if (accountUser) {
      if (accountUser.deleted_at) {
        recordAttempt({ userId: accountUser.id, kind: 'account_key', outcome: 'failure', req, detail: { reason: 'account_deleted' } });
        return res.status(410).json({ error: 'This account has been deleted.' });
      }
      if (accountUser.account_frozen) {
        recordAttempt({ userId: accountUser.id, kind: 'account_key', outcome: 'failure', req, detail: { reason: 'account_frozen_needs_payment_key' } });
        return res.status(403).json({
          error: 'This account is frozen. To unfreeze it you must use the payment key, not the account key.',
          frozen: true,
        });
      }
      const token = newRecoverySession({ userId: accountUser.id, recognition: 'half', req });
      return res.json({
        recognition: 'half',
        recovery_token: token,
        username: accountUser.username,
        frozen: !!accountUser.account_frozen,
        message: 'Account key accepted. To complete recovery you still need to receive a code at the email on file.',
      });
    }

    if (paymentUserId) {
      const user = db.prepare('SELECT id, username, email, deleted_at, account_frozen FROM users WHERE id = ?').get(paymentUserId);
      if (!user) {
        recordAttempt({ userId: null, kind: 'payment_key', outcome: 'failure', req, detail: { reason: 'no_user' } });
        return res.status(404).json({ error: 'No matching account found.' });
      }
      if (user.deleted_at) {
        recordAttempt({ userId: user.id, kind: 'payment_key', outcome: 'failure', req, detail: { reason: 'account_deleted' } });
        return res.status(410).json({ error: 'This account has been deleted.' });
      }
      const token = newRecoverySession({ userId: user.id, recognition: 'full', req });
      return res.json({
        recognition: 'full',
        recovery_token: token,
        username: user.username,
        frozen: !!user.account_frozen,
        message: 'Payment key accepted. You can immediately set a new password.',
      });
    }

    recordAttempt({ userId: null, kind: 'unknown', outcome: 'failure', req, detail: { reason: 'no_match' } });
    return res.status(404).json({ recognition: 'none', error: 'We could not match that key to any account.' });
  } catch (err) {
    console.error('[recover/start]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/recover/email-hint', async (req, res) => {
  const session = loadRecoverySession(String(req.body?.recovery_token || ''));
  if (!session) return res.status(400).json({ error: 'Recovery session expired. Start again.' });
  if (session.recognition !== 'half') return res.status(400).json({ error: 'Email hints are only for half-recognized recoveries.' });
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(session.user_id);
  if (!user || !user.email) return res.json({ hint: '' });
  res.json({ hint: maskEmail(user.email) });
});

router.post('/recover/send-code', async (req, res) => {
  try {
    const session = loadRecoverySession(String(req.body?.recovery_token || ''));
    if (!session) return res.status(400).json({ error: 'Recovery session expired. Start again.' });
    if (session.recognition !== 'half') return res.status(400).json({ error: 'Code emails are only for half-recognized recoveries.' });
    const claimedEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claimedEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });

    const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(session.user_id);
    if (!user) return res.status(404).json({ error: 'Account no longer exists.' });

    db.prepare('UPDATE recovery_sessions SET claimed_email = ? WHERE token = ?')
      .run(claimedEmail, session.token);

    const matches = (user.email || '').toLowerCase() === claimedEmail;
    if (!matches) {
      recordAttempt({ userId: user.id, kind: 'account_key', outcome: 'failure', req, detail: { reason: 'wrong_email', claimed: claimedEmail } });
      await notifyAccountEmails({ userId: user.id, outcome: 'failure', kind: 'account_key', req });
      return res.status(400).json({ error: 'That email does not match the address on file. If your email was changed or is inaccessible, use the payment key option below.' });
    }

    if (emailVerifySkipped(user.email)) {
      db.prepare("UPDATE recovery_sessions SET recognition = 'full' WHERE token = ?").run(session.token);
      return res.json({ ok: true, skipped: true, reason: 'blocked_domain' });
    }

    const lastSent = db.prepare(
      "SELECT created_at FROM auth_email_codes WHERE user_id = ? AND purpose = 'recover_account' ORDER BY created_at DESC LIMIT 1"
    ).get(user.id);
    if (lastSent && (Date.now() - lastSent.created_at) < VERIFY_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((VERIFY_RESEND_COOLDOWN_MS - (Date.now() - lastSent.created_at)) / 1000);
      return res.status(429).json({ error: `Please wait ${wait} seconds before requesting another code.`, retry_after: wait });
    }

    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    const now = Date.now();
    db.prepare("UPDATE auth_email_codes SET used_at = ? WHERE user_id = ? AND purpose = 'recover_account' AND used_at IS NULL")
      .run(now, user.id);
    db.prepare('INSERT INTO auth_email_codes (user_id, email, code, purpose, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.email, code, 'recover_account', now, now + VERIFY_CODE_TTL_MS, requestIp(req));

    const { html, text } = buildRecoveryCodeEmail({ code, ip: requestIp(req), username: user.username });
    const r = await sendEmail({
      to: user.email,
      subject: `${code} \u2014 JimmyQrg account recovery code`,
      html, text,
    });
    if (!r.ok) {
      console.error('[recover/send-code] email failed:', r.error);
      return res.status(500).json({ error: 'Failed to send recovery email.' });
    }
    res.json({ ok: true, expires_in: Math.round(VERIFY_CODE_TTL_MS / 1000) });
  } catch (err) {
    console.error('[recover/send-code]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/recover/complete', async (req, res) => {
  try {
    const session = loadRecoverySession(String(req.body?.recovery_token || ''));
    if (!session) return res.status(400).json({ error: 'Recovery session expired. Start again.' });
    const newPassword = String(req.body?.new_password || '');
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    const code = String(req.body?.code || '').trim();

    const user = db.prepare('SELECT id, username, email, account_frozen FROM users WHERE id = ?').get(session.user_id);
    if (!user) return res.status(404).json({ error: 'Account no longer exists.' });
    if (user.account_frozen && session.recognition !== 'full') {
      return res.status(403).json({ error: 'This account is frozen and can only be unfrozen with a payment key.', frozen: true });
    }

    if (session.recognition === 'half') {
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code we emailed you.' });
      const row = db.prepare(
        "SELECT id, code, expires_at, used_at FROM auth_email_codes WHERE user_id = ? AND purpose = 'recover_account' ORDER BY created_at DESC LIMIT 1"
      ).get(user.id);
      if (!row || row.used_at) {
        recordAttempt({ userId: user.id, kind: 'account_key', outcome: 'failure', req, detail: { reason: 'no_code' } });
        await notifyAccountEmails({ userId: user.id, outcome: 'failure', kind: 'account_key', req });
        return res.status(400).json({ error: 'No code request found. Please request a new code.' });
      }
      if (Date.now() > row.expires_at) {
        recordAttempt({ userId: user.id, kind: 'account_key', outcome: 'failure', req, detail: { reason: 'code_expired' } });
        await notifyAccountEmails({ userId: user.id, outcome: 'failure', kind: 'account_key', req });
        return res.status(400).json({ error: 'Code expired. Please request a new one.' });
      }
      if (row.code !== code) {
        recordAttempt({ userId: user.id, kind: 'account_key', outcome: 'failure', req, detail: { reason: 'wrong_code' } });
        await notifyAccountEmails({ userId: user.id, outcome: 'failure', kind: 'account_key', req });
        return res.status(400).json({ error: 'Incorrect code.' });
      }
      db.prepare('UPDATE auth_email_codes SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
    } else if (session.recognition !== 'full') {
      return res.status(400).json({ error: 'Invalid recovery state.' });
    }

    const result = resetPassword(user.id, newPassword);
    if (result.error) return res.status(400).json({ error: result.error });
    db.prepare('DELETE FROM recovery_sessions WHERE token = ?').run(session.token);
    db.prepare('UPDATE users SET account_frozen = 0 WHERE id = ?').run(user.id);

    const newKey = generateAccountKey();
    db.prepare('UPDATE users SET account_key = ? WHERE id = ?').run(newKey, user.id);

    recordAttempt({ userId: user.id, kind: session.recognition === 'full' ? 'payment_key' : 'account_key', outcome: 'success', req });
    await notifyAccountEmails({ userId: user.id, outcome: 'success', kind: session.recognition === 'full' ? 'payment_key' : 'account_key', req });

    const token = issueToken(user.id, 'recover');
    req.session.userId = user.id;
    req.session.save(() => res.json({
      ok: true,
      user: { id: user.id, username: user.username, email: user.email },
      token,
      account_key: newKey,
    }));
  } catch (err) {
    console.error('[recover/complete]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/recover/freeze', async (req, res) => {
  try {
    const session = loadRecoverySession(String(req.body?.recovery_token || ''));
    if (!session) return res.status(400).json({ error: 'Recovery session expired.' });
    db.prepare('UPDATE users SET account_frozen = 1 WHERE id = ?').run(session.user_id);
    db.prepare('DELETE FROM recovery_sessions WHERE token = ?').run(session.token);
    recordAttempt({ userId: session.user_id, kind: 'freeze', outcome: 'success', req });
    await notifyAccountEmails({ userId: session.user_id, outcome: 'failure', kind: 'account_key', req });
    res.json({ ok: true, frozen: true });
  } catch (err) {
    console.error('[recover/freeze]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
