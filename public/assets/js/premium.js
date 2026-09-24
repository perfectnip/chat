// Premium (Venory subscription) client: upgrade modal, Stripe embedded
// checkout, and the client-side half of the Venory limits.
//
// The server is the authority for every limit (see server/premium.js and
// server/quotas.js). This module exists so people see WHY they can't do
// something before they try, and so buying is one click from anywhere.
//
// Anything with `data-premium-open` opens the upgrade modal — placement code
// only needs the attribute, so CTAs can be added without touching this file.
let deps = {
  getState: () => ({}),
  setState: () => {},
  showToast: () => {},
  tx: (key, fallback) => fallback || key,
  escapeHtml: (s) => String(s ?? ''),
};

const FREE_LIMITS = { dailyMessages: 30, uploads: false, contextTokens: 10000 };

let plansCache = null;
let quota = null;
let stripePromise = null;
let checkout = null;
let quotaFetchedAt = 0;

/* ── helpers ───────────────────────────────────────────────────────────── */

function st() { return deps.getState() || {}; }
export function tierOf(state = st()) { return state.user?.premium_tier || 'free'; }
export function limitsOf(state = st()) {
  const l = state.user?.premium_limits;
  return l && typeof l === 'object' ? l : FREE_LIMITS;
}
export function isPremium(state = st()) { return tierOf(state) !== 'free'; }
export function userCanUploadToVenory(state = st()) { return !!limitsOf(state).uploads; }

/** Is the open conversation the one with Venory? */
export function isVenoryRoom(state = st()) { return state.dmUserId === 'helper'; }

function tierLabel(tier) {
  return tier === 'plus' ? 'Premium Plus' : tier === 'premium' ? 'Premium' : 'Free';
}

export function crownSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="m2.5 7 4.2 3.2L12 4l5.3 6.2L21.5 7l-2.1 12H4.6L2.5 7Z"/><path d="M4.6 16.2h14.8"/></svg>';
}

async function apiJson(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, body: body || {} };
}

/* ── quota state (pushed by the server on every Venory turn) ───────────── */

export function setQuota(q) {
  if (!q || typeof q !== 'object') return;
  quota = q;
  renderQuotaBar();
}
export function getQuota() { return quota; }

/** The quota bar is only meaningful in the Venory DM, and the server pushes
 *  it on every Venory turn — but a fresh page load has no numbers yet, so pull
 *  them once (throttled) when the Venory composer is on screen. */
function maybeFetchQuota() {
  if (quota) return;
  if (!isVenoryRoom()) return;
  if (Date.now() - quotaFetchedAt < 15000) return;
  quotaFetchedAt = Date.now();
  refreshTier().catch(() => {});
}

/** Inner markup for the quota bar. Rendered by the composer template so it
 *  survives re-renders; `renderQuotaBar` refreshes it live. */
export function quotaBarHtml() {
  const state = st();
  if (!isVenoryRoom(state)) return '';
  maybeFetchQuota();
  if (!quota) return '';
  const { tx } = deps;
  if (quota.unlimited) {
    return tierOf(state) === 'plus'
      ? `<span class="premium-quota-text premium-quota-unlimited">${tx('premiumUnlimited', 'Unlimited messages')} \u00b7 Premium Plus</span>`
      : '';
  }
  const limit = quota.limit ?? FREE_LIMITS.dailyMessages;
  const used = quota.used ?? 0;
  const remaining = Math.max(0, limit - used);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const exhausted = remaining <= 0 || quota.exceeded;
  return `
    <div class="premium-quota-inner ${exhausted ? 'exhausted' : remaining <= 5 ? 'warn' : ''}">
      <span class="premium-quota-text">${exhausted
        ? tx('premiumQuotaExhausted', "You've used all {limit} Venory messages today")
            .replace('{limit}', String(limit))
        : tx('premiumQuotaLeft', '{remaining} of {limit} Venory messages left today')
            .replace('{remaining}', String(remaining)).replace('{limit}', String(limit))}</span>
      <span class="premium-quota-track"><span class="premium-quota-fill" style="width:${pct}%"></span></span>
      <button type="button" class="premium-quota-cta" data-premium-open="quota">${tx('premiumUpgrade', 'Upgrade')}</button>
    </div>`;
}

/** The inline "N of M messages left today" bar above the Venory composer. */
export function renderQuotaBar() {
  const host = document.getElementById('premium-quota-bar');
  if (!host) return;
  const html = quotaBarHtml();
  host.innerHTML = html;
  host.hidden = !html;
}

/* ── the upgrade modal ─────────────────────────────────────────────────── */

function ensureModalHost() {
  let host = document.getElementById('premium-modal');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'premium-modal';
  host.className = 'premium-modal';
  host.hidden = true;
  host.innerHTML = `
    <div class="premium-modal-backdrop" data-premium-close></div>
    <div class="premium-modal-card" role="dialog" aria-modal="true" aria-labelledby="premium-modal-title">
      <button type="button" class="premium-modal-close" data-premium-close aria-label="Close">&times;</button>
      <div class="premium-modal-body" id="premium-modal-body"></div>
    </div>`;
  document.body.appendChild(host);
  return host;
}

function closeModal() {
  const host = document.getElementById('premium-modal');
  if (host) host.hidden = true;
  try { checkout?.destroy(); } catch (_) {}
  checkout = null;
}

function reasonLine(reason) {
  const { tx } = deps;
  if (reason === 'upload') {
    return tx('premiumReasonUpload', 'File uploads to Venory are part of Premium.');
  }
  if (reason === 'quota') {
    return tx('premiumReasonQuota', "You've used today's free Venory messages.");
  }
  return '';
}

/** Opens the upgrade modal. `reason` only changes the headline copy. */
export async function openPremiumModal({ reason = 'manual' } = {}) {
  const host = ensureModalHost();
  const body = host.querySelector('#premium-modal-body');
  host.hidden = false;
  body.innerHTML = `<div class="premium-loading">${deps.tx('loading', 'Loading\u2026')}</div>`;

  const status = await apiJson('/api/premium/status');
  const plans = plansCache || (await apiJson('/api/premium/plans'));
  plansCache = plans.ok ? plans.body : plansCache;

  const currentTier = status.body?.tier || tierOf();
  const features = plansCache?.features || {};
  const prices = plansCache?.tiers || {};
  const priceOf = (tier, plan) => prices?.[tier]?.[plan]?.price || '';
  const available = (tier, plan) => prices?.[tier]?.[plan]?.available !== false;

  let selectedPlan = 'monthly';
  let selectedTier = currentTier === 'free' ? 'premium' : currentTier;

  const cards = ['free', 'premium', 'plus'].map((tier) => {
    const info = features[tier] || { name: tierLabel(tier), features: [] };
    const list = (info.features || []).map((f) => `<li>${deps.escapeHtml(f)}</li>`).join('');
    const price = tier === 'free' ? '$0' : `<span class="premium-price" data-tier-price="${tier}">${deps.escapeHtml(priceOf(tier, selectedPlan))}</span>`;
    const isCurrent = tier === currentTier;
    return `
      <button type="button" class="premium-tier ${isCurrent ? 'current' : ''}" data-tier="${tier}">
        ${isCurrent ? `<span class="premium-tier-badge">${deps.tx('premiumCurrent', 'Current')}</span>` : ''}
        <span class="premium-tier-name">${deps.escapeHtml(info.name || tierLabel(tier))}</span>
        <span class="premium-tier-price">${price}</span>
        <ul class="premium-tier-features">${list}</ul>
      </button>`;
  }).join('');

  body.innerHTML = `
    <div class="premium-head">
      <span class="premium-crown">${crownSvg()}</span>
      <h2 id="premium-modal-title">${deps.tx('premiumTitle', 'Upgrade to Premium')}</h2>
      <p class="premium-sub">${deps.escapeHtml(reasonLine(reason)) || deps.tx('premiumSub', 'More Venory, bigger memory, file uploads.')}</p>
    </div>
    <div class="premium-plans-toggle" role="tablist">
      <button type="button" class="premium-plan-btn active" data-plan="monthly">${deps.tx('premiumMonthly', 'Monthly')}</button>
      <button type="button" class="premium-plan-btn" data-plan="yearly">${deps.tx('premiumYearly', 'Yearly')}</button>
      <span class="premium-plan-save">${deps.tx('premiumSave', 'Save ~17%')}</span>
    </div>
    <div class="premium-tiers">${cards}</div>
    <div class="premium-status">${deps.tx('premiumYouAreOn', 'You are on {tier}').replace('{tier}', tierLabel(currentTier))}${
      status.body?.quota && !status.body.quota.unlimited
        ? ` \u00b7 ${status.body.quota.used}/${status.body.quota.limit} ${deps.tx('premiumMessagesToday', 'messages today')}`
        : ''}</div>
    <div class="premium-actions">
      <button type="button" class="premium-btn primary" id="premium-subscribe">${deps.tx('premiumSubscribe', 'Subscribe')}</button>
      ${currentTier !== 'free' ? `<button type="button" class="premium-btn ghost" id="premium-portal">${deps.tx('premiumManage', 'Manage subscription')}</button>` : ''}
      <button type="button" class="premium-btn ghost" data-premium-close>${deps.tx('premiumNotNow', 'Not now')}</button>
    </div>
    <div class="premium-checkout-mount" id="premium-checkout-mount"></div>`;

  const syncCards = () => {
    body.querySelectorAll('.premium-tier').forEach((el) => {
      el.classList.toggle('selected', el.dataset.tier === selectedTier && el.dataset.tier !== currentTier);
    });
    body.querySelectorAll('[data-tier-price]').forEach((el) => {
      el.textContent = priceOf(el.dataset.tierPrice, selectedPlan);
    });
    const sub = document.getElementById('premium-subscribe');
    if (sub) {
      const t = selectedTier;
      const ok = t === 'free' ? false : available(t, selectedPlan);
      sub.disabled = !ok;
      sub.textContent = t === 'free'
        ? deps.tx('premiumPickPlan', 'Pick a plan')
        : ok
          ? `${deps.tx('premiumSubscribe', 'Subscribe')} \u00b7 ${priceOf(t, selectedPlan)}`
          : deps.tx('premiumUnavailable', 'Not available');
    }
  };
  syncCards();

  body.querySelectorAll('.premium-tier').forEach((el) => {
    el.addEventListener('click', () => { selectedTier = el.dataset.tier; syncCards(); });
  });
  body.querySelectorAll('.premium-plan-btn').forEach((el) => {
    el.addEventListener('click', () => {
      selectedPlan = el.dataset.plan;
      body.querySelectorAll('.premium-plan-btn').forEach((b) => b.classList.toggle('active', b === el));
      syncCards();
    });
  });
  document.getElementById('premium-subscribe')?.addEventListener('click', () => startCheckout(selectedTier, selectedPlan));
  document.getElementById('premium-portal')?.addEventListener('click', openPortal);
}

async function startCheckout(tier, plan) {
  const { tx } = deps;
  const sub = document.getElementById('premium-subscribe');
  const restoreButton = () => {
    if (!sub) return;
    sub.disabled = false;
    sub.textContent = tx('premiumSubscribe', 'Subscribe');
  };
  if (sub) { sub.disabled = true; sub.textContent = tx('premiumStarting', 'Starting\u2026'); }
  let res;
  try {
    res = await apiJson('/api/premium/checkout', {
      method: 'POST',
      body: JSON.stringify({ tier, plan }),
    });
  } catch (_) {
    deps.showToast(tx('premiumCheckoutFailed', 'Could not start checkout'));
    restoreButton();
    return;
  }
  if (!res.ok || !res.body?.clientSecret) {
    deps.showToast(res.body?.message || tx('premiumCheckoutFailed', 'Could not start checkout'));
    restoreButton();
    return;
  }
  try {
    const Stripe = await loadStripe();
    const pk = plansCache?.stripe_publishable_key;
    if (!Stripe || !pk) throw new Error('stripe unavailable');
    const stripe = Stripe(pk);
    checkout = await stripe.initEmbeddedCheckout({ clientSecret: res.body.clientSecret });
    const mount = document.getElementById('premium-checkout-mount');
    mount.classList.add('active');
    checkout.mount('#premium-checkout-mount');
    mount.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    deps.showToast(tx('premiumStripeFailed', 'Could not open the payment form. Please try again.'));
    restoreButton();
  }
}

function loadStripe() {
  if (stripePromise) return stripePromise;
  stripePromise = new Promise((resolve) => {
    if (window.Stripe) { resolve(window.Stripe); return; }
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = () => resolve(window.Stripe);
    s.onerror = () => { stripePromise = null; resolve(null); };
    document.head.appendChild(s);
  });
  return stripePromise;
}

async function openPortal() {
  const res = await apiJson('/api/premium/portal', { method: 'POST', body: '{}' });
  if (res.ok && res.body?.url) { window.location.href = res.body.url; return; }
  deps.showToast(res.body?.message || deps.tx('premiumPortalFailed', 'No billing portal available'));
}

/** Pull the current tier from the server and fold it into client state. */
export async function refreshTier({ announce = false } = {}) {
  const res = await apiJson('/api/premium/status?refresh=1');
  if (!res.ok || !res.body?.tier) return null;
  const state = st();
  const limits = res.body.limits || {};
  const cur = state.user || {};
  const curLimits = cur.premium_limits || {};
  const changed = cur.premium_tier !== res.body.tier
    || curLimits.dailyMessages !== limits.dailyMessages
    || curLimits.uploads !== limits.uploads
    || curLimits.contextTokens !== limits.contextTokens;
  // Only re-render when something actually moved (quota updates come through
  // setQuota, which patches the bar in place).
  if (changed) {
    deps.setState({ user: { ...cur, premium_tier: res.body.tier, premium_limits: limits } });
  }
  if (res.body.quota) setQuota({ ...res.body.quota, roomType: 'dm', roomId: state.convId });
  if (announce) {
    deps.showToast(
      res.body.tier === 'free'
        ? deps.tx('premiumStillFree', 'Subscription not active yet')
        : deps.tx('premiumActive', 'Premium active — thank you!'),
      'info'
    );
  }
  return res.body.tier;
}

/* ── gates used by the composer ────────────────────────────────────────── */

/** Would sending a file right now be refused (client-side pre-check)?
 *  True also when the user is looking at a group with @helper in the box. */
export function venoryUploadBlocked({ text = '' } = {}) {
  const state = st();
  if (userCanUploadToVenory(state)) return false;
  if (isVenoryRoom(state)) return true;
  if (!state.dmUserId && /(^|\s)@(?:helper|venory)\b/i.test(text)) return true;
  return false;
}

/** Blocks an attach attempt and explains why. Returns true when blocked. */
export function maybeBlockVenoryUpload({ text = '' } = {}) {
  if (!venoryUploadBlocked({ text })) return false;
  openPremiumModal({ reason: 'upload' });
  return true;
}

/** Called when a send fails with UPGRADE_REQUIRED — the server is the
 *  authority, so this is the path that actually matters. */
export function handleUpgradeRequired(err) {
  if (!err || err.code !== 'UPGRADE_REQUIRED') return false;
  openPremiumModal({ reason: 'upload' });
  return true;
}

/* ── reusable CTA markup ───────────────────────────────────────────────── */

/** Settings section: current plan + upgrade/manage. */
export function settingsPremiumHtml() {
  const state = st();
  const tier = tierOf(state);
  const limits = limitsOf(state);
  const { tx, escapeHtml } = deps;
  const rows = [
    limits.dailyMessages === null
      ? tx('premiumFeatUnlimitedMsgs', 'Unlimited Venory messages')
      : tx('premiumFeatMsgs', '{n} Venory messages / day').replace('{n}', String(limits.dailyMessages)),
    limits.uploads ? tx('premiumFeatUploads', 'File uploads to Venory') : tx('premiumFeatNoUploads', 'No file uploads to Venory'),
    tx('premiumFeatContext', '{n} token memory').replace('{n}', limits.contextTokens >= 1000000 ? '1M' : `${Math.round(limits.contextTokens / 1000)}k`),
  ];
  return `
    <h3 class="settings-section-title">${tx('premiumTitle', 'Upgrade to Premium')}</h3>
    <div class="premium-settings-card">
      <div class="premium-settings-top">
        <span class="premium-plan-chip tier-${escapeHtml(tier)}">${escapeHtml(tierLabel(tier))}</span>
        <span class="premium-settings-hint">${tx('premiumPlanHint', 'Your Venory plan')}</span>
      </div>
      <ul class="premium-settings-features">${rows.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      <div class="premium-settings-actions">
        ${tier === 'free'
          ? `<button type="button" class="premium-btn primary" data-premium-open="settings">${tx('premiumUpgrade', 'Upgrade')}</button>`
          : `<button type="button" class="premium-btn ghost" data-premium-open="settings">${tx('premiumChangePlan', 'Change plan')}</button>`}
        <button type="button" class="premium-btn ghost" id="premium-settings-learn">${tx('premiumSeeAll', 'Compare plans')}</button>
      </div>
    </div>`;
}

/** Compact banner for the profile page / header areas. */
export function premiumBannerHtml({ compact = false } = {}) {
  const state = st();
  const tier = tierOf(state);
  const { tx, escapeHtml } = deps;
  if (tier !== 'free') {
    return `<div class="premium-banner active">
      <span class="premium-banner-icon">${crownSvg()}</span>
      <div class="premium-banner-text"><strong>${escapeHtml(tierLabel(tier))}</strong>
      <span>${tx('premiumThanks', 'Thanks for supporting Venory!')}</span></div>
      <button type="button" class="premium-btn ghost small" data-premium-open="banner">${tx('premiumManage', 'Manage subscription')}</button>
    </div>`;
  }
  return `<div class="premium-banner ${compact ? 'compact' : ''}">
    <span class="premium-banner-icon">${crownSvg()}</span>
    <div class="premium-banner-text">
      <strong>${tx('premiumBannerTitle', 'Get more out of Venory')}</strong>
      <span>${tx('premiumBannerBody', '100 messages/day, file uploads and 100k memory with Premium.')}</span>
    </div>
    <button type="button" class="premium-btn primary small" data-premium-open="banner">${tx('premiumUpgrade', 'Upgrade')}</button>
  </div>`;
}

/** Menu item markup (sidebar action menu). */
export function premiumMenuItemHtml() {
  const tier = tierOf();
  return `<button type="button" class="menu-item premium-menu-item" data-premium-open="menu">
    <span class="icon" aria-hidden="true">${crownSvg()}</span>
    <span>${deps.tx(tier === 'free' ? 'premiumUpgrade' : 'premiumManage', tier === 'free' ? 'Upgrade' : 'Manage subscription')}</span>
  </button>`;
}

/* ── wiring ────────────────────────────────────────────────────────────── */

export function initPremiumClient(dependencies = {}) {
  deps = { ...deps, ...dependencies };

  // One delegated listener: any element carrying data-premium-open opens the
  // modal, so CTA placement never needs extra wiring.
  document.addEventListener('click', (e) => {
    const opener = e.target.closest?.('[data-premium-open]');
    if (opener) {
      e.preventDefault();
      openPremiumModal({ reason: opener.getAttribute('data-premium-open') || 'manual' });
      return;
    }
    if (e.target.closest?.('[data-premium-close]')) {
      e.preventDefault();
      closeModal();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('premium-modal')?.hidden) closeModal();
  });
  document.addEventListener('click', (e) => {
    if (e.target?.id === 'premium-settings-learn') {
      e.preventDefault();
      openPremiumModal({ reason: 'manual' });
    }
  });

  // Returning from Stripe checkout.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('upgraded') === '1') {
      refreshTier({ announce: true }).then(() => {
        try {
          params.delete('upgraded');
          const qs = params.toString();
          window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
        } catch (_) {}
      });
    }
  } catch (_) {}

  // Live quota + tier pushes from the server.
  const socket = dependencies.socket;
  if (socket?.on) {
    socket.on('helper:quota', (q) => {
      setQuota(q);
      if (q?.exceeded) {
        deps.showToast(
          deps.tx('premiumQuotaExceededToast', "You've hit today's Venory message limit. Upgrade for more."),
          'info'
        );
      }
    });
  }

  renderQuotaBar();
}
