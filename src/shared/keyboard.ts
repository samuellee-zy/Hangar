/**
 * What a chord *is*: parsing, canonical form, and how to draw one.
 *
 * In `shared/` rather than `core/` because both sides of the IPC boundary need it. Settings has to
 * turn a keypress into the same canonical string main will store, and has to render a stored one
 * back as `⌘⇧K` — and `renderer-is-sandboxed` forbids it importing core. The alternative was a
 * second copy of this in the renderer, which is exactly the duplication the keymap exists to end.
 *
 * Everything here is platform-free, deliberately: nothing in this file reads `process.platform`, so
 * it survives being bundled into a page where `process` doesn't exist. Which chords are *taken* is
 * a property of the host's menu bar and lives in `core/keyboard/keymap.ts`, main-side only.
 *
 * Chords are stored as a **string**, not as the object. `docs/preferences.md` promised the object
 * form and it was the wrong call for one specific reason: `withDefaults` merges a stored config
 * onto the defaults key by key, and an object leaf is merged *into* rather than replaced — so an
 * unbound action, which has to be storable, would come back holding whatever the default was. A
 * canonical string is a scalar, so `''` survives the merge, and it stays legible in a config file
 * people are expected to read and resolve merge conflicts in.
 */

export interface Chord {
  /** Lowercased, and normalised through `KEY_ALIASES`. */
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * The structural subset of Electron's `Input` this needs — and, not coincidentally, of the DOM's
 * `KeyboardEvent`, so the same function reads a keypress in main and in Settings. Note `control`,
 * which is what both of them call it.
 */
export interface KeyInput {
  type: string;
  key: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Canonical modifier order: ⌃⌥⇧⌘, matching how Apple prints them. */
export const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

export type Modifier = (typeof MODIFIER_ORDER)[number];

/**
 * Keys that are the *shifted* form of another key on a common layout.
 *
 * `⌘+` and `⌘=` are one gesture on most keyboards, and only handling one of them is the classic
 * miss — zoom-in worked or didn't depending on whether you happened to hold shift. Normalising the
 * key also clears `shift`, because the shift is what produced the alias in the first place; leaving
 * it set would make the two forms different chords again.
 */
const KEY_ALIASES: Record<string, string> = {
  '+': '=',
  _: '-',
  '{': '[',
  '}': ']',
  '|': '\\',
};

/** A modifier pressed alone is not a chord, however long you hold it. */
const MODIFIER_KEYS = new Set(['meta', 'control', 'alt', 'shift', 'capslock', 'dead']);

/** The canonical stored form: modifiers in ⌃⌥⇧⌘ order, then the key. `''` for no chord. */
export function formatChord(chord: Chord | null): string {
  if (!chord || !chord.key) return '';
  const parts = MODIFIER_ORDER.filter((name) => chord[name]);
  return [...parts, chord.key].join('+');
}

/**
 * The inverse. Returns null for anything that isn't a chord, including the empty string — an
 * unbound action and an unparseable one are the same thing to every caller.
 */
export function parseChord(text: string): Chord | null {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split('+');
  // `meta++` is ⌘ plus the plus key, and splits to ['meta', '', '']. Nothing else produces an
  // empty final part.
  const key = (parts.pop() || '+').toLowerCase();
  if (!key || MODIFIER_KEYS.has(key)) return null;
  // Modifier order is not enforced on the way in — a config people hand-edit and merge in git
  // should not fail over `meta+alt+k` — but anything that isn't a modifier at all is a typo, and
  // silently reading it as "no modifiers" would produce a binding that can never fire.
  const modifiers = new Set(parts.filter(Boolean));
  for (const part of modifiers) {
    if (!MODIFIER_ORDER.includes(part as Modifier)) return null;
  }
  return normalise({
    key,
    meta: modifiers.has('meta'),
    ctrl: modifiers.has('ctrl'),
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
  });
}

/** Applies the alias table. Every constructor in this file goes through it. */
function normalise(chord: Chord): Chord {
  const alias = KEY_ALIASES[chord.key];
  if (!alias) return chord;
  return { ...chord, key: alias, shift: false };
}

/**
 * A chord from a key event, or null if this event isn't one.
 *
 * `keyUp` is rejected here rather than by the caller, because a chord built from a key release is
 * indistinguishable from one built from the press and would fire every shortcut twice.
 */
export function chordFromInput(input: KeyInput): Chord | null {
  if (input.type !== 'keyDown') return null;
  const key = String(input.key ?? '').toLowerCase();
  if (!key || MODIFIER_KEYS.has(key)) return null;
  return normalise({
    key,
    meta: Boolean(input.meta),
    ctrl: Boolean(input.control),
    alt: Boolean(input.alt),
    shift: Boolean(input.shift),
  });
}

/**
 * The half of "may this be bound?" that holds everywhere.
 *
 * The command-modifier requirement is the important one: a binding with no ⌘ or ⌃ would swallow an
 * ordinary keystroke in every text field in every service. Escape is excluded because it is the
 * way out of an overlay whose renderer has failed, so it is not the user's to reassign.
 *
 * The platform-dependent half — the reserved list, the positional families — is `isBindable` in
 * `core/keyboard/keymap.ts`, which calls this first.
 */
export function isChordShapeBindable(chord: Chord | null): chord is Chord {
  if (!chord || !chord.key) return false;
  if (MODIFIER_KEYS.has(chord.key)) return false;
  if (!chord.meta && !chord.ctrl) return false;
  if (chord.key === 'escape') return false;
  return true;
}

const KEY_SYMBOLS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  enter: '↵',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  escape: 'Esc',
  ' ': 'Space',
};

/** For the UI: `alt+meta+arrowleft` → `⌥⌘←`. Never used for storage or comparison. */
export function displayChord(text: string): string {
  const chord = parseChord(text);
  if (!chord) return '';
  const key = KEY_SYMBOLS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return (
    (chord.ctrl ? '⌃' : '') +
    (chord.alt ? '⌥' : '') +
    (chord.shift ? '⇧' : '') +
    (chord.meta ? '⌘' : '') +
    key
  );
}

/**
 * Electron's accelerator spelling, for a menu item that only *displays* it.
 *
 * Returns '' for an unbound action, which is the caller's cue to omit the property entirely — an
 * empty `accelerator` string is not the same as no accelerator, and Electron treats it as invalid.
 */
export function toAccelerator(text: string): string {
  const chord = parseChord(text);
  if (!chord) return '';
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Control');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Command');
  parts.push(ACCELERATOR_KEYS[chord.key] ?? chord.key.toUpperCase());
  return parts.join('+');
}

/** Where Electron's accelerator names differ from a `KeyboardEvent.key`. */
const ACCELERATOR_KEYS: Record<string, string> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  enter: 'Return',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  ' ': 'Space',
  '+': 'Plus',
};
