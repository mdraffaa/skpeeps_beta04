(function () {
  'use strict';

  const INSTALLATION_KEY = 'skp_web_push_installation_id';
  const OPT_IN_KEY = 'skp_web_push_opted_in';
  const SW_VERSION = 'single-worker-v7-20260821';

  function normalizeRoute(route) {
    const raw = String(route || '/notifications').trim();
    if (!raw) return '/notifications';
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  // notificationclick opens the app root with ?skp_push=/route. This script is
  // loaded BEFORE flutter_bootstrap.js, so translate that one-shot parameter
  // into Flutter's hash route before GoRouter starts.
  function consumePushLaunchRoute() {
    try {
      const url = new URL(window.location.href);
      const route = url.searchParams.get('skp_push');
      if (!route) return;

      const normalized = normalizeRoute(route);
      url.searchParams.delete('skp_push');
      url.searchParams.delete('skp_push_ts');

      const query = url.searchParams.toString();
      const cleanUrl = `${url.pathname}${query ? `?${query}` : ''}#${normalized}`;
      window.history.replaceState(window.history.state, '', cleanUrl);
      console.info('[SKP Web Push] consumed launch route:', normalized);
    } catch (error) {
      console.warn('[SKP Web Push] failed to consume launch route:', error);
    }
  }

  // Run immediately, before Flutter boots.
  consumePushLaunchRoute();

  function isIos() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)').matches === true ||
      window.navigator.standalone === true;
  }

  function isSupported() {
    return 'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window;
  }

  function baseScopePath() {
    return new URL('.', document.baseURI).pathname;
  }

  function serviceWorkerUrl() {
    const url = new URL('skp-push-sw.js', document.baseURI);
    // Query version forces a service-worker update even if a CDN/browser has a
    // stale script cached. Same scope => existing PushSubscription is retained.
    url.searchParams.set('v', SW_VERSION);
    return url.href;
  }


  function isOptedIn() {
    try {
      return localStorage.getItem(OPT_IN_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function setOptedIn(value) {
    try {
      if (value) {
        localStorage.setItem(OPT_IN_KEY, '1');
      } else {
        localStorage.removeItem(OPT_IN_KEY);
      }
    } catch (_) {}
  }

  function getInstallationId() {
    let id = localStorage.getItem(INSTALLATION_KEY);
    if (id) return id;

    if (globalThis.crypto?.randomUUID) {
      id = globalThis.crypto.randomUUID();
    } else {
      id = `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    localStorage.setItem(INSTALLATION_KEY, id);
    return id;
  }

  let registrationPromise = null;

  function workerScriptUrl(worker) {
    try {
      return worker?.scriptURL || '';
    } catch (_) {
      return '';
    }
  }

  function registrationUsesSkpWorker(registration) {
    const urls = [
      workerScriptUrl(registration?.active),
      workerScriptUrl(registration?.waiting),
      workerScriptUrl(registration?.installing),
    ];
    return urls.some((url) => url.includes('/skp-push-sw.js'));
  }

  async function waitForSkpWorker(registration) {
    if (registrationUsesSkpWorker(registration)) return registration;

    const worker = registration.installing || registration.waiting;
    if (!worker) return registration;

    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 4000);
      const onState = () => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          clearTimeout(timeout);
          worker.removeEventListener('statechange', onState);
          resolve();
        }
      };
      worker.addEventListener('statechange', onState);
      onState();
    });
    return registration;
  }

  async function ensureRegistration() {
    if (!isSupported()) throw new Error('WEB_PUSH_UNSUPPORTED');
    if (registrationPromise) return registrationPromise;

    registrationPromise = (async () => {
      const scope = baseScopePath();
      const existing = await navigator.serviceWorker.getRegistration(scope);

      // flutter_service_worker.js used to own this same scope. Registering the
      // SKP worker on the SAME registration upgrades it without deleting the
      // PushSubscription. A custom Flutter bootstrap now prevents Flutter from
      // replacing it again on the next load.
      if (existing && !registrationUsesSkpWorker(existing)) {
        console.info(
          '[SKP Web Push] replacing conflicting root worker:',
          workerScriptUrl(existing.active) || workerScriptUrl(existing.waiting),
        );
      }

      const registration = await navigator.serviceWorker.register(
        serviceWorkerUrl(),
        {
          scope,
          updateViaCache: 'none',
        },
      );

      await waitForSkpWorker(registration);
      return registration;
    })();

    try {
      return await registrationPromise;
    } catch (error) {
      registrationPromise = null;
      throw error;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function payloadForSubscription(subscription) {
    if (!subscription) return null;
    const json = subscription.toJSON();
    return {
      subscribed: true,
      endpoint: json.endpoint || '',
      p256dh: json.keys?.p256dh || '',
      auth: json.keys?.auth || '',
      installationId: getInstallationId(),
      userAgent: navigator.userAgent || '',
      isIos: isIos(),
    };
  }

  async function getExistingSubscription({ ensure = false } = {}) {
    if (!isSupported()) return null;

    let registration = await navigator.serviceWorker.getRegistration(baseScopePath());

    // On a hard refresh Flutter can ask for Web Push state before the custom
    // push Service Worker has finished re-registering. In that tiny window
    // getRegistration() may return null and the UI would incorrectly show
    // notifications as disabled. Registration itself never prompts the user,
    // so it is safe to repair that race here.
    if (!registration && ensure) {
      registration = await ensureRegistration();
    }

    if (!registration) return null;
    return registration.pushManager.getSubscription();
  }

  async function getStateJson() {
    if (!isSupported()) {
      return JSON.stringify({
        supported: false,
        isIos: isIos(),
        isStandalone: isStandalone(),
        permission: 'unsupported',
        subscribed: false,
        installationId: getInstallationId(),
        optedIn: isOptedIn(),
      });
    }

    const subscription = await getExistingSubscription({ ensure: true });

    // Migration path: devices that were enabled before the persistent local
    // opt-in marker existed should become sticky as soon as we see a live
    // PushSubscription.
    if (subscription && Notification.permission === 'granted') {
      setOptedIn(true);
    }

    return JSON.stringify({
      supported: true,
      isIos: isIos(),
      isStandalone: isStandalone(),
      permission: Notification.permission,
      subscribed: !!subscription,
      installationId: getInstallationId(),
      optedIn: isOptedIn(),
    });
  }

  async function currentSubscriptionJson() {
    const subscription = await getExistingSubscription({ ensure: true });
    const payload = payloadForSubscription(subscription);
    return JSON.stringify(payload || {
      subscribed: false,
      installationId: getInstallationId(),
      isIos: isIos(),
    });
  }

  async function subscribeJson(vapidPublicKey) {
    if (!isSupported()) throw new Error('WEB_PUSH_UNSUPPORTED');
    if (isIos() && !isStandalone()) throw new Error('IOS_HOME_SCREEN_REQUIRED');

    // IMPORTANT: call requestPermission synchronously from the user's button
    // gesture before awaiting anything, as required by iOS Web Push.
    const permissionPromise = Notification.permission === 'default'
      ? Notification.requestPermission()
      : Promise.resolve(Notification.permission);

    const permission = await permissionPromise;
    if (permission !== 'granted') {
      throw new Error(permission === 'denied'
        ? 'NOTIFICATION_PERMISSION_DENIED'
        : 'NOTIFICATION_PERMISSION_NOT_GRANTED');
    }

    const registration = await ensureRegistration();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }

    setOptedIn(true);
    return JSON.stringify(payloadForSubscription(subscription));
  }

  async function unsubscribeJson() {
    const subscription = await getExistingSubscription();
    const installationId = getInstallationId();
    if (subscription) await subscription.unsubscribe();
    setOptedIn(false);
    return JSON.stringify({
      unsubscribed: true,
      installationId,
      isIos: isIos(),
    });
  }

  async function preRegister() {
    if (!isSupported()) return;
    try {
      await ensureRegistration();
    } catch (e) {
      console.debug('[SKP Web Push] pre-register skipped:', e);
    }
  }

  // Called by our custom flutter_bootstrap.js before Flutter starts. This is
  // the migration barrier that stops flutter_service_worker.js and
  // skp-push-sw.js from racing for the same root scope on every refresh.
  async function prepareForFlutterBoot() {
    if (!isSupported()) return;
    await ensureRegistration();
  }

  // Fast path for an already-open PWA. The worker also performs a navigation
  // fallback, so even if this message arrives while Flutter is busy the click
  // cannot be silently lost.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type !== 'SKP_PUSH_ROUTE') return;

      const route = normalizeRoute(data.route);
      console.info('[SKP Web Push] SW route message:', route);

      if (window.location.hash !== `#${route}`) {
        window.location.hash = route;
      }
    });
  }

  window.SKPWebPush = {
    getStateJson,
    currentSubscriptionJson,
    subscribeJson,
    unsubscribeJson,
    preRegister,
    prepareForFlutterBoot,
    swVersion: SW_VERSION,
  };

  // Registration itself needs no permission and makes the later user gesture
  // path much faster, especially on iOS Home Screen web apps.
  preRegister();
})();
