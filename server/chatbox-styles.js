// Shared chatbox-style listing/validation for the chat app.
// Public styles = the folders in public/assets/chatboxes; experimental
// styles are hidden from the picker for everyone except jimmyqrg
// (temporary testing gate — remove ids from EXPERIMENTAL_CHATBOX_STYLES
// to make them public).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPremiumPlus } from './premium.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const EXPERIMENTAL_CHATBOX_STYLES = new Set([
  'neon-blaze',
  'aqua-glass',
  'pixel-pop',
  'sticky-note',
  'bubble-gum',
]);

/** List chatbox styles by scanning the chatboxes directory. */
export function listChatboxStyles() {
  const dir = join(publicDir, 'assets', 'chatboxes');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'default-old')
      .map((e) => {
        const jsonPath = join(dir, e.name, 'chatbox.json');
        if (!existsSync(jsonPath)) return null;
        try {
          const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
          return {
            id: e.name,
            name: meta.name || e.name,
            type: meta.type || 'svg',
            tail: meta.tail === 'true' || meta.tail === true,
            author: meta.author || null,
            description: meta.description || null,
            experimental: EXPERIMENTAL_CHATBOX_STYLES.has(e.name) || undefined,
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
  const premiumPlus = isPremiumPlus(user?.id, user?.username);
  return listChatboxStyles()
    .filter((s) => (!s.experimental || user?.username === 'jimmyqrg') && (s.id !== 'custom' || premiumPlus))
    .map((s) => s.id);
}
