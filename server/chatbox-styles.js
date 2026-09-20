// Shared chatbox-style listing/validation for the chat app.
// Public styles = the folders in public/assets/chatboxes. Styles in
// EXPERIMENTAL_CHATBOX_STYLES are hidden from the picker for everyone
// except jimmyqrg (temporary testing gate). Released styles are removed
// from that set — it is currently empty, so every style is public.
//
// Locked styles are different from experimental ones: they stay VISIBLE in
// the picker for everyone, but only selectable once the user has earned
// them. The client renders `locked: true` with a lock badge; the server
// refuses to save such a style, so hiding it in the UI is cosmetic only.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const EXPERIMENTAL_CHATBOX_STYLES = new Set([]);

/** Owner always keeps access so a gated style stays testable before release. */
const OWNER_USERNAME = 'jimmyqrg';

/** Styles that must be earned, keyed by style id. */
export const CHATBOX_UNLOCKS = {
  'cake-1': { type: 'anniversary', label: 'First Anniversary' },
};

/** Did this user join the first anniversary celebration? That is recorded as
 *  an anniversary quiz submission — the only participation the server sees. */
function joinedAnniversary(user) {
  if (!user || !user.id) return false;
  if ((user.username || '').toLowerCase() === OWNER_USERNAME) return true;
  try {
    return !!db.prepare('SELECT 1 FROM anniversary_submissions WHERE user_id = ?').get(user.id);
  } catch (_) {
    return false;
  }
}

const UNLOCK_CHECKS = { anniversary: joinedAnniversary };

/** Visible but not selectable: a gated style this user has not earned. */
export function isChatboxLocked(id, user) {
  const gate = CHATBOX_UNLOCKS[id];
  if (!gate) return false;
  const check = UNLOCK_CHECKS[gate.type];
  return check ? !check(user) : true;   // unknown gate type stays locked
}

/** List chatbox styles by scanning the chatboxes directory.
 *  Pass the requesting user to get a per-user `locked` flag. */
export function listChatboxStyles(user) {
  const dir = join(publicDir, 'assets', 'chatboxes');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'default-old')
      .map((e) => {
        const jsonPath = join(dir, e.name, 'chatbox.json');
        if (!existsSync(jsonPath)) return null;
        try {
          const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
          const gate = CHATBOX_UNLOCKS[e.name];
          return {
            id: e.name,
            name: meta.name || e.name,
            type: meta.type || 'svg',
            tail: meta.tail === 'true' || meta.tail === true,
            author: meta.author || null,
            description: meta.description || null,
            experimental: EXPERIMENTAL_CHATBOX_STYLES.has(e.name) || undefined,
            locked: isChatboxLocked(e.name, user) || undefined,
            unlockLabel: gate ? gate.label : undefined,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Style ids a given user is allowed to SELECT (not just render). */
export function selectableChatboxStyles(user) {
  return listChatboxStyles(user)
    .filter((s) => (!s.experimental || user?.username === OWNER_USERNAME) && !s.locked)
    .map((s) => s.id);
}
