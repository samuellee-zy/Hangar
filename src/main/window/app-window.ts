import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BaseWindow,
  View,
  WebContentsView,
  dialog,
  app,
  nativeTheme,
  screen,
  session,
  type WebContents,
} from 'electron';
import { catalogById, resolveUrl } from '@shared/catalog';
import {
  loadConfig,
  updateConfig,
  updateConfigReturning,
  quarantinedConfigs,
  configFilePath,
  onConfigSaved,
  saveConfig,
} from '@main/platform/config';
import {
  Layout,
  PANE_RADIUS,
  chromeFor,
  contentArea,
  railBounds,
  railSizes,
  windowButtonPosition,
} from '@core/workspace/layout';
import { Overlay } from '@main/window/overlay';
import { DragLayer } from '@main/features/drag-layer';
import { loadRoute } from '@main/platform/renderer-url';
import { ServiceManager, startPageFor } from '@main/window/service-manager';
import { FindBar } from '@main/features/find-bar';
import { AttentionCenter } from '@main/window/attention';
import { PreferenceEffects } from '@main/window/preference-effects';
import { TileDrag } from '@main/window/tile-drag';
import { route, type ShellContext } from '@main/window/commands';
import { closePopOuts } from '@main/features/popout';
import { deleteCachedIcon, iconVersions } from '@main/features/icons';
import { installWebContextMenu } from '@main/features/context-menu';
import { LONG_SUSPEND_MS, servicesToHibernate, servicesToRefresh } from '@core/runtime/hibernate';
import { expiredQuiet } from '@core/notify/policy';
import { safeSend } from '@main/platform/safe-send';
import { appBackground, windowButtonMetrics } from '@main/platform/native-chrome';
import { railCanExpand } from '@shared/chrome';
import { accentFor, hexFor } from '@shared/accent';
import {
  releaseGlobalShortcut,
  globalShortcutStatus,
  onDownloadsChanged,
  recentDownloads,
} from '@main/platform/system';
import { clearBlockedHost, hostBlockedFor, setLinkRouter } from '@main/platform/session';
import { routable, routeTarget } from '@core/services/routing';
import { canCompose, composeUrlFor } from '@shared/mailto';
import { destroyTray, refreshTray } from '@main/features/tray';
import { isQuitting } from '@main/platform/quit-state';
import { findOrphanPartitions } from '@core/runtime/permissions';
import { isValidHost } from '@core/services/patch';
import { rehomeUnreachable } from '@core/workspace/workspaces';
import { closeSettingsWindow } from '@main/features/settings-window';
import { attachShortcuts } from '@main/window/shortcuts';
import { refreshMenu } from '@main/boot/menu';
import {
  DEFAULT_BINDINGS,
  resolvePassthrough,
  type KeyContext,
} from '@core/keyboard/keymap';
import {
  activeServicesOf,
  activeWorkspaceOf,
  projectShellState,
  removeServiceFromConfig,
  resolveCommand,
  withoutServiceCode,
} from '@core/shell-state';
import { ConfigSync } from '@main/features/sync';
import { readSyncBase, writeSyncBase } from '@main/platform/sync-base';
import { PushManager } from '@main/features/push-manager';
import { EndpointPoller } from '@main/features/endpoint-poll';
import { firebaseConfigStatus, pushEligible } from '@core/push/policy';
import { reachableBounds, sameBounds } from '@core/workspace/window-bounds';
import { resolveRepoPath } from '@core/config/sync';
import { LOG_FILE, sinceLaunch } from '@main/platform/log-file';
import type {
  Command,
  DomUnreadRule,
  OverlayMode,
  Rect,
  ServiceInstance,
  ShellState,
  WindowBounds,
  Workspace,
} from '@shared/types';

/**
 * `AppWindow` composes the shell: the window itself, the rail, the panes, and the overlay.
 *
 * It is the only place commands are interpreted. Every mutation goes through `dispatch`, and every
 * mutation ends in `sync()`, which broadcasts to *all* registered consumers — rail, overlay and
 * Settings. Sending to just one is what left the connection picker rendering a stale snapshot
 * (docs/decisions.md #17).
 *
 * Panes are native `WebContentsView`s, not DOM, so anything spanning the rail and a pane — drag,
 * keyboard routing, z-order — has to be coordinated here rather than in the renderer.
 */

/**
 * Saved bounds are only honoured if the window's title strip still lands on a connected display —
 * otherwise unplugging an external monitor strands the window offscreen with no way to get it back.
 * The rule itself is in core; this supplies the displays.
 */
function restoreBounds(saved: WindowBounds | undefined): WindowBounds {
  return reachableBounds(
    saved,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
  );
}

/** The `[boot]` mark for the first service page: once per process, not once per rebuilt window. */
let firstPaneTimed = false;

/** The Settings window, the one renderer that edits a service's custom CSS and JavaScript. */
const isSettingsView = (wc: WebContents): boolean => !wc.isDestroyed() && wc.getURL().includes('#settings');

/** How often config sync asks the remote for changes made on another machine. */
const SYNC_POLL_MS = 5 * 60_000;

/**
 * Composes the shell: window, rail, panes, overlay. Every mutation funnels through `dispatch`,
 * and every mutation ends in `sync()` — the rail is a pure render target, so there is exactly one
 * way for its state to change.
 */
export class AppWindow {
  readonly win: BaseWindow;
  private rail: WebContentsView;
  private layout = new Layout();
  private services: ServiceManager;
  private overlay: Overlay;
  private findBar: FindBar;
  /**
   * Attached only while a rail tile is in flight. See `features/drag-layer.ts` — the short version
   * is that a drag can't cross a `webContents` boundary, so the pointer is kept inside one.
   */
  private dragLayer: DragLayer;
  /**
   * A compact rail opened by the chevron. Meaningless unless `compactRail` is on, which `railSizes`
   * enforces so no reader has to check both.
   *
   * Deliberately not persisted. It's a one-click toggle either way, and a rail that came back open
   * from last week is exactly the screen space the preference was turned on to reclaim.
   */
  private railExpanded = false;
  private consumers = new Set<WebContents>();
  private flashServiceId: string | null = null;
  /**
   * The last "edit this name" request. Never cleared — the nonce is what the rail keys off, so a
   * stale request re-broadcast with every other state change is inert.
   */
  private renameRequest: { id: string; nonce: number } = { id: '', nonce: 0 };
  /**
   * Unread, banners, the badge and recent notifications — see attention.ts. The host is lazy (every
   * member is read at call time), so it is safe to build before the constructor has run.
   */
  private attention = new AttentionCenter({
    drawnServiceIds: () => this.layout.drawnServiceIds(),
    paneServiceIds: () => this.layout.panes.map((p) => p.serviceId),
    isLive: (serviceId) => this.services.has(serviceId),
    contentsFor: (serviceId) => this.contentsForService(serviceId),
    windowOnScreen: () => this.windowOnScreen(),
    sync: () => this.sync(),
    focusService: (serviceId) => {
      this.showWindow();
      this.dispatch({ type: 'focus-service', serviceId });
    },
  });
  /**
   * Unread counts live in the attention centre rather than on `ServiceRuntime`, so they survive
   * hibernation and can be set for a service that was never loaded. See core/notify/unread.ts.
   */
  private get unread() {
    return this.attention.unread;
  }
  private flashTimer: NodeJS.Timeout | null = null;

  /**
   * Web Push receiver. Constructed always, started only once there's a window to notify — a socket
   * that opens before anything can display a message just drops it.
   */
  private push: PushManager;

  /**
   * Git-backed config sync. Inert until `sync.repoPath` is set.
   *
   * Named `configSync` because `sync()` is already the state broadcaster — two very different
   * things that would otherwise share a name on the same object.
   */
  private configSync: ConfigSync;

  /**
   * Unread for services that are asleep, asked of their own endpoints over their own cookie jars.
   *
   * Only sleeping ones: a live view reports its title and its badge, both of which are fresher and
   * cost nothing, and two absolute sources for one service is a badge that flips.
   */
  private endpoints: EndpointPoller;

  constructor() {
    this.win = new BaseWindow({
      ...restoreBounds(loadConfig().window),
      minWidth: 720,
      minHeight: 480,
      title: 'Hangar',
      // 'hidden' rather than 'hiddenInset' so the traffic-light position is ours to control;
      // hiddenInset adds its own inset and left them straddling the rail's right edge.
      titleBarStyle: 'hidden',
      // Initial placement only; relayout() repositions these whenever the rail moves. The same
      // chrome relayout uses, compact included, so they don't open in the rail and jump out of it.
      trafficLightPosition: windowButtonPosition(this.chrome(), windowButtonMetrics()),
      backgroundColor: appBackground(),
    });
    nativeTheme.on('updated', this.repaintBackground);

    this.services = new ServiceManager(
      () => this.sync(),
      (c) => this.dispatch(c),
      (serviceId) => this.keyContextFor(serviceId),
      (wc) => {
        installWebContextMenu(wc, this.win);
        if (!firstPaneTimed) {
          firstPaneTimed = true;
          wc.once('did-finish-load', () => console.log(`[boot] first pane loaded at ${sinceLaunch()}ms`));
        }
      },
      (active, total) => {
        const contents = this.findBar.contents;
        if (contents) safeSend(contents, 'find:result', { active, total });
      },
      (serviceId, title) => this.attention.handleTitle(serviceId, title),
    );
    this.findBar = new FindBar(this.win, (wc) => this.adoptSurface(wc));
    this.overlay = new Overlay(this.win, (wc) => this.adoptSurface(wc));
    this.dragLayer = new DragLayer(this.win);

    this.rail = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/sidebar.cjs'),
        contextIsolation: true,
        // Explicit rather than left to the default: these views hold the app's bridge (decisions #97).
        sandbox: true,
      },
    });
    this.win.contentView.addChildView(this.rail);
    loadRoute(this.rail.webContents, 'rail');
    this.rail.webContents.once('did-finish-load', () =>
      console.log(`[boot] rail loaded at ${sinceLaunch()}ms`),
    );
    this.adoptSurface(this.rail.webContents);

    this.win.on('resize', () => {
      this.relayout();
      this.saveWindowBounds();
    });
    this.win.on('move', () => this.saveWindowBounds());
    this.win.on('focus', () => (this.defaultMailApp = null));
    this.win.on('show', () => this.attention.acknowledgePanes());
    this.win.on('restore', () => this.attention.acknowledgePanes());
    // The debounce means a window that's never moved would otherwise never record its bounds,
    // and a quit inside the debounce window would drop the last change.
    this.win.on('close', (event: Electron.Event) => {
      this.saveWindowBounds({ immediate: true });
      // Hide rather than destroy, so the tray icon still leads somewhere.
      if (loadConfig().preferences.behaviour.closeToTray && !isQuitting()) {
        event.preventDefault();
        this.hideWindow();
      }
    });

    // Safety net: a service reachable from no workspace is invisible everywhere while still
    // holding a session. Rehome before the first render rather than leaving it stranded.
    const stranded = updateConfigReturning(rehomeUnreachable);
    if (stranded.length) console.warn(`[workspace] rehomed ${stranded.length} stranded service(s)`);

    this.push = new PushManager({
      firebase: () => loadConfig().preferences.notifications.firebase,
      load: () => loadConfig().pushRegistrations ?? [],
      save: (registrations) =>
        updateConfig((c) => {
          c.pushRegistrations = registrations;
        }),
      deliver: (serviceId, message) => this.attention.handlePushMessage(serviceId, message),
      log: (message) => console.log(`[push] ${message}`),
    });

    this.endpoints = new EndpointPoller(
      () => loadConfig().services.filter((svc) => !this.services.has(svc.id)),
      (serviceId, count) => this.attention.applyEndpointCount(serviceId, count),
    );

    this.configSync = new ConfigSync({
      // Optional-chained: a config from before this preference existed has no `sync` section, and
      // reading through it unguarded threw inside a `void`-ed promise where nothing surfaced it.
      repoPath: () => resolveRepoPath(loadConfig().preferences.sync?.repoPath, os.homedir()),
      // Same optional chain, same reason: a config predating this preference has no `sync` section.
      // Defaulting to false is the safe direction — the guard stays on.
      allowPublicRepo: () => loadConfig().preferences.sync?.allowPublicRepo ?? false,
      read: () => loadConfig(),
      // `sync: false` — this write comes *from* sync, and the default hook would feed it back.
      write: (next) => saveConfig(next, { sync: false }),
      readBase: () => readSyncBase(),
      writeBase: (text) => writeSyncBase(text),
      onApplied: (previous) => {
        // Theme, tray, shortcut, ad blocking, push: an incoming config changes them like any other
        // edit, and they used to stay as they were until a restart while Settings showed the new.
        this.effects.applyChanged(previous.preferences);
        // Mirrors `import-config` exactly. Calling `restoreLayout()` without clearing first
        // appends to the existing panes — `Layout.add` never dedupes — so two panes became four,
        // each service shown twice, and `saveLayout()` made it stick.
        for (const [serviceId] of [...this.services.all()]) this.sleep(serviceId);
        this.layout.panes = [];
        this.layout.focusedPaneId = null;
        this.restoreLayout();
        this.relayout();
        this.sync();
      },
      onStatusChange: () => this.sync(),
      log: (message) => console.log(`[sync] ${message}`),
    });

    // The single funnel: every config write schedules a reconcile. Sync previously fired only from
    // `set-preference`, so adding a service or a workspace never travelled.
    onConfigSaved(() => this.configSync.schedule());
    setLinkRouter((url, fromServiceId) => this.routeLink(url, fromServiceId));
    onDownloadsChanged(() => this.sync());

    // Safe to start here despite `onApplied` touching panes: `reconcile` awaits `git --version`
    // before doing anything, so the constructor's own `restoreLayout()` below has always run by the
    // time an incoming config could land.
    void this.configSync.reconcile();
    this.configSync.startPolling(SYNC_POLL_MS);

    this.scanOrphanPartitions();
    this.restoreLayout();
    this.relayout();

    // Reconnect whatever was already registered, so a restart doesn't mean silence until each
    // service is opened once.
    // Both conditions, matching applyPreferenceEffect. Starting without complete credentials means
    // every registration fails and the reconnect loop retries them forever.
    const notify = loadConfig().preferences.notifications;
    if (notify.push && firebaseConfigStatus(notify.firebase) === 'ready') {
      this.push.start(loadConfig().services.map((s) => s.id));
    }
  }

  // --- persistence ------------------------------------------------------------------------

  /**
   * Rebuild the last arrangement for the active workspace. Pane ids are regenerated rather than
   * reused — a stored pane whose service has since been deleted must not resurrect a dead id, so
   * we filter against the current service list and fall back to the first service.
   */
  private restoreLayout(): void {
    const config = loadConfig();
    const workspaceId = config.activeWorkspaceId;
    const stored = workspaceId ? config.layouts[workspaceId] : undefined;
    const available = new Set(this.activeServices(workspaceId).map((s) => s.id));

    const serviceIds = (stored?.panes ?? [])
      .map((p) => p.serviceId)
      .filter((id) => available.has(id));
    // Resolve the focused *service*, not its index. The index was computed against the unfiltered
    // stored array and then applied to the filtered live one, so any deleted service shifted focus
    // onto the wrong pane: stored [deleted, Gmail, Notion] focused on Gmail (index 1) filtered to
    // [Gmail, Notion], and panes[1] is Notion.
    const focusedServiceId =
      stored?.panes.find((p) => p.id === stored.focusedPaneId)?.serviceId ?? null;

    if (serviceIds.length === 0) {
      const first = this.activeServices(workspaceId)[0];
      if (first) this.openService(first.id, { newPane: true });
      return;
    }

    // try/finally: a throw here used to leave the flag set for the process lifetime, silently
    // disabling every subsequent layout save.
    this.restoring = true;
    try {
      for (const serviceId of serviceIds) this.openService(serviceId, { newPane: true });
    } finally {
      this.restoring = false;
    }
    const focusedIndex = focusedServiceId ? serviceIds.indexOf(focusedServiceId) : -1;
    const restoredFocus = this.layout.panes[focusedIndex >= 0 ? focusedIndex : 0];
    if (restoredFocus) this.layout.focusedPaneId = restoredFocus.id;
    this.saveLayout();
  }

  private saveLayout(): void {
    // The flag was set and cleared but never read, so restoring four panes performed four full
    // write-and-rename cycles at startup, each persisting a *partial* pane list — and a throw
    // mid-restore left the truncated layout on disk permanently.
    if (this.restoring) return;
    const workspaceId = loadConfig().activeWorkspaceId;
    if (!workspaceId) return;
    updateConfig((c) => {
      c.layouts[workspaceId] = {
        panes: this.layout.panes.map((p) => ({ ...p })),
        focusedPaneId: this.layout.focusedPaneId,
      };
    });
  }

  /** Debounced — `resize` and `move` fire continuously while dragging. */
  private boundsTimer: NodeJS.Timeout | null = null;
  private saveWindowBounds({ immediate = false } = {}): void {
    if (this.boundsTimer) clearTimeout(this.boundsTimer);

    const write = () => {
      if (this.win.isDestroyed() || this.win.isMinimized()) return;
      // The normal bounds, not the current ones: saved while fullscreen or zoomed, the window came
      // back next launch at the size of the whole screen, with no way to un-zoom it to what it was.
      const { x, y, width, height } = this.win.getNormalBounds();
      updateConfig((c) => {
        c.window = { x, y, width, height };
      });
    };

    if (immediate) write();
    else this.boundsTimer = setTimeout(write, 400);
  }

  // --- state ------------------------------------------------------------------------------

  private activeWorkspace(workspaceId: string | null) {
    return activeWorkspaceOf(loadConfig(), workspaceId);
  }

  /** Flattened in rail order, so ⌘1..9 and the palette match what you see. */
  private activeServices(workspaceId: string | null): ServiceInstance[] {
    return activeServicesOf(loadConfig(), workspaceId);
  }

  /**
   * Whether macOS sends `mailto:` here. Asked once and remembered, rather than on every state
   * broadcast — it is a Launch Services query, and a resize alone broadcasts dozens of times.
   * Forgotten when the window regains focus (the answer can change in Mail's settings while you're
   * elsewhere) and after Hangar asks to become the default.
   */
  private defaultMailApp: boolean | null = null;

  private isDefaultMailApp(): boolean {
    this.defaultMailApp ??= app.isPackaged && app.isDefaultProtocolClient('mailto');
    return this.defaultMailApp;
  }

  /**
   * What `shell:get-state` answers a renderer with: the same split as `broadcast`.
   *
   * Pulled by each renderer on mount. The push in `Overlay.open()` races the view's first load — on
   * the very first open the renderer hasn't subscribed yet, so the message vanished and the overlay
   * rendered nothing while still swallowing every click.
   */
  stateFor(wc: WebContents): ShellState {
    const state = this.state();
    return isSettingsView(wc) ? state : withoutServiceCode(state);
  }

  state(): ShellState {
    return projectShellState({
      config: loadConfig(),
      runtimes: this.services.all(),
      unread: this.unread.snapshot(),
      panes: this.layout.panes,
      focusedPaneId: this.layout.focusedPaneId,
      orphanPartitions: this.orphanPartitions,
      quarantinedConfigs: quarantinedConfigs(),
      syncStatus: this.configSync.current(),
      flashServiceId: this.flashServiceId,
      renameRequest: this.renameRequest,
      railExpanded: this.railExpanded,
      iconVersions: iconVersions(),
      about: { version: app.getVersion(), configPath: configFilePath(), logPath: LOG_FILE },
      globalShortcutStatus: globalShortcutStatus(),
      isDefaultMailApp: this.isDefaultMailApp(),
      recentNotifications: this.attention.recentNotifications(),
      downloads: recentDownloads(),
    });
  }

  /** Current on-screen rectangle of a pane, for positioning the find bar. */
  private paneRect(paneId: string) {
    const { width, height } = this.win.getContentBounds();
    return this.layout.bounds(this.chrome(), width, height).get(paneId) ?? null;
  }

  /**
   * The window title follows the focused service, the way a browser follows the active tab.
   * Permanently reading "Hangar" told you nothing, especially in ⌘-tab.
   */
  private updateTitle(): void {
    const pane = this.layout.focused();
    const svc = pane && loadConfig().services.find((s) => s.id === pane.serviceId);
    this.win.setTitle(svc ? `${svc.name} — Hangar` : 'Hangar');
  }

  /** What the drag layer should be drawing, for its page once it's listening. */
  dragHighlight() {
    return this.dragLayer.currentHighlight();
  }

  get overlayOpen(): { mode: OverlayMode; nonce: number } | null {
    const mode = this.overlay.currentMode;
    return mode ? { mode, nonce: this.overlay.currentNonce } : null;
  }

  /**
   * Partition directories with no account pointing at them — sessions left behind by services that
   * were removed. Scanned once at boot and after a purge; there's no reason to stat the disk on
   * every sync.
   */
  private orphanPartitions: string[] = [];

  scanOrphanPartitions(): void {
    const dir = path.join(app.getPath('userData'), 'Partitions');
    let onDisk: string[] = [];
    try {
      onDisk = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      onDisk = []; // no Partitions dir yet
    }
    this.orphanPartitions = findOrphanPartitions(
      loadConfig().accounts.map((a) => a.partition),
      onDisk,
    );
    if (this.orphanPartitions.length) {
      console.log(`[partitions] ${this.orphanPartitions.length} unused session(s) on disk`);
    }
  }

  /** User-triggered only. Deleting cookie jars is not something to do automatically at boot. */
  private purgeOrphanPartitions(): void {
    if (!this.orphanPartitions.length) return;
    const response = dialog.showMessageBoxSync(this.win, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete ${this.orphanPartitions.length} unused session(s)?`,
      detail:
        'These belong to connections that were removed. Deleting frees disk space and clears ' +
        'their cookies. If you re-add one of those services you will need to sign in again.',
    });
    if (response !== 0) return;

    const base = path.join(app.getPath('userData'), 'Partitions');
    for (const name of this.orphanPartitions) {
      try {
        fs.rmSync(path.join(base, name), { recursive: true, force: true });
        console.log(`[partitions] deleted ${name}`);
      } catch (err) {
        console.error(`[partitions] could not delete ${name}:`, err);
      }
    }

    this.scanOrphanPartitions();
    this.sync();
  }

  /** The error page's Try again button. Resets backoff — this is a deliberate human retry. */
  retryService(serviceId: string): void {
    const runtime = this.services.get(serviceId);
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!runtime || !svc || runtime.view.webContents.isDestroyed()) return;
    runtime.failures = 0;
    void runtime.view.webContents.loadURL(startPageFor(svc));
  }

  /**
   * The blocked page's Allow button. Adds the host main last refused for this service, then
   * reloads it so the interrupted sign-in step can be retried.
   *
   * Additive via `extraAllowedHosts`, never by rewriting `allowedHosts` — see the field's comment:
   * a merged list written back would pin the instance to today's catalog forever.
   */
  allowBlockedHost(serviceId: string): void {
    const host = hostBlockedFor(serviceId);
    // Already a hostname parsed out of a URL, so the check is belt and braces — but this writes to
    // the allowlist, and the one place that must not accept a surprising value is that one.
    if (!host || !isValidHost(host)) return;
    updateConfig((c) => {
      const svc = c.services.find((s) => s.id === serviceId);
      if (!svc) return;
      const extra = svc.extraAllowedHosts ?? [];
      if (extra.includes(host)) return;
      svc.extraAllowedHosts = [...extra, host];
    });
    console.log(`[nav] ${serviceId}: allowed ${host}`);
    clearBlockedHost(serviceId);
    // The guards re-read config per navigation, so no view rebuild is needed — the reload alone
    // is enough for the newly allowed host to be accepted.
    this.retryService(serviceId);
    this.sync();
  }

  /** Diagnostic: the live webContents for a service, if it has one. */
  contentsForService(serviceId: string): WebContents | null {
    const runtime = this.services.get(serviceId);
    return runtime && !runtime.view.webContents.isDestroyed() ? runtime.view.webContents : null;
  }

  /** Maps a webContents back to its service, so IPC can be attributed to a sender. */
  serviceIdForContents(wc: WebContents): string | null {
    for (const [serviceId, runtime] of this.services.all()) {
      if (runtime.view.webContents === wc) return serviceId;
    }
    return null;
  }

  /**
   * The preload reports a blank body. Reload at most once per minute per service — a page that is
   * genuinely broken would otherwise reload forever, which is worse than showing nothing.
   */
  private lastBlankReload = new Map<string, number>();

  reloadIfStillBlank(serviceId: string): void {
    const last = this.lastBlankReload.get(serviceId) ?? 0;
    if (Date.now() - last < 60_000) return;
    const wc = this.services.get(serviceId)?.view.webContents;
    if (!wc || wc.isDestroyed() || wc.isLoading()) return;
    this.lastBlankReload.set(serviceId, Date.now());
    console.log(`[blank] reloading ${serviceId}`);
    wc.reload();
  }

  /** Diagnostic access for the startup probe. */
  get overlayContents() {
    return this.overlay.contents;
  }

  get railContents() {
    return this.rail.webContents;
  }

  /**
   * Every surface that renders shell state registers here. Previously `sync()` sent only to the
   * rail, so the picker and Settings silently rendered whatever they fetched on mount — which is
   * how "the picker doesn't load any new option" happened. Fanning out means a fourth surface
   * can't reintroduce it.
   */
  registerConsumer(wc: WebContents): void {
    this.consumers.add(wc);
    wc.once('destroyed', () => this.consumers.delete(wc));
  }

  /**
   * Everything one of *our* renderers needs: shell state, and the keymap.
   *
   * Both, together, because they were forgotten separately. The rail, the overlay, the find bar and
   * the empty view are four surfaces that should be indistinguishable to the keyboard, and each was
   * wired by hand — so the overlay had a hand-rolled Escape and nothing else, and the find bar and
   * the empty view had no shortcuts at all. ⌘K was dead on three of the four.
   *
   * Service views are pointedly not here: they get the same treatment plus their own passthrough
   * list, which is `ServiceManager`'s to supply.
   */
  private adoptSurface(wc: WebContents): void {
    this.registerConsumer(wc);
    attachShortcuts(
      wc,
      (c) => this.dispatch(c),
      () => this.shellKeyContext(),
    );
  }

  /**
   * The keymap for a surface with no page behind it to defer to.
   *
   * Read on every keystroke rather than captured, so a rebind reaches views that have been open
   * since before it happened.
   */
  private shellKeyContext(): KeyContext {
    return { bindings: this.bindings(), passthrough: [] };
  }

  /** The keymap for a service view: the same bindings, minus whatever that service has claimed. */
  private keyContextFor(serviceId: string): KeyContext {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    return {
      bindings: this.bindings(),
      passthrough: resolvePassthrough(
        svc?.keyboardPassthrough,
        svc && catalogById(svc.catalogId)?.passthrough,
      ),
    };
  }

  /** Optional-chained for the same reason `sync` is: a config predating the preference has none. */
  private bindings() {
    return loadConfig().preferences.keyboard?.bindings ?? DEFAULT_BINDINGS;
  }

  /**
   * Broadcast state to every surface — soon, once, and only where it changed.
   *
   * It was immediate, whole, and unconditional: every call sent the full state to every surface,
   * and it is called on every page load start and stop, every resize event (through relayout) and
   * every mutation. The rail, Settings and the overlay then re-rendered completely each time. Now
   * calls within one frame collapse into one broadcast, and a surface is only sent a state that
   * differs from the last one it received — per surface, so one that has just opened still gets
   * the current state even if nothing changed.
   *
   * `state()` is still synchronous for anyone who needs it now; only the broadcast waits.
   */
  private syncScheduled: ReturnType<typeof setTimeout> | null = null;
  private lastSent = new WeakMap<WebContents, string>();

  sync(): void {
    if (this.syncScheduled) return;
    this.syncScheduled = setTimeout(() => {
      this.syncScheduled = null;
      this.broadcast();
    }, 16);
  }

  private broadcast(): void {
    if (this.win.isDestroyed()) return;
    const state = this.state();
    // Scripts and stylesheets only to Settings, which edits them — see `withoutServiceCode`.
    const lean = withoutServiceCode(state);
    const signatures = new Map([
      [state, JSON.stringify(state)],
      [lean, JSON.stringify(lean)],
    ]);
    for (const wc of this.consumers) {
      const payload = isSettingsView(wc) ? state : lean;
      const signature = signatures.get(payload)!;
      if (this.lastSent.get(wc) === signature) continue;
      this.lastSent.set(wc, signature);
      safeSend(wc, 'shell:state', payload);
    }
    refreshTray(state, (c) => this.dispatch(c));
    this.refreshMenuIfRebound(state.preferences.keyboard?.bindings);
  }

  /**
   * The menu draws each chord beside its label, so it goes stale the moment one moves.
   *
   * Detected here rather than called from the rebind handler, for the same reason `onConfigSaved`
   * drives config sync: bindings change from at least four places — a rebind, a section reset, a
   * whole-config import, and an incoming sync — and a list of call sites is a list of things to
   * forget. Every one of them ends in `sync()`.
   *
   * The comparison is a stringify of fifteen short strings against a stored copy, which is cheap
   * enough to do on a broadcast that also fires for a page finishing loading.
   */
  private lastMenuBindings: string | null = null;
  private refreshMenuIfRebound(bindings: Record<string, string> | undefined): void {
    const signature = JSON.stringify(bindings ?? {});
    if (signature === this.lastMenuBindings) return;
    const first = this.lastMenuBindings === null;
    this.lastMenuBindings = signature;
    // Nothing to redraw before the first broadcast — `installMenu` has just built it, or hasn't
    // run yet and will build it against these same bindings.
    if (!first) refreshMenu();
  }

  /**
   * A `mailto:` link from anywhere on the Mac: a new message in your chosen mail service.
   *
   * Falls back to the first mail service that can take one when none is chosen, so making Hangar
   * the default email app and clicking an address does something the first time rather than
   * nothing until a second setting is found.
   */
  openMailto(link: string): void {
    const config = loadConfig();
    const chosen = config.services.find((s) => s.id === config.preferences.behaviour.mailtoServiceId);
    const svc = chosen && canCompose(chosen.catalogId) ? chosen : config.services.find((s) => canCompose(s.catalogId));
    this.showWindow();
    if (!svc) {
      console.warn('[mailto] no mail service here can open a new message — add Gmail, Outlook or Yahoo');
      this.dispatch({ type: 'open-settings' });
      return;
    }
    const url = composeUrlFor(svc.catalogId, link);
    if (!url) return;
    this.dispatch({ type: 'focus-service', serviceId: svc.id });
    this.contentsForService(svc.id)?.loadURL(url).catch(() => {
      // Reported through did-fail-load.
    });
  }

  /**
   * A link leaving `fromServiceId`: opened in the service it belongs to, when link routing is on and
   * one of yours matches (see core/services/routing.ts). Returns whether it took the link.
   */
  private routeLink(url: string, fromServiceId: string): boolean {
    const config = loadConfig();
    if (!config.preferences.behaviour.routeLinks) return false;
    const target = routeTarget(url, routable(config.services, resolveUrl), fromServiceId);
    if (!target) return false;
    const name = config.services.find((s) => s.id === target)?.name ?? target;
    console.log(`[nav] routed a link to ${name}`);
    this.dispatch({ type: 'focus-service', serviceId: target });
    const wc = this.contentsForService(target);
    wc?.loadURL(url).catch(() => {
      // Reported through did-fail-load, which decides what happens next.
    });
    return true;
  }

  /**
   * Hide the window, leaving native fullscreen first if it's in it.
   *
   * `hide()` on a fullscreen window leaves its Space behind: an empty black desktop you are swiped
   * into, with nothing on it, until you find your way out. Fullscreen has to be left first, and
   * leaving it is animated, so the hide waits for it to finish.
   */
  hideWindow(): void {
    if (this.win.isDestroyed()) return;
    if (this.win.isFullScreen()) {
      this.win.once('leave-full-screen', () => {
        if (!this.win.isDestroyed()) this.win.hide();
      });
      this.win.setFullScreen(false);
      return;
    }
    this.win.hide();
  }

  showWindow(): void {
    // Checked again here, not only at construction. A window closed to the tray on an external
    // monitor that is then unplugged comes back from `show()` exactly where it was — macOS only
    // rescues windows that are visible when the display goes — so "show" put it nowhere.
    //
    // Only for a window that *isn't* on screen, which is the case above and the only one. `activate`
    // lands here on every Dock click and at launch, and correcting a visible window's bounds is a
    // resize, and a resize is a relayout — which ends any tile drag in progress. On a CI runner whose
    // display is smaller than the window, a late `activate` did exactly that, mid-drag.
    const offScreen = !this.win.isVisible() || this.win.isMinimized();
    // Already on screen: showing it is focusing it, which is all `activate` did before it learned
    // to show a hidden window. Nothing else — `show()` re-orders the window and raises events, and
    // `activate` can arrive at any moment, mid-drag included (it arrives late on CI).
    if (!offScreen) {
      this.win.focus();
      return;
    }
    if (this.win.isMinimized()) this.win.restore();
    if (!this.win.isFullScreen()) {
      const current = this.win.getBounds();
      const reachable = restoreBounds(current);
      if (!sameBounds(current, reachable)) this.win.setBounds(reachable);
    }
    this.win.show();
    this.win.focus();
  }

  /** Pulse a rail tile, then clear it so the next sync doesn't replay the animation. */
  private flash(serviceId: string): void {
    this.flashServiceId = serviceId;
    this.sync();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashServiceId = null;
      this.sync();
    }, 900);
  }

  // --- panes ------------------------------------------------------------------------------

  /** Suppresses the per-call layout save while a batch of panes is being restored. */
  private restoring = false;

  private openService(serviceId: string, { newPane = false } = {}): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return;

    // Shortcuts are bound inside ensure(), once per view.
    this.services.ensure(svc);

    if (newPane && !this.layout.isFull) this.layout.add(serviceId);
    else this.layout.show(serviceId);

    this.relayout();
    this.saveLayout();
  }

  /** Follows the theme — the system's, or the preference's — as it changes. See `appBackground`. */
  private readonly repaintBackground = (): void => {
    if (!this.win.isDestroyed()) this.win.setBackgroundColor(appBackground());
  };

  /** What the *panes* have to work around. */
  private chrome() {
    const appearance = loadConfig().preferences.appearance;
    const { railPosition, gutter } = appearance;
    const sizes = railSizes(appearance, this.railExpanded);
    return chromeFor(railPosition, sizes.reserved, gutter, this.smallestRailSize());
  }

  /**
   * Where the rail view actually sits. The same rectangle the panes were laid out against, since
   * they reflow around the rail rather than letting it sit over them.
   *
   * Still its own method because the origin is load-bearing beyond the drawing: a right-hand rail's
   * origin moves when it grows, and the drag code translates rail-relative pointer positions
   * through it.
   */
  private railRect(width: number, height: number): Rect {
    const appearance = loadConfig().preferences.appearance;
    const { railPosition, gutter } = appearance;
    const size = railSizes(appearance, this.railExpanded).rail;
    return railBounds(
      chromeFor(railPosition, size, gutter, this.smallestRailSize()),
      width,
      height,
    );
  }

  /** The narrowest the rail will get without a preference change. See `chromeFor`. */
  private smallestRailSize(): number {
    const appearance = loadConfig().preferences.appearance;
    return railSizes(appearance, false).rail;
  }

  /**
   * Shown when no pane can be filled. Without it, removing the last service leaves a blank window
   * whose only exit is a `+` in a rail that now also looks empty — the app appears broken.
   */
  private emptyView: WebContentsView | null = null;

  private setEmptyVisible(
    visible: boolean,
    chrome: ReturnType<AppWindow['chrome']>,
    width: number,
    height: number,
  ): void {
    if (!visible) {
      if (this.emptyView) {
        this.win.contentView.removeChildView(this.emptyView);
        this.emptyView.webContents.close();
        this.emptyView = null;
      }
      return;
    }

    if (!this.emptyView) {
      this.emptyView = new WebContentsView({
        webPreferences: {
          preload: path.join(__dirname, '../preload/sidebar.cjs'),
          contextIsolation: true,
          // Explicit rather than left to the default: these views hold the app's bridge (decisions #97).
          sandbox: true,
        },
      });
      loadRoute(this.emptyView.webContents, 'empty');
      this.adoptSurface(this.emptyView.webContents);
    }

    this.win.contentView.addChildView(this.emptyView);
    const area = contentArea(chrome, width, height);
    this.emptyView.setBounds({
      x: area.x + chrome.gutter,
      y: area.y + chrome.gutter,
      width: Math.max(0, area.width - chrome.gutter * 2),
      height: Math.max(0, area.height - chrome.gutter * 2),
    });
    this.emptyView.setBorderRadius(PANE_RADIUS);
  }

  /**
   * Attach exactly the visible views, in pane order, then keep the overlay on top. Detaching
   * rather than hiding matters: a hidden-but-attached view still composites and still eats clicks.
   */
  private relayout(): void {
    // A drag holds a frozen copy of the pane rectangles, and this is the one thing that invalidates
    // them. Ending it is the honest answer: the alternative is a highlight over a pane that has
    // moved, and a drop that lands somewhere the user didn't aim. The layer is also attached above
    // the panes, and the `addChildView` calls below would bury it.
    this.tileDrag.end('relayout');
    // Turning compact off while the rail is open would otherwise leave the flag set, and switching
    // it back on later would give a rail that was already expanded before it was ever collapsed.
    // Moving an open rail to the top or bottom is the same: the flag would outlive the only shape
    // it means anything for, and the rail would draw full-size tiles in a strip sized for icons.
    if (!railCanExpand(loadConfig().preferences.appearance)) this.railExpanded = false;
    // The find bar's target is set once on open, but focus can move underneath it — relayout then
    // moved the bar over the newly focused pane while it was still searching the old one. Closing
    // is the honest answer: the alternative is silently retargeting a search the user is mid-way
    // through.
    if (this.findBar.isOpen && this.findBar.targetServiceId) {
      const focused = this.layout.focused();
      if (!focused || focused.serviceId !== this.findBar.targetServiceId) this.findBar.close();
    }
    const { width, height } = this.win.getContentBounds();
    const chrome = this.chrome();
    const bounds = this.layout.bounds(chrome, width, height);
    // Drawn, not merely in a pane: behind a maximised pane the others keep their places but must
    // come off the window, or they would sit under it — and hit-test — at their old rectangles.
    const visible = this.layout.drawnServiceIds();

    for (const [serviceId, runtime] of this.services.all()) {
      if (!visible.has(serviceId)) this.win.contentView.removeChildView(runtime.view);
    }

    // Looking at a pane is what marks it read — but only if anyone *can* look. Relayout runs on the
    // hibernation sweep every 30s whatever the window is doing, so with the window closed to the
    // tray every service in a pane had its unread wiped before anyone saw it. `show`/`restore`
    // acknowledge the panes instead, once they are actually on screen.
    const onScreen = this.windowOnScreen();
    for (const pane of this.layout.drawn()) {
      const runtime = this.services.get(pane.serviceId);
      const rect = bounds.get(pane.id);
      if (!runtime || !rect) continue;
      // Idle time is measured as time off screen, so refresh the stamp while visible.
      this.services.markActive(pane.serviceId);
      if (onScreen) this.attention.acknowledge(pane.serviceId);
      this.win.contentView.addChildView(runtime.view);
      runtime.view.setBounds(rect);
      // Rounded card. Note Electron's caveat: the cut-out corners still capture clicks — harmless
      // here since nothing sits underneath them but the rail background.
      runtime.view.setBorderRadius(PANE_RADIUS);
    }
    this.drawFocusRing(bounds, chrome.gutter);

    // A pane whose service has no runtime renders nothing, so treat that as empty too.
    const hasVisibleContent = this.layout.panes.some((p) => this.services.has(p.serviceId));
    this.setEmptyVisible(!hasVisibleContent, chrome, width, height);

    // Runtime reposition rather than recreating the window, which `titleBarStyle` would otherwise
    // require — see docs/decisions.md.
    try {
      this.win.setWindowButtonPosition(windowButtonPosition(chrome, windowButtonMetrics()));
    } catch {
      // Older Electron, or a platform without window buttons. Placement just stays as-is.
    }
    this.raiseChrome(width, height);
    this.updateTitle();
    this.sync();
  }

  /**
   * Sizes the rail and puts the window's own furniture back on top of the panes.
   *
   * **The rail is above the panes, always.** It was attached first and so sat underneath, which no
   * longer shows now that the panes reflow around it rather than lying beneath it — but a pane
   * whose bounds are stale for a frame should cover the window's own furniture in neither
   * direction, and one unconditional rule is easier to keep true than a conditional one.
   *
   * `removeChildView` then `addChildView`, matching `Overlay.raise()`: re-adding an existing child
   * is not documented to reorder it.
   *
   * Only when something is actually above it, though. Every relayout — each resize event, the
   * 30-second sweep — detached and re-attached the rail's view, and a rail mid-gesture being taken
   * off the window and put back is exactly the kind of thing that ends a drag in its renderer.
   */
  private raiseChrome(width: number, height: number): void {
    this.rail.setBounds(this.railRect(width, height));
    const children = this.win.contentView.children;
    const railAt = children.indexOf(this.rail);
    const panes = new Set<View>([...this.services.all().values()].map((runtime) => runtime.view));
    if (railAt < 0 || children.slice(railAt + 1).some((child) => panes.has(child))) {
      this.win.contentView.removeChildView(this.rail);
      this.win.contentView.addChildView(this.rail);
    }
    // Both sit above the rail. The drag layer does too, and needs no raise here: the rail can't be
    // resized during a drag, and `relayout` ends one before it reaches this.
    this.overlay.raise();
    this.findBar.raise(this.layout.focusedPaneId ? this.paneRect(this.layout.focusedPaneId) : null);
  }

  /**
   * The chevron was clicked.
   *
   * Refused outright while a tile is in flight. A drag froze the geometry at the lift — including
   * the rail's own origin, which moves when a right-hand rail grows — so resizing the rail
   * underneath it would offset the whole gesture.
   */
  private toggleRail(): void {
    if (this.dragLayer.draggingServiceId) return;
    this.setRailExpanded(!this.railExpanded);
  }

  private setRailExpanded(expanded: boolean): void {
    // Only a compact rail on a side opens; see `railCanExpand`.
    if (expanded && !railCanExpand(loadConfig().preferences.appearance)) return;
    if (this.railExpanded === expanded) return;
    this.railExpanded = expanded;
    // A full relayout, because the panes reflow around the rail rather than sitting under it.
    this.relayout();
  }

  /** Every route to the overlay. */
  private openOverlay(mode: OverlayMode): void {
    this.overlay.open(mode);
  }

  // --- commands ---------------------------------------------------------------------------

  /** Resolves the `#n` / `#focused` placeholders the keyboard layer can't resolve on its own. */
  private resolve(command: Command): Command | null {
    return resolveCommand(command, {
      config: loadConfig(),
      focusedPaneId: this.layout.focusedPaneId,
      focusedServiceId: this.layout.focused()?.serviceId ?? null,
    });
  }

  /** Returns whether anything happened — the keyboard layer uses this to decide whether to
   *  swallow the keystroke. See CommandSink.
   *
   *  The handlers are in `commands/`, one file per concern; this resolves placeholders and looks
   *  the type up. */
  dispatch(raw: Command): boolean {
    const command = this.resolve(raw);
    if (!command) return false;
    return route(command, this.context);
  }

  /**
   * What the command handlers may reach — see commands/context.ts. Getters for the members, so a
   * handler always sees the current object, and closures for the methods, so AppWindow's own
   * members stay private.
   */
  private readonly context: ShellContext = (() => {
    // The getters need the instance, and inside a getter on an object literal `this` is the literal.
    const self = this;
    return {
      get win() {
        return self.win;
      },
      get layout() {
        return self.layout;
      },
      get services() {
        return self.services;
      },
      get overlay() {
        return self.overlay;
      },
      get findBar() {
        return self.findBar;
      },
      get configSync() {
        return self.configSync;
      },
      dispatch: (c) => this.dispatch(c),
      sync: () => this.sync(),
      relayout: () => this.relayout(),
      showWindow: () => this.showWindow(),
      focusActivePane: () => this.focusActivePane(),
      openOverlay: (mode) => this.openOverlay(mode),
      openService: (id, options) => this.openService(id, options),
      flash: (id) => this.flash(id),
      saveLayout: () => this.saveLayout(),
      rebuildPanes: () => this.rebuildPanes(),
      paneRect: (id) => this.paneRect(id),
      contentsForService: (id) => this.contentsForService(id),
      activeWorkspace: (id) => this.activeWorkspace(id),
      activeServices: (id) => this.activeServices(id),
      mutateWorkspace: (mutate) => this.mutateWorkspace(mutate),
      removeService: (id) => this.removeService(id),
      sleep: (id) => this.sleep(id),
      signOut: (id) => this.signOut(id),
      purgeOrphanPartitions: () => this.purgeOrphanPartitions(),
      registerConsumer: (wc) => this.registerConsumer(wc),
      unreadOf: (id) => this.unread.get(id),
      clearUnread: (id) => this.clearUnread(id),
      pushUnreadRules: (id) => this.pushUnreadRules(id),
      applyAllPreferenceEffects: () => this.effects.applyAll(),
      applyPreferenceEffect: (path) => this.effects.applyFor(path),
      applyChangedPreferences: (before) => this.effects.applyChanged(before),
      forgetDefaultMailApp: () => (this.defaultMailApp = null),
      toggleRail: () => this.toggleRail(),
      beginRename: (id) => this.beginRename(id),
      beginTileDrag: (id) => this.tileDrag.begin(id),
      moveTileDrag: (from, x, y) => this.tileDrag.move(from, x, y),
      dropTile: (from, x, y) => this.tileDrag.drop(from, x, y),
      endTileDrag: () => void this.tileDrag.end('cancel'),
    };
  })();

  /** Throws the current panes away and rebuilds them from the active workspace's saved layout. */
  private rebuildPanes(): void {
    this.layout.panes = [];
    this.layout.focusedPaneId = null;
    this.layout.maximisedPaneId = null;
    this.restoreLayout();
  }

  /**
   * Asks the rail to put an item's name into an editable field. The field replaces the name, so
   * there has to be a name on screen to replace: a collapsed compact rail is icons only, so it is
   * opened first, or the request would land somewhere invisible.
   */
  private beginRename(id: string): void {
    if (railCanExpand(loadConfig().preferences.appearance) && !this.railExpanded) {
      this.setRailExpanded(true);
    }
    this.renameRequest = { id, nonce: this.renameRequest.nonce + 1 };
    this.sync();
  }

  // --- tile drag: see tile-drag.ts ---------------------------------------------------------

  private readonly tileDrag = (() => {
    const self = this;
    return new TileDrag({
      get win() {
        return self.win;
      },
      get layout() {
        return self.layout;
      },
      get dragLayer() {
        return self.dragLayer;
      },
      chrome: () => this.chrome(),
      railRect: (width, height) => this.railRect(width, height),
      railContents: () => this.rail.webContents,
      openService: (id, options) => this.openService(id, options),
      flash: (id) => this.flash(id),
    });
  })();

  /** Removes the service everywhere it's referenced, then tears down its view. */
  private removeService(serviceId: string): void {
    // Before the config write, or the registration row is orphaned with a live socket behind it.
    this.push.unsubscribe(serviceId);
    // Through `clearUnread`, which recomputes the badge. Clearing the map directly left the Dock
    // counting a service that no longer existed.
    this.clearUnread(serviceId);
    deleteCachedIcon(serviceId);

    updateConfig((c) => removeServiceFromConfig(c, serviceId));

    for (const pane of this.layout.panes.filter((p) => p.serviceId === serviceId)) {
      this.layout.close(pane.id);
    }
    // Detach first: relayout() only removes views still in the ServiceManager map, so destroying
    // before detaching leaves a dead view attached to the window forever.
    const runtime = this.services.get(serviceId);
    if (runtime) this.win.contentView.removeChildView(runtime.view);
    this.services.destroy(serviceId);

    // Closing the last pane is refused by Layout, so a rail emptied down to one service could
    // leave a pane pointing at something that no longer exists.
    const orphan = this.layout.panes.find((p) => p.serviceId === serviceId);
    if (orphan) this.retargetPane(orphan, serviceId);

    this.relayout();
    this.saveLayout();
  }

  /**
   * Unloads one service's view, freeing its renderer (~100 MB). Detach precedes destroy because
   * relayout only removes views still in the manager's map — destroying first strands a dead view
   * attached to the window.
   */
  private sleep(serviceId: string): void {
    const runtime = this.services.get(serviceId);
    if (!runtime) return;
    this.win.contentView.removeChildView(runtime.view);
    this.services.destroy(serviceId);
    // Nothing is watching this service's count from now on, so let the endpoint poller ask at the
    // next sweep rather than waiting out an interval that started while the page was still live.
    this.endpoints.forget(serviceId);
    // A pane pointing at a sleeping service would render nothing, so retarget it.
    for (const pane of this.layout.panes.filter((p) => p.serviceId === serviceId)) {
      this.retargetPane(pane, serviceId);
    }
    this.saveLayout();
  }

  /**
   * Points an orphaned pane at another service and *loads* it.
   *
   * Three things went wrong here before. The replacement was never opened, so the pane had no view
   * and `relayout` showed the **empty state with a full rail**. It wasn't checked against panes
   * already on screen, so a split could end up rendering the same service twice. And nothing saved
   * the layout, so config kept naming the service that had just gone.
   */
  private retargetPane(pane: { id: string; serviceId: string }, avoid: string): void {
    const onScreen = new Set(
      this.layout.panes.filter((p) => p.id !== pane.id).map((p) => p.serviceId),
    );
    const candidates = this.activeServices(loadConfig().activeWorkspaceId);
    const replacement =
      candidates.find((s) => s.id !== avoid && !onScreen.has(s.id)) ??
      candidates.find((s) => s.id !== avoid);

    if (!replacement) {
      // Nothing left to show. Dropping the pane is what makes the empty state correct rather than
      // a blank pane with no explanation.
      //
      // Through `Layout`, not by assigning `panes` directly: `close()` exists to keep
      // `focusedPaneId` pointing at a pane that still exists, and going around it left the id
      // dangling. `Layout.show()` treats a dangling id as "no focus" and calls `add()`, which calls
      // `show()` back when full — so the bypass was one step from a mutually recursive hang.
      this.layout.dropPane(pane.id);
      return;
    }
    pane.serviceId = replacement.id;
    // Load it. Without this the pane exists, has no view, and renders nothing.
    this.services.ensure(replacement);
  }

  /**
   * Ends timed Do Not Disturb and timed mutes whose time is up. Runs on the 30-second sweep, so a
   * quiet period ends within half a minute of when it said it would.
   */
  private expireQuietPeriods(): void {
    const expired = expiredQuiet(loadConfig(), Date.now());
    if (!expired.dnd && expired.services.length === 0) return;
    updateConfig((c) => {
      if (expired.dnd) {
        c.preferences.notifications.dnd = false;
        c.preferences.notifications.dndUntil = null;
      }
      for (const svc of c.services) {
        if (!expired.services.includes(svc.id)) continue;
        svc.notificationLevel = 'all';
        delete svc.mutedUntil;
      }
    });
    for (const serviceId of expired.services) this.pushUnreadRules(serviceId);
    if (expired.dnd) console.log('[notify] Do Not Disturb ended on schedule');
    this.sync();
  }

  /** Periodic sweep. Cheap enough to run often; the decision itself lives in hibernate.ts. */
  hibernateIdle(): void {
    // First, and whatever the hibernation setting: the sweep is the only clock timed quiet has.
    this.expireQuietPeriods();
    const config = loadConfig();
    const timeout = config.preferences.behaviour.hibernateAfterMinutes;
    if (timeout <= 0) return;

    const visible = this.layout.visibleServiceIds();
    const due = servicesToHibernate(
      config.services.map((svc) => ({
        serviceId: svc.id,
        visible: visible.has(svc.id),
        sleeping: !this.services.has(svc.id),
        hibernate: svc.hibernate,
        lastActiveAt: this.services.get(svc.id)?.lastActiveAt ?? Date.now(),
      })),
      timeout,
      Date.now(),
    );

    if (!due.length) return;
    for (const serviceId of due) this.sleep(serviceId);
    console.log(`[hibernate] slept ${due.length} idle service(s)`);
    this.relayout();
  }

  /** After a long suspend, loaded views hold stale content and often a dead socket. */
  refreshAfterWake(suspendedForMs: number): void {
    // Before anything else, and unconditionally: the sweep that runs 30 seconds from now measures
    // idle time against the wall clock, which has just jumped by however long the lid was shut.
    // Every off-screen service would read as hours idle and be unloaded in one go.
    this.services.creditSuspendedTime(suspendedForMs);

    const visible = this.layout.visibleServiceIds();
    const stale = servicesToRefresh(
      [...this.services.all()].map(([serviceId, runtime]) => ({
        serviceId,
        sleeping: false,
        visible: visible.has(serviceId),
        lastActiveAt: runtime.lastActiveAt,
      })),
      suspendedForMs,
    );
    for (const serviceId of stale) {
      const wc = this.services.get(serviceId)?.view.webContents;
      if (wc && !wc.isDestroyed()) wc.reload();
    }
    if (stale.length) console.log(`[power] reloaded ${stale.length} view(s) after wake`);

    // Same threshold as the view reload, for the same reason — the sockets died with the network.
    if (suspendedForMs >= LONG_SUSPEND_MS) this.push.reconnectAll();
  }

  // --- preference effects: see preference-effects.ts ----------------------------------------

  private readonly effects = (() => {
    const self = this;
    return new PreferenceEffects({
      state: () => this.state(),
      dispatch: (c) => this.dispatch(c),
      get push() {
        return self.push;
      },
      toggleWindow: () => {
        if (this.win.isVisible() && !this.win.isMinimized()) this.hideWindow();
        else this.showWindow();
      },
    });
  })();

  /** Boot, and again when `activate` rebuilds the window. See `PreferenceEffects.applySystem`. */
  applySystemPreferences(): void {
    this.effects.applySystem();
  }

  /**
   * Feeds a synthetic push through the real delivery path. Used by the E2E suite.
   *
   * Exists because A1 shipped unverified: testing delivery looked like it needed a Firebase
   * project and a real message, so it was skipped. It doesn't — `handlePushMessage` receives an
   * already decrypted payload, so injecting one covers everything downstream of decryption, which
   * is exactly where the bug was. Verified by reintroducing the bug and watching the test fail.
   */
  injectPush(serviceId: string, payload: { title: string; body: string }): void {
    this.attention.handlePushMessage(serviceId, payload);
  }

  /** Live service views. Used by the E2E teardown test to detect leaked views. */
  get serviceCount(): number {
    return this.services.all().size;
  }

  /**
   * Tears the window down.
   *
   * **Hooked to `closed`, never `close`.** The `close` handler calls `preventDefault()` when
   * `closeToTray` is on, so disposing there would destroy a window the user only hid — and the
   * tray icon would then lead somewhere that no longer exists.
   *
   * Before this existed, ⌘W on the last pane destroyed the window and the dock icon built a whole
   * new `AppWindow` while nothing disposed the old one. The global shortcut kept a closure over
   * the dead window and threw `Object has been destroyed` forever after; `ensureTray` and
   * `openSettingsWindow` both early-returned on stale instances; the old `PushManager` kept its
   * sockets, so a second set opened alongside and every notification arrived twice. Service views
   * were the worst of it: detached with `removeChildView`, they aren't children of the window and
   * so aren't destroyed with it — roughly 100 MB each, still resident, still running reload timers.
   *
   * Electron is explicit that a `WebContentsView`'s `webContents` must be closed explicitly or it
   * leaks. Nothing here was doing that.
   */
  dispose(): void {
    nativeTheme.off('updated', this.repaintBackground);
    this.attention.dispose();
    // Sockets and timers first: they can fire during teardown and would then touch a half-torn
    // window.
    if (this.syncScheduled) clearTimeout(this.syncScheduled);
    this.syncScheduled = null;
    this.push.stopAll();
    // An in-flight fetch resolving after teardown would call `applyDetectedUnread` on a window
    // whose views are gone.
    this.endpoints.dispose();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;

    releaseGlobalShortcut();
    setLinkRouter(null);
    onDownloadsChanged(null);
    closePopOuts();
    destroyTray();
    closeSettingsWindow();
    // Drop the config hook, or a write after teardown schedules a reconcile against a window that
    // no longer exists. A rebuilt AppWindow re-registers its own.
    onConfigSaved(null);
    // The hook only stops *new* schedules. A debounce armed seconds ago, or a reconcile parked in
    // an await, still holds `onApplied` — which calls restoreLayout() and relayout() on this
    // window. Only the instance can cancel those.
    this.configSync.dispose();

    // Every service view, not just the visible ones — the detached ones are exactly the leak.
    for (const serviceId of [...this.services.all().keys()]) {
      const runtime = this.services.get(serviceId);
      if (runtime) {
        try {
          this.win.contentView.removeChildView(runtime.view);
        } catch {
          // Already detached, or the window is gone. Either way the destroy below is what matters.
        }
      }
      this.services.destroy(serviceId);
    }

    // `destroy`, not `close`: both surfaces cache their view for reuse and only detach on close, so
    // one that the user has opened and closed is a detached renderer the window won't collect.
    this.findBar.destroy();
    this.overlay.destroy();
    this.dragLayer.destroy();
    // The rail and the empty view too. They were thought to go with the window as attached children;
    // they don't — a view's webContents lives until it is closed — so each ⌘W and reopen left one
    // more rail renderer running, receiving every broadcast, with nothing on screen.
    for (const view of [this.rail, this.emptyView]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    }
    this.emptyView = null;
    this.consumers.clear();
  }

  /**
   * Called from the intercepted `pushManager.subscribe()`. Returns `null` — rather than throwing —
   * whenever push isn't available for this service, because the page falls back to its own
   * subscribe on null and would break outright on a rejection.
   */
  async subscribePush(
    serviceId: string,
    vapidKey: string,
  ): Promise<{ endpoint: string; p256dh: string; auth: string } | null> {
    const config = loadConfig();
    const svc = config.services.find((s) => s.id === serviceId);
    if (!svc) return null;

    const eligible = pushEligible({
      pushEnabled: config.preferences.notifications.push,
      configStatus: firebaseConfigStatus(config.preferences.notifications.firebase),
      serviceNotifications: svc.notifications,
      level: svc.notificationLevel ?? 'all',
    });
    if (!eligible) return null;

    this.push.start(config.services.map((s) => s.id));
    try {
      return await this.push.subscribe(serviceId, vapidKey);
    } catch (error) {
      // A bad Firebase project, a revoked key, no network. The site keeps working; it just won't
      // reach us while asleep.
      console.error(`[push] subscribe failed for ${svc.name}:`, error);
      return null;
    }
  }

  /** A service's unread rules, for its preload. Public for the IPC handler in boot/index.ts. */
  unreadRulesFor(serviceId: string): DomUnreadRule[] {
    return this.attention.unreadRulesFor(serviceId);
  }

  /** A service's page read its own badge. Public for the IPC handler in boot/index.ts. */
  handleUnreadProbes(serviceId: string, probes: unknown): void {
    this.attention.handleUnreadProbes(serviceId, probes);
  }

  /**
   * One sweep of the endpoint poller, driven by the same background interval as hibernation.
   *
   * Public because the loop lives in `boot/index.ts` with the other timers, and because the E2E
   * test needs to run a sweep on demand rather than waiting out a real interval.
   */
  pollEndpoints(): Promise<void> {
    return this.endpoints.sweep();
  }

  /** A service fired a notification. Public for the IPC handler and the E2E suite. */
  handleNotification(serviceId: string, raw: unknown): void {
    this.attention.handleNotification(serviceId, raw);
  }

  /**
   * A ring around the focused pane, when there is more than one to tell apart.
   *
   * Only the rail tile said which pane had focus, so with two Gmails side by side ⌘W and ⌘F were a
   * guess. A plain coloured view just behind the focused pane, two pixels larger, in that service's
   * colour — drawn in the gutter, so it needs one at least that wide.
   */
  private focusRing: View | null = null;
  private drawFocusRing(bounds: Map<string, { x: number; y: number; width: number; height: number }>, gutter: number): void {
    const focused = this.layout.focused();
    const rect = focused ? bounds.get(focused.id) : undefined;
    if (!rect || bounds.size < 2 || gutter < 2) {
      this.focusRing?.setVisible(false);
      return;
    }
    if (!this.focusRing) {
      this.focusRing = new View();
      // Index 0: beneath everything, so it shows only around the pane's edge.
      this.win.contentView.addChildView(this.focusRing, 0);
    }
    const svc = loadConfig().services.find((s) => s.id === focused!.serviceId);
    // Adjusted the way the rail adjusts its tiles. The raw brand colour was drawn against the window
    // background, where GitHub's #181717, X's #111 and Slack's #4A154B are all but invisible — the
    // ring existed and nobody could see it.
    const colour =
      hexFor(
        accentFor(
          svc?.color ?? catalogById(svc?.catalogId ?? '')?.color ?? '#8a8a92',
          nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        ),
      ) ?? '#8a8a92';
    const ring = 2;
    this.focusRing.setBounds({
      x: rect.x - ring,
      y: rect.y - ring,
      width: rect.width + ring * 2,
      height: rect.height + ring * 2,
    });
    this.focusRing.setBorderRadius(PANE_RADIUS + ring);
    this.focusRing.setBackgroundColor(`${colour}cc`);
    this.focusRing.setVisible(true);
  }

  /** Whether the window is somewhere a person could be looking at it. */
  private windowOnScreen(): boolean {
    return !this.win.isDestroyed() && this.win.isVisible() && !this.win.isMinimized();
  }

  private clearUnread(serviceId: string): void {
    this.attention.clearUnread(serviceId);
  }

  private pushUnreadRules(serviceId: string): void {
    this.attention.pushUnreadRules(serviceId);
  }

  /** Every workspace mutation goes through here so the sync is never forgotten. */
  private mutateWorkspace(mutate: (w: Workspace) => void): void {
    updateConfig((c) => {
      const workspace = c.workspaces.find((w) => w.id === c.activeWorkspaceId) ?? c.workspaces[0];
      if (workspace) mutate(workspace);
    });
    this.sync();
  }

  /** Clears the account's cookie jar. The services stay; they just land on a login page. */
  private async signOut(accountId: string): Promise<void> {
    const config = loadConfig();
    const account = config.accounts.find((a) => a.id === accountId);
    if (!account) return;

    await session.fromPartition(account.partition).clearStorageData();
    for (const svc of config.services.filter((s) => s.accountId === accountId)) {
      this.services.get(svc.id)?.view.webContents.reload();
    }
    this.sync();
  }

  private focusActivePane(): void {
    const pane = this.layout.focused();
    if (!pane) return;
    const runtime = this.services.get(pane.serviceId);
    if (runtime && !runtime.view.webContents.isDestroyed()) runtime.view.webContents.focus();
  }
}
