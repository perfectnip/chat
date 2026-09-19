import { Router } from 'express';
import { requireAuth, getCurrentUser } from '../auth.js';
import { db } from '../db.js';

const router = Router();

// First Anniversary quiz — reward tracking & scoring. Lives on the jchat
// server instead of the Cloudflare Worker (which can't be redeployed).

// Release gate. Flip to true on release day (keep in sync with the frontend
// ANNIV_PENDING flag). While false, only jimmyqrg can submit, in test mode.
const ANNIVERSARY_RELEASED = false;

// Tables (idempotent).
db.exec(`
  CREATE TABLE IF NOT EXISTS anniversary_submissions (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    score INTEGER NOT NULL,
    reward TEXT NOT NULL,
    rank INTEGER NOT NULL,
    ts INTEGER NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS anniversary_counter (
    id INTEGER PRIMARY KEY,
    value INTEGER NOT NULL
  )
`);

const DAY = 86400;

// Answer key lives in a Fly secret (ANNIVERSARY_KEY = JSON object) so the
// correct answers are NOT in this public repo.
function getAnniversaryKey() {
  try {
    const raw = process.env.ANNIVERSARY_KEY;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) { return null; }
}

// Best-tier-wins ladder. rank = global submission order (1-based).
function annivRewardFor(rank, score) {
  if (score >= 9 && rank <= 5)   return 'PERMANENT PREMIUM PLUS';
  if (score >= 9 && rank <= 20)  return '30-day Premium Plus, then permanent Premium';
  if (score === 8 && rank <= 20) return '1-year Premium';
  if (score >= 6 && score <= 7 && rank <= 50) return '4-month Premium';
  if (score === 5 && rank <= 100) return '2-month Premium';
  return '1-month Premium';
}

router.post('/submit', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'auth_required' });

  const isAdmin = (user.username || '').toLowerCase() === 'jimmyqrg';
  const isTest = !ANNIVERSARY_RELEASED;

  if (isTest && !isAdmin) {
    return res.status(403).json({ error: 'not_released', message: 'The anniversary game is not open yet.' });
  }

  const key = getAnniversaryKey();
  if (!key) {
    return res.status(503).json({ error: 'not_configured', message: 'Anniversary quiz is not configured.' });
  }

  const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
  const seen = new Set();
  let score = 0;
  for (const a of answers) {
    if (!a || typeof a.q !== 'string' || typeof a.a !== 'string') continue;
    if (seen.has(a.q)) continue;
    seen.add(a.q);
    if (key[a.q] === a.a) score++;
  }

  if (isTest) {
    const reward = annivRewardFor(1, score);
    return res.json({ result: 'ok', score, reward, mode: 'test', rank_preview: 1 });
  }

  // Released: one submission per account.
  const existing = db.prepare('SELECT rank, score, reward FROM anniversary_submissions WHERE user_id = ?').get(user.id);
  if (existing) {
    return res.json({ result: 'already_submitted', rank: existing.rank, score: existing.score, reward: existing.reward });
  }

  // Global rank via a counter (better-sqlite3 is synchronous, so this is atomic).
  const counter = db.prepare('SELECT value FROM anniversary_counter WHERE id = 1').get();
  const rank = (counter ? counter.value : 0) + 1;
  db.prepare('INSERT OR REPLACE INTO anniversary_counter (id, value) VALUES (1, ?)').run(rank);

  const reward = annivRewardFor(rank, score);
  db.prepare('INSERT INTO anniversary_submissions (user_id, username, score, reward, rank, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, user.username, score, reward, rank, Date.now());

  return res.json({ result: 'ok', rank, score, reward });
});

export default router;
