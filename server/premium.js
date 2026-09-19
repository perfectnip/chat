// Premium tiers. The only tier source right now is the anniversary quiz
// (server/routes/anniversary.js), which records a reward string like
// "PERMANENT PREMIUM PLUS" or "30-day Premium Plus, then permanent Premium"
// per user. jimmyqrg always qualifies so he can test premium-gated features.
import { db } from './db.js';

export function isPremiumPlus(userId, username) {
  if (typeof username === 'string' && username.toLowerCase() === 'jimmyqrg') return true;
  if (!userId) return false;
  try {
    return !!db.prepare(
      "SELECT 1 FROM anniversary_submissions WHERE user_id = ? AND reward LIKE '%PREMIUM PLUS%'"
    ).get(userId);
  } catch {
    // Table may not exist yet (module load order) — treat as not premium.
    return false;
  }
}
