// Locks the Phase 1.1 regression: attachShortcuts used to be called from the focus path, so every
// focus added another before-input-event listener to the same webContents and one keypress
// dispatched N commands. It compounded silently, which is the worst kind of bug.
//
// shortcuts.ts imports only *types* from electron, so it bundles and runs under plain node.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachShortcuts, translate } from '@main/window/shortcuts';
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

const key = (k: string, mods: Partial<Input> = {}) =>
  ({ type: 'keyDown', key: k, meta: true, alt: false, ...mods }) as Input;

describe("listener registration", () => {

  const accept = () => true;

  it('attaching repeatedly to the same contents dispatches a command exactly once', () => {
    const wc = new FakeContents();
    const seen: Command[] = [];
    const sink = (c: Command) => (seen.push(c), true);

    // The old bug: openService re-attached on every focus.
    for (let i = 0; i < 5; i++) attachShortcuts(wc.asContents, sink);

    wc.press(key('\\'));
    assert.equal(seen.length, 1, `expected 1 command, got ${seen.length}`);
    assert.equal(seen[0].type, 'split');
  });

  it('separate contents each get their own listener', () => {
    const a = new FakeContents();
    const b = new FakeContents();
    const seen: Command[] = [];
    attachShortcuts(a.asContents, (c) => (seen.push(c), true));
    attachShortcuts(b.asContents, (c) => (seen.push(c), true));
    a.press(key('k'));
    b.press(key('k'));
    assert.equal(seen.length, 2);
  });

  it('a chord the sink handled is preventDefault-ed so the page never sees it', () => {
    const wc = new FakeContents();
    attachShortcuts(wc.asContents, accept);
    assert.equal(wc.press(key('k')).defaultPrevented, true);
  });

  it('an unrecognised chord passes through to the page', () => {
    const wc = new FakeContents();
    attachShortcuts(wc.asContents, accept);
    assert.equal(wc.press(key('j')).defaultPrevented, false);
  });

  it('a chord the sink DECLINED passes through — Escape must still close a web app dialog', () => {
    const wc = new FakeContents();
    attachShortcuts(wc.asContents, () => false); // e.g. Escape while no overlay is open
    const event = wc.press({ type: 'keyDown' as const, key: 'Escape', meta: false, alt: false });
    assert.equal(event.defaultPrevented, false);
  });
});

describe("chord translation", () => {

  it('bare keys and keyUp are ignored', () => {
    assert.equal(translate({ type: 'keyDown' as const, key: 'k', meta: false, alt: false } as Input), null);
    assert.equal(translate({ type: 'keyUp' as const, key: 'k', meta: true, alt: false } as Input), null);
  });

  it('bare Escape closes the overlay — bound everywhere, not just on the overlay itself', () => {
    // Binding this only to the overlay's contents left a blank overlay unclosable, because
    // before-input-event only fires for whichever contents holds focus.
    assert.deepEqual(translate({ type: 'keyDown' as const, key: 'Escape', meta: false, alt: false } as Input), {
      type: 'close-overlay',
    });
  });

  it('modified Escape is left alone', () => {
    assert.equal(translate({ type: 'keyDown' as const, key: 'Escape', meta: true, alt: false } as Input), null);
  });

  it('⌘1..9 and ⌘⌥1..9 resolve to different commands', () => {
    assert.deepEqual(translate(key('3')), { type: 'focus-service', serviceId: '#3' });
    assert.deepEqual(translate(key('3', { alt: true })), { type: 'set-workspace', workspaceId: '#3' });
  });

  it('⌘⌥arrows cycle panes in both directions', () => {
    assert.deepEqual(translate(key('arrowleft', { alt: true })), { type: 'cycle-pane', delta: -1 });
    assert.deepEqual(translate(key('arrowright', { alt: true })), { type: 'cycle-pane', delta: 1 });
  });

  it('⌘[ and ⌘] map to history navigation', () => {
    assert.deepEqual(translate(key('[')), { type: 'navigate', direction: 'back' });
    assert.deepEqual(translate(key(']')), { type: 'navigate', direction: 'forward' });
  });

  it('⌘W targets the focused pane rather than a literal id', () => {
    assert.deepEqual(translate(key('w')), { type: 'close-pane', paneId: '#focused' });
  });
});

// Seven of translate()'s fifteen chord branches had no test. Added alongside the Phase 3.5
// affordances but never asserted, so a stray edit to the key list would go unnoticed.
describe('the affordance chords', () => {
  const chord = (key, over = {}) => translate({ type: 'keyDown' as const, key, meta: true, ...over } as Input);

  it('⌘K opens the palette and ⌘F the find bar', () => {
    assert.deepEqual(chord('k'), { type: 'open-palette' });
    assert.deepEqual(chord('f'), { type: 'open-find' });
  });

  it('⌘P prints', () => {
    assert.deepEqual(chord('p'), { type: 'print' });
  });

  it('zoom covers both the shifted and unshifted plus key', () => {
    // '=' unshifted, '+' with shift — layouts differ and only handling one is a common miss.
    assert.deepEqual(chord('='), { type: 'zoom', direction: 'in' });
    assert.deepEqual(chord('+'), { type: 'zoom', direction: 'in' });
    assert.deepEqual(chord('-'), { type: 'zoom', direction: 'out' });
    assert.deepEqual(chord('0'), { type: 'zoom', direction: 'reset' });
  });

  it('⌘⌥0 is not a workspace — workspaces are 1-9 and there is no zeroth', () => {
    assert.equal(translate({ type: 'keyDown' as const, key: '0', meta: true, alt: true } as Input), null);
  });

  it('a bare key with no modifier is never a command', () => {
    for (const key of ['f', 'p', 'k', '0', '\\']) {
      assert.equal(translate({ type: 'keyDown' as const, key } as Input), null, key);
    }
  });

  it('keyUp is ignored — only keyDown dispatches', () => {
    assert.equal(translate({ type: 'keyUp' as const, key: 'f', meta: true } as Input), null);
  });
});
