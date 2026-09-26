import fs from 'node:fs';
import os from 'node:os';
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
import { catalogById } from '@shared/catalog';
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
  railSizes,
  windowButtonPosition,
} from '@core/workspace/layout';
import { Overlay } from '@main/window/overlay';
import { DragLayer } from '@main/features/drag-layer';
import { loadRoute } from '@main/platform/renderer-url';
import { ServiceManager, startPageFor } from '@main/window/service-manager';
import { FindBar } from '@main/features/find-bar';
import { deleteCachedIcon } from '@main/features/icons';
import {
  installWebContextMenu,
  showFolderMenu,
  showRailMenu,
  showServiceMenu,
} from '@main/features/context-menu';
import { exportConfig, importConfig } from '@main/features/transfer';
import { LONG_SUSPEND_MS, servicesToHibernate, servicesToRefresh } from '@core/runtime/hibernate';
import { decideNotification, normaliseNotification } from '@core/notify/policy';
import {
  ALL_PREFERENCE_EFFECTS,
  preferenceEffectFor,
  trayWanted,
  type PreferenceEffect,
} from '@core/config/effects';
import { safeSend } from '@main/platform/safe-send';
import {
  UnreadCounts,
  resolveUnreadRules,
  unreadFromDom,
  unreadFromTitle,
} from '@core/notify/unread';
import {
  applyGlobalShortcut,
  applyLoginItem,
  applyProxy,
  releaseGlobalShortcut,
} from '@main/platform/system';
import { allLiveSessions, clearBlockedHost, hostBlockedFor } from '@main/platform/session';
import { setAdBlocking } from '@main/platform/adblock';
import { destroyTray, ensureTray, refreshTray } from '@main/features/tray';
import { isQuitting } from '@main/platform/quit-state';
import {
  createFolder,
  deleteFolder,
  findFolder,
  moveItemTo,
  moveToFolder,
} from '@core/workspace/folders';
import { findOrphanPartitions } from '@core/runtime/permissions';
import { isValidHost, sanitiseServicePatch } from '@core/services/patch';
import { resetPreferences, setPreference } from '@core/config/preferences';
import {
  createWorkspace,
  deleteWorkspace,
  rehomeUnreachable,
  renameWorkspace,
  reorderWorkspaces,
  workspaceHolding,
} from '@core/workspace/workspaces';
import { closeSettingsWindow, openSettingsWindow } from '@main/features/settings-window';
import { attachShortcuts } from '@main/window/shortcuts';
import { refreshMenu } from '@main/boot/menu';
import {
  DEFAULT_BINDINGS,
  normalisePassthrough,
  rebind,
  resolvePassthrough,
  type KeyContext,
} from '@core/keyboard/keymap';
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
import { EndpointPoller } from '@main/features/endpoint-poll';
import { extractNotification, firebaseConfigStatus, pushEligible } from '@core/push/policy';
import { dropAt, highlightFor, type DropContext } from '@core/workspace/drop';
import { reachableBounds, sameBounds } from '@core/workspace/window-bounds';
import { resolveRepoPath } from '@core/config/sync';
import { isWebUrl } from '@core/runtime/urls';
import type {
  Command,
  DomUnreadRule,
  DragOrigin,
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
      // Initial placement only; relayout() repositions these whenever the rail moves.
      trafficLightPosition: windowButtonPosition(
        chromeFor(
          loadConfig().preferences.appearance.railPosition,
          loadConfig().preferences.appearance.railSize,
          loadConfig().preferences.appearance.gutter,
        ),
      ),
      backgroundColor: '#1b1b1f',
    });

    this.services = new ServiceManager(
      () => this.sync(),
      (c) => this.dispatch(c),
      (serviceId) => this.keyContextFor(serviceId),
      (wc) => installWebContextMenu(wc, this.win),
      (active, total) => {
        const contents = this.findBar.contents;
        if (contents) safeSend(contents, 'find:result', { active, total });
      },
      (serviceId, title) => this.handleTitle(serviceId, title),
    );
    this.findBar = new FindBar(this.win, (wc) => this.adoptSurface(wc));
    this.overlay = new Overlay(this.win, (wc) => this.adoptSurface(wc));
    this.dragLayer = new DragLayer(this.win);

    this.rail = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/sidebar.cjs'),
        contextIsolation: true,
      },
    });
    this.win.contentView.addChildView(this.rail);
    loadRoute(this.rail.webContents, 'rail');
    this.adoptSurface(this.rail.webContents);

    this.win.on('resize', () => {
      this.relayout();
      this.saveWindowBounds();
    });
    this.win.on('move', () => this.saveWindowBounds());
    this.win.on('show', () => this.acknowledgePanes());
    this.win.on('restore', () => this.acknowledgePanes());
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
      deliver: (serviceId, message) => this.handlePushMessage(serviceId, message),
      log: (message) => console.log(`[push] ${message}`),
    });

    this.endpoints = new EndpointPoller(
      () => loadConfig().services.filter((svc) => !this.services.has(svc.id)),
      (serviceId, count) => this.applyEndpointCount(serviceId, count),
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
      renameRequest: this.renameRequest,
      railExpanded: this.railExpanded,
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
    const signature = JSON.stringify(state);
    for (const wc of this.consumers) {
      if (this.lastSent.get(wc) === signature) continue;
      this.lastSent.set(wc, signature);
      safeSend(wc, 'shell:state', state);
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
    if (this.win.isMinimized()) this.win.restore();
    // Checked again here, not only at construction. A window closed to the tray on an external
    // monitor that is then unplugged comes back from `show()` exactly where it was — macOS only
    // rescues windows that are visible when the display goes — so "show" put it nowhere.
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

  /**
   * Attach exactly the visible views, in pane order, then keep the overlay on top. Detaching
   * rather than hiding matters: a hidden-but-attached view still composites and still eats clicks.
   */
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

  private relayout(): void {
    // A drag holds a frozen copy of the pane rectangles, and this is the one thing that invalidates
    // them. Ending it is the honest answer: the alternative is a highlight over a pane that has
    // moved, and a drop that lands somewhere the user didn't aim. The layer is also attached above
    // the panes, and the `addChildView` calls below would bury it.
    this.endTileDrag();
    // Turning compact off while the rail is open would otherwise leave the flag set, and switching
    // it back on later would give a rail that was already expanded before it was ever collapsed.
    if (!loadConfig().preferences.appearance.compactRail) this.railExpanded = false;
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

    // Looking at a pane is what marks it read — but only if anyone *can* look. Relayout runs on the
    // hibernation sweep every 30s whatever the window is doing, so with the window closed to the
    // tray every service in a pane had its unread wiped before anyone saw it. `show`/`restore`
    // acknowledge the panes instead, once they are actually on screen.
    const onScreen = this.windowOnScreen();
    for (const pane of this.layout.panes) {
      const runtime = this.services.get(pane.serviceId);
      const rect = bounds.get(pane.id);
      if (!runtime || !rect) continue;
      // Idle time is measured as time off screen, so refresh the stamp while visible.
      this.services.markActive(pane.serviceId);
      if (onScreen) this.clearUnread(pane.serviceId);
      this.win.contentView.addChildView(runtime.view);
      runtime.view.setBounds(rect);
      // Rounded card. Note Electron's caveat: the cut-out corners still capture clicks — harmless
      // here since nothing sits underneath them but the rail background.
      runtime.view.setBorderRadius(PANE_RADIUS);
    }

    // A pane whose service has no runtime renders nothing, so treat that as empty too.
    const hasVisibleContent = this.layout.panes.some((p) => this.services.has(p.serviceId));
    this.setEmptyVisible(!hasVisibleContent, chrome, width, height);

    // Runtime reposition rather than recreating the window, which `titleBarStyle` would otherwise
    // require — see docs/decisions.md.
    try {
      this.win.setWindowButtonPosition(windowButtonPosition(chrome));
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
   */
  private raiseChrome(width: number, height: number): void {
    this.rail.setBounds(this.railRect(width, height));
    this.win.contentView.removeChildView(this.rail);
    this.win.contentView.addChildView(this.rail);
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
    if (!loadConfig().preferences.appearance.compactRail) return;
    this.setRailExpanded(!this.railExpanded);
  }

  private setRailExpanded(expanded: boolean): void {
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
    });
  }

  /** Returns whether anything happened — the keyboard layer uses this to decide whether to
   *  swallow the keystroke. See CommandSink. */
  dispatch(raw: Command): boolean {
    const command = this.resolve(raw);
    if (!command) return false;

    switch (command.type) {
      case 'focus-service': {
        // A service in another workspace — reachable now from the tray, the palette and a
        // notification — is opened in its own workspace, not dropped into this one's panes.
        const config = loadConfig();
        const home = workspaceHolding(config, command.serviceId);
        if (home && home !== config.activeWorkspaceId) {
          this.dispatch({ type: 'set-workspace', workspaceId: home });
        }
        this.overlay.close();
        this.openService(command.serviceId);
        // Without this, clicking a service that's already the focused pane changes nothing on
        // screen and reads as a dead button — the reported bug.
        this.flash(command.serviceId);
        break;
      }

      case 'open-in-new-pane':
        this.overlay.close();
        this.openService(command.serviceId, { newPane: true });
        break;

      case 'split': {
        // Split with the next service in the workspace that isn't already on screen.
        const visible = this.layout.visibleServiceIds();
        const next = this.activeServices(loadConfig().activeWorkspaceId).find(
          (s) => !visible.has(s.id),
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
          this.openOverlay('palette');
        }
        break;

      case 'open-connections':
        this.openOverlay('connections');
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
          addService(
            c,
            makeInstance(c, command.catalogId, { forceNewAccount: command.forceNewAccount }),
          ),
        );
        this.overlay.close();
        this.openService(svc.id, { newPane: false });
        this.flash(svc.id);
        break;
      }

      case 'add-custom-service': {
        if (!isWebUrl(command.url)) {
          console.warn(`[command] add-custom-service refused: not an http(s) URL`);
          break;
        }
        const svc = updateConfigReturning((c) => addService(c, makeCustomInstance(c, command)));
        this.overlay.close();
        this.openService(svc.id, { newPane: false });
        this.flash(svc.id);
        break;
      }

      case 'move-item':
        this.mutateWorkspace((w) => moveItemTo(w, command.activeId, command.overId));
        break;

      case 'toggle-rail':
        this.toggleRail();
        break;

      case 'begin-tile-drag':
        this.beginTileDrag(command.serviceId);
        break;

      case 'drag-tile-to':
        this.moveTileDrag(command.from, command.x, command.y);
        break;

      case 'drop-tile':
        this.dropTile(command.from, command.x, command.y);
        break;

      case 'cancel-tile-drag':
        this.endTileDrag();
        break;

      case 'create-folder': {
        let folderId = '';
        this.mutateWorkspace((w) => {
          folderId = createFolder(w, command.name, command.serviceIds);
        });
        // Straight into naming it, where the rail can edit in place. Every folder used to stay
        // "New folder": the name was a placeholder and nothing afterwards asked for a real one.
        // Not elsewhere — an ordinary rail would answer by opening Settings, every time.
        const { compactRail, railPosition } = loadConfig().preferences.appearance;
        const vertical = railPosition === 'left' || railPosition === 'right';
        if (folderId && compactRail && vertical) {
          this.dispatch({ type: 'begin-rename-folder', folderId });
        }
        break;
      }

      case 'rename-folder': {
        // Every workspace, not just the active one: Settings lists the folders of all of them, and
        // an id names exactly one folder wherever it lives.
        const name = command.name.trim();
        if (!name) break;
        updateConfig((c) => {
          for (const w of c.workspaces) {
            const folder = findFolder(w, command.folderId);
            if (folder) folder.name = name;
          }
        });
        this.sync();
        break;
      }

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

      case 'rebind': {
        // Revalidated here, not trusted from the renderer: `rebind` refuses an unknown action or an
        // unbindable chord, and returns the map unchanged rather than throwing.
        updateConfig((c) => {
          c.preferences.keyboard.bindings = rebind(
            c.preferences.keyboard.bindings,
            command.actionId,
            command.chord,
          );
        });
        // `sync()` redraws the menu — see `refreshMenuIfRebound`, which is what makes an imported
        // or synced config update it too.
        this.sync();
        break;
      }

      case 'update-service': {
        // Validated rather than assigned straight through: this was a bare `Object.assign`, so any
        // field and any value reached config verbatim. See `sanitiseServicePatch`.
        const patch = sanitiseServicePatch(command.patch);
        updateConfig((c) => {
          const svc = c.services.find((s) => s.id === command.serviceId);
          if (!svc) return;
          Object.assign(svc, patch);
          // Canonicalised on the way in — Settings sends what it captured, and a list holding
          // `Meta+K` and `meta+k` would claim one chord twice and match neither reliably. Only
          // when the patch actually carries it, so every other update leaves it alone.
          if ('keyboardPassthrough' in patch) {
            svc.keyboardPassthrough = normalisePassthrough(patch.keyboardPassthrough);
          }
        });
        // Zoom applies live; CSS/JS and UA need a reload to take effect, so say so rather than
        // silently doing half the job.
        const runtime = this.services.get(command.serviceId);
        const zoom = patch.zoom;
        if (runtime && typeof zoom === 'number') runtime.view.webContents.setZoomFactor(zoom);
        // Unread detection applies live too, and has to: the field is edited by someone looking at
        // the page, and a selector you must reload to test is a selector nobody tunes. Muting also
        // lands here, which is how it stops the page watching for a count it isn't allowed to set.
        if ('unreadSelector' in patch || 'notificationLevel' in patch || 'notifications' in patch) {
          // The old count came from the old rules, so it is now unattributable. Detection reports
          // again within a frame or two if there is still something to report.
          this.clearUnread(command.serviceId);
          this.pushUnreadRules(command.serviceId);
        }
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

      case 'begin-rename-service':
      case 'begin-rename-folder': {
        // The field replaces the name, so there has to be a name on screen to replace. A collapsed
        // compact rail is icons only — open it first, or the request lands somewhere invisible.
        if (loadConfig().preferences.appearance.compactRail && !this.railExpanded) {
          this.setRailExpanded(true);
        }
        const id = command.type === 'begin-rename-service' ? command.serviceId : command.folderId;
        this.renameRequest = { id, nonce: this.renameRequest.nonce + 1 };
        this.sync();
        break;
      }

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
        this.signOut(command.accountId).catch((err: unknown) =>
          console.error(`[account] sign out of ${command.accountId} failed:`, err),
        );
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
            : Math.min(
                2,
                Math.max(
                  0.5,
                  Number((base + (command.direction === 'in' ? 0.1 : -0.1)).toFixed(2)),
                ),
              );
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
          (c) => this.dispatch(c),
        );
        break;
      }

      case 'show-window':
        this.showWindow();
        break;

      case 'export-config':
        exportConfig(this.win).catch((err: unknown) => console.error('[transfer] export failed:', err));
        break;

      case 'import-config':
        importConfig(this.win, () => {
          // A fresh config means every view is stale — rebuild from scratch.
          for (const [serviceId] of [...this.services.all()]) this.sleep(serviceId);
          this.layout.panes = [];
          this.layout.focusedPaneId = null;
          this.restoreLayout();
          this.relayout();
        }).catch((err: unknown) => console.error('[transfer] import failed:', err));
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

  // --- tile drag --------------------------------------------------------------------------

  /**
   * The geometry a drag is judged against, frozen at the lift.
   *
   * Frozen rather than recomputed per pointer move, and safe because `relayout()` ends any drag in
   * progress — geometry shifting mid-drag would mean the highlight and the drop disagree, and the
   * user only ever sees the highlight.
   */
  private dragContext: (DropContext & { railOrigin: Rect }) | null = null;

  /** A rail tile was lifted. Freeze the geometry and hand the content area to the drag layer. */
  private beginTileDrag(serviceId: string): void {
    if (!loadConfig().services.some((s) => s.id === serviceId)) return;
    const { width, height } = this.win.getContentBounds();
    const chrome = this.chrome();
    const bounds = this.layout.bounds(chrome, width, height);
    const content = contentArea(chrome, width, height);

    this.dragContext = {
      content,
      panes: this.layout.panes.flatMap((pane) => {
        const rect = bounds.get(pane.id);
        return rect ? [{ paneId: pane.id, rect }] : [];
      }),
      // Whether another pane is possible is Layout's to say — a renderer re-deriving it from
      // `MAX_PANES` would be a second copy of a rule only one of them enforces.
      canOpenNewPane: !this.layout.isFull,
      // The rail view's own rectangle, not the space the panes reserved for it. An expanded
      // compact rail on the right edge starts further left than the reservation says, and every
      // `from: 'rail'` position is translated through this.
      railOrigin: this.railRect(width, height),
    };
    this.dragLayer.begin(serviceId, content);
  }

  /**
   * A pointer position from one of the two renderers, in that renderer's own client coordinates.
   *
   * Translating here is the whole point of the arrangement: neither surface knows where it sits in
   * the window, and only one of them needs to.
   */
  private dragPoint(from: DragOrigin, x: number, y: number): { x: number; y: number } | null {
    const context = this.dragContext;
    if (!context) return null;
    const origin = from === 'rail' ? context.railOrigin : context.content;
    return { x: origin.x + x, y: origin.y + y };
  }

  private moveTileDrag(from: DragOrigin, x: number, y: number): void {
    const context = this.dragContext;
    const point = this.dragPoint(from, x, y);
    if (!context || !point) return;
    const drop = dropAt(context, point.x, point.y);
    const rect = highlightFor(drop, context);
    this.dragLayer.highlight(
      rect && drop.kind !== 'none'
        ? {
            // Into the layer's coordinates. It sits exactly on the content area, so this is the
            // same translation as above, backwards.
            rect: { ...rect, x: rect.x - context.content.x, y: rect.y - context.content.y },
            kind: drop.kind,
          }
        : null,
    );
  }

  /**
   * Detaches the layer and reports which service was in flight, or null if none was.
   *
   * Every exit from a drag comes through here, including the ones nobody asked for — a relayout, a
   * teardown. The rail is told each time, because its dnd-kit drag may never see the release: if
   * the pointer ended up over the layer's renderer, the rail is left holding a lifted tile with no
   * way to put it down.
   */
  private endTileDrag(): string | null {
    const serviceId = this.dragLayer.draggingServiceId;
    this.dragLayer.end();
    this.dragContext = null;
    if (serviceId) safeSend(this.rail.webContents, 'drag:ended', null);
    return serviceId;
  }

  /**
   * The release. Which service is in flight comes from the layer, never from the message: the drag
   * is main's state, and a `drop-tile` for a tile that was never lifted should do nothing at all.
   */
  private dropTile(from: DragOrigin, x: number, y: number): void {
    const context = this.dragContext;
    const point = this.dragPoint(from, x, y);
    // A null service means this is the second message for one drag — typically the rail's own
    // drag-end arriving after the layer already handled the release.
    const serviceId = this.endTileDrag();
    if (!serviceId || !context || !point) return;

    const target = dropAt(context, point.x, point.y);
    if (target.kind === 'replace') {
      // Focus the pane, then `openService` *without* `newPane`: `Layout.show` replaces the focused
      // pane's service, which is exactly "drop here" once the right pane is focused.
      if (!this.layout.find(target.paneId)) return;
      this.layout.focusedPaneId = target.paneId;
      this.openService(serviceId);
      this.flash(serviceId);
    } else if (target.kind === 'new-pane') {
      this.openService(serviceId, { newPane: true });
      this.flash(serviceId);
    }
  }

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

  /**
   * Boot, and again when `activate` rebuilds the window — preference *changes* go through
   * `applyPreferenceEffect`.
   *
   * A deliberate subset, not an oversight, and the two omissions have reasons worth stating:
   * `push` is already started by the constructor and starting it twice opens a second set of FCM
   * sockets, which is how every notification once arrived twice; `spellcheck` is read when a
   * session is created, and at this point none exist yet.
   *
   * Expressed as effect tags so the *how* lives in exactly one place. This was a fourth copy of
   * `applyLoginItem` / `applyProxy` / shortcut / tray, and when the tray gained its `closeToTray`
   * condition, this copy is the one that would have been missed.
   */
  applySystemPreferences(): void {
    for (const effect of ['login-item', 'proxy', 'shortcut', 'tray'] as const) {
      this.runEffect(effect);
    }
  }

  /**
   * Every preference effect at once, for a reset.
   *
   * Previously reset called `applySystemPreferences()`, which covers the login item, proxy,
   * shortcut and tray — but *not* the two branches for push and spellcheck. So resetting with push
   * enabled left the FCM sockets open while Settings reported push off, and live sessions kept the
   * old spellcheck languages until restart.
   *
   * Iterates the effect tags themselves. It used to iterate a hand-written list of representative
   * *paths*, under a comment claiming a new branch couldn't be forgotten here — it could, because
   * that list was a second copy of the branch set with nothing tying the two together.
   */
  private applyAllPreferenceEffects(): void {
    for (const effect of ALL_PREFERENCE_EFFECTS) this.runEffect(effect);
    nativeTheme.themeSource = loadConfig().preferences.appearance.theme;
  }

  /**
   * Only the effect the changed key actually needs. Re-running everything meant adjusting the rail
   * size re-registered the global shortcut and kicked off an unawaited proxy fan-out across every
   * session — harmless today, but exactly the shape that produces a race later.
   */
  private applyPreferenceEffect(path: string): void {
    const effect = preferenceEffectFor(path);
    if (effect) this.runEffect(effect);
  }

  /**
   * Performs one effect, and contains its failure.
   *
   * Each one reaches outside the app — the file system, launchd, the menu bar, a network — and a
   * throw from any of them used to escape into whatever called it. At boot that was
   * `applySystemPreferences`, so a `new Tray()` that failed took down the rest of startup with it,
   * and one broken effect in a reset skipped every effect after it.
   */
  private runEffect(effect: PreferenceEffect): void {
    try {
      this.performEffect(effect);
    } catch (err) {
      console.error(`[effect] ${effect} failed:`, err);
    }
  }

  /** Which paths map to which effect is decided in core. */
  private performEffect(effect: PreferenceEffect): void {
    const prefs = loadConfig().preferences;
    switch (effect) {
      case 'login-item':
        applyLoginItem(prefs);
        return;

      case 'proxy':
        // Async, so `runEffect`'s try/catch cannot see its rejection.
        void applyProxy(allLiveSessions().values(), prefs).catch((err) =>
          console.error('[effect] proxy failed:', err),
        );
        return;

      case 'adblock':
        setAdBlocking(allLiveSessions().values(), prefs.network.blockAds);
        return;

      case 'shortcut':
        this.applyShortcut(prefs.behaviour.globalShortcut);
        return;

      case 'tray':
        // Symmetric: `destroyTray` existed and was never called, so the icon outlived its setting.
        if (trayWanted(prefs))
          ensureTray(
            () => this.state(),
            (c) => this.dispatch(c),
          );
        else destroyTray();
        return;

      case 'push':
        // Switching push off must actually close the sockets, not just stop new subscriptions.
        if (
          prefs.notifications.push &&
          firebaseConfigStatus(prefs.notifications.firebase) === 'ready'
        ) {
          this.push.start(loadConfig().services.map((s) => s.id));
        } else {
          this.push.stopAll();
        }
        return;

      case 'spellcheck':
        // Read once per session at creation, so existing sessions need telling.
        for (const ses of allLiveSessions().values()) {
          ses.setSpellCheckerLanguages(prefs.behaviour.spellcheckLanguages);
        }
        return;
    }
  }

  private applyShortcut(accelerator: string | null): void {
    applyGlobalShortcut(accelerator, () => {
      if (this.win.isVisible() && !this.win.isMinimized()) this.hideWindow();
      else this.showWindow();
    });
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
    if (this.syncScheduled) clearTimeout(this.syncScheduled);
    this.syncScheduled = null;
    this.push.stopAll();
    // An in-flight fetch resolving after teardown would call `applyDetectedUnread` on a window
    // whose views are gone.
    this.endpoints.dispose();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;

    releaseGlobalShortcut();
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
    // one that the user has opened and closed is a detached renderer the window won't collect. The
    // rail and the empty state are attached children and go with the window, so they need nothing.
    this.findBar.destroy();
    this.overlay.destroy();
    this.dragLayer.destroy();
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
    this.applyDetectedUnread(svc, unreadFromTitle(title, catalogById(svc.catalogId)?.unread));
  }

  /**
   * The DOM rules a service view should watch, answered when its preload asks on load.
   *
   * Resolved here rather than in the preload because it needs the config: which catalog entry this
   * instance came from, and whether the user has overridden the selector.
   */
  /** Tells a live view to start watching a different set of rules. No-op if it isn't loaded. */
  private pushUnreadRules(serviceId: string): void {
    const contents = this.services.get(serviceId)?.view.webContents;
    if (contents)
      safeSend(contents, 'service:unread-rules-changed', this.unreadRulesFor(serviceId));
  }

  unreadRulesFor(serviceId: string): DomUnreadRule[] {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return [];
    // A muted service isn't going to be allowed to set a count, so don't make its page watch every
    // mutation to produce one.
    if (svc.notificationLevel === 'muted' || !svc.notifications) return [];
    return resolveUnreadRules(catalogById(svc.catalogId)?.unread, svc.unreadSelector);
  }

  /**
   * A service view read its own badge. The probes are raw page output: the page-side code collects
   * strings and `unreadFromDom` decides what they mean, so the rule semantics stay in a pure
   * function rather than in a serialised closure no test can reach.
   */
  handleUnreadProbes(serviceId: string, probes: unknown): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    if (!svc) return;
    const rules = resolveUnreadRules(catalogById(svc.catalogId)?.unread, svc.unreadSelector);
    this.applyDetectedUnread(svc, unreadFromDom(rules, probes));
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

  private applyEndpointCount(serviceId: string, count: number): void {
    const svc = loadConfig().services.find((s) => s.id === serviceId);
    // Raced with the service being deleted, or with it waking up — in which case its own page is
    // about to report, and the endpoint's answer is the staler of the two.
    if (!svc || this.services.has(serviceId)) return;
    this.applyDetectedUnread(svc, count);
  }

  /**
   * Records an absolute count from detection — a title pattern or a DOM rule.
   *
   * `null` means the rule had nothing to say, which is not zero: a service we cannot read keeps
   * whatever count it has rather than being silently cleared.
   */
  private applyDetectedUnread(svc: ServiceInstance, detected: number | null): void {
    if (detected === null) return;

    // Muting and the per-service toggle still win: an unread count is an interruption of a
    // quieter kind, and opting out should mean opting out of both.
    if (svc.notificationLevel === 'muted' || !svc.notifications) return;

    if (this.unread.get(svc.id) === detected) return;
    this.unread.set(svc.id, detected);
    this.updateBadge();
    this.sync();
  }

  /**
   * A service fired a notification. Attribution is the whole reason the preload wraps the
   * constructor rather than letting Electron route it directly.
   */
  handleNotification(serviceId: string, raw: unknown): void {
    // `unknown`, because one caller is an IPC handler fed by a page. See `normaliseNotification`.
    const payload = normaliseNotification(raw);
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
      windowVisible: this.windowOnScreen(),
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
      // Bounded. A notification left in Notification Center never closes, so over a week of
      // messages the set only grew. The oldest are the least likely to be clicked; a Set iterates
      // in insertion order, so the first entry is the oldest.
      while (this.liveNotifications.size > 50) {
        const oldest = this.liveNotifications.values().next().value;
        if (!oldest) break;
        this.liveNotifications.delete(oldest);
      }
      // The only evidence there will ever be. macOS delivers nothing to an unsigned bundle, and
      // before this the banner simply never appeared — unread counted, the badge moved, and the
      // log said nothing at all. Also released here: a failed notification never closes.
      notification.on('failed', (_event, error) => {
        console.error(`[notification] ${svc.name}: not delivered — ${error}`);
        this.liveNotifications.delete(notification);
      });
    }

    this.updateBadge();
    this.sync();
  }

  /** macOS hides the badge at 0, so it must be *set* to 0 rather than skipped. */
  private updateBadge(): void {
    app.setBadgeCount(this.unread.total());
  }

  /** Looking at a service is what marks it read — the only signal we reliably have. */
  /** Whether the window is somewhere a person could be looking at it. */
  private windowOnScreen(): boolean {
    return !this.win.isDestroyed() && this.win.isVisible() && !this.win.isMinimized();
  }

  /** The window has just come back into view: whatever is in a pane has now been seen. */
  private acknowledgePanes(): void {
    for (const pane of this.layout.panes) {
      if (this.services.has(pane.serviceId)) this.clearUnread(pane.serviceId);
    }
    this.sync();
  }

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
