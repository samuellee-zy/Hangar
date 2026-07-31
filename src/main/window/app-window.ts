import fs from 'node:fs';
import path from 'node:path';
import {
  BaseWindow,
  Notification,
  WebContentsView,
  dialog,
  app,
  nativeTheme,
  screen,
  session,
  shell,
  type WebContents,
} from 'electron';
import { catalogById, resolveUrl } from '@shared/catalog';
import {
  addService,
  loadConfig,
  makeCustomInstance,
  makeInstance,
  updateConfig,
  updateConfigReturning,
  quarantinedConfigs,
  onConfigSaved,
  saveConfig,
} from '@main/platform/config';
import {
  Layout,
  PANE_RADIUS,
  chromeFor,
  contentArea,
  railBounds,
  windowButtonPosition,
} from '@core/workspace/layout';
import { Overlay } from '@main/window/overlay';
import { loadRoute } from '@main/platform/renderer-url';
import { ServiceManager } from '@main/window/service-manager';
import { FindBar } from '@main/features/find-bar';
import { deleteCachedIcon } from '@main/features/icons';
import { installWebContextMenu, showFolderMenu, showRailMenu, showServiceMenu } from '@main/features/context-menu';
import { exportConfig, importConfig } from '@main/features/transfer';
import { servicesToHibernate, servicesToRefresh } from '@core/runtime/hibernate';
import { decideNotification } from '@core/notify/policy';
import { UnreadCounts, unreadFromTitle } from '@core/notify/unread';
import {
  applyGlobalShortcut,
  applyLoginItem,
  applyProxy,
  releaseGlobalShortcut,
} from '@main/platform/system';
import { allLiveSessions } from '@main/platform/session';
import { destroyTray, ensureTray, refreshTray } from '@main/features/tray';
import { isQuitting } from '@main/platform/quit-state';
import {
  createFolder,
  deleteFolder,
  findFolder,
  flattenServiceIds,
  moveToFolder,
  pruneMissing,
  reorderItems,
} from '@core/workspace/folders';
import { findOrphanPartitions } from '@core/runtime/permissions';
import { resetPreferences, setPreference } from '@core/config/preferences';
import {
  createWorkspace,
  deleteWorkspace,
  rehomeUnreachable,
  renameWorkspace,
  reorderWorkspaces,
} from '@core/workspace/workspaces';
import { closeSettingsWindow, openSettingsWindow } from '@main/features/settings-window';
import { attachShortcuts } from '@main/window/shortcuts';
import {
  activeServicesOf,
  activeWorkspaceOf,
  projectShellState,
  removeServiceFromConfig,
  resolveCommand,
} from '@core/shell-state';
import { ConfigSync } from '@main/features/sync';
import { readSyncBase, writeSyncBase } from '@main/platform/sync-base';
import { PushManager } from '@main/features/push-manager';
import { extractNotification, firebaseConfigStatus, pushEligible } from '@core/push/policy';
import type {
  Command,
  OverlayMode,
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

const DEFAULT_BOUNDS = { width: 1440, height: 940 };

/** Compact collapses the rail to icons only; labels are suppressed at this width. */
export const COMPACT_RAIL_SIZE = 48;

/**
 * Saved bounds are only honoured if they still land on a connected display — otherwise unplugging
 * an external monitor strands the window offscreen with no way to get it back.
 */
function restoreBounds(saved: WindowBounds | undefined) {
  if (!saved) return DEFAULT_BOUNDS;
  const onAnyDisplay = screen.getAllDisplays().some(({ workArea }) => {
    const overlapsX = saved.x < workArea.x + workArea.width && saved.x + saved.width > workArea.x;
    const overlapsY = saved.y < workArea.y + workArea.height && saved.y + saved.height > workArea.y;
    return overlapsX && overlapsY;
  });
  return onAnyDisplay ? saved : DEFAULT_BOUNDS;
}

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
  private consumers = new Set<WebContents>();
  private flashServiceId: string | null = null;
  /**
   * Unread counts live here rather than on `ServiceRuntime`, so they survive hibernation and can
   * be set for a service that was never loaded. See core/notify/unread.ts.
   */
  private unread = new UnreadCounts();
  /** Held so GC can't collect a banner before its click handler runs. */
  private liveNotifications = new Set<Notification>();
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

  constructor() {
    this.win = new BaseWindow({
      ...restoreBounds(loadConfig().window),
      minWidth: 720,
      minHeight: 480,
      title: 'Hangar',
      // 'hidden' rather than 'hiddenInset' so the traffic-light position is ours to control;
      // hiddenInset adds its own inset and left them straddling the rail's right edge.
      titleBarStyle: 'hidden',
      // Initial placement only; relayout() repositions these whenever the rail moves.
      trafficLightPosition: windowButtonPosition(
        chromeFor(
          loadConfig().preferences.appearance.railPosition,
          loadConfig().preferences.appearance.railSize,
          loadConfig().preferences.appearance.gutter
        )
      ),
      backgroundColor: '#1b1b1f',
    });

    this.services = new ServiceManager(
      () => this.sync(),
      (c) => this.dispatch(c),
      (wc) => installWebContextMenu(wc, this.win),
      (active, total) => {
        const contents = this.findBar.contents;
        if (contents) safeSend(contents, 'find:result', { active, total });
      },
      (serviceId, title) => this.handleTitle(serviceId, title)
    );
    this.findBar = new FindBar(this.win, (wc) => this.registerConsumer(wc));
    this.overlay = new Overlay(
      this.win,
      () => this.dispatch({ type: 'close-overlay' }),
      (wc) => this.registerConsumer(wc)
    );

    this.rail = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/sidebar.cjs'),
        contextIsolation: true,
      },
    });
    this.win.contentView.addChildView(this.rail);
    loadRoute(this.rail.webContents, 'rail');
    this.registerConsumer(this.rail.webContents);
    attachShortcuts(this.rail.webContents, (c) => this.dispatch(c));

    this.win.on('resize', () => {
      this.relayout();
      this.saveWindowBounds();
    });
    this.win.on('move', () => this.saveWindowBounds());
    // The debounce means a window that's never moved would otherwise never record its bounds,
    // and a quit inside the debounce window would drop the last change.
    this.win.on('close', (event: Electron.Event) => {
      this.saveWindowBounds({ immediate: true });
      // Hide rather than destroy, so the tray icon still leads somewhere.
      if (loadConfig().preferences.behaviour.closeToTray && !isQuitting()) {
        event.preventDefault();
        this.win.hide();
      }
    });

    // Safety net: a service reachable from no workspace is invisible everywhere while still
    // holding a session. Rehome before the first render rather than leaving it stranded.
    const stranded = updateConfigReturning(rehomeUnreachable);
    if (stranded.length) console.warn(`[workspace] rehomed ${stranded.length} stranded service(s)`);

    this.push = new PushManager({
      firebase: () => loadConfig().preferences.notifications.firebase,
      load: () => loadConfig().pushRegistrations ?? [],
      save: (registrations) => updateConfig((c) => { c.pushRegistrations = registrations; }),
      deliver: (serviceId, message) => this.handlePushMessage(serviceId, message),
      log: (message) => console.log(`[push] ${message}`),
    });

    this.configSync = new ConfigSync({
      // Optional-chained: a config from before this preference existed has no `sync` section, and
      // reading through it unguarded threw inside a `void`-ed promise where nothing surfaced it.
      repoPath: () => loadConfig().preferences.sync?.repoPath.trim() || null,
      read: () => loadConfig(),
      // `sync: false` — this write comes *from* sync, and the default hook would feed it back.
      write: (next) => saveConfig(next, { sync: false }),
      readBase: () => readSyncBase(),
      writeBase: (text) => writeSyncBase(text),
      onApplied: () => {
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

    // Safe to start here despite `onApplied` touching panes: `reconcile` awaits `git --version`
    // before doing anything, so the constructor's own `restoreLayout()` below has always run by the
    // time an incoming config could land.
    void this.configSync.reconcile();

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

    const serviceIds = (stored?.panes ?? []).map((p) => p.serviceId).filter((id) => available.has(id));
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
      const { x, y, width, height } = this.win.getBounds();
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
    });
  }


  /**
   * Pulled by the overlay renderer on mount. The push in `Overlay.open()` races the view's first
   * load — on the very first open the renderer hasn't subscribed yet, so the message vanished and
   * the overlay rendered nothing while still swallowing every click.
   */
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
      onDisk = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      onDisk = []; // no Partitions dir yet
    }
    this.orphanPartitions = findOrphanPartitions(
      loadConfig().accounts.map((a) => a.partition),
      onDisk
    );
    if (this.orphanPartitions.length) {
      console.log(`[partitions] ${this.orphanPartitions.length} unused session(s) on disk`);
    }
  }

  /** User-triggered only. Deleting cookie jars is not something to do automatically at boot. */
  private purgeOrphanPartitions(): void {
    if (!this.orphanPartitions.length) return;
    const { response } = {
      response: dialog.showMessageBoxSync(this.win as never, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Delete ${this.orphanPartitions.length} unused session(s)?`,
        detail:
          'These belong to connections that were removed. Deleting frees disk space and clears ' +
          'their cookies. If you re-add one of those services you will need to sign in again.',
      }),
    };
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
    void runtime.view.webContents.loadURL(resolveUrl(svc));
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

  sync(): void {
    const state = this.state();
    for (const wc of this.consumers) safeSend(wc, 'shell:state', state);
    refreshTray(state, (c) => this.dispatch(c));
  }

  showWindow(): void {
    if (this.win.isMinimized()) this.win.restore();
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

  /**
   * Attach exactly the visible views, in pane order, then keep the overlay on top. Detaching
   * rather than hiding matters: a hidden-but-attached view still composites and still eats clicks.
   */
  /** Current chrome metrics, derived from preferences. Compact overrides the stored rail size. */
  private chrome() {
    const { railPosition, railSize, gutter, compactRail } = loadConfig().preferences.appearance;
    return chromeFor(railPosition, compactRail ? COMPACT_RAIL_SIZE : railSize, gutter);
  }

  /**
   * Shown when no pane can be filled. Without it, removing the last service leaves a blank window
   * whose only exit is a `+` in a rail that now also looks empty — the app appears broken.
   */
  private emptyView: WebContentsView | null = null;

  private setEmptyVisible(visible: boolean, chrome: ReturnType<AppWindow['chrome']>, width: number, height: number): void {
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
        },
      });
      loadRoute(this.emptyView.webContents, 'empty');
      this.registerConsumer(this.emptyView.webContents);
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

  private relayout(): void {
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
    const visible = this.layout.visibleServiceIds();

    for (const [serviceId, runtime] of this.services.all()) {
      if (!visible.has(serviceId)) this.win.contentView.removeChildView(runtime.view);
    }

    for (const pane of this.layout.panes) {
      const runtime = this.services.get(pane.serviceId);
      const rect = bounds.get(pane.id);
      if (!runtime || !rect) continue;
      // Idle time is measured as time off screen, so refresh the stamp while visible.
      this.services.markActive(pane.serviceId);
      this.clearUnread(pane.serviceId);
      this.win.contentView.addChildView(runtime.view);
      runtime.view.setBounds(rect);
      // Rounded card. Note Electron's caveat: the cut-out corners still capture clicks — harmless
      // here since nothing sits underneath them but the rail background.
      runtime.view.setBorderRadius(PANE_RADIUS);
    }

    // A pane whose service has no runtime renders nothing, so treat that as empty too.
    const hasVisibleContent = this.layout.panes.some((p) => this.services.has(p.serviceId));
    this.setEmptyVisible(!hasVisibleContent, chrome, width, height);

    this.rail.setBounds(railBounds(chrome, width, height));
    // Runtime reposition rather than recreating the window, which `titleBarStyle` would otherwise
    // require — see docs/decisions.md.
    try {
      this.win.setWindowButtonPosition(windowButtonPosition(chrome));
    } catch {
      // Older Electron, or a platform without window buttons. Placement just stays as-is.
    }
    this.overlay.raise();
    this.findBar.raise(this.layout.focusedPaneId ? this.paneRect(this.layout.focusedPaneId) : null);
    this.updateTitle();
    this.sync();
  }

  // --- commands ---------------------------------------------------------------------------

  /** Resolves the `#n` / `#focused` placeholders the keyboard layer can't resolve on its own. */
  private resolve(command: Command): Command | null {
    return resolveCommand(command, {
      config: loadConfig(),
      focusedPaneId: this.layout.focusedPaneId,
    });
  }


  /** Returns whether anything happened — the keyboard layer uses this to decide whether to
   *  swallow the keystroke. See CommandSink. */
  dispatch(raw: Command): boolean {
    const command = this.resolve(raw);
    if (!command) return false;

    switch (command.type) {
      case 'focus-service':
        this.overlay.close();
        this.openService(command.serviceId);
        // Without this, clicking a service that's already the focused pane changes nothing on
        // screen and reads as a dead button — the reported bug.
        this.flash(command.serviceId);
        break;

      case 'open-in-new-pane':
        this.overlay.close();
        this.openService(command.serviceId, { newPane: true });
        break;

      case 'split': {
        // Split with the next service in the workspace that isn't already on screen.
        const visible = this.layout.visibleServiceIds();
        const next = this.activeServices(loadConfig().activeWorkspaceId).find(
          (s) => !visible.has(s.id)
        );
        if (next) this.openService(next.id, { newPane: true });
        break;
      }

      case 'focus-pane':
        // Ignore a stale pane id rather than pointing focus at nothing.
        if (!this.layout.find(command.paneId)) break;
        this.layout.focusedPaneId = command.paneId;
        this.focusActivePane();
        this.saveLayout();
        this.sync();
        break;

      case 'cycle-pane':
        this.layout.cycleFocus(command.delta);
        this.focusActivePane();
        this.saveLayout();
        this.sync();
        break;

      case 'close-pane':
        // Closing the last pane means closing the window — otherwise ⌘W is a no-op and the window
        // can't be dismissed from the keyboard at all.
        if (this.layout.panes.length === 1) {
          this.win.close();
          break;
        }
        this.layout.close(command.paneId);
        this.relayout();
        this.saveLayout();
        break;

      case 'create-workspace': {
        const id = updateConfigReturning((c) => createWorkspace(c, command.name));
        this.dispatch({ type: 'set-workspace', workspaceId: id });
        break;
      }

      case 'rename-workspace':
        updateConfig((c) => renameWorkspace(c, command.workspaceId, command.name));
        this.sync();
        break;

      case 'delete-workspace': {
        const result = updateConfigReturning((c) => deleteWorkspace(c, command.workspaceId));
        if (!result.deleted) break;
        if (result.rehomed.length) {
          console.log(`[workspace] rehomed ${result.rehomed.length} orphaned service(s)`);
        }
        // The active workspace may have changed under us; rebuild from whatever it is now.
        this.layout.panes = [];
        this.layout.focusedPaneId = null;
        this.restoreLayout();
        this.relayout();
        break;
      }

      case 'sync-now':
        void this.configSync.reconcile();
        break;

      case 'resolve-sync':
        void this.configSync.resolve(command.winner);
        break;

      case 'reset-preferences': {
        // Per section or wholesale. Until now a bad rail position or zoom was only recoverable by
        // hand-editing config.json — which for a setting that can make the window unusable is not
        // a recovery path at all.
        updateConfig((c) => {
          c.preferences = resetPreferences(c.preferences, command.section);
        });
        this.applyAllPreferenceEffects();
        this.relayout();
        this.sync();
        break;
      }

      case 'reveal-path':
        // Restricted to paths we actually surfaced. The renderer is a separate process and this is
        // an IPC boundary — an arbitrary path from a message would be a way to probe the disk.
        if (quarantinedConfigs().includes(command.path)) shell.showItemInFolder(command.path);
        break;

      case 'purge-orphan-partitions':
        this.purgeOrphanPartitions();
        break;

      case 'reorder-workspaces':
        updateConfig((c) => reorderWorkspaces(c, command.workspaceIds));
        this.sync();
        break;

      case 'set-workspace':
        // Save the outgoing workspace's arrangement before switching, so ⌘⌥1/⌘⌥2 round-trips.
        this.saveLayout();
        updateConfig((c) => {
          c.activeWorkspaceId = command.workspaceId;
        });
        this.overlay.close();
        this.layout.panes = [];
        this.layout.focusedPaneId = null;
        this.restoreLayout();
        this.relayout();
        break;

      case 'navigate': {
        const pane = this.layout.focused();
        if (pane) this.services.navigate(pane.serviceId, command.direction);
        break;
      }

      case 'open-palette':
        // Toggle, but only against itself — ⌘K while the picker is open should switch to the
        // palette rather than dismiss.
        if (this.overlay.currentMode === 'palette') {
          this.overlay.close();
          this.focusActivePane();
        } else {
          this.overlay.open('palette');
        }
        break;

      case 'open-connections':
        this.overlay.open('connections');
        break;

      case 'close-overlay': {
        // Reports false when nothing was open, so Escape falls through to the page.
        const wasOpen = this.overlay.isOpen;
        if (wasOpen) {
          this.overlay.close();
          this.focusActivePane();
        }
        return wasOpen;
      }

      case 'add-service': {
        const svc = updateConfigReturning((c) =>
          addService(c, makeInstance(c, command.catalogId, { forceNewAccount: command.forceNewAccount }))
        );
        this.overlay.close();
        this.openService(svc.id, { newPane: false });
        this.flash(svc.id);
        break;
      }

      case 'add-custom-service': {
        const svc = updateConfigReturning((c) => addService(c, makeCustomInstance(c, command)));
        this.overlay.close();
        this.openService(svc.id, { newPane: false });
        this.flash(svc.id);
        break;
      }

      case 'reorder-items':
        this.mutateWorkspace((w) => reorderItems(w, command.itemIds));
        break;

      case 'create-folder':
        this.mutateWorkspace((w) => createFolder(w, command.name, command.serviceIds));
        break;

      case 'rename-folder':
        this.mutateWorkspace((w) => {
          const folder = findFolder(w, command.folderId);
          if (folder) folder.name = command.name;
        });
        break;

      case 'delete-folder':
        this.mutateWorkspace((w) => deleteFolder(w, command.folderId));
        break;

      case 'toggle-folder':
        this.mutateWorkspace((w) => {
          const folder = findFolder(w, command.folderId);
          if (folder) folder.collapsed = !folder.collapsed;
        });
        break;

      case 'move-to-folder':
        this.mutateWorkspace((w) => moveToFolder(w, command.serviceId, command.folderId));
        break;

      case 'show-folder-menu': {
        const ws = this.activeWorkspace(loadConfig().activeWorkspaceId);
        const folder = ws && findFolder(ws, command.folderId);
        if (folder) showFolderMenu(this.win, folder, (c: Command) => this.dispatch(c));
        break;
      }

      case 'update-service': {
        updateConfig((c) => {
          const svc = c.services.find((s) => s.id === command.serviceId);
          if (svc) Object.assign(svc, command.patch);
        });
        // Zoom applies live; CSS/JS and UA need a reload to take effect, so say so rather than
        // silently doing half the job.
        const runtime = this.services.get(command.serviceId);
        const zoom = command.patch.zoom;
        if (runtime && typeof zoom === 'number') runtime.view.webContents.setZoomFactor(zoom);
        this.sync();
        break;
      }

      case 'rename-service':
        updateConfig((c) => {
          const svc = c.services.find((s) => s.id === command.serviceId);
          if (svc) svc.name = command.name;
        });
        this.sync();
        break;

      case 'remove-service':
        this.removeService(command.serviceId);
        break;

      case 'rename-account':
        updateConfig((c) => {
          const account = c.accounts.find((a) => a.id === command.accountId);
          if (account) account.label = command.label;
        });
        this.sync();
        break;

      case 'sign-out-account':
        void this.signOut(command.accountId);
        break;

      case 'open-find': {
        const pane = this.layout.focused();
        const wc = pane && this.services.get(pane.serviceId)?.view.webContents;
        const rect = pane ? this.paneRect(pane.id) : null;
        if (wc && rect && pane) this.findBar.open(wc, rect, pane.serviceId);
        break;
      }

      case 'close-find':
        this.findBar.close();
        this.focusActivePane();
        break;

      case 'find':
        this.findBar.search(command.query, {
          forward: command.forward ?? true,
          findNext: command.findNext ?? false,
        });
        break;

      case 'zoom': {
        const pane = this.layout.focused();
        const svc = pane && loadConfig().services.find((s) => s.id === pane.serviceId);
        const runtime = pane && this.services.get(pane.serviceId);
        if (!svc || !runtime) break;
        const base = svc.zoom || 1;
        const next =
          command.direction === 'reset'
            ? loadConfig().preferences.behaviour.defaultZoom
            : Math.min(2, Math.max(0.5, Number((base + (command.direction === 'in' ? 0.1 : -0.1)).toFixed(2))));
        runtime.view.webContents.setZoomFactor(next);
        // Persisted per service, so it survives a reload and a restart.
        updateConfig((c) => {
          const target = c.services.find((s) => s.id === svc.id);
          if (target) target.zoom = next;
        });
        this.sync();
        break;
      }

      case 'print': {
        const pane = this.layout.focused();
        this.services.get(pane?.serviceId ?? '')?.view.webContents.print();
        break;
      }

      case 'clear-unread':
        this.clearUnread(command.serviceId);
        this.sync();
        break;

      case 'set-preference': {
        const before = loadConfig().preferences.appearance.theme;
        updateConfig((c) => {
          // Rejected silently when the path is unknown or the type is wrong — see setPreference.
          if (!setPreference(c.preferences, command.path, command.value)) {
            console.warn(`[preferences] rejected ${command.path}`);
          }
        });
        const after = loadConfig().preferences.appearance.theme;
        // Renderers read `prefers-color-scheme`, which Electron drives from themeSource.
        if (after !== before) nativeTheme.themeSource = after;
        this.applyPreferenceEffect(command.path);
        // Appearance changes affect pane geometry, so relayout before telling anyone.
        this.relayout();
        break;
      }

      case 'reload-service': {
        const runtime = this.services.get(command.serviceId);
        if (runtime && !runtime.view.webContents.isDestroyed()) runtime.view.webContents.reload();
        break;
      }

      case 'sleep-service':
        this.sleep(command.serviceId);
        this.relayout();
        break;

      case 'sleep-others': {
        const keep = this.layout.visibleServiceIds();
        for (const [serviceId] of [...this.services.all()]) {
          if (!keep.has(serviceId)) this.sleep(serviceId);
        }
        this.relayout();
        break;
      }

      case 'show-service-menu': {
        const svc = loadConfig().services.find((s) => s.id === command.serviceId);
        if (!svc) break;
        const workspace = this.activeWorkspace(loadConfig().activeWorkspaceId);
        const folders = (workspace?.items ?? []).filter((i) => i.kind === 'folder');
        showServiceMenu(
          this.win,
          svc,
          {
            isVisible: this.layout.visibleServiceIds().has(svc.id),
            isSleeping: !this.services.has(svc.id),
            folders: folders.map((f) => ({ id: f.id, name: f.name })),
            currentFolderId: folders.find((f) => f.serviceIds.includes(svc.id))?.id ?? null,
          },
          (c) => this.dispatch(c)
        );
        break;
      }

      case 'show-window':
        this.showWindow();
        break;

      case 'export-config':
        void exportConfig(this.win);
        break;

      case 'import-config':
        void importConfig(this.win, () => {
          // A fresh config means every view is stale — rebuild from scratch.
          for (const [serviceId] of [...this.services.all()]) this.sleep(serviceId);
          this.layout.panes = [];
          this.layout.focusedPaneId = null;
          this.restoreLayout();
          this.relayout();
        });
        break;

      case 'show-rail-menu':
        showRailMenu(this.win, (c) => this.dispatch(c));
        break;

      case 'open-settings':
        openSettingsWindow((wc) => this.registerConsumer(wc));
        break;
    }
    return true;
  }

  /** Removes the service everywhere it's referenced, then tears down its view. */
  private removeService(serviceId: string): void {
    // Before the config write, or the registration row is orphaned with a live socket behind it.
    this.push.unsubscribe(serviceId);
    this.unread.clear(serviceId);
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
      this.layout.panes.filter((p) => p.id !== pane.id).map((p) => p.serviceId)
    );
    const candidates = this.activeServices(loadConfig().activeWorkspaceId);
    const replacement =
      candidates.find((s) => s.id !== avoid && !onScreen.has(s.id)) ??
      candidates.find((s) => s.id !== avoid);

    if (!replacement) {
      // Nothing left to show. Dropping the pane is what makes the empty state correct rather than
      // a blank pane with no explanation.
      this.layout.panes = this.layout.panes.filter((p) => p.id !== pane.id);
      return;
    }
    pane.serviceId = replacement.id;
    // Load it. Without this the pane exists, has no view, and renders nothing.
    this.services.ensure(replacement);
  }

  /** Periodic sweep. Cheap enough to run often; the decision itself lives in hibernate.ts. */
  hibernateIdle(): void {
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
      Date.now()
    );

    if (!due.length) return;
    for (const serviceId of due) this.sleep(serviceId);
    console.log(`[hibernate] slept ${due.length} idle service(s)`);
    this.relayout();
  }

  /** After a long suspend, loaded views hold stale content and often a dead socket. */
  refreshAfterWake(suspendedForMs: number): void {
    const visible = this.layout.visibleServiceIds();
    const stale = servicesToRefresh(
      [...this.services.all()].map(([serviceId, runtime]) => ({
        serviceId,
        sleeping: false,
        visible: visible.has(serviceId),
        lastActiveAt: runtime.lastActiveAt,
      })),
      suspendedForMs
    );
    for (const serviceId of stale) {
      const wc = this.services.get(serviceId)?.view.webContents;
      if (wc && !wc.isDestroyed()) wc.reload();
    }
    if (stale.length) console.log(`[power] reloaded ${stale.length} view(s) after wake`);
  }

  /** Full pass. Boot only — preference changes go through `applyPreferenceEffect`. */
  applySystemPreferences(): void {
    const prefs = loadConfig().preferences;
    applyLoginItem(prefs);
    void applyProxy(allLiveSessions().values(), prefs);
    this.applyShortcut(prefs.behaviour.globalShortcut);
    this.applyTray(prefs);
  }

  /**
   * Only the effect the changed key actually needs. Re-running everything meant adjusting the rail
   * size re-registered the global shortcut and kicked off an unawaited proxy fan-out across every
   * session — harmless today, but exactly the shape that produces a race later.
   */
  /**
   * Every preference effect at once, for a reset.
   *
   * Previously reset called `applySystemPreferences()`, which covers the login item, proxy,
   * shortcut and tray — but *not* the two branches `applyPreferenceEffect` has for push and
   * spellcheck. So resetting with push enabled left the FCM sockets open while Settings reported
   * push off, and live sessions kept the old spellcheck languages until restart.
   *
   * Driven off the same per-key function rather than duplicating it, so a branch added there can't
   * be forgotten here.
   */
  private applyAllPreferenceEffects(): void {
    for (const path of [
      'behaviour.launchAtLogin',
      'network.proxy',
      'behaviour.globalShortcut',
      'appearance.showTrayIcon',
      'notifications.push',
      'behaviour.spellcheckLanguages',
    ]) {
      this.applyPreferenceEffect(path);
    }
    nativeTheme.themeSource = loadConfig().preferences.appearance.theme;
  }

  private applyPreferenceEffect(path: string): void {
    const prefs = loadConfig().preferences;
    if (path === 'behaviour.launchAtLogin' || path === 'behaviour.startHidden') {
      applyLoginItem(prefs);
    } else if (path.startsWith('network.proxy')) {
      void applyProxy(allLiveSessions().values(), prefs);
    } else if (path === 'behaviour.globalShortcut') {
      this.applyShortcut(prefs.behaviour.globalShortcut);
    } else if (path === 'appearance.showTrayIcon' || path === 'behaviour.closeToTray') {
      this.applyTray(prefs);
    } else if (path === 'notifications.push' || path.startsWith('notifications.firebase')) {
      // Switching push off must actually close the sockets, not just stop new subscriptions.
      if (prefs.notifications.push && firebaseConfigStatus(prefs.notifications.firebase) === 'ready') {
        this.push.start(loadConfig().services.map((s) => s.id));
      } else {
        this.push.stopAll();
      }
    } else if (path === 'behaviour.spellcheckLanguages') {
      // Read once per session at creation, so existing sessions need telling.
      for (const ses of allLiveSessions().values()) {
        ses.setSpellCheckerLanguages(prefs.behaviour.spellcheckLanguages);
      }
    }
  }

  private applyShortcut(accelerator: string | null): void {
    applyGlobalShortcut(accelerator, () => {
      if (this.win.isVisible() && !this.win.isMinimized()) this.win.hide();
      else this.showWindow();
    });
  }

  /** Symmetric: `destroyTray` existed and was never called, so the icon outlived its setting. */
  private applyTray(prefs: ReturnType<typeof loadConfig>['preferences']): void {
    // closeToTray without a tray icon would hide the window with no way back to it.
    const wanted = prefs.appearance.showTrayIcon || prefs.behaviour.closeToTray;
    if (wanted) ensureTray(() => this.state(), (c) => this.dispatch(c));
    else destroyTray();
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
    this.handlePushMessage(serviceId, payload);
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
    // Sockets and timers first: they can fire during teardown and would then touch a half-torn
    // window.
    this.push.stopAll();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;

    releaseGlobalShortcut();
    destroyTray();
    closeSettingsWindow();
    // Drop the config hook, or a write after teardown schedules a reconcile against a window that
    // no longer exists. A rebuilt AppWindow re-registers its own.
    onConfigSaved(null);

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

    this.findBar.close();
    this.consumers.clear();
  }

  /**
   * Called from the intercepted `pushManager.subscribe()`. Returns `null` — rather than throwing —
   * whenever push isn't available for this service, because the page falls back to its own
   * subscribe on null and would break outright on a rejection.
   */
  async subscribePush(
    serviceId: string,
    vapidKey: string
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

  /**
   * A push arrived for a service. Routed through the same notification path as an in-page one, so
   * DND, muting, unread counting and click-to-focus all behave identically — the transport
   * shouldn't be visible in the behaviour.
   */
  private handlePushMessage(serviceId: string, message: unknown): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return;
    const content = extractNotification(message, svc.name);
    // A payload we can't read at all is dropped rather than shown as an empty banner.
    if (!content) {
      console.warn(`[push] unreadable payload for ${svc.name}`);
      return;
    }
    this.handleNotification(serviceId, {
      title: content.title,
      body: content.body,
      silent: false,
    });
  }

  /**
   * A service changed its title.
   *
   * Where the catalog declares a pattern, the title is treated as the *authoritative* unread count
   * rather than another event to tally. That's a real difference: counting `new Notification()`
   * calls only ever goes up, never reflects what you've already read elsewhere, and reads zero for
   * a service whose browser notifications are off — Gmail showing "(5) Inbox" reported nothing.
   *
   * A title that stops matching means zero, which is how reading your mail on your phone clears
   * the badge here.
   */
  private handleTitle(serviceId: string, title: string): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return;
    const detected = unreadFromTitle(title, catalogById(svc.catalogId)?.unread);
    // null means the rule doesn't apply — no information, which is not the same as zero.
    if (detected === null) return;

    // Muting and the per-service toggle still win: an unread count is an interruption of a
    // quieter kind, and opting out should mean opting out of both.
    if (svc.notificationLevel === 'muted' || !svc.notifications) return;

    if (this.unread.get(serviceId) === detected) return;
    this.unread.set(serviceId, detected);
    this.updateBadge();
    this.sync();
  }

  /**
   * A service fired a notification. Attribution is the whole reason the preload wraps the
   * constructor rather than letting Electron route it directly.
   */
  handleNotification(serviceId: string, payload: { title: string; body: string; silent: boolean }): void {
    const config = loadConfig();
    const svc = config.services.find((s) => s.id === serviceId);
    // Deliberately no runtime check. A hibernated service has no runtime by definition, and a Web
    // Push exists precisely to reach you then — requiring one dropped every push this feature was
    // built for. See docs/decisions.md #56.
    if (!svc) return;

    const decision = decideNotification({
      enabled: config.preferences.notifications.enabled,
      dnd: config.preferences.notifications.dnd,
      level: svc.notificationLevel ?? 'all',
      serviceEnabled: svc.notifications,
      inVisiblePane: this.layout.visibleServiceIds().has(serviceId),
      // A pane inside a window you closed to the tray is not something you're looking at.
      windowVisible: !this.win.isDestroyed() && this.win.isVisible() && !this.win.isMinimized(),
    });

    if (decision.count) this.unread.increment(serviceId);

    if (decision.banner) {
      const notification = new Notification({
        title: payload.title || svc.name,
        body: payload.body,
        silent: payload.silent || !config.preferences.notifications.sound,
      });
      // Clicking should land you on the thing that pinged you.
      notification.on('click', () => {
        this.showWindow();
        this.dispatch({ type: 'focus-service', serviceId });
      });
      notification.show();
      // Retained until it's dismissed: the object is otherwise only referenced by this local, so
      // GC can collect it before the click handler ever fires and click-to-focus does nothing.
      this.liveNotifications.add(notification);
      notification.on('close', () => this.liveNotifications.delete(notification));
    }

    this.updateBadge();
    this.sync();
  }


  /** macOS hides the badge at 0, so it must be *set* to 0 rather than skipped. */
  private updateBadge(): void {
    app.setBadgeCount(this.unread.total());
  }

  /** Looking at a service is what marks it read — the only signal we reliably have. */
  private clearUnread(serviceId: string): void {
    if (this.unread.get(serviceId) === 0) return;
    this.unread.clear(serviceId);
    this.updateBadge();
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

/**
 * `isDestroyed()` is not sufficient. A renderer that has crashed — or is being torn down — reports
 * `false` while its underlying render frame is already gone, and `send` then throws
 * "Render frame was disposed before WebFrameMain could be accessed".
 *
 * That matters beyond tidiness: a crash makes every consumer throw a stack trace at once, and that
 * volume of noise is exactly what buried three separate bugs earlier in this project. A broadcast
 * to a view that no longer exists is not an error worth reporting.
 */
function safeSend(wc: Electron.WebContents, channel: string, payload: unknown): void {
  if (wc.isDestroyed()) return;
  try {
    wc.send(channel, payload);
  } catch {
    // The view went away between the check and the send. Nothing to do and nothing to say.
  }
}
