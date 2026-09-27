import type { BaseWindow, WebContents } from 'electron';
import type { Layout, Rect } from '@core/workspace/layout';
import type { ConfigSync } from '@main/features/sync';
import type { FindBar } from '@main/features/find-bar';
import type { Overlay } from '@main/window/overlay';
import type { ServiceManager } from '@main/window/service-manager';
import type { Command, OverlayMode, Preferences, ServiceInstance, Workspace } from '@shared/types';

/**
 * What a command handler may reach in the window, listed.
 *
 * `dispatch` was a ~650-line switch inside AppWindow, where every case could touch every private
 * member and nothing said which it needed. The handlers now live in files by concern and get this:
 * an explicit capability list, built once by AppWindow from closures over its own members, which
 * stay private. A handler that needs something new has to add it here, in the open.
 */
export interface ShellContext {
  readonly win: BaseWindow;
  readonly layout: Layout;
  readonly services: ServiceManager;
  readonly overlay: Overlay;
  readonly findBar: FindBar;
  readonly configSync: ConfigSync;

  dispatch(command: Command): boolean;
  sync(): void;
  relayout(): void;
  showWindow(): void;
  focusActivePane(): void;
  openOverlay(mode: OverlayMode): void;
  openService(serviceId: string, options?: { newPane?: boolean }): void;
  flash(serviceId: string): void;
  saveLayout(): void;
  /** Throws the current panes away and rebuilds them from the active workspace's saved layout. */
  rebuildPanes(): void;
  paneRect(paneId: string): Rect | null;
  contentsForService(serviceId: string): WebContents | null;
  activeWorkspace(workspaceId: string | null): Workspace | undefined;
  activeServices(workspaceId: string | null): ServiceInstance[];
  mutateWorkspace(mutate: (w: Workspace) => void): void;

  removeService(serviceId: string): void;
  sleep(serviceId: string): void;
  signOut(accountId: string): Promise<void>;
  clearAccountCache(partition: string): Promise<void>;
  purgeOrphanPartitions(): void;
  registerConsumer(wc: WebContents): void;

  unreadOf(serviceId: string): number;
  /** Services by most recent use, newest first. */
  recentServiceIds(): string[];
  clearUnread(serviceId: string): void;
  pushUnreadRules(serviceId: string): void;

  applyAllPreferenceEffects(): void;
  applyPreferenceEffect(path: string): void;
  /** After preferences were replaced wholesale, run whatever changed from `before`. */
  applyChangedPreferences(before: Preferences): void;
  /** The cached default-mail-app answer is stale: ask Launch Services again next time. */
  forgetDefaultMailApp(): void;

  toggleRail(): void;
  /** Asks the rail to put an item's name in an editable field. See `ShellState.renameRequest`. */
  beginRename(id: string): void;

  beginTileDrag(serviceId: string): void;
  moveTileDrag(from: 'rail' | 'content', x: number, y: number): void;
  dropTile(from: 'rail' | 'content', x: number, y: number): void;
  endTileDrag(): void;
}

export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

/**
 * Handles one command. Returns `false` to say nothing happened — the keyboard layer then lets the
 * keystroke through to the page, which is how Escape reaches a service when no overlay is open.
 */
export type Handler<T extends CommandType> = (command: CommandOf<T>, shell: ShellContext) => boolean | void;

export type CommandTable = { [T in CommandType]?: Handler<T> };
