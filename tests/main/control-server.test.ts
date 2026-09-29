// The control socket's server, over a real Unix socket. What a client may send is tested in
// control.test.ts; these are about moving lines — buffering, limits, clients that stop reading —
// and about the server never taking the app down with it.

import fs from 'node:fs';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import type { ControlState } from '@core/runtime/control';

fs.mkdirSync(app.getPath('userData'), { recursive: true });
const { controlSocketPath, publishControlState, startControlServer, stopControlServer } = await import(
  '@main/features/control-server'
);
const { MAX_CONTROL_LINE } = await import('@core/runtime/control');

const state = (over: Partial<ControlState> = {}): ControlState => ({
  window: true,
  dnd: false,
  dndUntil: null,
  activeWorkspaceId: null,
  workspaces: [],
  services: [],
  focusedServiceId: null,
  unreadTotal: 0,
  ...over,
});

const run = vi.fn();
const start = () => startControlServer({ run, current: () => state() });

/**
 * A client that collects the lines it's sent, returned once the server has sent the first — so it's
 * registered, which the connect callback alone doesn't mean. `paused` then stops reading: a plugin
 * that was suspended.
 */
async function connect({ paused = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(controlSocketPath(), () => resolve(s));
        s.once('error', reject);
      });
      const lines: string[] = [];
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n')) !== -1) {
          lines.push(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
        }
      });
      await until(() => lines.length > 0);
      if (paused) socket.pause();
      return { socket, lines, closed };
    } catch (err) {
      if (attempt > 40) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

afterEach(() => {
  stopControlServer();
  run.mockClear();
});

describe('the control server', () => {
  it('tells a client the state on connecting, and joins a line split across writes', async () => {
    start();
    const client = await connect();
    await until(() => client.lines.length > 0);
    expect(JSON.parse(client.lines[0]!)).toMatchObject({ type: 'state', state: { window: true } });

    client.socket.write('{"type":"command","command":{"type":"split"}}\n{"type":"com');
    client.socket.write('mand","command":{"type":"reopen-pane"}}\n');
    await until(() => run.mock.calls.length === 2);
    expect(run.mock.calls.map(([c]) => c.type)).toEqual(['split', 'reopen-pane']);
    client.socket.destroy();
  });

  it('drops a client that sends more than a line can be, without a newline', async () => {
    start();
    const client = await connect();
    client.socket.write('x'.repeat(MAX_CONTROL_LINE + 10));
    await client.closed;
    expect(run).not.toHaveBeenCalled();
  });

  it('TWENTY COMMANDS IN TEN SECONDS PER CLIENT — a runaway plugin gets "too many", not a thousand presses', async () => {
    start();
    const client = await connect();
    for (let i = 0; i < 25; i++) client.socket.write('{"type":"command","command":{"type":"split"}}\n');
    await until(() => client.lines.filter((l) => l.includes('too many commands')).length === 5);
    expect(run).toHaveBeenCalledTimes(20);
    client.socket.destroy();
  });

  it('A CLIENT THAT STOPPED READING IS DROPPED TO MAKE ROOM — eight of them locked everyone out', async () => {
    start();
    const readers = await Promise.all(Array.from({ length: 7 }, () => connect()));
    const stalled = await connect({ paused: true });
    // Distinct states, sent over many turns of the event loop, until far more is waiting than a
    // paused socket's buffers and the kernel's hold. Coalescing means a reader is sent only what it
    // can take; the paused one ends backlogged, which is what marks it stalled.
    const big = 'x'.repeat(32 * 1024);
    for (let i = 0; i < 60; i++) {
      publishControlState(state({ workspaces: [{ id: String(i), name: big }] }));
      await new Promise((r) => setImmediate(r));
    }
    const newest = (lines: string[]) => lines.at(-1)?.includes('"id":"59"') === true;
    await until(() => readers.every((r) => newest(r.lines)));

    const ninth = await connect();
    // A paused socket doesn't see the other end hang up until it reads: resumed, it drains what it
    // was sent and then finds itself closed — by the server, making room.
    stalled.socket.resume();
    await stalled.closed;
    expect(JSON.parse(ninth.lines[0]!).type).toBe('state');
    for (const reader of readers) expect(reader.socket.destroyed, 'the ones still reading stay').toBe(false);
    for (const c of [...readers, ninth]) c.socket.destroy();
  });

  it("A CLIENT THAT FALLS BEHIND IS SENT THE NEWEST STATE, NOT EVERY ONE — Node held them all", async () => {
    start();
    const slow = await connect({ paused: true });
    // Nearly 2 MB of states: every one kept would be over the backlog limit, and the client dropped.
    const big = 'x'.repeat(32 * 1024);
    for (let i = 0; i < 60; i++) {
      publishControlState(state({ workspaces: [{ id: String(i), name: big }] }));
      await new Promise((r) => setImmediate(r));
    }
    slow.socket.resume();
    await until(() => slow.lines.at(-1)?.includes('"id":"59"') === true);
    expect(slow.socket.destroyed).toBe(false);
    expect(slow.lines.length, 'the ones in between were skipped').toBeLessThan(60);
    slow.socket.destroy();
  });

  it('removes its socket when it stops', async () => {
    start();
    await connect().then((c) => c.socket.destroy());
    stopControlServer();
    expect(fs.existsSync(controlSocketPath())).toBe(false);
  });

  it("A DIRECTORY WHERE THE SOCKET GOES DOESN'T THROW — it stopped the window being built", () => {
    fs.mkdirSync(controlSocketPath(), { recursive: true });
    try {
      expect(() => start()).not.toThrow();
      expect(() => stopControlServer()).not.toThrow();
    } finally {
      fs.rmSync(controlSocketPath(), { recursive: true, force: true });
    }
  });
});
