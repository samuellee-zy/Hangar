import { catalogById } from '@shared/catalog';
import { flattenServiceIds, pruneMissing } from '@core/workspace/folders';
import { KEY_ACTIONS, RESERVED_CHORDS, conflicts, resolvePassthrough } from '@core/keyboard/keymap';
import type {
  Config,
  Command,
  KeyboardMap,
  Pane,
  ServiceInstance,
  ServiceView,
  ShellState,
  SyncStatus,
  Workspace,
} from '@shared/types';

/**
 * The pure half of `AppWindow`.
 *
 * These four functions were inline methods on a 1,296-line class, which is why none of them had a
 * test — reaching them meant constructing a `BaseWindow`. They are folds over `Config` plus a
 * little runtime state and nothing else, so pulling them out costs nothing and makes the rules
 * they encode assertable.
 *
 * Extracted **verbatim**, bugs included. Where behaviour here is known to be wrong it's marked
 * BUG and pinned by a characterisation test, so the fix and the refactor stay separable.
 */

/** Falls back to the first workspace, so a dangling `activeWorkspaceId` still renders something. */
export function activeWorkspaceOf(
  config: Config,
  workspaceId: string | null,
): Workspace | undefined {
  return config.workspaces.find((w) => w.id === workspaceId) ?? config.workspaces[0];
}

/**
 * Services in the active workspace, flattened to visual order — folders inlined at their position.
 * Drives ⌘1–9 and the palette, so the order is load-bearing, not cosmetic.
 */
export function activeServicesOf(config: Config, workspaceId: string | null): ServiceInstance[] {
  const workspace = activeWorkspaceOf(config, workspaceId);
  // No workspace means nothing to show. Falling back to every service used to silently render
  // tiles belonging to no workspace at all.
  if (!workspace) return [];
  const byId = new Map(config.services.map((s) => [s.id, s]));
  return flattenServiceIds(workspace)
    .map((id) => byId.get(id))
    .filter((s): s is ServiceInstance => Boolean(s));
}

/** Just enough of a live service view for the projection; the real one owns a WebContentsView. */
export interface RuntimeView {
  loading: boolean;
}

export interface ProjectionInput {
  config: Config;
  /** Keyed by service id. A service absent from this map is asleep, by definition. */
  runtimes: Map<string, RuntimeView>;
  /**
   * Keyed by service id, and deliberately separate from `runtimes` — a hibernated service has no
   * runtime but can still have unread, which is the whole point of Web Push.
   */
  unread: Map<string, number>;
  panes: Pane[];
  focusedPaneId: string | null;
  orphanPartitions: string[];
  quarantinedConfigs: string[];
  syncStatus: SyncStatus;
  flashServiceId?: string | null;
  renameRequest?: { id: string; nonce: number } | null;
  about?: { version: string; configPath: string; logPath: string };
  globalShortcutStatus?: 'off' | 'active' | 'taken' | 'invalid';
  isDefaultMailApp?: boolean;
  recentNotifications?: ShellState['recentNotifications'];
  downloads?: ShellState['downloads'];
  /** Whether a compact rail is currently open. See `railSizes`. */
  railExpanded: boolean;
  fullScreen?: boolean;
  /** Bumped each time a service's favicon is cached, so the renderer refetches it. */
  iconVersions?: ReadonlyMap<string, number>;
  /** Services by most recent use, newest first. */
  recentServiceIds?: string[];
  maximisedPaneId?: string | null;
  layoutShape?: 'columns' | 'main-stack';
}

/**
 * Everything the four renderer surfaces draw. They hold no state of their own, so a field missing
 * here is a blank rail with no error anywhere — which is the argument for testing it.
 */
export function projectShellState(input: ProjectionInput): ShellState {
  const { config, runtimes } = input;
  const view = (svc: ServiceInstance): ServiceView => {
    const entry = catalogById(svc.catalogId);
    const runtime = runtimes.get(svc.id);
    return {
      ...svc,
      initials: entry?.initials ?? svc.name.slice(0, 2),
      // The service's own colour when it has one — every custom connection does, and a catalog one
      // does once someone picks a colour in Settings — and otherwise the brand hex. Brand first
      // made a chosen colour do nothing, which is how two Gmail tiles stayed the same red.
      color: svc.color ?? entry?.color ?? '#666',
      loading: runtime?.loading ?? false,
      // No runtime *is* the definition of asleep — there's no separate flag to disagree with.
      sleeping: !runtime,
      unread: input.unread.get(svc.id) ?? 0,
      iconVersion: input.iconVersions?.get(svc.id) ?? 0,
    };
  };
  return {
    accounts: config.accounts,
    preferences: config.preferences,
    orphanPartitions: input.orphanPartitions,
    quarantinedConfigs: input.quarantinedConfigs,
    syncStatus: input.syncStatus,
    // Views, like `services`, not the raw config entries. The tray, the palette and the rail's
    // spoken count all need every workspace's unread, and a raw entry has none — which is how all
    // three came to count the active workspace only while the Dock badge counted everything.
    allServices: config.services.map(view),
    flashServiceId: input.flashServiceId,
    renameRequest: input.renameRequest,
    about: input.about,
    globalShortcutStatus: input.globalShortcutStatus,
    isDefaultMailApp: input.isDefaultMailApp,
    recentNotifications: input.recentNotifications,
    downloads: input.downloads,
    services: activeServicesOf(config, config.activeWorkspaceId).map(view),
    workspaces: config.workspaces,
    railItems: activeWorkspaceOf(config, config.activeWorkspaceId)?.items ?? [],
    panes: input.panes,
    focusedPaneId: input.focusedPaneId,
    activeWorkspaceId: config.activeWorkspaceId,
    railExpanded: input.railExpanded,
    fullScreen: input.fullScreen ?? false,
    recentServiceIds: input.recentServiceIds ?? [],
    maximisedPaneId: input.maximisedPaneId ?? null,
    layoutShape: input.layoutShape ?? 'columns',
    keyboard: keyboardMapOf(config),
  };
}

/**
 * The shortcut table as Settings draws it.
 *
 * Conflicts are computed here rather than in the renderer for the same reason the table is: the
 * tie-break rule (`KEY_ACTIONS` order) is what decides which of two clashing shortcuts actually
 * fires, and a renderer re-deriving it would be a second copy of the rule free to disagree.
 */
export function keyboardMapOf(config: Config): KeyboardMap {
  const bindings = config.preferences.keyboard?.bindings ?? {};
  const clashing = conflicts(bindings);
  return {
    actions: KEY_ACTIONS.map((action) => {
      const chord = bindings[action.id] ?? '';
      return {
        id: action.id,
        label: action.label,
        chord,
        conflict: clashing.has(chord),
        command: action.command,
        menu: action.menu,
      };
    }),
    reserved: [...RESERVED_CHORDS],
    // Resolved here, through the same function the keystroke path uses. The renderer could not do
    // it anyway — the catalog writes `mod+k`, and expanding that needs a platform it can't ask.
    passthrough: Object.fromEntries(
      config.services.map((svc) => [
        svc.id,
        {
          chords: resolvePassthrough(
            svc.keyboardPassthrough,
            catalogById(svc.catalogId)?.passthrough,
          ),
          fromCatalog: svc.keyboardPassthrough === undefined,
        },
      ]),
    ),
  };
}

/**
 * Translates the positional forms a keystroke produces — `#3` for "the third service", `#focused`
 * for "whichever pane has focus" — into real ids.
 *
 * Returns null when the target doesn't exist, and `dispatch` turns that into `false` so the
 * keystroke isn't swallowed. ⌘7 with six services must reach the page, not vanish.
 */
export function resolveCommand(
  command: Command,
  context: { config: Config; focusedPaneId: string | null; focusedServiceId?: string | null },
): Command | null {
  const { config, focusedPaneId } = context;

  if (command.type === 'focus-service' && command.serviceId.startsWith('#')) {
    const index = Number(command.serviceId.slice(1)) - 1;
    const svc = activeServicesOf(config, config.activeWorkspaceId)[index];
    return svc ? { type: 'focus-service', serviceId: svc.id } : null;
  }
  if (command.type === 'set-workspace' && command.workspaceId.startsWith('#')) {
    const index = Number(command.workspaceId.slice(1)) - 1;
    const ws = config.workspaces[index];
    return ws ? { type: 'set-workspace', workspaceId: ws.id } : null;
  }
  if (command.type === 'close-pane' && command.paneId === '#focused') {
    return focusedPaneId ? { type: 'close-pane', paneId: focusedPaneId } : null;
  }
  if (command.type === 'reload-service' && command.serviceId === '#focused') {
    const serviceId = context.focusedServiceId;
    return serviceId ? { ...command, serviceId } : null;
  }
  return command;
}

/**
 * Removes a service from every structure that can reference it. Five of them, and missing one
 * leaves a dangling id that surfaces far from here — a pane pointing at nothing, or an account
 * garbage-collected while a service still needs its partition, which makes that service
 * permanently unloadable.
 *
 * Mutates in place, matching the `updateConfig` callback it was lifted from.
 */
export function removeServiceFromConfig(config: Config, serviceId: string): void {
  config.services = config.services.filter((s) => s.id !== serviceId);

  const alive = new Set(config.services.map((s) => s.id));
  // Both nesting levels: top-level rail items and folder membership.
  for (const workspace of config.workspaces) pruneMissing(workspace, alive);

  // Every workspace's stored layout, not just the active one.
  for (const layout of Object.values(config.layouts)) {
    layout.panes = layout.panes.filter((p) => p.serviceId !== serviceId);
  }

  // An account with no services is a cookie jar nothing can reach. Dropped, or Settings fills up
  // with dead entries — but only when genuinely unused, since two services can share one login.
  const used = new Set(config.services.map((s) => s.accountId));
  config.accounts = config.accounts.filter((a) => used.has(a.id));
}

/**
 * The state as the app's other screens get it: without each service's custom CSS and JavaScript.
 *
 * `view` spreads the whole service record, so every broadcast carried every script body to the
 * rail, the overlay, the find bar, the drag layer and the empty view — none of which reads them.
 * Only Settings edits them. Code that runs in signed-in pages is worth keeping in as few processes
 * as it can be, and the bodies can run to kilobytes a service, sent on every sync.
 */
export function withoutServiceCode(state: ShellState): ShellState {
  const strip = ({ customCss: _css, customJs: _js, ...svc }: ServiceView): ServiceView => svc;
  return { ...state, services: state.services.map(strip), allServices: state.allServices.map(strip) };
}

