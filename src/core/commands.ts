import type { Command } from '@shared/types';

/**
 * The shape of every command, checked where commands arrive from a renderer.
 *
 * `shell:command` answers only the app's own screens now (decision #97), but those are still a
 * separate process, and a malformed message used to reach `dispatch` as-is: a `focus-service`
 * without a `serviceId`, a `cycle-pane` with a `delta` of `"1"`. Each case did its own defensive
 * lookup, or didn't. This is the one place that says what a command is, and the `satisfies` below
 * makes a new command type without an entry here a compile error rather than an unchecked message.
 */

type Field =
  | 'string'
  | 'string?'
  | 'number'
  | 'boolean'
  | 'boolean?'
  | 'string|null'
  | 'number|null'
  | 'string[]'
  | 'string[]?'
  | 'object'
  | 'any'
  | readonly (string | number)[];

const SCHEMA = {
  'focus-service': { serviceId: 'string', keepFocus: 'boolean?' },
  'open-in-new-pane': { serviceId: 'string', keepFocus: 'boolean?' },
  'focus-pane': { paneId: 'string' },
  'close-pane': { paneId: 'string' },
  split: {},
  'cycle-pane': { delta: [-1, 1] },
  'set-workspace': { workspaceId: 'string' },
  navigate: { direction: ['back', 'forward'] },
  'open-palette': {},
  'open-shortcuts': {},
  'set-dnd': { on: 'boolean', until: 'number|null' },
  'mute-service': { serviceId: 'string', until: 'number|null' },
  'mark-read': { serviceId: 'string' },
  'mark-all-read': {},
  'focus-next-unread': {},
  'focus-previous-service': {},
  reveal: { what: ['config', 'log'] },
  'make-default-mail-app': {},
  'pop-out-service': { serviceId: 'string' },
  'toggle-maximise-pane': {},
  'reveal-download': { id: 'string' },
  'choose-folder': { purpose: ['downloads', 'sync'] },
  'move-to-workspace': { serviceId: 'string', workspaceId: 'string' },
  'open-connections': {},
  'close-overlay': {},
  'add-service': { catalogId: 'string', forceNewAccount: 'boolean?' },
  'add-custom-service': { name: 'string', url: 'string' },
  'rename-service': { serviceId: 'string', name: 'string' },
  'begin-rename-service': { serviceId: 'string' },
  'begin-rename-folder': { folderId: 'string' },
  'remove-service': { serviceId: 'string' },
  'rename-account': { accountId: 'string', label: 'string' },
  'sign-out-account': { accountId: 'string' },
  'open-settings': {},
  // `value` is validated against the preference schema by `setPreference`, which knows the types.
  'set-preference': { path: 'string', value: 'any' },
  'create-workspace': { name: 'string' },
  'rename-workspace': { workspaceId: 'string', name: 'string' },
  'delete-workspace': { workspaceId: 'string' },
  'reorder-workspaces': { workspaceIds: 'string[]' },
  'purge-orphan-partitions': {},
  'reveal-path': { path: 'string' },
  'sync-now': {},
  'resolve-sync': { winner: ['local', 'remote'] },
  'reset-preferences': { section: 'string?' },
  'open-find': {},
  'close-find': {},
  find: { query: 'string', forward: 'boolean?', findNext: 'boolean?' },
  zoom: { direction: ['in', 'out', 'reset'] },
  print: {},
  'reload-service': { serviceId: 'string', ignoreCache: 'boolean?' },
  'sleep-service': { serviceId: 'string' },
  'show-service-menu': { serviceId: 'string' },
  'show-rail-menu': {},
  'show-workspace-menu': {},
  'create-folder': { name: 'string', serviceIds: 'string[]?' },
  'rename-folder': { folderId: 'string', name: 'string' },
  'delete-folder': { folderId: 'string' },
  'toggle-folder': { folderId: 'string' },
  'move-to-folder': { serviceId: 'string', folderId: 'string|null' },
  'move-item': { activeId: 'string', overId: 'string' },
  'begin-tile-drag': { serviceId: 'string' },
  'drag-tile-to': { from: ['rail', 'content'], x: 'number', y: 'number' },
  'drop-tile': { from: ['rail', 'content'], x: 'number', y: 'number' },
  'cancel-tile-drag': {},
  'toggle-rail': {},
  rebind: { actionId: 'string', chord: 'string|null' },
  'show-folder-menu': { folderId: 'string' },
  'sleep-others': {},
  'show-window': {},
  'export-config': {},
  'import-config': {},
  // The patch itself is sanitised field by field in `sanitiseServicePatch`.
  'update-service': { serviceId: 'string', patch: 'object' },
} as const satisfies Record<Command['type'], Record<string, Field>>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fits(value: unknown, field: Field): boolean {
  if (Array.isArray(field)) return (field as readonly unknown[]).includes(value);
  switch (field) {
    case 'string':
      return typeof value === 'string';
    case 'string?':
      return value === undefined || typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'boolean?':
      return value === undefined || typeof value === 'boolean';
    case 'string|null':
      return value === null || typeof value === 'string';
    case 'number|null':
      return value === null || (typeof value === 'number' && Number.isFinite(value));
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'string[]?':
      return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
    case 'object':
      return isObject(value);
    case 'any':
      return true;
  }
  return false;
}

/** Why a message is not a command, or null when it is one. */
export function commandProblem(value: unknown): string | null {
  if (!isObject(value)) return 'not an object';
  const type = value['type'];
  if (typeof type !== 'string' || !Object.hasOwn(SCHEMA, type)) return `unknown type ${String(type).slice(0, 40)}`;
  const fields = SCHEMA[type as Command['type']] as Record<string, Field>;
  for (const [name, field] of Object.entries(fields)) {
    if (!fits(value[name], field)) return `${type}: bad ${name}`;
  }
  return null;
}

export const isCommand = (value: unknown): value is Command => commandProblem(value) === null;

/** Every command type there is. For the test that each one has a handler. */
export const commandTypes = (): Command['type'][] => Object.keys(SCHEMA) as Command['type'][];
