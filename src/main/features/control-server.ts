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
import { createRateLimiter } from '@core/runtime/urls';
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
/**
 * Unread output a client may leave waiting before it's dropped. A client that stops reading — a
 * plugin suspended mid-session — would otherwise have Node buffer every message it was sent, for
 * as long as Hangar ran.
 */
const MAX_BACKLOG = 1024 * 1024;
/** Commands per client: a Stream Deck's worth of presses, not a loop's. Links get ten in ten seconds. */
const COMMANDS_PER_WINDOW = 20;
const COMMAND_WINDOW_MS = 10_000;

interface Client {
  socket: net.Socket;
  /**
   * When the kernel buffer filled, or null while it isn't full. Until `drain`, states are held in
   * `pendingState`, latest only.
   */
  backloggedSince: number | null;
  pendingState: string | null;
  allow: (key: string) => boolean;
}

interface Deps {
  /** Runs an allowlisted command — building or showing the window first if it asks to be seen. */
  run: (command: Command) => void;
  /** The state right now, for a client that has just connected. */
  current: () => ControlState;
}

let server: net.Server | null = null;
const clients = new Map<net.Socket, Client>();
let lastSignature = '';

export const controlSocketPath = (): string => path.join(app.getPath('userData'), 'control.sock');

/**
 * Starts listening. Never throws: the socket is a convenience, and it failing — a directory where
 * the socket should be, a permission refused — must not stop the window being built, which is
 * what a throw out of here into `whenReady` did.
 */
export function startControlServer(deps: Deps): void {
  if (server) return;
  const socketPath = controlSocketPath();
  // The single-instance lock means a socket already there is a crashed run's, not a live one's.
  try {
    fs.rmSync(socketPath, { force: true });
  } catch (err) {
    console.error('[control] socket unavailable — the path is taken:', err);
    return;
  }

  server = net.createServer((socket) => {
    if (clients.size >= MAX_CLIENTS && !evictStalled()) {
      write(socket, { type: 'error', error: 'too many clients' });
      socket.end();
      return;
    }
    const client: Client = {
      socket,
      backloggedSince: null,
      pendingState: null,
      allow: createRateLimiter({ max: COMMANDS_PER_WINDOW, windowMs: COMMAND_WINDOW_MS }),
    };
    clients.set(socket, client);
    socket.setEncoding('utf8');
    socket.on('close', () => clients.delete(socket));
    // A client that goes away mid-write is its own business; without a listener it's a crash.
    socket.on('error', () => clients.delete(socket));
    socket.on('drain', () => {
      client.backloggedSince = null;
      const pending = client.pendingState;
      client.pendingState = null;
      if (pending) sendLine(client, pending);
    });

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleLine(client, line, deps);
      }
      if (buffer.length > MAX_CONTROL_LINE) {
        console.warn('[control] dropped a client: line too long');
        socket.destroy();
      }
    });

    try {
      sendState(client, JSON.stringify({ type: 'state', state: deps.current() }));
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
  for (const socket of clients.keys()) socket.destroy();
  clients.clear();
  server?.close();
  server = null;
  try {
    fs.rmSync(controlSocketPath(), { force: true });
  } catch {
    // Not ours to remove after all — a directory, say. Quitting goes on.
  }
}

/**
 * Makes room for a new client by dropping the longest-stalled one — backlogged, so not reading.
 * Eight idle connections from a suspended plugin otherwise locked every later client out.
 *
 * The longest, not the first found: a burst of states backlogs every client for a moment, and the
 * one that's reading would drain a millisecond later while the one that isn't never will.
 */
function evictStalled(): boolean {
  let oldest: Client | null = null;
  for (const client of clients.values()) {
    if (client.backloggedSince === null) continue;
    if (!oldest || client.backloggedSince < oldest.backloggedSince!) oldest = client;
  }
  if (!oldest) return false;
  console.warn('[control] dropped a client that stopped reading, to make room');
  oldest.socket.destroy();
  clients.delete(oldest.socket);
  return true;
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
  const line = JSON.stringify({ type: 'state', state: control });
  for (const client of clients.values()) sendState(client, line);
}

function handleLine(client: Client, line: string, deps: Deps): void {
  // Before anything else: a runaway client's lines cost a check, not a parse and a dispatch each.
  if (!client.allow('commands')) {
    sendLine(client, JSON.stringify({ type: 'error', error: 'too many commands' }));
    return;
  }
  const message = readControlMessage(line);
  if (!message.ok) {
    console.warn(`[control] refused: ${message.error}`);
    sendLine(client, JSON.stringify({ type: 'error', error: message.error }));
    return;
  }
  // Caught like `shell:command`: a throw here would otherwise surface nowhere at all.
  try {
    deps.run(message.command);
  } catch (err) {
    console.error(`[control] ${message.command.type} failed:`, err);
    sendLine(client, JSON.stringify({ type: 'error', error: `${message.command.type} failed` }));
  }
}

/**
 * A state for one client. Only the latest matters, so a client that isn't keeping up is sent the
 * newest when it next drains, not every one in between.
 */
function sendState(client: Client, line: string): void {
  if (client.backloggedSince !== null) {
    client.pendingState = line;
    return;
  }
  sendLine(client, line);
}

/** Writes a line; notes backpressure, and drops a client whose unread output has grown too far. */
function sendLine(client: Client, line: string): void {
  const { socket } = client;
  if (socket.destroyed || !socket.writable) return;
  if (!socket.write(`${line}\n`) && client.backloggedSince === null) client.backloggedSince = Date.now();
  if (socket.writableLength > MAX_BACKLOG) {
    console.warn('[control] dropped a client that stopped reading');
    socket.destroy();
    clients.delete(socket);
  }
}

/** For a connection that was never made a client — one turned away. */
function write(socket: net.Socket, message: object): void {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}
