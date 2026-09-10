/**
 * JimmyQrg Chat — service worker
 *
 * Handles Web Push: shows OS notifications when the app is closed or in the
 * background, and deep-links notification clicks to the right chat.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Active room per window client: the page posts {type:'jchat:active-room',
// roomType, roomId} on navigation so we can suppress pushes for the room
// the user is currently staring at (the socket already renders it live).
const activeRooms = new Map();

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'jchat:active-room') {
    // roomType is null when the user navigated away from any chat room
    // (inbox/settings) — clear the entry so those pages don't suppress.
    if (msg.roomType && msg.roomId) {
      activeRooms.set(event.source?.id || 'main', `${msg.roomType}:${msg.roomId}`);
    } else {
      activeRooms.delete(event.source?.id || 'main');
    }
  } else if (msg.type === 'jchat:clear-active-room') {
    activeRooms.delete(event.source?.id || 'main');
  }
});

// The room is open on the chat page in this client — the socket already
// renders its messages live, so a push notification would be noise. This
// holds even when the tab is backgrounded (the page still shows that room).
async function isRoomFocusedOnClient(roomType, roomId) {
  const key = `${roomType}:${roomId}`;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    if (activeRooms.get(client.id) === key) {
      return true;
    }
  }
  return false;
}

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (_) {}
  if (!data) return;

  const roomType = data.data?.roomType || null;
  const roomId = data.data?.roomId || null;

  // The user is staring at this exact room right now — the socket already
  // rendered the message; a notification would just be noise.
  if (roomType && roomId) {
    event.waitUntil(isRoomFocusedOnClient(roomType, roomId).then((focused) => {
      if (focused) return;
      return showPushNotification(data);
    }));
    return;
  }

  event.waitUntil(showPushNotification(data));
});

function showPushNotification(data) {
  const title = data.title || 'JimmyQrg Chat';
  const options = {
    body: data.body || '',
    icon: '/assets/favicon.ico',
    badge: '/assets/favicon.ico',
    tag: data.tag || undefined,
    data: {
      url: data.url || '/chat/group/',
      roomType: data.data?.roomType || null,
      roomId: data.data?.roomId || null,
      msgId: data.data?.msgId || null,
    },
    renotify: Boolean(data.tag),
    timestamp: data.ts || Date.now(),
  };
  return self.registration.showNotification(title, options);
}

self.addEventListener('notificationclick', (event) => {
  const notif = event.notification;
  const target = (notif.data && notif.data.url) || '/chat/group/';
  notif.close();

  const openWindow = () => self.clients.openWindow(target);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        // If we have a window open, focus it and navigate to the chat.
        if ('focus' in client) {
          client.postMessage({
            type: 'jchat:push-click',
            url: target,
            roomType: notif.data?.roomType || null,
            roomId: notif.data?.roomId || null,
            msgId: notif.data?.msgId || null,
          });
          return client.focus();
        }
      }
      return openWindow();
    })
  );
});
