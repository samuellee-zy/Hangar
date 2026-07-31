/** A template in the catalog. Adding a service instance copies from one of these. */
export interface CatalogEntry {
  id: string;
  name: string;
  url: string;
  /**
   * dashboard-icons slug, vendored into assets/icons/. See scripts/fetch-icons.mjs.
   *
   * Optional: not every service has a logo upstream, and omitting the field is honest where
   * declaring a slug that 404s is indistinguishable from a typo. `initials` covers it.
   */
  icon?: string;
  /** Last-resort fallback when there's no vendored logo and no captured favicon yet. */
  initials: string;
  /** Brand hex. Lifted for dark backgrounds at render time — see renderer/accent.ts. */
  color: string;
  /**
   * Hosts allowed to navigate inside the view or open an in-app popup. Anything else goes to the
   * system browser. Auth hosts must be listed or sign-in silently dies.
   */
  allowedHosts: string[];
  /**
   * Identity provider. Services sharing a provider can share an Account — one Google sign-in
   * covers Gmail, Calendar and Drive. Rambox gives every app its own jar, which is why it makes
   * you sign into Google once per Google app.
   */
  provider: string;
  /** Services whose session the server drops on browser close (Salesforce) — see plan, Tier 2. */
  sessionNotPersistable?: boolean;
  /**
   * How to read this service's unread count from its own UI. Opt-in per entry, and deliberately
   * absent for custom connections: a universal title parser produces phantom counts from any page
   * whose title happens to contain a number in brackets. See core/notify/unread.ts.
   */
  unread?: { titlePattern?: string };
}

/**
 * A signed-in identity, owning one cookie jar. Two Gmails are two Accounts; Gmail and Calendar on
 * the same Google login share one.
 */
export interface Account {
  id: string;
  /** User-facing, editable — "Google (work)". Never used to derive the partition. */
  label: string;
  provider: string;
  /**
   * The Chromium partition. Written once at creation and **never recomputed**: a partition name
   * *is* the identity of a cookie jar, so deriving it from a mutable field (an id scheme, a label)
   * means a rename silently signs you out of everything. Migrated accounts keep their original
   * `persist:grp-*` names for exactly this reason.
   */
  partition: string;
}

/** A configured instance. Two Gmail accounts are two of these, pointing at two Accounts. */
export interface ServiceInstance {
  id: string;
  catalogId: string;
  name: string;
  /**
   * Override only — omit to follow the catalog. Copying the catalog URL in here at creation time
   * meant a catalog fix never reached existing installs, which is how a stale
   * `mail.google.com/mail/u/0/` survived after the equivalent Calendar bug was fixed.
   * Custom connections set this explicitly; catalog-backed services should not.
   */
  url?: string;
  /** Which Account (and therefore which cookie jar) this instance signs in with. */
  accountId: string;
  notifications: boolean;
  hibernate: boolean;
  zoom: number;
  /** Per-service UA override. Unused so far — Phase 0 found the global scrub sufficient. */
  userAgent?: string;
  /**
   * Days to extend session cookies by on quit. Omitted → the default. Set to 0 to opt out entirely,
   * which is what `CatalogEntry.sessionNotPersistable` forces for services whose server invalidates
   * the session on browser close anyway (Salesforce).
   */
  cookieTtlDays?: number;
  /**
   * Custom connections carry their own host allowlist — there's no catalog entry to read it from.
   * Without this every navigation would be treated as external and bounced to the system browser,
   * which looks exactly like the service failing to load.
   */
  allowedHosts?: string[];
  /** Tile accent for custom connections, which have no catalog colour. */
  color?: string;
  /** Injected on every dom-ready. The escape hatch for anything the app doesn't model. */
  customCss?: string;
  customJs?: string;
  /**
   * `all` or `muted`. There's deliberately no "mentions only" — we'd have to guess at what counts
   * as a mention from a title string, and a filter that silently drops real messages is worse than
   * no filter.
   */
  notificationLevel?: 'all' | 'muted';
  /**
   * Lets a custom connection use the microphone, camera and screen share. Catalog services get
   * these by provenance; a URL the user typed has to ask.
   */
  allowMedia?: boolean;
}

/**
 * A visible slot holding one service. Main owns 1–4 of these; a single pane is the degenerate
 * case, not a special case. Anything not in a pane is detached from the window entirely.
 */
export interface Pane {
  id: string;
  serviceId: string;
}

/**
 * A workspace's rail contents, in display order. One level deep on purpose — nesting past that is
 * where Arc-style sidebars stop being navigable.
 */
export type RailItem =
  | { kind: 'service'; id: string }
  | {
      kind: 'folder';
      id: string;
      name: string;
      collapsed: boolean;
      /** Ordered. A service belongs to at most one folder. */
      serviceIds: string[];
    };

export interface Workspace {
  id: string;
  name: string;
  items: RailItem[];
}

/** A workspace's pane arrangement, restored on launch so a split view survives a restart. */
export interface StoredLayout {
  panes: Pane[];
  focusedPaneId: string | null;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProxyConfig {
  mode: 'system' | 'none' | 'http' | 'socks4' | 'socks5';
  host: string;
  port: number;
}

/**
 * Every configurable choice. Defaults live in `main/preferences.ts` and act as the schema — a
 * stored config is merged onto them, so adding a key here can never break an existing install.
 */
export interface Preferences {
  appearance: {
    railPosition: 'left' | 'right' | 'top' | 'bottom';
    railSize: number;
    compactRail: boolean;
    theme: 'system' | 'light' | 'dark';
    density: 'comfortable' | 'compact';
    gutter: number;
    showLabels: boolean;
    /** Menu-bar presence. Independent of closeToTray, which needs it but isn't the only reason to want it. */
    showTrayIcon: boolean;
  };
  behaviour: {
    /** Accelerator string, or null for none. The single legitimate global shortcut. */
    globalShortcut: string | null;
    hibernateAfterMinutes: number;
    launchAtLogin: boolean;
    startHidden: boolean;
    closeToTray: boolean;
    confirmQuit: boolean;
    defaultZoom: number;
    spellcheckLanguages: string[];
  };
  notifications: {
    enabled: boolean;
    sound: boolean;
    dnd: boolean;
    dndUntil: number | null;
    /**
     * Web Push. Off by default and useless until `firebase` is filled in — intercepting a site's
     * push subscription changes how that site behaves, so it's never done uninvited.
     */
    push: boolean;
    /**
     * The user's own Firebase project. Hangar can't ship one: FCM web registration requires an
     * `apiKey`, and a key in the repo would be a shared quota anyone could get revoked.
     * See `docs/push.md`.
     */
    firebase: { projectId: string; appId: string; apiKey: string; messagingSenderId: string };
  };
  network: { proxy: ProxyConfig };
  /**
   * Git-backed config sync. `repoPath` is a local clone you control; empty disables it.
   * See core/config/sync.ts for what travels and what deliberately doesn't.
   */
  sync: { repoPath: string };
  downloads: { folder: string | null; askWhereToSave: boolean; openOnComplete: boolean };
}

/** Mirrors core/config/sync.ts. Declared here because ShellState crosses the IPC boundary. */
export type SyncStatus =
  | { state: 'off' }
  | { state: 'unavailable'; reason: string }
  | { state: 'idle'; lastSync: number | null }
  | { state: 'conflict'; detail: string }
  | { state: 'error'; detail: string };

export interface Config {
  version: 4;
  preferences: Preferences;
  accounts: Account[];
  services: ServiceInstance[];
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Keyed by workspace id — each workspace remembers its own arrangement. */
  layouts: Record<string, StoredLayout>;
  /**
   * Live FCM registrations, one per push-enabled service. Persisted because re-registering hands
   * the site a new endpoint and orphans the one its servers are already pushing to.
   */
  pushRegistrations?: Array<{
    serviceId: string;
    vapidKey: string;
    credentials: unknown;
    seenIds: string[];
  }>;
  window?: WindowBounds;
}

export type ServiceView = ServiceInstance & {
  initials: string;
  color: string;
  loading: boolean;
  sleeping: boolean;
  unread: number;
};

/** Everything the rail renders. The renderer holds no state of its own — it draws this. */
export interface ShellState {
  /** Services in the active workspace, flattened in visual order — drives ⌘1..9 and the palette. */
  services: ServiceView[];
  /** The active workspace's rail tree: top-level services and folders, in order. */
  railItems: RailItem[];
  /** Every service, including those outside the active workspace — Settings edits all of them. */
  allServices: ServiceInstance[];
  preferences: Preferences;
  /**
   * Partition directories no account references. Derived at runtime, surfaced in Settings, and
   * never deleted automatically — these are cookie jars, and a bug in the reachability calculation
   * would sign the user out of everything.
   */
  orphanPartitions: string[];
  /**
   * Config copies quarantined after a failed read. Surfaced because they are the only surviving
   * record of a setup that couldn't be loaded — until now nothing ever mentioned them again.
   */
  quarantinedConfigs: string[];
  /** Config sync state, so Settings can report it rather than leaving the user guessing. */
  syncStatus: SyncStatus;
  /** So the picker can offer "open with Google (work)" vs "add another account". */
  accounts: Account[];
  workspaces: Workspace[];
  /**
   * Briefly set after an action whose effect might otherwise be invisible — focusing a service
   * that's already the focused pane, for instance. The rail pulses this tile so every action
   * acknowledges itself. See docs/decisions.md #16.
   */
  flashServiceId?: string | null;
  panes: Pane[];
  focusedPaneId: string | null;
  activeWorkspaceId: string | null;
}

/** Commands the rail and palette can send. Keep this the single funnel into main. */
export type Command =
  | { type: 'focus-service'; serviceId: string }
  | { type: 'open-in-new-pane'; serviceId: string }
  | { type: 'focus-pane'; paneId: string }
  | { type: 'close-pane'; paneId: string }
  | { type: 'split' }
  | { type: 'cycle-pane'; delta: -1 | 1 }
  | { type: 'set-workspace'; workspaceId: string }
  | { type: 'navigate'; direction: 'back' | 'forward' }
  | { type: 'open-palette' }
  | { type: 'open-connections' }
  | { type: 'close-overlay' }
  | { type: 'add-service'; catalogId: string; forceNewAccount?: boolean }
  | { type: 'add-custom-service'; name: string; url: string }
  | { type: 'rename-service'; serviceId: string; name: string }
  | { type: 'remove-service'; serviceId: string }
  | { type: 'rename-account'; accountId: string; label: string }
  | { type: 'sign-out-account'; accountId: string }
  | { type: 'open-settings' }
  | { type: 'set-preference'; path: string; value: unknown }
  | { type: 'clear-unread'; serviceId: string }
  | { type: 'create-workspace'; name: string }
  | { type: 'rename-workspace'; workspaceId: string; name: string }
  | { type: 'delete-workspace'; workspaceId: string }
  | { type: 'reorder-workspaces'; workspaceIds: string[] }
  | { type: 'purge-orphan-partitions' }
  /** Reveal a file in Finder. Used for quarantined config copies, which are otherwise unfindable. */
  | { type: 'reveal-path'; path: string }
  | { type: 'sync-now' }
  /** Explicit conflict resolution. Each direction discards something, so it is never automatic. */
  | { type: 'resolve-sync'; winner: 'local' | 'remote' }
  | { type: 'reset-preferences'; section?: string }
  | { type: 'open-find' }
  | { type: 'close-find' }
  | { type: 'find'; query: string; forward?: boolean; findNext?: boolean }
  | { type: 'zoom'; direction: 'in' | 'out' | 'reset' }
  | { type: 'print' }
  | { type: 'reload-service'; serviceId: string }
  | { type: 'sleep-service'; serviceId: string }
  | { type: 'show-service-menu'; serviceId: string }
  | { type: 'show-rail-menu' }
  | { type: 'create-folder'; name: string; serviceIds?: string[] }
  | { type: 'rename-folder'; folderId: string; name: string }
  | { type: 'delete-folder'; folderId: string }
  | { type: 'toggle-folder'; folderId: string }
  | { type: 'move-to-folder'; serviceId: string; folderId: string | null }
  | { type: 'reorder-items'; itemIds: string[] }
  | { type: 'show-folder-menu'; folderId: string }
  | { type: 'sleep-others' }
  | { type: 'show-window' }
  | { type: 'export-config' }
  | { type: 'import-config' }
  | { type: 'update-service'; serviceId: string; patch: Partial<ServiceInstance> };

/** What the overlay is currently being used for. One view, three jobs. */
export type OverlayMode = 'palette' | 'connections';

/**
 * The nonce exists so reopening the overlay in the *same* mode still remounts the renderer.
 * Without it React sees an unchanged key and the picker keeps a stale snapshot of the service list.
 */
export interface OverlayOpen {
  mode: OverlayMode;
  nonce: number;
}
