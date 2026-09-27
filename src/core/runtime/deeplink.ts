import { tomorrowMorning } from '@shared/time';
import { flattenServiceIds } from '@core/workspace/folders';
import type { Command, Config, ServiceInstance, Workspace } from '@shared/types';

/**
 * `hangar://` links and the command-line flags that mean the same things — what Shortcuts, Raycast,
 * a Focus automation or a shell script uses to drive the app. See docs/automation.md.
 *
 * **Any page can open a link.** A `hangar://` URL can be clicked in a browser tab, in a mail, in a
 * note — anywhere but the services Hangar shows, which can't hand the OS a scheme like ours. So a link is never a `Command`: it is parsed into one of a
 * handful of verbs below, and only this module turns a verb into commands, from templates written
 * here. Nothing a link carries reaches `dispatch` except a name to look up. Removing a service,
 * importing a config, signing out, running a script — none has a verb, and adding one would be a
 * decision about who is allowed to do that, not a feature.
 *
 * The flags are rewritten as links and parsed once, so the two can't drift into different grammars.
 *
 * Pure — no Electron — so the grammar is testable under plain node.
 */

/** How long a mute or Do Not Disturb lasts: minutes, until tomorrow morning, or until turned off. */
export type Duration = { minutes: number } | 'tomorrow' | null;

export type LinkAction =
  | { verb: 'show' }
  | { verb: 'open'; service: string; newPane: boolean }
  | { verb: 'workspace'; workspace: string }
  | { verb: 'dnd'; on: boolean; duration: Duration }
  | { verb: 'mute'; service: string; duration: Duration }
  | { verb: 'unmute'; service: string }
  /** `service` null is every service. */
  | { verb: 'read'; service: string | null };

export const LINK_SCHEME = 'hangar';

/** Long enough for any name; short enough that nothing is ever parsed out of a pasted essay. */
const MAX_LINK_LENGTH = 2048;
/** A week. A mute for longer than that is a mute until you unmute it, which has its own form. */
const MAX_MINUTES = 7 * 24 * 60;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Whether a string is one of ours, before anything else is asked of it. */
export function isLink(text: string): boolean {
  return text.toLowerCase().startsWith(`${LINK_SCHEME}:`);
}

/**
 * `hangar://verb/target?option=…` → a verb.
 *
 * - `hangar://` or `hangar://show`: bring the window forward
 * - `hangar://open/<service>`, `?pane=new` to open it beside the focused pane
 * - `hangar://workspace/<workspace>`
 * - `hangar://dnd/on`, `hangar://dnd/off`, with `?for=<minutes>` or `?for=tomorrow`
 * - `hangar://mute/<service>`, the same `?for=`; without one, until it's unmuted
 * - `hangar://unmute/<service>`
 * - `hangar://read/<service>`, or `hangar://read/all`
 */
export function parseLink(link: string): Parsed<LinkAction> {
  if (link.length > MAX_LINK_LENGTH) return fail('the link is too long');
  if (!isLink(link)) return fail(`not a ${LINK_SCHEME}: link`);
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return fail('the link is malformed');
  }
  // `hangar://open/x` puts the verb in the host; `hangar:open/x` puts it in the path. Both, then.
  const segments = `${url.host}${url.pathname}`.split('/').filter(Boolean);
  const [rawVerb = 'show', ...rest] = segments;
  let target: string;
  try {
    target = decodeURIComponent(rest.join('/')).trim();
  } catch {
    return fail('the link is malformed');
  }
  const verb = rawVerb.toLowerCase();
  const option = (name: string) => url.searchParams.get(name)?.trim() ?? null;
  const needs = (what: string): Parsed<never> | null => (target ? null : fail(`${verb} needs a ${what}`));

  switch (verb) {
    case 'show':
      return { ok: true, value: { verb: 'show' } };
    case 'open':
      return needs('service') ?? { ok: true, value: { verb: 'open', service: target, newPane: option('pane') === 'new' } };
    case 'workspace':
      return needs('workspace') ?? { ok: true, value: { verb: 'workspace', workspace: target } };
    case 'dnd': {
      const state = target.toLowerCase();
      if (state !== 'on' && state !== 'off') return fail('dnd is on or off');
      const duration = parseDuration(option('for'));
      if (!duration.ok) return duration;
      return { ok: true, value: { verb: 'dnd', on: state === 'on', duration: duration.value } };
    }
    case 'mute': {
      const missing = needs('service');
      if (missing) return missing;
      const duration = parseDuration(option('for'));
      if (!duration.ok) return duration;
      return { ok: true, value: { verb: 'mute', service: target, duration: duration.value } };
    }
    case 'unmute':
      return needs('service') ?? { ok: true, value: { verb: 'unmute', service: target } };
    case 'read':
      return (
        needs('service, or all') ?? {
          ok: true,
          value: { verb: 'read', service: target.toLowerCase() === 'all' ? null : target },
        }
      );
    default:
      return fail(`there is no "${verb}" — see docs/automation.md for what a link can do`);
  }
}

function parseDuration(raw: string | null): Parsed<Duration> {
  if (raw === null || raw === '') return { ok: true, value: null };
  if (raw.toLowerCase() === 'tomorrow') return { ok: true, value: 'tomorrow' };
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    return fail(`"for" is a whole number of minutes, 1 to ${MAX_MINUTES}, or "tomorrow"`);
  }
  return { ok: true, value: { minutes } };
}

/**
 * The command line, rewritten as links. Anything that isn't ours is skipped rather than refused:
 * this is the whole argv, and Chromium and macOS put their own switches in it.
 *
 * `--open <service>` (`--new-pane` beside the focused one), `--workspace <workspace>`,
 * `--dnd on|off`, `--mute <service>`, `--unmute <service>`, `--mark-read <service|all>`, with
 * `--for <minutes|tomorrow>` after a `--dnd on` or a `--mute`. A `hangar://` link on its own is taken
 * as it is. `--flag=value` works as well as `--flag value`.
 */
export function linksFromArgv(argv: readonly string[]): string[] {
  const args = argv.flatMap((arg) => {
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg];
  });
  const links: string[] = [];
  // The link being built: a verb flag starts one, and `--for` / `--new-pane` add to it.
  let current: { path: string; params: URLSearchParams } | null = null;
  const flush = () => {
    if (!current) return;
    const query = current.params.toString();
    links.push(`${LINK_SCHEME}://${current.path}${query ? `?${query}` : ''}`);
    current = null;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? next : null;
    const verb = Object.hasOwn(VERB_FLAGS, arg) ? VERB_FLAGS[arg] : undefined;
    if (isLink(arg)) {
      flush();
      links.push(arg);
    } else if (verb && value !== null) {
      flush();
      current = { path: `${verb}/${encodeURIComponent(value)}`, params: new URLSearchParams() };
      i++;
    } else if (arg === '--new-pane') {
      current?.params.set('pane', 'new');
    } else if (arg === '--for' && value !== null) {
      current?.params.set('for', value);
      i++;
    }
  }
  flush();
  return links;
}

const VERB_FLAGS: Readonly<Record<string, string>> = {
  '--open': 'open',
  '--workspace': 'workspace',
  '--dnd': 'dnd',
  '--mute': 'mute',
  '--unmute': 'unmute',
  '--mark-read': 'read',
};

/**
 * A service by what someone would type: its id, then its name, then which catalog entry it is.
 *
 * The name before the catalog id, because the name is the one the user chose: with two Gmails,
 * "gmail" is either, and "Work mail" is the one they renamed. Case doesn't matter. A tie goes to the
 * one higher in the rail — this workspace's first, then the others' — not to whichever was added
 * first, which is what the order of `services` is.
 */
export function findService(config: Config, name: string): ServiceInstance | undefined {
  const lower = name.toLowerCase();
  const byId = new Map(config.services.map((s) => [s.id, s]));
  const workspaces = [
    ...config.workspaces.filter((w) => w.id === config.activeWorkspaceId),
    ...config.workspaces.filter((w) => w.id !== config.activeWorkspaceId),
  ];
  const inRail = workspaces.flatMap((w) => flattenServiceIds(w)).flatMap((id) => byId.get(id) ?? []);
  const ordered = [...new Set([...inRail, ...config.services])];
  return (
    ordered.find((s) => s.id.toLowerCase() === lower) ??
    ordered.find((s) => s.name.toLowerCase() === lower) ??
    ordered.find((s) => s.catalogId.toLowerCase() === lower)
  );
}

/** A workspace by id, then name, then its place in the switcher: `workspace/2` is the second. */
export function findWorkspace(config: Config, name: string): Workspace | undefined {
  const lower = name.toLowerCase();
  const byPlace = /^[1-9]\d*$/.test(name) ? config.workspaces[Number(name) - 1] : undefined;
  return (
    config.workspaces.find((w) => w.id === name) ??
    config.workspaces.find((w) => w.name.toLowerCase() === lower) ??
    byPlace
  );
}

/**
 * What a verb does, as commands — the only place a link becomes one. `show` says whether to bring
 * the window forward: opening something is asking to see it, but a Focus automation turning Do Not
 * Disturb on in the background is not.
 */
export function commandsFor(
  action: LinkAction,
  config: Config,
  now: number,
): Parsed<{ commands: Command[]; show: boolean }> {
  const until = (duration: Duration): number | null =>
    duration === null ? null : duration === 'tomorrow' ? tomorrowMorning(now) : now + duration.minutes * 60_000;
  const service = (name: string) => {
    const svc = findService(config, name);
    return svc ? { ok: true as const, svc } : fail(`no service is called "${name}"`);
  };
  const done = (commands: Command[], show = false) => ({ ok: true as const, value: { commands, show } });

  switch (action.verb) {
    case 'show':
      return done([], true);
    case 'open': {
      const found = service(action.service);
      if (!found.ok) return found;
      const serviceId = found.svc.id;
      return done([action.newPane ? { type: 'open-in-new-pane', serviceId } : { type: 'focus-service', serviceId }], true);
    }
    case 'workspace': {
      const workspace = findWorkspace(config, action.workspace);
      if (!workspace) return fail(`no workspace is called "${action.workspace}"`);
      return done([{ type: 'set-workspace', workspaceId: workspace.id }], true);
    }
    case 'dnd':
      return done([{ type: 'set-dnd', on: action.on, until: action.on ? until(action.duration) : null }]);
    case 'mute': {
      const found = service(action.service);
      if (!found.ok) return found;
      const serviceId = found.svc.id;
      const at = until(action.duration);
      // Until unmuted is the tile menu's "Until I unmute it": the level alone, with no timer to lift
      // it. A fixed patch, written here — nothing from the link is in it.
      return done([
        at === null
          ? { type: 'update-service', serviceId, patch: { notificationLevel: 'muted' } }
          : { type: 'mute-service', serviceId, until: at },
      ]);
    }
    case 'unmute': {
      const found = service(action.service);
      if (!found.ok) return found;
      return done([{ type: 'mute-service', serviceId: found.svc.id, until: null }]);
    }
    case 'read': {
      if (action.service === null) return done([{ type: 'mark-all-read' }]);
      const found = service(action.service);
      if (!found.ok) return found;
      return done([{ type: 'mark-read', serviceId: found.svc.id }]);
    }
  }
}

/** The command types a link can produce, and no others. Tested against every verb. */
export const LINK_COMMAND_TYPES: ReadonlySet<Command['type']> = new Set([
  'focus-service',
  'open-in-new-pane',
  'set-workspace',
  'set-dnd',
  'mute-service',
  'update-service',
  'mark-read',
  'mark-all-read',
]);

/** Parse and resolve in one: a link in, commands out, or why not. */
export function resolveLink(link: string, config: Config, now: number): Parsed<{ commands: Command[]; show: boolean }> {
  const parsed = parseLink(link);
  return parsed.ok ? commandsFor(parsed.value, config, now) : parsed;
}
