// Surviving a terminal that went away, and a renderer that went away.
//
// Both of these were found the same way: the app died overnight with `Error: write EPIPE` and a
// stack that ran through Electron's own `console.error`. Neither module had a single test, and both
// are the kind that only ever run when something else has already gone wrong — so the failure path
// is the whole point here, and the happy path is the cheap part.

import { describe, it, expect, vi } from 'vitest';
import { guardWrites, isBrokenPipe, type Writer } from '@main/platform/logging';
import { safeSend } from '@main/platform/safe-send';

const errno = (code: string) => Object.assign(new Error(code), { code });

/** Enough of a WebContents for `safeSend`. Anything it touches, and nothing it doesn't. */
function fakeContents({
  destroyed = false,
  frame = { isDestroyed: () => false, send: vi.fn() } as unknown,
  frameThrows = false,
} = {}) {
  const send = vi.fn();
  const wc = {
    isDestroyed: () => destroyed,
    send,
    get mainFrame() {
      if (frameThrows) throw new Error('Render frame was disposed');
      return frame;
    },
  };
  return { wc: wc as unknown as Electron.WebContents, send };
}

describe('recognising a pipe with nobody on the other end', () => {

  it('spots the codes a dead stdout actually reports', () => {
    for (const code of ['EPIPE', 'EIO', 'EBADF', 'ERR_STREAM_DESTROYED']) {
      expect(isBrokenPipe(errno(code)), code).toBe(true);
    }
  });

  it('does not mistake an ordinary failure for one', () => {
    // The whole design rests on this line: anything matching here gets silently swallowed, so a
    // false positive is a real bug that disappears.
    expect(isBrokenPipe(new Error('boom'))).toBe(false);
    expect(isBrokenPipe(errno('ENOENT'))).toBe(false);
    expect(isBrokenPipe(null)).toBe(false);
    expect(isBrokenPipe('EPIPE')).toBe(false);
  });
});

describe('a console that gives up rather than taking the app with it', () => {

  it('stops writing once the pipe breaks, instead of throwing', () => {
    let writes = 0;
    const target: Writer = {
      log: () => {
        writes++;
        throw errno('EPIPE');
      },
      warn: () => {},
      error: () => {},
    };

    const guard = guardWrites(target);
    expect(() => target.log('first')).not.toThrow();
    expect(guard.muted()).toBe(true);

    // The point of muting: the 60-second persistence loop keeps calling this forever, and every one
    // of those calls was previously a chance to kill the process.
    target.log('second');
    target.log('third');
    expect(writes, 'only the write that discovered the break should have been attempted').toBe(1);
  });

  it('mutes every level, not just the one that failed', () => {
    // Held before wrapping: `guardWrites` replaces the methods, so `target.warn` afterwards is the
    // wrapper rather than the spy.
    const warn = vi.fn();
    const error = vi.fn();
    const target: Writer = {
      log: () => {
        throw errno('EPIPE');
      },
      warn,
      error,
    };

    guardWrites(target);
    target.log('breaks it');
    target.warn('quiet now');
    target.error('quiet too');

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('still throws anything that is not a broken pipe', () => {
    // A console that swallowed everything would hide bugs in whatever was being logged — a circular
    // structure, a getter that throws. Only the one condition is special.
    const target: Writer = {
      log: () => {
        throw new Error('a real bug');
      },
      warn: () => {},
      error: () => {},
    };

    const guard = guardWrites(target);
    expect(() => target.log('x')).toThrow('a real bug');
    expect(guard.muted()).toBe(false);
  });

  it('passes arguments through untouched while the pipe is alive', () => {
    const log = vi.fn();
    const target: Writer = { log, warn: vi.fn(), error: vi.fn() };
    guardWrites(target);
    target.log('[cookies] %s', 'grp-gmail', 7);
    expect(log).toHaveBeenCalledWith('[cookies] %s', 'grp-gmail', 7);
  });
});

describe('sending to a renderer that may already be gone', () => {

  it('sends through the main frame when everything is alive', () => {
    const send = vi.fn();
    const { wc } = fakeContents({ frame: { isDestroyed: () => false, send } });
    safeSend(wc, 'shell:state', { a: 1 });
    expect(send).toHaveBeenCalledWith('shell:state', { a: 1 });
  });

  it('declines a destroyed webContents without touching the frame', () => {
    const { wc } = fakeContents({ destroyed: true, frameThrows: true });
    expect(() => safeSend(wc, 'shell:state')).not.toThrow();
  });

  it('declines a disposed frame — the case Electron logs instead of throwing', () => {
    // This is the regression. `webContents.send` delegates to `webFrameMain.send`, which catches
    // the disposed-frame error itself and reports it with `console.error`. A try/catch around the
    // send never sees it, so the only way not to produce that log line is not to send.
    const send = vi.fn();
    const { wc } = fakeContents({ frame: { isDestroyed: () => true, send } });
    safeSend(wc, 'shell:state');
    expect(send).not.toHaveBeenCalled();
  });

  it('survives a mainFrame getter that throws', () => {
    // Reading `mainFrame` on a webContents torn down since the isDestroyed() check throws in its
    // own right, and this runs inside a broadcast loop over every consumer.
    const { wc } = fakeContents({ frameThrows: true });
    expect(() => safeSend(wc, 'shell:state')).not.toThrow();
  });

  it('survives a null mainFrame', () => {
    const { wc } = fakeContents({ frame: null });
    expect(() => safeSend(wc, 'shell:state')).not.toThrow();
  });
});
