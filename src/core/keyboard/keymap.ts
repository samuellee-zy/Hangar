import {
  chordFromInput,
  formatChord,
  isChordShapeBindable,
  parseChord,
  type Chord,
  type KeyInput,
} from '@shared/keyboard';
import type { Command } from '@shared/types';

/**
 * The key map: one table, read by three things that used to each hold their own copy.
 *
 * `translate` matched chords in main, `boot/menu.ts` declared accelerators for the same actions,
 * and Settings listed them a third time as static strings. Three copies of one fact, and nothing
 * tying them together — the Settings list was already wrong about ⌘F and ⌘P, which it simply never
 * mentioned.
 *
 * Collapsing them is not tidying. **Rebinding is impossible while a second copy exists**: an
 * accelerator registered by the menu fires at the application level, so a rebound ⌘K would keep
 * opening the palette from the menu's copy no matter what this file decided. The menu now declares
 * its items with `registerAccelerator: false` — displayed, not registered — which leaves
 * `before-input-event` as the only thing that dispatches a shortcut, and this table as the only
 * thing that says which.
 *
 * ## What is not in the table
 *
 * - **Escape.** Bound everywhere and unconditionally: it is the way out of an overlay whose
 *   renderer has failed, so it is not a preference.
 * - **⌘1–9 and ⌘⌥1–9.** Positional families — nine chords meaning "the nth thing" — which a
 *   one-chord-per-action table cannot express, and which nothing has asked to move.
 */

/**
 * ⌘ on macOS, Ctrl elsewhere — the `CmdOrCtrl` the menu accelerators used to spell out.
 *
 * A single constant rather than a branch at every comparison, because the defaults, the reserved
 * list and the positional families all need the same answer, and three copies of that ternary is
 * three chances to write one of them backwards.
 *
 * `process.platform` is node, not Electron, so this stays inside the `core-is-electron-free`
 * boundary. It is also why the chord primitives live in `shared/`: this line would throw in a page.
 */
export const PRIMARY_MODIFIER: 'meta' | 'ctrl' = process.platform === 'darwin' ? 'meta' : 'ctrl';

/** A canonical chord string built from the primary modifier plus whatever else is held. */
export function primaryChord(key: string, extra: { alt?: boolean; shift?: boolean } = {}): string {
  return formatChord({
    key,
    meta: PRIMARY_MODIFIER === 'meta',
    ctrl: PRIMARY_MODIFIER === 'ctrl',
    alt: Boolean(extra.alt),
    shift: Boolean(extra.shift),
  });
}

/** Whether a chord carries the primary modifier and, of the two command modifiers, only it. */
export function hasPrimary(chord: Chord): boolean {
  return PRIMARY_MODIFIER === 'meta' ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta;
}

/**
 * Chords that cannot be bound, and why each one is here.
 *
 * All of these belong to `role`-based menu items, and roles keep their real accelerators — only our
 * own items drop accelerator *registration* (see `boot/menu.ts`). Binding an action to one would
 * produce a shortcut that silently never fires, which is worse than refusing it.
 */
export const RESERVED_CHORDS: readonly string[] = [
  primaryChord('q'), // quit
  primaryChord('m'), // minimize
  primaryChord('h'), // hide
  primaryChord('h', { shift: true }), // hide others
  primaryChord('c'),
  primaryChord('v'),
  primaryChord('x'),
  primaryChord('a'),
  primaryChord('z'),
  primaryChord('z', { shift: true }), // redo
  primaryChord('tab'), // the system's, not ours
  primaryChord('`'),
];

const RESERVED = new Set(RESERVED_CHORDS);

/** Whether this chord may be assigned to an action here, on this platform. */
export function isBindable(chord: Chord | null): chord is Chord {
  if (!isChordShapeBindable(chord)) return false;
  if (RESERVED.has(formatChord(chord))) return false;
  // ⌘1–9 and ⌘⌥1–9 are positional families rather than single actions: nine chords that mean "the
  // nth thing", which is not something a one-chord binding can express.
  if (/^[1-9]$/.test(chord.key) && hasPrimary(chord) && !chord.shift) return false;
  return true;
}

export type ActionId =
  | 'shortcuts'
  | 'palette'
  | 'add-connection'
  | 'settings'
  | 'find'
  | 'print'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'split'
  | 'maximise-pane'
  | 'close-pane'
  | 'focus-prev-pane'
  | 'focus-next-pane'
  | 'back'
  | 'forward'
  | 'reload'
  | 'hard-reload'
  | 'next-unread'
  | 'previous-service'
  | 'mark-all-read'
  | 'sleep-others';

export interface KeyAction {
  id: ActionId;
  /** Shown in Settings and used as the menu item's label, so the two can't drift. */
  label: string;
  command: Command;
  /** Which menu this action appears under, or null to keep it out of the menu bar. */
  menu: 'app' | 'file' | 'view' | null;
  /** A separator is drawn above this item. Purely the menu's business; Settings ignores it. */
  group?: boolean;
  defaultChord: string;
}

/** Order is load-bearing twice over: it is the menu's order, and it breaks ties on a conflict. */
export const KEY_ACTIONS: readonly KeyAction[] = [
  {
    id: 'settings',
    label: 'Settings…',
    command: { type: 'open-settings' },
    menu: 'app',
    defaultChord: primaryChord(','),
  },
  // A sheet of every shortcut, read from the live keymap — so it can't advertise a chord you have
  // since moved, which the hard-coded hints around the app did.
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    command: { type: 'open-shortcuts' },
    menu: 'app',
    defaultChord: primaryChord('/'),
  },
  {
    id: 'add-connection',
    label: 'Add connection…',
    command: { type: 'open-connections' },
    menu: 'file',
    defaultChord: primaryChord('n'),
  },
  {
    id: 'print',
    label: 'Print…',
    command: { type: 'print' },
    menu: 'file',
    group: true,
    defaultChord: primaryChord('p'),
  },
  {
    id: 'close-pane',
    label: 'Close pane',
    command: { type: 'close-pane', paneId: '#focused' },
    menu: 'file',
    group: true,
    defaultChord: primaryChord('w'),
  },
  {
    id: 'palette',
    label: 'Command palette',
    command: { type: 'open-palette' },
    menu: 'view',
    defaultChord: primaryChord('k'),
  },
  {
    id: 'find',
    label: 'Find in page…',
    command: { type: 'open-find' },
    menu: 'view',
    defaultChord: primaryChord('f'),
  },
  {
    id: 'zoom-in',
    label: 'Zoom in',
    command: { type: 'zoom', direction: 'in' },
    menu: 'view',
    group: true,
    defaultChord: primaryChord('='),
  },
  {
    id: 'zoom-out',
    label: 'Zoom out',
    command: { type: 'zoom', direction: 'out' },
    menu: 'view',
    defaultChord: primaryChord('-'),
  },
  {
    id: 'zoom-reset',
    label: 'Actual size',
    command: { type: 'zoom', direction: 'reset' },
    menu: 'view',
    defaultChord: primaryChord('0'),
  },
  {
    id: 'split',
    label: 'Split pane',
    command: { type: 'split' },
    menu: 'view',
    group: true,
    defaultChord: primaryChord('\\'),
  },
  {
    id: 'maximise-pane',
    label: 'Maximise pane',
    command: { type: 'toggle-maximise-pane' },
    menu: 'view',
    defaultChord: primaryChord('enter', { shift: true }),
  },
  {
    id: 'focus-prev-pane',
    label: 'Focus previous pane',
    command: { type: 'cycle-pane', delta: -1 },
    menu: 'view',
    defaultChord: primaryChord('arrowleft', { alt: true }),
  },
  {
    id: 'focus-next-pane',
    label: 'Focus next pane',
    command: { type: 'cycle-pane', delta: 1 },
    menu: 'view',
    defaultChord: primaryChord('arrowright', { alt: true }),
  },
  {
    id: 'back',
    label: 'Back',
    command: { type: 'navigate', direction: 'back' },
    menu: 'view',
    group: true,
    defaultChord: primaryChord('['),
  },
  {
    id: 'forward',
    label: 'Forward',
    command: { type: 'navigate', direction: 'forward' },
    menu: 'view',
    defaultChord: primaryChord(']'),
  },
  // ⌘R did nothing: a pane is not a browser tab, so nothing gave it the chord every browser does,
  // and the only way to reload a stuck page was its right-click menu.
  {
    id: 'reload',
    label: 'Reload page',
    command: { type: 'reload-service', serviceId: '#focused' },
    menu: 'view',
    defaultChord: primaryChord('r'),
  },
  {
    id: 'hard-reload',
    label: 'Reload page, ignoring the cache',
    command: { type: 'reload-service', serviceId: '#focused', ignoreCache: true },
    menu: 'view',
    defaultChord: primaryChord('r', { shift: true }),
  },
  // Walks on through everything waiting: each press goes to the next service with unread after the
  // focused one, across workspaces.
  {
    id: 'next-unread',
    label: 'Next service with unread',
    command: { type: 'focus-next-unread' },
    menu: 'view',
    group: true,
    defaultChord: primaryChord('u', { shift: true }),
  },
  // ⌃Tab, the browser's "other tab": back to the service used before this one. ⌘Tab is the
  // system's (RESERVED_CHORDS), and ⌃Tab is free in every service we ship.
  {
    id: 'previous-service',
    label: 'Previous service',
    command: { type: 'focus-previous-service' },
    menu: 'view',
    defaultChord: 'ctrl+tab',
  },
  {
    id: 'mark-all-read',
    label: 'Mark all as read',
    command: { type: 'mark-all-read' },
    menu: 'view',
    defaultChord: '',
  },
  // No default chord. It's a real action, it belongs in the menu, and there is no obvious key for
  // it — which is exactly the case rebinding exists to serve.
  {
    id: 'sleep-others',
    label: 'Sleep background services',
    command: { type: 'sleep-others' },
    menu: 'view',
    group: true,
    defaultChord: '',
  },
];

/** Action id → canonical chord, or `''` for unbound. */
export type Bindings = Record<string, string>;

export const DEFAULT_BINDINGS: Bindings = Object.fromEntries(
  KEY_ACTIONS.map((action) => [action.id, action.defaultChord])
);

const ACTION_BY_ID = new Map(KEY_ACTIONS.map((action) => [action.id as string, action]));

export const actionById = (id: string): KeyAction | undefined => ACTION_BY_ID.get(id);

/**
 * Which action owns a chord.
 *
 * Iterates `KEY_ACTIONS` rather than the bindings object so the answer is stable: a stored config
 * can hold a conflict — it was hand-edited, or it arrived through config sync from a build with
 * different defaults — and "whichever key `Object.entries` happened to yield first" is not an
 * acceptable way to decide which of two shortcuts works today and which works tomorrow.
 */
export function actionForChord(bindings: Bindings, chord: string): ActionId | null {
  if (!chord) return null;
  for (const action of KEY_ACTIONS) {
    if (bindings[action.id] === chord) return action.id;
  }
  return null;
}

/**
 * Actions sharing a chord, keyed by chord. Surfaced in Settings rather than prevented in the store:
 * `rebind` cannot produce one, but a synced or hand-edited config can, and a config that renders as
 * "one of these two shortcuts silently does nothing" is worse than one that says so.
 */
export function conflicts(bindings: Bindings): Map<string, ActionId[]> {
  const byChord = new Map<string, ActionId[]>();
  for (const action of KEY_ACTIONS) {
    const chord = bindings[action.id];
    if (!chord) continue;
    byChord.set(chord, [...(byChord.get(chord) ?? []), action.id]);
  }
  for (const [chord, actions] of byChord) if (actions.length < 2) byChord.delete(chord);
  return byChord;
}

/**
 * Assigns a chord to an action, or clears it with `null`.
 *
 * **The previous holder is unbound**, rather than the assignment being refused. Refusing means
 * telling someone to go and clear a different row first, and displacing is what every shortcut
 * editor people already use does. The displaced action then reads "Not bound", which is visible;
 * two actions quietly sharing one chord would not be.
 *
 * Returns the input unchanged when the action is unknown or the chord isn't bindable — this is fed
 * by IPC, and a bad message should be a no-op rather than a config that can't be typed into.
 */
export function rebind(bindings: Bindings, actionId: string, chord: string | null): Bindings {
  if (!ACTION_BY_ID.has(actionId)) return bindings;
  if (chord === null || chord === '') return { ...bindings, [actionId]: '' };

  const parsed = parseChord(chord);
  if (!isBindable(parsed)) return bindings;
  const canonical = formatChord(parsed);

  const next: Bindings = { ...bindings };
  for (const action of KEY_ACTIONS) {
    if (next[action.id] === canonical) next[action.id] = '';
  }
  next[actionId] = canonical;
  return next;
}

/**
 * Chords a service keeps for itself.
 *
 * ⌘K is the motivating case: Hangar intercepts it before the page, so Slack's own switcher was
 * simply unreachable — the shortcut existed, was documented by Slack, and did the wrong thing.
 * Validated here because it arrives over IPC and lands in the path every keystroke takes.
 */
export function normalisePassthrough(chords: unknown): string[] {
  if (!Array.isArray(chords)) return [];
  const out: string[] = [];
  for (const entry of chords) {
    if (typeof entry !== 'string') continue;
    const parsed = parseChord(entry);
    // The shape rule, not the full `isBindable`: a service may reasonably want ⌘Q-adjacent chords
    // back, and the reserved list exists to stop *us* claiming what the menu already owns. What it
    // may not have is a bare keystroke, which would be every keypress in the app.
    if (!isChordShapeBindable(parsed)) continue;
    const canonical = formatChord(parsed);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Expands the catalog's `mod` placeholder to this platform's primary modifier.
 *
 * The catalog is bundled into the renderer, so it cannot ask `process.platform` — but a web app's
 * own ⌘K is Ctrl+K on Linux exactly as ours is, so a hard-coded `meta+k` there would be a
 * passthrough that never matches on half the platforms we build for.
 */
export function expandMod(text: string): string {
  return typeof text === 'string' && text.startsWith('mod+')
    ? `${PRIMARY_MODIFIER}+${text.slice(4)}`
    : text;
}

/**
 * A service's effective passthrough list: its own if it has one, else the catalog's.
 *
 * Override rather than merge, so "Slack should not keep ⌘K after all" is expressible. `undefined`
 * means "follow the catalog"; `[]` means "claim nothing", and the two have to stay distinct.
 */
export function resolvePassthrough(
  stored: string[] | undefined,
  fromCatalog: string[] | undefined
): string[] {
  const source = stored ?? fromCatalog ?? [];
  return normalisePassthrough(Array.isArray(source) ? source.map(expandMod) : source);
}

/** Everything `translate` needs that isn't the keystroke. */
export interface KeyContext {
  bindings: Bindings;
  /** Canonical chords this surface's service has claimed. Empty for the shell's own renderers. */
  passthrough: readonly string[];
}

/**
 * A keystroke to a command, or null to leave it to the page.
 *
 * Order matters and is the whole feature:
 *
 *  1. **Escape**, unconditionally — see the module comment.
 *  2. **Passthrough**, before anything else, so a service can take a chord back from the app.
 *  3. **Bindings**, so a rebind beats the default that used to hold the chord.
 *  4. **The positional families**, last, so binding an action to ⌘⌥3 wins over "third workspace"
 *     rather than being shadowed by it.
 */
export function translate(input: KeyInput, context: KeyContext): Command | null {
  if (input.type !== 'keyDown') return null;

  // Bare Escape only. Bound on *every* webContents rather than the overlay's, because
  // `before-input-event` fires only for whichever contents holds focus and the overlay does not
  // reliably win focus from a service view — binding it there alone left a blank overlay with no
  // way out.
  if (input.key === 'Escape' && !input.meta && !input.control && !input.alt) {
    return { type: 'close-overlay' };
  }

  const chord = chordFromInput(input);
  if (!chord) return null;
  const text = formatChord(chord);

  if (context.passthrough.includes(text)) return null;

  const action = actionForChord(context.bindings, text);
  if (action) return ACTION_BY_ID.get(action)!.command;

  return positional(chord);
}

/** ⌘1–9 and ⌘⌥1–9. Resolved to real ids by the caller, which knows the lists. */
function positional(chord: Chord): Command | null {
  if (!hasPrimary(chord) || chord.shift) return null;
  const n = Number(chord.key);
  if (!Number.isInteger(n) || n < 1 || n > 9) return null;
  return chord.alt
    ? { type: 'set-workspace', workspaceId: `#${n}` }
    : { type: 'focus-service', serviceId: `#${n}` };
}
