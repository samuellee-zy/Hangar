// Locks the Phase 1.1 regression: attachShortcuts used to be called from the focus path, so every
// focus added another before-input-event listener to the same webContents and one keypress
// dispatched N commands. It compounded silently, which is the worst kind of bug.
//
// shortcuts.ts imports only *types* from electron, so it bundles and runs under plain node.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachShortcuts, translate } from '../../src/main/shortcuts';


// Minimal stand-in for a WebContents: attachShortcuts only ever calls .on('before-input-event').
class FakeContents extends EventEmitter {
  press(input) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('before-input-event', event, input);
    return event;
  }
}

const key = (k, mods = {}) => ({ type: 'keyDown', key: k, meta: true, alt: false, ...mods });

describe("listener registration", () => {

  const accept = () => true;

  it('attaching repeatedly to the same contents dispatches a command exactly once', () => {
    const wc = new FakeContents();
    const seen = [];
    const sink = (c) => (seen.push(c), true);

    // The old bug: openService re-attached on every focus.
    for (let i = 0; i < 5; i++) attachShortcuts(wc, sink);

    wc.press(key('\\'));
    assert.equal(seen.length, 1, `expected 1 command, got ${seen.length}`);
    assert.equal(seen[0].type, 'split');
  });

  it('separate contents each get their own listener', () => {
    const a = new FakeContents();
    const b = new FakeContents();
    const seen = [];
    attachShortcuts(a, (c) => (seen.push(c), true));
    attachShortcuts(b, (c) => (seen.push(c), true));
    a.press(key('k'));
    b.press(key('k'));
    assert.equal(seen.length, 2);
  });

  it('a chord the sink handled is preventDefault-ed so the page never sees it', () => {
    const wc = new FakeContents();
    attachShortcuts(wc, accept);
    assert.equal(wc.press(key('k')).defaultPrevented, true);
  });

  it('an unrecognised chord passes through to the page', () => {
    const wc = new FakeContents();
    attachShortcuts(wc, accept);
    assert.equal(wc.press(key('j')).defaultPrevented, false);
  });

  it('a chord the sink DECLINED passes through — Escape must still close a web app dialog', () => {
    const wc = new FakeContents();
    attachShortcuts(wc, () => false); // e.g. Escape while no overlay is open
    const event = wc.press({ type: 'keyDown', key: 'Escape', meta: false, alt: false });
    assert.equal(event.defaultPrevented, false);
  });
});

describe("chord translation", () => {

  it('bare keys and keyUp are ignored', () => {
    assert.equal(translate({ type: 'keyDown', key: 'k', meta: false, alt: false }), null);
    assert.equal(translate({ type: 'keyUp', key: 'k', meta: true, alt: false }), null);
  });

  it('bare Escape closes the overlay — bound everywhere, not just on the overlay itself', () => {
    // Binding this only to the overlay's contents left a blank overlay unclosable, because
    // before-input-event only fires for whichever contents holds focus.
    assert.deepEqual(translate({ type: 'keyDown', key: 'Escape', meta: false, alt: false }), {
      type: 'close-overlay',
    });
  });

  it('modified Escape is left alone', () => {
    assert.equal(translate({ type: 'keyDown', key: 'Escape', meta: true, alt: false }), null);
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
