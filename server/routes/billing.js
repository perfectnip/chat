// Billing / premium endpoints for the chat app.
//
// Stripe lives on the Cloudflare Worker that also fronts the main site's
// Venory, and that worker resolves users through THIS app's /api/auth/me — so
// a chat account is the billing identity. We therefore proxy the worker
// instead of duplicating any billing state:
//
//   GET  /api/premium/plans     -> prices + publishable key (from worker /v1/config)
//   GET  /api/premium/status    -> this user's tier, limits and today's usage
//   POST /api/premium/checkout  -> { clientSecret } for Stripe embedded checkout
//   POST /api/premium/portal    -> Stripe billing portal URL (manage/cancel)
//
// The bearer token the worker requires is minted HERE for the signed-in user
// and never reaches the browser, so the client only ever sees a clientSecret.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, getCurrentUser } from '../auth.js';
import { issueToken } from '../tokens.js';
import { tierInfo, refreshUserTier, PREMIUM_WORKER_URL, tierLimits } from '../premium.js';
import { helperQuotaStatus, quotaResetAt } from '../quotas.js';

const router = Router();

/** Publishable config is public; cache it so the modal opens instantly. */
let plansCache = { at: 0, data: null };
const PLANS_TTL_MS = 10 * 60 * 1000;

/** Worker with our fallback if /v1/config is briefly unavailable. Prices are
 *  display-only — the worker's Stripe price IDs are the real authority. */
const FALLBACK_PLANS = {
  stripe_publishable_key: null,
  tiers: {
    premium: { name: 'Premium', monthly: { price: '$5.99/mo', available: true }, yearly: { price: '$59.99/yr', available: true } },
    plus: { name: 'Premium Plus', monthly: { price: '$10.99/mo', available: false }, yearly: { price: '$80.99/yr', available: false } },
  },
};

async function fetchPlans() {
  if (plansCache.data && Date.now() - plansCache.at < PLANS_TTL_MS) return plansCache.data;
  try {
    const res = await fetch(`${PREMIUM_WORKER_URL}/v1/config`, {
      headers: { 'User-Agent': 'jchat-server' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.tiers) {
        plansCache = { at: Date.now(), data };
        return data;
      }
    }
  } catch (_) { /* fall through to the cached/fallback copy */ }
  return plansCache.data || FALLBACK_PLANS;
}

function mintTokenFor(user) {
  try {
    return issueToken(user.id, 'billing');
  } catch (err) {
    console.warn('[billing] token mint failed:', err?.message || err);
    return null;
  }
}

function appOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.headers.host}`;
}

/** What each tier includes, for the upgrade UI. Kept next to the enforcement
 *  constants in premium.js so the copy can't drift from the limits. */
function tierFeatureCopy() {
  return {
    free: { name: 'Free', features: ['30 Venory messages / day', 'No file uploads to Venory', '10k token memory'] },
    premium: { name: 'Premium', features: ['100 Venory messages / day', 'File uploads to Venory', '100k token memory'] },
    plus: { name: 'Premium Plus', features: ['Unlimited Venory messages', 'File uploads to Venory', '1M token memory'] },
  };
}

router.get('/plans', requireAuth, async (req, res) => {
  const plans = await fetchPlans();
  res.json({ ...plans, features: tierFeatureCopy() });
});

router.get('/status', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  // On-demand refresh: called when the client returns from checkout.
  if (req.query.refresh === '1') {
    await refreshUserTier(user);
  }
  const cached = db.prepare('SELECT tier, source, checked_at FROM user_tiers WHERE user_id = ?').get(user.id);
  res.json({
    ...tierInfo(user),
    source: cached?.source || null,
    checkedAt: cached?.checked_at || null,
    quota: { ...helperQuotaStatus(user), resetAt: quotaResetAt() },
    features: tierFeatureCopy(),
  });
});

router.post('/checkout', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const plan = req.body?.plan === 'yearly' ? 'yearly' : 'monthly';
  const tier = req.body?.tier === 'plus' ? 'plus' : 'premium';

  const token = mintTokenFor(user);
  if (!token) return res.status(500).json({ error: 'Could not authenticate to billing' });

  let upstream;
  try {
    upstream = await fetch(`${PREMIUM_WORKER_URL}/v1/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'jchat-server',
      },
      body: JSON.stringify({ tier, plan, return_url: `${appOrigin(req)}/?upgraded=1` }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    console.warn('[billing] checkout upstream failed:', err?.message || err);
    return res.status(502).json({ error: 'Billing service unreachable' });
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return res.status(upstream.status === 401 ? 401 : 400).json({
      error: data?.error || 'checkout_failed',
      message: data?.message || 'Could not start checkout',
    });
  }
  res.json({ clientSecret: data.clientSecret, id: data.id || null, tier, plan });
});

router.post('/portal', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const token = mintTokenFor(user);
  if (!token) return res.status(500).json({ error: 'Could not authenticate to billing' });
  let upstream;
  try {
    upstream = await fetch(`${PREMIUM_WORKER_URL}/v1/billing-portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'jchat-server' },
      body: JSON.stringify({ return_url: `${appOrigin(req)}/` }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Billing service unreachable' });
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !data?.url) {
    return res.status(upstream.status || 400).json({ error: data?.error || 'portal_failed', message: data?.message || 'No portal available' });
  }
  res.json({ url: data.url });
});

/** Effective per-tier limits, for the client's own pre-checks. */
router.get('/limits', requireAuth, (req, res) => {
  res.json({ tiers: { free: tierLimits('free'), premium: tierLimits('premium'), plus: tierLimits('plus') } });
});

export default router;
