// Venory (helper) usage limits.
//
// Free users get 30 messages/day and cannot send files to Venory; Premium gets
// 100/day and uploads; Premium Plus is unlimited. Counting is per user per
// calendar day in the app's timezone (America/Los_Angeles), across every room —
// a DM question and a group @helper mention both spend from the same budget.
//
// The limits are enforced on the SERVER (the client also pre-checks so people
// don't waste an upload, but the client is never the authority).
import { db } from './db.js';
import { tierLimits, getUserTier } from './premium.js';

/** Day key in the app's timezone, so "today" matches what users see. */
export function usageDayKey(now = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: process.env.APP_TIMEZONE || 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(now));
  } catch (_) {
    return new Date(now).toISOString().slice(0, 10);
  }
}

/** How many messages this user has already sent to Venory today. */
export function helperUsageToday(userId, now = Date.now()) {
  if (!userId) return 0;
  try {
    const row = db.prepare('SELECT messages FROM helper_daily_usage WHERE user_id = ? AND day = ?')
      .get(userId, usageDayKey(now));
    return Number(row?.messages || 0);
  } catch (_) {
    return 0;
  }
}

/** Current standing without spending anything — used by the API/UI. */
export function helperQuotaStatus(user) {
  const tier = getUserTier(user);
  const limit = tierLimits(tier).dailyMessages;
  const used = helperUsageToday(user?.id);
  return {
    tier,
    limit,                                   // null = unlimited
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    unlimited: limit === null,
  };
}

/** Spend one Venory message. Returns { allowed, ...quota } — `allowed: false`
 *  means the caller must NOT call the model. Unlimited tiers are not counted. */
export function consumeHelperMessage(user) {
  const status = helperQuotaStatus(user);
  if (status.unlimited) return { ...status, allowed: true };
  if (status.remaining <= 0) return { ...status, allowed: false };
  const day = usageDayKey();
  try {
    db.prepare(`INSERT INTO helper_daily_usage (user_id, day, messages) VALUES (?, ?, 1)
      ON CONFLICT(user_id, day) DO UPDATE SET messages = messages + 1`).run(user.id, day);
  } catch (err) {
    console.warn('[helper-quota] increment failed:', err?.message || err);
  }
  return { ...status, used: status.used + 1, remaining: status.remaining - 1, allowed: true };
}

/** Human-readable block message. `what` is 'message' or 'file'. */
export function quotaMessage(quota, what = 'message') {
  const limit = quota.limit;
  const lines = [];
  if (what === 'file') {
    lines.push(`I can't take files on the free plan — file uploads are a Premium feature.`);
  } else {
    lines.push(`You've used all ${limit} of your Venory messages for today.`);
  }
  lines.push(`Free: ${'\u2022'} 30 messages/day, no files, 10k context`);
  lines.push(`Premium ($5.99/mo): 100 messages/day, file uploads, 100k context`);
  lines.push(`Premium Plus: unlimited messages, 1M context`);
  lines.push(`Your limit resets at midnight \u2014 or tap Upgrade in Settings for more right now.`);
  return lines.join('\n');
}

/** Resets at midnight in the app timezone (for the UI countdown). */
export function quotaResetAt(now = Date.now()) {
  const day = usageDayKey(now);
  const [y, m, d] = day.split('-').map(Number);
  // Midnight PT after the current day key. Using UTC math here is fine because
  // the key itself is already the PT calendar day.
  const next = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  // PT is UTC-8/-7: subtract the offset that applies at that date.
  const offsetMs = tzOffsetMs(new Date(next));
  return next - offsetMs;
}

function tzOffsetMs(date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.APP_TIMEZONE || 'America/Los_Angeles',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second),
    );
    return asUTC - date.getTime();
  } catch (_) {
    return 0;
  }
}
