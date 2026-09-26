/**
 * A rectangle.
 *
 * Here rather than in `core/workspace/layout.ts`, where it used to live, because one of these now
 * crosses IPC: main tells the drag layer which rectangle to highlight, and the renderer can't
 * import core for the type (`renderer-is-sandboxed`). `layout.ts` re-exports it, so the geometry
 * functions still read as if it were theirs.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the drag layer draws: the rectangle a release would affect, and which of the two things it
 * would do. Null — sent as the message itself — means a release here does nothing.
 */
export interface DropHighlight {
  rect: Rect;
  kind: 'replace' | 'new-pane';
}

/**
 * One way to read an unread count out of a service's own DOM.
 *
 * **Data, not code.** Rambox ships a JavaScript file per service and `eval`s it in the page. That
 * reaches anything, and it also means 90 unauditable scripts, no way to unit-test a rule, and a
 * syntax error taking out a service. A rule is declarative instead: one evaluator, in core, tested
 * once, driving every entry.
 *
 * The rules for an entry are tried in order and the first one that has anything to say wins, so a
 * precise selector can lead and a broad fallback can follow.
 */
export interface DomUnreadRule {
  /** CSS selector for the badge element(s). */
  selector: string;
  /**
   * How to turn the matches into a number:
   *   - `text` (default) — parse a count out of the first match's text. "12", "12 unread", "9+".
   *     Non-empty text with no digits reads as 1, which covers a bare dot.
   *   - `count` — the number of matching elements *is* the count, for a badge per row.
   *   - `attr` — read `attr` off the first match, for `aria-label="3 unread"` and friends.
   */
  read?: 'text' | 'count' | 'attr';
  /** Attribute name for `read: 'attr'`. Ignored otherwise. */
  attr?: string;
  /**
   * Proof that the app has actually rendered.
   *
   * Without it, "no badge on the page" is ambiguous — it is either zero unread or an SPA that
   * hasn't drawn its sidebar yet, and guessing zero clears a real count on every reload. With an
   * anchor present and the badge absent, zero is a fact. With the anchor absent we say nothing and
   * the previous count stands.
   *
   * Omit only when the selector's own container is always present.
   */
  anchor?: string;
}

/**
 * What the page found for one rule. The page-side code does no arithmetic: it collects strings and
 * main parses them, so the parsing is a pure function in core rather than a copy inlined in a
 * serialised main-world closure that no test can reach.
 */
export interface DomUnreadProbe {
  /** Whether the rule's anchor was found — always true for a rule that declares none. */
  anchored: boolean;
  /** Text (or attribute value) of each matching element, in document order. */
  values: string[];
}

/**
 * An endpoint of the service's own that reports its unread count, called with the login the service
 * already has. See core/notify/endpoint.ts for what it is for and what guards it.
 */
export interface EndpointRule {
  /** Absolute URL, and enforced to be on the service's own host allowlist. */
  url: string;
  /** A dotted JSON path, or a regex whose first capture group is the count. */
  extract: { json: string } | { regex: string };
  /** Polling interval, floored at one minute. */
  everySeconds?: number;
}

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
  /**
   * Other names people search for. The picker matched the display name only, so "twitter" found
   * nothing and "microsoft" didn't find Outlook. The provider is searched too; this is for the
   * names that aren't a provider — a rebrand, a product's old name, an obvious synonym.
   */
  aliases?: string[];
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
   * What this entry can't do, said before it is added.
   *
   * Some products have no web client at all, so the honest URL is a marketing page. Adding one
   * looks like adding any other service and then simply doesn't work, and the natural fix —
   * deleting the entry — is worse: a `catalogId` that stops resolving strands every existing
   * instance on a blank pane (see `isOrphaned`). Saying so in the picker costs nothing and is the
   * only version of this that helps.
   */
  caveat?: string;
  /**
   * How to read this service's unread count from its own UI. Opt-in per entry, and deliberately
   * absent for custom connections: a universal title parser produces phantom counts from any page
   * whose title happens to contain a number in brackets. See core/notify/unread.ts.
   *
   * `titlePattern` and `dom` are alternatives, never both — two sources writing one absolute count
   * flap between them. A catalog test enforces it.
   *
   * `endpoint` sits alongside either, because it only ever runs when the service has no live view:
   * a page that isn't rendered cannot be read, which is precisely the hibernated case the other two
   * cannot cover.
   */
  unread?: { titlePattern?: string; dom?: DomUnreadRule[]; endpoint?: EndpointRule };
  /**
   * Chords this service is known to bind itself, which Hangar therefore leaves alone. Slack's ⌘K
   * is the motivating case. A default, not a rule: `ServiceInstance.keyboardPassthrough` overrides
   * it in either direction.
   */
  passthrough?: string[];
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
  /**
   * Hosts the *user* added, unioned with the list above rather than replacing it.
   *
   * A separate field because `allowedHosts` is a replacement: writing a merged list into it would
   * pin the instance to today's catalog and it would never see a later fix. That's the property
   * `resolveUrl` deliberately preserves for URLs, and hosts drift for the same reasons — Teams
   * moved to `teams.cloud.microsoft`, Notion from `.so` to `.com`. Additive here means a service
   * unblocked by hand still picks up the entry the catalog grows later.
   */
  extraAllowedHosts?: string[];
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
   * When a timed mute ends, epoch ms. Set together with `notificationLevel: 'muted'`, which is what
   * everything actually reads — this is only the alarm clock that turns it back to `'all'`. So a
   * timed mute behaves exactly like a manual one until it expires, and nothing that checks for
   * `'muted'` needs to know timers exist.
   */
  mutedUntil?: number;
  /**
   * Lets a custom connection use the microphone, camera and screen share. Catalog services get
   * these by provenance; a URL the user typed has to ask.
   */
  allowMedia?: boolean;
  /**
   * Canonical chords this service keeps for itself — Hangar leaves them to the page.
   *
   * Absent means "follow the catalog", which is how Slack gets its own ⌘K back out of the box.
   * An empty array is the distinct, deliberate "claim nothing", so the catalog default is
   * overridable in both directions. See core/keyboard/keymap.ts.
   */
  keyboardPassthrough?: string[];
  /**
   * A CSS selector for this service's unread badge, replacing whatever the catalog says.
   *
   * The catalog can only carry rules for pages we have looked at, and a site's markup is not ours
   * to keep up with. This is the seam for the person who can actually see the page: point it at the
   * badge, get a real count. Absent follows the catalog; the empty string is the deliberate "no
   * detection", which is how you switch a catalog rule off when it starts reading the wrong node.
   */
  unreadSelector?: string;
  /**
   * An endpoint of this service's own to ask for a count while it is asleep, overriding the
   * catalog's.
   *
   * `null` is the deliberate "call nothing", which stops the background request without having to
   * turn the service's notifications off; absent follows the catalog. No Settings control on
   * purpose — a URL that gets fetched with your session cookies is not a field to put beside a zoom
   * spinner, and the guard that it must be on the service's own allowlist is worth keeping as the
   * only thing standing between a typo and a credentialled request somewhere else.
   */
  unreadEndpoint?: EndpointRule | null;
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
    /**
     * Let launchd restart Hangar if it stops unexpectedly. Meaningless without `launchAtLogin`,
     * because launchd can only supervise a process it started — see core/config/launch-agent.ts.
     */
    relaunchOnCrash: boolean;
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
  /**
   * Action id → canonical chord, `''` for unbound. The schema is `DEFAULT_BINDINGS`, so an action
   * added in a later version picks up its default and one removed is dropped on the next merge.
   */
  keyboard: { bindings: Record<string, string> };
  /**
   * `blockAds` covers ads *and* trackers, from the prebuilt Ghostery lists. On by default: a
   * service pane is a browser tab you cannot install an extension into, so the alternative is not
   * "your own blocker" but no blocker at all.
   */
  network: { proxy: ProxyConfig; blockAds: boolean };
  /**
   * Git-backed config sync. `repoPath` is a local clone you control; empty disables it.
   * See core/config/sync.ts for what travels and what deliberately doesn't.
   *
   * `allowPublicRepo` overrides the refusal to sync into a repo that answers an anonymous request
   * with 200 — off by default, and only ever consulted when the probe was decisive.
   */
  sync: { repoPath: string; allowPublicRepo: boolean };
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
  /**
   * Every service, including those outside the active workspace — Settings edits all of them, and
   * the tray, palette and spoken unread count read them so another workspace's messages are seen.
   */
  allServices: ServiceView[];
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
  /**
   * A request from main that the rail put a service's or a folder's name into an editable field.
   * `id` is the rail item's id; service and folder ids never collide.
   *
   * Carries a nonce rather than being a plain id because it is an *event*, not a state: asking to
   * rename the same item twice running is two requests, and an id alone cannot tell the second
   * from a re-broadcast of the first. Main never has to clear it, and the rail acts only when the
   * nonce changes — so an unrelated broadcast arriving mid-edit cannot restart the edit.
   */
  renameRequest?: { id: string; nonce: number } | null;
  /** For Settings → About: the running version and where its files really are. */
  about?: { version: string; configPath: string; logPath: string };
  panes: Pane[];
  focusedPaneId: string | null;
  activeWorkspaceId: string | null;
  /**
   * Whether a compact rail is currently open.
   *
   * Main owns this rather than the rail renderer, even though the rail hosts the chevron: main is
   * the one that resizes the view, and it refuses the change outright during a drag. Two copies of
   * the answer would disagree exactly then.
   */
  railExpanded: boolean;
  /** The shortcut table, resolved against the stored bindings. See `KeyboardMap`. */
  keyboard: KeyboardMap;
}

/**
 * The keymap as Settings draws it.
 *
 * Projected by main rather than imported by the renderer, because the table lives in `core/` and
 * `renderer-is-sandboxed` forbids reaching it. The renderer still owns *chords* — it parses and
 * renders them through `shared/keyboard.ts` — but which actions exist, and which of them are in
 * conflict, is main's answer.
 */
export interface KeyboardMap {
  actions: Array<{
    id: string;
    label: string;
    /** Canonical, or `''` for unbound. */
    chord: string;
    /** True when another action holds the same chord, which only a hand-edited config produces. */
    conflict: boolean;
  }>;
  /** Chords the menu bar's roles already own. Settings refuses them before sending. */
  reserved: string[];
  /**
   * Per service id: the chords Hangar leaves to that page, already resolved against the catalog
   * and this platform's primary modifier. `fromCatalog` distinguishes "hasn't been touched" from
   * "was set to exactly this", which is the difference between following a future catalog change
   * and not.
   */
  passthrough: Record<string, { chords: string[]; fromCatalog: boolean }>;
}

/** Whose client coordinates a drag position is expressed in. See `drag-tile-to`. */
export type DragOrigin = 'rail' | 'content';

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
  | { type: 'open-shortcuts' }
  /** `until` null with `on` true is "until I turn it off". */
  | { type: 'set-dnd'; on: boolean; until: number | null }
  /** `until` null unmutes; a number mutes until then. */
  | { type: 'mute-service'; serviceId: string; until: number | null }
  | { type: 'mark-read'; serviceId: string }
  | { type: 'reveal'; what: 'config' | 'log' }
  /** Opens a folder picker and writes the choice to that preference. */
  | { type: 'choose-folder'; purpose: 'downloads' | 'sync' }
  | { type: 'move-to-workspace'; serviceId: string; workspaceId: string }
  | { type: 'open-connections' }
  | { type: 'close-overlay' }
  | { type: 'add-service'; catalogId: string; forceNewAccount?: boolean }
  | { type: 'add-custom-service'; name: string; url: string }
  | { type: 'rename-service'; serviceId: string; name: string }
  /** Ask the rail to edit this service's name in place, opening the rail first if it is collapsed. */
  | { type: 'begin-rename-service'; serviceId: string }
  | { type: 'begin-rename-folder'; folderId: string }
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
  /**
   * A rail drag finished: put `activeId` where `overId` is. Covers reordering and filing into a
   * folder, because from the rail's side they are the same gesture — which of the two it was is
   * decided against the workspace tree, in `moveItemTo`.
   */
  | { type: 'move-item'; activeId: string; overId: string }
  /**
   * A rail tile was lifted with the pointer. Main answers by attaching the drag layer over the
   * panes — `main/features/drag-layer.ts` explains why the drag can't simply travel there itself.
   */
  | { type: 'begin-tile-drag'; serviceId: string }
  /**
   * The pointer moved, or was released, during a tile drag.
   *
   * `from` says which renderer's coordinate space `x`/`y` are in, because only main knows where
   * either of those surfaces sits in the window. Both report: mouse capture keeps the events in
   * whichever view the press started in on some platforms and hands them over on others, and a
   * feature that works on one of those is not a feature.
   */
  | { type: 'drag-tile-to'; from: DragOrigin; x: number; y: number }
  | { type: 'drop-tile'; from: DragOrigin; x: number; y: number }
  /**
   * Escape, or a drag that ended without a release. Distinct from a `drop-tile` outside every
   * target only in intent, but the intent is worth keeping: this one can never open a pane.
   */
  | { type: 'cancel-tile-drag' }
  /**
   * The chevron was clicked. Only a compact rail acts on it — see `railSizes`.
   *
   * A report of what happened, not an instruction: main decides whether the rail may change size
   * right now, and a drag in flight is the case where it may not.
   */
  | { type: 'toggle-rail' }
  /**
   * Assign a chord to an action, or clear it with null. The chord is canonical — Settings builds it
   * with `shared/keyboard.ts` — but main revalidates it, because this is an IPC boundary.
   */
  | { type: 'rebind'; actionId: string; chord: string | null }
  | { type: 'show-folder-menu'; folderId: string }
  | { type: 'sleep-others' }
  | { type: 'show-window' }
  | { type: 'export-config' }
  | { type: 'import-config' }
  | { type: 'update-service'; serviceId: string; patch: Partial<ServiceInstance> };

/** What the overlay is currently being used for. One view, three jobs. */
export type OverlayMode = 'palette' | 'connections' | 'shortcuts';

/**
 * The nonce exists so reopening the overlay in the *same* mode still remounts the renderer.
 * Without it React sees an unchanged key and the picker keeps a stale snapshot of the service list.
 */
export interface OverlayOpen {
  mode: OverlayMode;
  nonce: number;
}
