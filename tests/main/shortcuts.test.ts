// Locks the Phase 1.1 regression: attachShortcuts used to be called from the focus path, so every
// focus added another before-input-event listener to the same webContents and one keypress
// dispatched N commands. It compounded silently, which is the worst kind of bug.
//
// The chord table itself is tested in keyboard.test.ts. This file is only the wiring: one listener
// per contents, the right things swallowed, and the key context read fresh on every keystroke.
//
// shortcuts.ts imports only *types* from electron, so it bundles and runs under plain node.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachShortcuts } from '@main/window/shortcuts';
import { DEFAULT_BINDINGS, PRIMARY_MODIFIER, primaryChord, type KeyContext } from '@core/keyboard/keymap';
import type { Command } from '@shared/types';
import type { Input, WebContents } from 'electron';

/**
 * The fixtures below are deliberately partial — a `FakeContents` is not a `WebContents`, and a
 * `key()` is not a full Electron `Input`. Casting at the helper rather than at each call site puts
 * the "this is a stand-in" claim in one place.
 */
type AnyContents = WebContents;

// Minimal stand-in for a WebContents: attachShortcuts only ever calls .on('before-input-event').
class FakeContents extends EventEmitter {
  /**
   * `attachShortcuts` only ever calls `.on('before-input-event')`, so a full `WebContents` is not
   * needed — but the signature asks for one. Cast here rather than at each call site.
   */
  get asContents(): AnyContents {
    return this as unknown as AnyContents;
  }

  press(input: Partial<Input>) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('before-input-event', event, input);
    return event;
  }
}

/** Holds whichever modifier is primary here, so these assertions aren't macOS-only. */
const key = (k: string, mods: Partial<Input> = {}) =>
  ({
    type: 'keyDown',
    key: k,
    meta: PRIMARY_MODIFIER === 'meta',
    control: PRIMARY_MODIFIER === 'ctrl',
    alt: false,
    ...mods,
  }) as Input;

const shell = (): KeyContext => ({ bindings: DEFAULT_BINDINGS, passthrough: [] });

describe('listener registration', () => {
  const accept = () => true;

  it('attaching repeatedly to the same contents dispatches a command exactly once', () => {
    const wc = new FakeContents();
    const seen: Command[] = [];
    const sink = (c: Command) => (seen.push(c), true);

    // The old bug: openService re-attached on every focus.
    for (let i = 0; i < 5; i++) attachShortcuts(wc.asContents, sink, shell);

    wc.press(key('\\'));
    assert.equal(seen.length, 1, `expected 1 command, got ${seen.length}`);
    assert.equal(seen[0].type, 'split');
  });

  it('separate contents each get their own listener', () => {
    const a = new FakeContents();
    const b = new FakeContents();
    const seen: Command[] = [];
    attachShortcuts(a.asContents, (c) => (seen.push(c), true), shell);
    attachShortcuts(b.asContents, (c) => (seen.push(c), true), shell);
    a.press(key('k'));
    b.press(key('k'));
    assert.equal(seen.length, 2);
  });

  it('a chord the sink handled is preventDefault-ed so the page never sees it', () => {
    const wc = new FakeContents();
    attachShortcuts(wc.asContents, accept, shell);
    assert.equal(wc.press(key('k')).defaultPrevented, true);
  });

  it('an unrecognised chord passes through to the page', () => {
    const wc = new FakeContents();
    attachShortcuts(wc.asContents, accept, shell);
    assert.equal(wc.press(key('j')).defaultPrevented, false);
  });

  it('a chord the sink DECLINED passes through — Escape must still close a web app dialog', () => {
    const wc = new FakeContents();
    attachShortcuts(wc.asContents, () => false, shell); // e.g. Escape while no overlay is open
    const event = wc.press({ type: 'keyDown' as const, key: 'Escape', meta: false, alt: false });
    assert.equal(event.defaultPrevented, false);
  });
});

describe('the key context', () => {
  it('is read on every keystroke, so a rebind reaches views opened before it', () => {
    // The bug this forbids: capturing the context at attach time. A service view opened at launch
    // would keep the launch-time keymap for its whole life, and rebinding would appear to work
    // everywhere except in the app you were using.
    const wc = new FakeContents();
    const seen: Command[] = [];
    let bindings = { ...DEFAULT_BINDINGS };
    attachShortcuts(wc.asContents, (c) => (seen.push(c), true), () => ({
      bindings,
      passthrough: [],
    }));

    wc.press(key('k'));
    bindings = { ...bindings, palette: primaryChord('j') };
    wc.press(key('k'));
    wc.press(key('j'));

    assert.deepEqual(
      seen.map((c) => c.type),
      ['open-palette', 'open-palette'],
      'the second ⌘K should have stopped matching, and ⌘J started'
    );
  });

  it('a passthrough chord reaches the page instead of being swallowed', () => {
    const wc = new FakeContents();
    const seen: Command[] = [];
    attachShortcuts(wc.asContents, (c) => (seen.push(c), true), () => ({
      bindings: DEFAULT_BINDINGS,
      passthrough: [primaryChord('k')],
    }));

    // The whole feature: Slack's own switcher, previously unreachable.
    assert.equal(wc.press(key('k')).defaultPrevented, false);
    assert.deepEqual(seen, []);
  });
});
