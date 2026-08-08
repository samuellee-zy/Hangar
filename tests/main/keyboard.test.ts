// The keyboard model: what a chord is, which ones may be bound, and what a keystroke means.
//
// Both halves are pure — `shared/keyboard.ts` knows no platform and `core/keyboard/keymap.ts` knows
// no Electron — so all of this runs under plain node. That is the point of the split: the table
// that decides whether ⌘K reaches Slack is assertable without a window.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  chordFromInput,
  displayChord,
  formatChord,
  isChordShapeBindable,
  parseChord,
  toAccelerator,
} from '@shared/keyboard';
import {
  DEFAULT_BINDINGS,
  KEY_ACTIONS,
  PRIMARY_MODIFIER,
  RESERVED_CHORDS,
  actionForChord,
  conflicts,
  expandMod,
  isBindable,
  normalisePassthrough,
  primaryChord,
  rebind,
  resolvePassthrough,
  translate,
  type Bindings,
} from '@core/keyboard/keymap';

const shell = (bindings: Bindings = DEFAULT_BINDINGS) => ({ bindings, passthrough: [] });

/** A keystroke holding whichever modifier is primary here, so nothing below is macOS-only. */
const press = (key: string, mods: { alt?: boolean; shift?: boolean } = {}) => ({
  type: 'keyDown',
  key,
  meta: PRIMARY_MODIFIER === 'meta',
  control: PRIMARY_MODIFIER === 'ctrl',
  alt: Boolean(mods.alt),
  shift: Boolean(mods.shift),
});

describe('chords round-trip', () => {
  it('formats modifiers in one canonical order regardless of how they were written', () => {
    // A hand-edited config is allowed to say `meta+alt+k`; storage is not allowed to keep two
    // spellings of one chord, or `actionForChord` compares strings that never match.
    assert.equal(formatChord(parseChord('meta+alt+k')), 'alt+meta+k');
    assert.equal(formatChord(parseChord('alt+meta+k')), 'alt+meta+k');
  });

  it('a chord survives parse → format unchanged', () => {
    for (const text of ['meta+k', 'ctrl+shift+f', 'alt+meta+arrowleft', 'meta+\\', 'meta+[']) {
      assert.equal(formatChord(parseChord(text)), text, text);
    }
  });

  it('the plus key is not the separator', () => {
    // `meta++` splits to ['meta', '', ''] and nothing else does, which is the only reason this
    // parses at all.
    const chord = parseChord('meta++');
    // '+' aliases to '=', because they are one key.
    assert.deepEqual(chord, { key: '=', meta: true, ctrl: false, alt: false, shift: false });
  });

  it('shifted aliases collapse onto the unshifted key', () => {
    // ⌘+ and ⌘= are one gesture; handling only one is how zoom-in worked or didn't depending on
    // whether you happened to hold shift.
    assert.equal(formatChord(chordFromInput({ type: 'keyDown', key: '+', meta: true, shift: true })), 'meta+=');
    assert.equal(formatChord(chordFromInput({ type: 'keyDown', key: '|', meta: true, shift: true })), 'meta+\\');
  });

  it('rejects an unknown modifier rather than reading it as no modifier', () => {
    // `cmd+k` is a plausible hand-edit. Reading it as the bare key `k` would produce a binding
    // that fires on every keystroke in every text field.
    assert.equal(parseChord('cmd+k'), null);
    assert.equal(parseChord('meta+shft+k'), null);
  });

  it('is null for the empty string, a bare modifier and a key release', () => {
    assert.equal(parseChord(''), null);
    assert.equal(parseChord('meta+meta'), null);
    assert.equal(chordFromInput({ type: 'keyUp', key: 'k', meta: true }), null);
    assert.equal(chordFromInput({ type: 'keyDown', key: 'Meta', meta: true }), null);
  });
});

describe('what may be bound', () => {
  it('needs a command modifier', () => {
    assert.equal(isChordShapeBindable(parseChord('shift+k')), false);
    assert.equal(isBindable(parseChord('meta+j')), true);
  });

  it('refuses Escape, which is the way out of a broken overlay', () => {
    assert.equal(isBindable(parseChord('meta+escape')), false);
    assert.equal(isChordShapeBindable(parseChord('meta+escape')), false);
  });

  it('refuses what the menu bar already owns', () => {
    for (const chord of RESERVED_CHORDS) {
      assert.equal(isBindable(parseChord(chord)), false, chord);
    }
    // Binding one would produce a shortcut that silently never fires: the role's accelerator is
    // registered at the application level and outranks before-input-event.
    assert.ok(RESERVED_CHORDS.includes(primaryChord('q')));
  });

  it('refuses the positional families but not their shifted forms', () => {
    assert.equal(isBindable(parseChord(primaryChord('3'))), false);
    assert.equal(isBindable(parseChord(primaryChord('3', { alt: true }))), false);
    assert.equal(isBindable(parseChord(primaryChord('3', { shift: true }))), true);
  });
});

describe('the table', () => {
  it('has no duplicate ids and no default conflicts', () => {
    const ids = KEY_ACTIONS.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    // A shipped default that collides means one of two menu items silently does nothing.
    assert.deepEqual([...conflicts(DEFAULT_BINDINGS).keys()], []);
  });

  it('every default is a chord this platform will accept', () => {
    for (const action of KEY_ACTIONS) {
      if (!action.defaultChord) continue;
      assert.equal(isBindable(parseChord(action.defaultChord)), true, `${action.id}: ${action.defaultChord}`);
    }
  });

  it('ships one action with no chord, so the unbound state is a real rendered case', () => {
    assert.ok(KEY_ACTIONS.some((a) => a.defaultChord === ''));
  });

  it('every default renders as an accelerator the menu can display', () => {
    // '' is the caller's cue to omit the property; anything else must be a real accelerator, or
    // `Menu.buildFromTemplate` throws and the app boots with no menu at all.
    assert.equal(toAccelerator(''), '');
    assert.equal(toAccelerator('alt+meta+arrowleft'), 'Alt+Command+Left');
    assert.equal(toAccelerator('meta+\\'), 'Command+\\');
    for (const action of KEY_ACTIONS) {
      if (!action.defaultChord) continue;
      assert.notEqual(toAccelerator(action.defaultChord), '', action.id);
    }
  });
});

describe('rebinding', () => {
  it('unbinds the previous holder rather than refusing', () => {
    // Refusing means telling someone to go and clear a different row first. The displaced action
    // reads "Not bound", which is visible; two actions on one chord would not be.
    const next = rebind(DEFAULT_BINDINGS, 'find', DEFAULT_BINDINGS['palette']!);
    assert.equal(next['find'], DEFAULT_BINDINGS['palette']);
    assert.equal(next['palette'], '');
    assert.deepEqual([...conflicts(next).keys()], []);
  });

  it('canonicalises on the way in', () => {
    const next = rebind(DEFAULT_BINDINGS, 'palette', 'meta+alt+j');
    assert.equal(next['palette'], 'alt+meta+j');
  });

  it('null clears without touching anything else', () => {
    const next = rebind(DEFAULT_BINDINGS, 'palette', null);
    assert.equal(next['palette'], '');
    assert.equal(next['find'], DEFAULT_BINDINGS['find']);
  });

  it('is a no-op for an unknown action or an unbindable chord', () => {
    // Both arrive over IPC. A bad message must not produce a config that can't be typed into.
    assert.equal(rebind(DEFAULT_BINDINGS, 'not-an-action', 'meta+j'), DEFAULT_BINDINGS);
    assert.equal(rebind(DEFAULT_BINDINGS, 'palette', 'j'), DEFAULT_BINDINGS);
    assert.equal(rebind(DEFAULT_BINDINGS, 'palette', primaryChord('q')), DEFAULT_BINDINGS);
  });

  it('does not mutate the map it was given', () => {
    // DEFAULT_BINDINGS is a module-level constant. Mutating it would change the defaults for the
    // rest of the process — the exact bug `withDefaults` was fixed for once already.
    const before = { ...DEFAULT_BINDINGS };
    rebind(DEFAULT_BINDINGS, 'palette', 'meta+j');
    assert.deepEqual(DEFAULT_BINDINGS, before);
  });

  it('reports a conflict a hand-edited config can still hold', () => {
    const clashing = { ...DEFAULT_BINDINGS, find: DEFAULT_BINDINGS['palette']! };
    const found = conflicts(clashing);
    assert.deepEqual(found.get(DEFAULT_BINDINGS['palette']!), ['palette', 'find']);
    // Table order breaks the tie, so the answer doesn't depend on key insertion order.
    assert.equal(actionForChord(clashing, DEFAULT_BINDINGS['palette']!), 'palette');
  });
});

describe('translate', () => {
  it('dispatches a bound chord and ignores an unbound one', () => {
    assert.deepEqual(translate(press('k'), shell()), { type: 'open-palette' });
    assert.equal(translate(press('j'), shell()), null);
  });

  it('follows a rebind rather than the default', () => {
    const bindings = rebind(DEFAULT_BINDINGS, 'palette', primaryChord('j'));
    assert.deepEqual(translate(press('j'), shell(bindings)), { type: 'open-palette' });
    assert.equal(translate(press('k'), shell(bindings)), null);
  });

  it('leaves a passthrough chord to the page even though it is bound', () => {
    // The motivating case. Before this, Slack's own ⌘K switcher was unreachable from Hangar.
    const context = { bindings: DEFAULT_BINDINGS, passthrough: [primaryChord('k')] };
    assert.equal(translate(press('k'), context), null);
    // Only that one — everything else still belongs to the app.
    assert.deepEqual(translate(press('f'), context), { type: 'open-find' });
  });

  it('lets a binding beat the positional family it lands on', () => {
    // Bindings are matched before ⌘1–9, so an explicitly assigned ⌘⇧3 is not shadowed by "third
    // service" — which is why isBindable allows the shifted form.
    const bindings = rebind(DEFAULT_BINDINGS, 'split', primaryChord('3', { shift: true }));
    assert.deepEqual(translate(press('3', { shift: true }), shell(bindings)), { type: 'split' });
    assert.deepEqual(translate(press('3'), shell(bindings)), {
      type: 'focus-service',
      serviceId: '#3',
    });
  });

  it('bare Escape closes the overlay, and a modified one does not', () => {
    // Bound on every webContents, not just the overlay's: before-input-event fires only for
    // whichever contents holds focus, and binding it there alone left a blank overlay unclosable.
    assert.deepEqual(
      translate({ type: 'keyDown', key: 'Escape', meta: false, control: false, alt: false }, shell()),
      { type: 'close-overlay' }
    );
    assert.equal(translate({ type: 'keyDown', key: 'Escape', meta: true, alt: false }, shell()), null);
  });

  it('Escape is not overridable by a passthrough list', () => {
    // A service claiming Escape would have no way out of a broken overlay, which is the one thing
    // the keyboard layer must always be able to do.
    const context = { bindings: DEFAULT_BINDINGS, passthrough: ['escape'] };
    assert.deepEqual(
      translate({ type: 'keyDown', key: 'Escape', meta: false, control: false, alt: false }, context),
      { type: 'close-overlay' }
    );
  });

  it('⌘⌥1–9 are workspaces, ⌘0 is zoom, and ⌘⌥0 is neither', () => {
    assert.deepEqual(translate(press('3', { alt: true }), shell()), {
      type: 'set-workspace',
      workspaceId: '#3',
    });
    assert.deepEqual(translate(press('0'), shell()), { type: 'zoom', direction: 'reset' });
    assert.equal(translate(press('0', { alt: true }), shell()), null);
  });

  it('a bare key and a key release are never commands', () => {
    for (const key of ['f', 'p', 'k', '0', '\\']) {
      assert.equal(translate({ type: 'keyDown', key }, shell()), null, key);
    }
    assert.equal(translate({ ...press('k'), type: 'keyUp' }, shell()), null);
  });
});

describe('passthrough lists', () => {
  it('drops anything that would swallow ordinary typing', () => {
    // This list is consulted on every keystroke in a service. A bare 'k' in it would mean the
    // letter k never reaches the page.
    assert.deepEqual(normalisePassthrough(['meta+k', 'k', 'escape', 42, null]), ['meta+k']);
  });

  it('canonicalises and de-duplicates', () => {
    assert.deepEqual(normalisePassthrough(['meta+alt+k', 'alt+meta+k']), ['alt+meta+k']);
    assert.deepEqual(normalisePassthrough('not an array'), []);
  });

  it('may claim a reserved chord, unlike a binding', () => {
    // The reserved list stops *us* claiming what the menu owns. A page asking for the same chord
    // back is a different question, and refusing it here would be borrowing the wrong rule.
    assert.deepEqual(normalisePassthrough([primaryChord('q')]), [primaryChord('q')]);
  });

  it('expands the catalog placeholder to this platform', () => {
    // The catalog is bundled into the renderer, so it writes `mod+k` rather than asking a
    // `process.platform` it doesn't have.
    assert.equal(expandMod('mod+k'), primaryChord('k'));
    assert.equal(expandMod('meta+k'), 'meta+k');
    assert.deepEqual(resolvePassthrough(undefined, ['mod+k']), [primaryChord('k')]);
  });

  it('an empty stored list overrides the catalog, an absent one follows it', () => {
    // The distinction is the whole reason the field is optional: `[]` is "claim nothing", which
    // has to be expressible, and `undefined` is "whatever the catalog says today".
    assert.deepEqual(resolvePassthrough([], ['mod+k']), []);
    assert.deepEqual(resolvePassthrough(undefined, ['mod+k']), [primaryChord('k')]);
    assert.deepEqual(resolvePassthrough(['meta+j'], ['mod+k']), ['meta+j']);
  });
});

describe('display', () => {
  it('renders modifiers as symbols in the printed order', () => {
    assert.equal(displayChord('alt+meta+arrowleft'), '⌥⌘←');
    assert.equal(displayChord('ctrl+shift+k'), '⌃⇧K');
    assert.equal(displayChord('meta+\\'), '⌘\\');
  });

  it('is empty for anything that is not a chord, so a row can say so itself', () => {
    assert.equal(displayChord(''), '');
    // Same rule as parseChord: an unknown modifier is a typo, not a bare key called `cmd+k`.
    assert.equal(displayChord('cmd+k'), '');
  });
});
