import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { app } from 'electron';
import {
  MAX_CONTROL_LINE,
  controlState,
  readControlMessage,
  type ControlState,
} from '@core/runtime/control';
import type { Command, ShellState } from '@shared/types';

/**
 * The control socket: a Unix socket in userData that streams Hangar's state and takes a short list
 * of commands, for a Stream Deck plugin or a script. See docs/automation.md and decision #114.
 *
 * Newline-delimited JSON. A client is sent `{"type":"state","state":…}` on connecting and whenever
 * the state changes, and sends `{"type":"command","command":…}`. What it may send is decided in
 * core/runtime/control.ts; this file only moves lines.
 *
 * A socket rather than a port: a port on localhost answers every process on the machine, and a
 * browser can be talked into sending it requests. The socket is a file in a directory only you can
 * read, and it is made 0600 besides.
 */

const MAX_CLIENTS = 8;

interface Deps {
  /** Runs an allowlisted command — building or showing the window first if it asks to be seen. */
  run: (command: Command) => void;
  /** The state right now, for a client that has just connected. */
  current: () => ControlState;
}

let server: net.Server | null = null;
const clients = new Set<net.Socket>();
let lastSignature = '';

export const controlSocketPath = (): string => path.join(app.getPath('userData'), 'control.sock');

export function startControlServer(deps: Deps): void {
  if (server) return;
  const socketPath = controlSocketPath();
  // The single-instance lock means a socket already there is a crashed run's, not a live one's.
  fs.rmSync(socketPath, { force: true });

  server = net.createServer((socket) => {
    if (clients.size >= MAX_CLIENTS) {
      socket.end();
      return;
    }
    clients.add(socket);
    socket.setEncoding('utf8');
    socket.on('close', () => clients.delete(socket));
    // A client that goes away mid-write is its own business; without a listener it's a crash.
    socket.on('error', () => clients.delete(socket));

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleLine(socket, line, deps);
      }
      if (buffer.length > MAX_CONTROL_LINE) {
        console.warn('[control] dropped a client: line too long');
        socket.destroy();
      }
    });

    try {
      send(socket, { type: 'state', state: deps.current() });
    } catch (err) {
      console.error('[control] initial state failed:', err);
    }
  });

  server.on('error', (err) => {
    // A path over the 104-byte limit (a deep HANGAR_USER_DATA) lands here. The app works without it.
    console.error('[control] socket unavailable:', err);
    server = null;
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (err) {
      console.error('[control] chmod failed:', err);
    }
    console.log('[control] listening');
  });

  app.once('will-quit', stopControlServer);
}

export function stopControlServer(): void {
  for (const socket of clients) socket.destroy();
  clients.clear();
  server?.close();
  server = null;
  fs.rmSync(controlSocketPath(), { force: true });
}

/** Called with every broadcast. Sends only what changed, and nothing when no one is listening. */
export function publishControlState(state: ShellState | ControlState): void {
  if (clients.size === 0) {
    // Forgotten, so the first client after a quiet spell is compared against nothing stale.
    lastSignature = '';
    return;
  }
  const control = 'allServices' in state ? controlState(state) : state;
  const signature = JSON.stringify(control);
  if (signature === lastSignature) return;
  lastSignature = signature;
  for (const socket of clients) send(socket, { type: 'state', state: control });
}

function handleLine(socket: net.Socket, line: string, deps: Deps): void {
  const message = readControlMessage(line);
  if (!message.ok) {
    console.warn(`[control] refused: ${message.error}`);
    send(socket, { type: 'error', error: message.error });
    return;
  }
  // Caught like `shell:command`: a throw here would otherwise surface nowhere at all.
  try {
    deps.run(message.command);
  } catch (err) {
    console.error(`[control] ${message.command.type} failed:`, err);
    send(socket, { type: 'error', error: `${message.command.type} failed` });
  }
}

function send(socket: net.Socket, message: object): void {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}
