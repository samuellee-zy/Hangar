import { commandProblem } from '@core/commands';
import { expiredQuiet } from '@core/notify/policy';
import { catalogById } from '@shared/catalog';
import type { Command, Config, MeetingState, ShellState } from '@shared/types';

/**
 * The control socket's side of things that needs no Electron: what a client may ask for, what it
 * is told, and how a line it sends is read. The socket itself is main/features/control-server.ts.
 *
 * A client is anything running as you — a Stream Deck plugin, a script. The socket is only
 * reachable by your user (decision #114), so unlike a link it can see state; but it can still only
 * do what a link could, plus moving around what's on screen. Nothing that removes, signs out,
 * imports or edits a service.
 */

/**
 * What a client may send. The link verbs (#110) other than their one patch, plus navigation that a
 * link has no reason to offer but a button next to the screen does.
 */
export const CONTROL_COMMAND_TYPES: ReadonlySet<Command['type']> = new Set([
  'focus-service',
  'open-in-new-pane',
  'set-workspace',
  'set-dnd',
  'mute-service',
  'mark-read',
  'mark-all-read',
  'focus-next-unread',
  'focus-previous-service',
  'toggle-maximise-pane',
  'split',
  'cycle-pane',
  'reopen-pane',
  'reload-service',
  'sleep-service',
  'open-palette',
  'open-activity',
  'show-window',
  // Presses a control in a meeting running in a service's page. Only here, never a link verb (#115).
  'meeting-control',
]);

/**
 * The commands that ask to see something, and so bring the window forward — building one after ⌘W.
 * The rest change a setting, or what's in a window that is already there, and never build one: a
 * Do Not Disturb key pressed with no window changes the setting where it's kept, as a link does.
 */
export const CONTROL_SHOWS: ReadonlySet<Command['type']> = new Set([
  'focus-service',
  'open-in-new-pane',
  'set-workspace',
  'focus-next-unread',
  'focus-previous-service',
  'open-palette',
  'open-activity',
  'show-window',
]);

export interface ControlService {
  id: string;
  name: string;
  catalogId: string;
  /**
   * The vendored logo's name, `assets/icons/<icon>.svg` in the app bundle — the catalog id isn't
   * the file name (`gcal` is `google-calendar`). Absent for a service with none; its captured
   * favicon, if any, is `icons/<id>.*` in userData.
   */
  icon?: string;
  /** Tile colour and initials, for a client with no icon to draw. Absent with no window. */
  color?: string;
  initials?: string;
  unread: number;
  muted: boolean;
  /** When a timed mute ends, epoch ms. */
  mutedUntil: number | null;
  sleeping: boolean;
  /** A call in the service's page (Teams, a Slack huddle, Meet), when there is one. */
  meeting?: MeetingState;
}

/** What a client is sent: on connecting, and whenever any of it changes. */
export interface ControlState {
  /** False after ⌘W with close-to-tray off: nothing is running, so nothing is unread. */
  window: boolean;
  dnd: boolean;
  dndUntil: number | null;
  activeWorkspaceId: string | null;
  workspaces: Array<{ id: string; name: string }>;
  /** Every service, in every workspace — the Dock badge counts them all. */
  services: ControlService[];
  focusedServiceId: string | null;
  unreadTotal: number;
}

export function controlState(state: ShellState): ControlState {
  const services = state.allServices.map(
    (svc): ControlService => ({
      id: svc.id,
      name: svc.name,
      catalogId: svc.catalogId,
      icon: catalogById(svc.catalogId)?.icon,
      color: svc.color,
      initials: svc.initials,
      unread: svc.unread,
      muted: svc.notificationLevel === 'muted',
      mutedUntil: svc.mutedUntil ?? null,
      sleeping: svc.sleeping,
      ...(svc.meeting ? { meeting: svc.meeting } : {}),
    })
  );
  const focused = state.panes.find((pane) => pane.id === state.focusedPaneId);
  return {
    window: true,
    dnd: state.preferences.notifications.dnd,
    dndUntil: state.preferences.notifications.dndUntil,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map(({ id, name }) => ({ id, name })),
    services,
    focusedServiceId: focused?.serviceId ?? null,
    unreadTotal: services.reduce((sum, svc) => sum + svc.unread, 0),
  };
}

/**
 * The same picture with no window: settings only. Quiet periods as they stand *now*: with no
 * window there's no sweep to end a timed Do Not Disturb or mute, and the config says "on" after
 * its time is up — a Stream Deck key showed DND long after it had ended.
 */
export function controlStateFromConfig(config: Config, now = Date.now()): ControlState {
  const expired = expiredQuiet(config, now);
  const dnd = config.preferences.notifications.dnd && !expired.dnd;
  return {
    window: false,
    dnd,
    dndUntil: dnd ? config.preferences.notifications.dndUntil : null,
    activeWorkspaceId: config.activeWorkspaceId,
    workspaces: config.workspaces.map(({ id, name }) => ({ id, name })),
    services: config.services.map((svc) => ({
      id: svc.id,
      name: svc.name,
      catalogId: svc.catalogId,
      icon: catalogById(svc.catalogId)?.icon,
      unread: 0,
      muted: svc.notificationLevel === 'muted' && !expired.services.includes(svc.id),
      mutedUntil: expired.services.includes(svc.id) ? null : (svc.mutedUntil ?? null),
      sleeping: false,
    })),
    focusedServiceId: null,
    unreadTotal: 0,
  };
}

/** Longer than any command needs. A client that sends more without a newline is dropped. */
export const MAX_CONTROL_LINE = 16 * 1024;

export type ControlMessage = { ok: true; command: Command } | { ok: false; error: string };

/** One line from a client: `{"type":"command","command":{…}}`, shape-checked and allowlisted. */
export function readControlMessage(line: string): ControlMessage {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { ok: false, error: 'not an object' };
  }
  const { type, command } = message as { type?: unknown; command?: unknown };
  if (type !== 'command') return { ok: false, error: `unknown message ${String(type).slice(0, 40)}` };
  const problem = commandProblem(command);
  if (problem) return { ok: false, error: problem };
  const valid = command as Command;
  if (!CONTROL_COMMAND_TYPES.has(valid.type)) return { ok: false, error: `${valid.type} is not allowed here` };
  return { ok: true, command: valid };
}
