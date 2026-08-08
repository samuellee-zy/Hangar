import { contextBridge, ipcRenderer } from 'electron';
import type { DomUnreadProbe, DomUnreadRule } from '../shared/types';

/**
 * Injected into every service view.
 *
 * **The isolated-world trap.** With `contextIsolation: true` — which we want — the preload's
 * `window` is a *different object* from the page's. Patching `window.Notification` here does
 * nothing the page can see. An earlier version of this file did exactly that, and the override,
 * the badge stub and the credentials block were all silently no-ops.
 *
 * So the work is split:
 *   - the **isolated world** (this scope) owns `ipcRenderer` and exposes a narrow bridge;
 *   - the **main world** gets the actual patches, via `contextBridge.executeInMainWorld`, and
 *     reaches back through that bridge.
 *
 * The main-world function is serialised, so it cannot close over anything in this file. Everything
 * it needs must come through `__hangar` or be defined inline.
 */

contextBridge.exposeInMainWorld('__hangar', {
  /**
   * Electron would route the page's own Notification to macOS on its own, but that loses *which
   * service* fired it — and with it attribution, unread counting, Do Not Disturb, and focusing the
   * right pane on click.
   */
  notify: (payload: { title: string; body: string; silent: boolean }) =>
    ipcRenderer.send('service:notification', payload),
  reportBlank: () => ipcRenderer.send('service:blank'),
  /** Called by the in-pane error page's Try again button. */
  retry: () => ipcRenderer.send('service:retry'),
  /**
   * Called by the blocked page's Allow button. Takes no host on purpose — this preload is in every
   * service page, so a host named here would be a page widening its own allowlist. Main applies
   * the host it just blocked for this service and nothing else.
   */
  allowHost: () => ipcRenderer.send('service:allow-host'),
  /**
   * Registers with FCM on the site's behalf and returns what a `PushSubscription` needs. Resolves
   * to `null` when push is off, unconfigured, or registration failed — the caller then falls back
   * to the browser's own `subscribe`, so a failure here is never worse than not being here.
   */
  subscribePush: (vapidKey: string): Promise<{ endpoint: string; p256dh: string; auth: string } | null> =>
    ipcRenderer.invoke('service:push-subscribe', vapidKey),
  /**
   * The DOM rules for *this* service, resolved by main from the catalog and the user's override.
   * Asked for rather than baked in, because a serialised main-world function cannot close over
   * anything and the answer depends on which service this view is — which only main knows.
   */
  unreadRules: (): Promise<DomUnreadRule[]> => ipcRenderer.invoke('service:unread-rules'),
  reportUnread: (probes: DomUnreadProbe[]) => ipcRenderer.send('service:unread', probes),
  /**
   * Main pushing a new rule set, after the user edited the selector or muted the service.
   *
   * Without this the rules are whatever they were at load, so trying out a selector would mean
   * reloading the service to find out whether it worked — and the point of the field is that the
   * person editing it is looking at the page.
   */
  onUnreadRules: (callback: (rules: DomUnreadRule[]) => void) => {
    ipcRenderer.on('service:unread-rules-changed', (_event, rules: DomUnreadRule[]) =>
      callback(rules)
    );
  },
});

try {
  contextBridge.executeInMainWorld({
    func: () => {
      type Bridge = {
        notify: (p: { title: string; body: string; silent: boolean }) => void;
        reportBlank: () => void;
        subscribePush: (
          vapidKey: string
        ) => Promise<{ endpoint: string; p256dh: string; auth: string } | null>;
        unreadRules: () => Promise<DomUnreadRule[]>;
        reportUnread: (probes: DomUnreadProbe[]) => void;
        onUnreadRules: (callback: (rules: DomUnreadRule[]) => void) => void;
      };
      const maybe = (window as unknown as { __hangar?: Bridge }).__hangar;
      if (!maybe) return;
      // Bound locals: the class body below is a separate scope, so TS can't carry the narrowing
      // of `maybe` into it.
      const notify = (p: { title: string; body: string; silent: boolean }) => maybe.notify(p);
      const reportBlank = () => maybe.reportBlank();
      const subscribePush = (k: string) => maybe.subscribePush(k);
      const unreadRules = () => maybe.unreadRules();
      const reportUnread = (probes: DomUnreadProbe[]) => maybe.reportUnread(probes);
      const onUnreadRules = (cb: (rules: DomUnreadRule[]) => void) => maybe.onUnreadRules(cb);

      // --- notifications ---------------------------------------------------------------------

      class HangarNotification extends EventTarget {
        static permission = 'granted';

        // Pages gate on this before even trying. Denying would mean no notifications at all; the
        // real decision lives in Hangar's own settings.
        static requestPermission(callback?: (p: string) => void) {
          callback?.('granted');
          return Promise.resolve('granted');
        }

        constructor(title: string, options: { body?: string; silent?: boolean } = {}) {
          super();
          notify({
            title: String(title ?? ''),
            body: String(options.body ?? ''),
            silent: Boolean(options.silent),
          });
        }

        // Pages call this on the instance; it must exist and must not throw.
        close() {}
      }

      try {
        Object.defineProperty(window, 'Notification', {
          value: HangarNotification,
          writable: false,
          configurable: false,
        });
      } catch {
        // A page that froze the global first — rare, and only costs us attribution.
      }

      // --- badging ---------------------------------------------------------------------------

      // Web apps calling setAppBadge would fight us for the dock badge, which we drive from
      // aggregated unread. Rambox stubs these for the same reason.
      try {
        Object.defineProperties(window.navigator, {
          setAppBadge: { value: () => Promise.resolve(), configurable: false },
          clearAppBadge: { value: () => Promise.resolve(), configurable: false },
        });
      } catch {
        /* already locked down */
      }

      // --- web push ----------------------------------------------------------------------------

      // A site subscribes, gets an endpoint, and POSTs it to its own servers. We substitute an FCM
      // endpoint Hangar holds the receiving socket for, so pushes arrive even with the service
      // hibernated or never opened — which is what stops sleeping a service meaning going silent
      // on it.
      //
      // Patched on `PushManager.prototype` rather than per registration, because a site can hold
      // several service worker registrations and we'd otherwise cover only the first.
      try {
        const proto = (window as any).PushManager?.prototype;
        if (proto) {
          const originalSubscribe = proto.subscribe;

          // `applicationServerKey` may be a BufferSource or a base64url string. FCM wants the
          // string form, and getting this wrong fails at registration rather than at call time.
          const toBase64Url = (key: unknown): string => {
            if (typeof key === 'string') return key;
            if (!key) return '';
            const bytes = new Uint8Array(
              key instanceof ArrayBuffer ? key : (key as ArrayBufferView).buffer
            );
            let binary = '';
            for (const b of bytes) binary += String.fromCharCode(b);
            return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          };

          const decode = (value: string): ArrayBuffer => {
            const padded = value.replace(/-/g, '+').replace(/_/g, '/');
            const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
            const out = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
            return out.buffer;
          };

          // Shaped like a real PushSubscription. Sites read it two different ways — `toJSON()` and
          // `getKey()` — so both have to work; supporting only one breaks half of them.
          const makeSubscription = (
            data: { endpoint: string; p256dh: string; auth: string },
            options: unknown
          ) => ({
            endpoint: data.endpoint,
            expirationTime: null,
            options,
            getKey: (name: string) =>
              name === 'p256dh' ? decode(data.p256dh) : name === 'auth' ? decode(data.auth) : null,
            toJSON: () => ({
              endpoint: data.endpoint,
              expirationTime: null,
              keys: { p256dh: data.p256dh, auth: data.auth },
            }),
            unsubscribe: () => Promise.resolve(true),
          });

          let last: ReturnType<typeof makeSubscription> | null = null;

          proto.subscribe = function (options: any) {
            const vapidKey = toBase64Url(options?.applicationServerKey);
            if (!vapidKey) return originalSubscribe.call(this, options);
            return subscribePush(vapidKey).then((data) => {
              // Null means push is off or unconfigured. Falling back leaves the site exactly as it
              // would have been without Hangar, rather than breaking its notification setup.
              if (!data) return originalSubscribe.call(this, options);
              last = makeSubscription(data, options);
              return last;
            });
          };

          // Sites call this first and only subscribe if it returns null. Returning the browser's
          // real answer here would make them re-subscribe on every load.
          const originalGet = proto.getSubscription;
          proto.getSubscription = function () {
            return last ? Promise.resolve(last) : originalGet.call(this);
          };

          // Chromium reports 'prompt' because Electron never wires up a push service, and a site
          // that sees 'prompt' may never call subscribe at all.
          proto.permissionState = function () {
            return Promise.resolve('granted');
          };
        }
      } catch (err) {
        // Not fatal: without this the service still works, it just can't be reached while asleep.
        console.warn('[hangar] push interception unavailable', err);
      }

      // --- load hardening --------------------------------------------------------------------

      // Google One Tap and passkey prompts fire on load and steal focus before the page is usable.
      // Anything the user actually initiates lands well after this window.
      try {
        const creds = navigator.credentials;
        if (creds?.get) {
          const original = creds.get.bind(creds);
          const loadedAt = Date.now();
          creds.get = ((options?: CredentialRequestOptions) =>
            Date.now() - loadedAt < 5000
              ? Promise.resolve(null)
              : original(options)) as typeof creds.get;
        }
      } catch {
        /* not available */
      }

      // Rambox polls for an empty body and reloads — it's why it rarely shows a white screen. A
      // service whose SPA failed to boot looks identical to one that's merely slow, and the page
      // will never recover on its own. Main rate-limits the actual reload.
      const checkBlank = () => {
        try {
          const body = document.body;
          // Empty text is not the same as an empty page. A canvas or WebGL app — anything
          // Figma-shaped — renders everything and has no `innerText` at all, so text alone reported
          // a healthy service as blank every 15 seconds and got it reloaded once a minute, forever.
          //
          // Ask whether the page painted *anything* instead: text, or a node with real layout.
          // A failed SPA boot leaves neither, which is the case this exists to catch.
          const hasText = Boolean(body?.innerText.trim());
          const hasPaintedElement = Boolean(
            body &&
              [...body.querySelectorAll('canvas, svg, img, video, iframe')].some((el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 1 && rect.height > 1;
              })
          );
          const blank = !body || (!hasText && !hasPaintedElement);
          // `document.hidden` guards against reloading a backgrounded pane mid-render.
          if (blank && !document.hidden && document.readyState === 'complete') {
            reportBlank();
          }
        } catch {
          /* mid-navigation; try again next tick */
        } finally {
          setTimeout(checkBlank, 15_000);
        }
      };
      setTimeout(checkBlank, 15_000);

      // --- unread badges -----------------------------------------------------------------------

      // Most services never put a count in their title, so the count for them was a tally of
      // `new Notification()` calls: it only ever rose, and it read zero outright for anyone who had
      // turned the site's own notifications off. Reading the badge the service already draws gives
      // an absolute number that can also go *down*.
      //
      // Nothing here decides what a badge means — it collects strings and main parses them, so the
      // arithmetic stays in a core function a test can reach. This closure cannot be imported.
      const probeRule = (rule: DomUnreadRule): DomUnreadProbe => {
        try {
          const anchored = rule.anchor ? document.querySelector(rule.anchor) !== null : true;
          const values = [...document.querySelectorAll(rule.selector)].map((el) =>
            rule.read === 'attr'
              ? (el.getAttribute(rule.attr ?? '') ?? '')
              : (el.textContent ?? '').trim()
          );
          return { anchored, values };
        } catch {
          // An invalid selector throws here. Reporting it as un-anchored is exactly right: it means
          // "no information", so a later fallback rule still gets its turn.
          return { anchored: false, values: [] };
        }
      };

      let stopWatching = () => {};

      const watchUnread = (rules: DomUnreadRule[]) => {
        stopWatching();
        stopWatching = () => {};
        // The overwhelmingly common case, and it must cost nothing: no rules, no observer.
        if (!Array.isArray(rules) || rules.length === 0) return;

        let previous = '';
        const report = () => {
          const probes = rules.map(probeRule);
          // A chat app rewrites its DOM continuously. Without this, every keystroke anyone types in
          // a channel is an IPC message saying the count is still 3.
          const encoded = JSON.stringify(probes);
          if (encoded === previous) return;
          previous = encoded;
          reportUnread(probes);
        };

        let pending = 0;
        const schedule = () => {
          if (pending) return;
          pending = window.setTimeout(() => {
            pending = 0;
            report();
          }, 400);
        };

        const observer = new MutationObserver(schedule);
        observer.observe(document, {
          subtree: true,
          childList: true,
          characterData: true,
          // Whole-document attribute mutations are the expensive subscription, so only take it when
          // a rule actually reads an attribute.
          attributes: rules.some((rule) => rule.read === 'attr'),
        });

        // A badge inside a shadow root or drawn to a canvas mutates nothing the observer can see,
        // and a service that renders once and idles would otherwise never report at all.
        const poll = setInterval(report, 30_000);

        stopWatching = () => {
          observer.disconnect();
          clearInterval(poll);
          clearTimeout(pending);
        };

        report();
      };

      onUnreadRules(watchUnread);
      void unreadRules()
        .then(watchUnread)
        .catch(() => {
          // Main is gone or the view is being torn down. The service itself is unaffected.
        });
    },
  });
} catch (err) {
  // executeInMainWorld is still marked experimental. If it ever goes away, notifications lose
  // attribution rather than the service breaking — worth knowing, so log it loudly.
  console.error('[preload] could not patch the main world; notifications will not be attributed', err);
}

export {};
