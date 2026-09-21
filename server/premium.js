// Premium tiers for the chat app.
//
// The canonical billing identity IS the chat account: the Cloudflare Worker
// that runs Stripe resolves users through OUR `/api/auth/me` (AUTH_SERVER =
// discord.jimmyqrg.com), so a chat user id is the same id the subscription
// is keyed on. That means we can ask the worker for the authoritative state
// (`GET /v1/subscription-status` with a bearer token) instead of keeping a
// second copy of the billing data.
//
// Tier sources, best-wins:
//   1. owner (jimmyqrg)                       -> plus  (always, so he can test)
//   2. first-anniversary reward (chat DB)     -> plus | premium
//   3. worker subscription / admin / comp     -> plus | premium
//   4. otherwise                              -> free
//
// Resolution is CACHE-BACKED and synchronous at call sites: `getUserTier()`
// returns the cached value immediately and schedules a refresh in the
// background when the cache is stale, so message sending never waits on the
// network. `refreshUserTier()` is awaited at login and from the premium API.
import { db } from './db.js';
import { issueToken } from './tokens.js';

/** Worker that owns Stripe + subscription state (same one the main site uses). */
const WORKER_URL = (process.env.JQRG_PREMIUM_WORKER_URL || 'https://deepseek-proxy.ikunbeautiful.workers.dev').replace(/\/+$/, '');

/** How long a cached tier is trusted before we refresh in the background. */
const TIER_TTL_MS = Number(process.env.JQRG_TIER_TTL_MS || 30 * 60 * 1000);

/** Owner always gets the top tier so premium-gated features stay testable. */
const OWNER_USERNAME = 'jimmyqrg';

/** Hard cap on tokens we will ever put in front of the model. The TIER budget
 *  is a memory/compaction target, but the DeepSeek API has its own window, so
 *  the assembled prompt is additionally clamped to this. */
export const HELPER_MODEL_INPUT_TOKENS = Number(process.env.HELPER_MODEL_INPUT_TOKENS || 48000);

export const TIERS = ['free', 'premium', 'plus'];

/** What each tier gets. `dailyMessages: null` = unlimited. */
export const TIER_LIMITS = {
  free:    { dailyMessages: 30,   uploads: false, contextTokens: 10000 },
  premium: { dailyMessages: 100,  uploads: true,  contextTokens: 100000 },
  plus:    { dailyMessages: null, uploads: true,  contextTokens: 1000000 },
};

export function tierLimits(tier) {
  return TIER_LIMITS[TIERS.includes(tier) ? tier : 'free'];
}

/** Rank for best-wins comparisons (higher = better). */
export function tierRank(tier) {
  return tier === 'plus' ? 2 : tier === 'premium' ? 1 : 0;
}

export function bestTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/* ── Anniversary rewards (stored in OUR db by /api/anniversary/submit) ─── */

/** Map a reward string like "30-day Premium Plus, then permanent Premium"
 *  to the tier it grants right now. Time-boxed lower tiers are treated as
 *  their granted tier; the worker owns when they actually expire. */
function anniversaryTier(userId) {
  if (!userId) return null;
  let reward = '';
  try {
    const row = db.prepare('SELECT reward FROM anniversary_submissions WHERE user_id = ?').get(userId);
    reward = row?.reward || '';
  } catch (_) {
    return null;   // table may not exist yet during boot
  }
  if (!reward) return null;
  if (/premium plus/i.test(reward)) return 'plus';
  if (/premium/i.test(reward)) return 'premium';
  return null;
}

/* ── Subscription cache ────────────────────────────────────────────────
 * One row per user: the last tier we resolved and when. A stale row is
 * refreshed in the background; a missing row means "not resolved yet".
 * -------------------------------------------------------------------*/

function readCachedTier(userId) {
  if (!userId) return null;
  try {
    return db.prepare('SELECT tier, source, checked_at FROM user_tiers WHERE user_id = ?').get(userId) || null;
  } catch (_) {
    return null;
  }
}

function writeCachedTier(userId, tier, source) {
  if (!userId || !TIERS.includes(tier)) return;
  try {
    db.prepare(`INSERT INTO user_tiers (user_id, tier, source, checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET tier=excluded.tier, source=excluded.source, checked_at=excluded.checked_at`)
      .run(userId, tier, source || 'worker', Date.now());
  } catch (_) { /* cache write is best-effort */ }
}

/* ── Worker lookup ───────────────────────────────────────────────────── */

/** Ask the worker for this user's subscription. Returns { tier, status } or
 *  null when the worker is unreachable / the token is rejected.
 *
 *  We mint a short-lived bearer token for the user rather than storing one:
 *  the worker resolves it through /api/auth/me just like a browser would. */
async function fetchWorkerSubscription(user) {
  if (!user?.id) return null;
  let token;
  try {
    token = issueToken(user.id, 'premium-check');
  } catch (_) {
    return null;
  }
  let res;
  try {
    res = await fetch(`${WORKER_URL}/v1/subscription-status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'jchat-server' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (_) {
    return null;   // network/worker failure -> keep whatever we had cached
  }
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch (_) { return null; }
  if (!data || typeof data !== 'object') return null;
  const status = String(data.status || 'none');
  // Admins are returned as active with no tier — treat them as top tier,
  // mirroring how the main site treats admin accounts.
  if (status === 'admin') return { tier: 'plus', status };
  if (data.active && data.tier) {
    return { tier: data.tier === 'plus' ? 'plus' : 'premium', status };
  }
  return { tier: 'free', status };
}

/* ── Public API ──────────────────────────────────────────────────────── */

/** Resolve and CACHE this user's tier (awaits the worker). Use at login and
 *  from the premium endpoints. Never throws. */
export async function refreshUserTier(user) {
  if (!user?.id) return 'free';
  const username = (user.username || '').toLowerCase();
  const local = bestTier(username === OWNER_USERNAME ? 'plus' : 'free', anniversaryTier(user.id) || 'free');
  if (local === 'plus') {
    writeCachedTier(user.id, 'plus', 'owner-or-anniversary');
    return 'plus';
  }
  const remote = await fetchWorkerSubscription(user);
  if (!remote) {
    // Worker down: keep the cached value if we have one, else local result.
    const cached = readCachedTier(user.id);
    return cached?.tier || local;
  }
  const tier = bestTier(local, remote.tier);
  writeCachedTier(user.id, tier, `worker:${remote.status}`);
  return tier;
}

const refreshing = new Set();

/** Synchronous tier read for hot paths (message send, normalizeUser).
 *
 *  Returns the best locally-known answer right now and kicks off a background
 *  refresh when the cache is stale or missing, so a user never waits on the
 *  worker to send a message. */
export function getUserTier(user) {
  if (!user?.id) return 'free';
  const username = (user.username || '').toLowerCase();
  const local = bestTier(username === OWNER_USERNAME ? 'plus' : 'free', anniversaryTier(user.id) || 'free');
  if (local === 'plus') return 'plus';      // owner/anniversary: no lookup needed

  const cached = readCachedTier(user.id);
  const fresh = cached && (Date.now() - Number(cached.checked_at || 0)) < TIER_TTL_MS;
  if (fresh) return cached.tier || local;

  if (!refreshing.has(user.id)) {
    refreshing.add(user.id);
    refreshUserTier(user).catch(() => {}).finally(() => refreshing.delete(user.id));
  }
  return cached?.tier || local;
}

/** Kept for older call sites that only care about the top tier. */
export function isPremiumPlus(userId, username) {
  return getUserTier({ id: userId, username }) === 'plus';
}

/** Does this tier allow uploading files to Venory? */
export function tierAllowsUploads(tier) {
  return !!tierLimits(tier).uploads;
}

/** Everything the client needs to render tier UI. */
export function tierInfo(user) {
  const tier = getUserTier(user);
  const limits = tierLimits(tier);
  return {
    tier,
    limits: {
      dailyMessages: limits.dailyMessages,
      uploads: limits.uploads,
      contextTokens: limits.contextTokens,
    },
  };
}

export { WORKER_URL as PREMIUM_WORKER_URL };
