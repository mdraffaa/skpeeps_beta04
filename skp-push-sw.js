/* SK Peeps standards-based Web Push service worker. */

// Bump this whenever notification click/navigation behavior changes. The page
// registers this file with ?v=<version>, forcing Chrome/Edge/iOS PWA to pick up
// the new worker instead of silently continuing to use an old click handler.
const SKP_SW_VERSION = 'persist-v5-20260821';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'SK Peeps';
  const route = normalizeRoute(data.route || routeForData(data));
  const options = {
    body: data.body || '',
    icon: data.icon || 'icons/Icon-192.png',
    badge: data.badge || 'icons/Icon-192.png',
    tag: data.tag || buildTag(data),
    renotify: false,
    data: {
      route,
      swVersion: SKP_SW_VERSION,
    },
  };

  // Safari requires a visible notification for every received push event.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const route = normalizeRoute(
    event.notification.data?.route || '/notifications',
  );

  console.info('[SKP SW] notification click', SKP_SW_VERSION, route);
  event.waitUntil(openFlutterRoute(route));
});

function normalizeRoute(route) {
  const raw = String(route || '/notifications').trim();
  if (!raw) return '/notifications';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function routeForData(data) {
  const type = String(data.type || '');
  const postId = String(data.postId || '');
  const uid = String(data.uid || '');
  const chatId = String(data.chatId || '');

  if (type === 'groupChat' && chatId) return `/group/${chatId}`;
  if (type === 'chat' && uid) return `/chat/${uid}`;
  if (type === 'profileVisit' && uid) return `/profile/${uid}`;
  if (postId) return `/post/${postId}`;
  return '/notifications';
}

function buildTag(data) {
  if (data.type === 'groupChat' && data.chatId) {
    return `group_chat_${data.chatId}`;
  }
  if (data.type === 'chat' && data.uid) return `chat_${data.uid}`;
  return `skp_${data.type || 'social'}_${data.postId || Date.now()}`;
}

function launchUrlForRoute(route) {
  const scopeUrl = new URL(self.registration.scope);
  const basePath = scopeUrl.pathname.endsWith('/')
    ? scopeUrl.pathname
    : `${scopeUrl.pathname}/`;

  // Do NOT rely on client.navigate('/#/chat/...') alone. Installed PWAs and
  // Chromium can occasionally focus an existing window without Flutter seeing
  // the hash transition. Instead reload the app root with a temporary launch
  // parameter. skp_web_push.js consumes it before Flutter boots and converts it
  // into the correct hash route.
  const target = new URL(basePath, scopeUrl.origin);
  target.searchParams.set('skp_push', normalizeRoute(route));
  target.searchParams.set('skp_push_ts', String(Date.now()));
  return target.href;
}

async function openFlutterRoute(route) {
  const target = launchUrlForRoute(route);
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  // Prefer reusing an existing SK Peeps window/PWA. We send a message for the
  // fast path, then also navigate to a one-shot launch URL as a guaranteed
  // fallback. The reload is intentional: reliability > a tiny transition here.
  for (const client of windows) {
    try {
      client.postMessage({
        type: 'SKP_PUSH_ROUTE',
        route: normalizeRoute(route),
        swVersion: SKP_SW_VERSION,
      });

      if ('navigate' in client) {
        const navigated = await client.navigate(target);
        if (navigated && 'focus' in navigated) {
          return await navigated.focus();
        }
      }

      if ('focus' in client) return await client.focus();
    } catch (error) {
      console.warn('[SKP SW] reuse client failed', error);
    }
  }

  const opened = await self.clients.openWindow(target);
  if (opened && 'focus' in opened) return opened.focus();
  return opened;
}
