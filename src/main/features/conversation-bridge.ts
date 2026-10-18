import type { WebContents } from 'electron';
import { catalogById } from '@shared/catalog';
import { asConversationProbe, conversationProbeScript, openConversationScript, readConversations } from '@core/services/conversations';
import type { Conversation, ConversationRule } from '@shared/types';

/**
 * Who's waiting on you in each chat service — its conversation list — for the control socket, so
 * a Stream Deck's Chats screen can show the people and channels, not just a count. And opening one.
 * The rules are catalog data and the reading is core/services/conversations.ts; this only runs the
 * probe and keeps the result. Decision #119.
 *
 * Probed from main in an isolated world, like the meeting bridge (#115): the page's own scripts
 * can't observe the probe or answer in `document.querySelector`'s place. Every five seconds, and
 * only for services whose entry has rules and whose page is running — the rest cost nothing.
 */

/** An isolated world of our own, beside the meeting bridge's (1108). */
const WORLD = 1_109;
const EVERY_MS = 5_000;
/** A busy or hung page mustn't stall the loop. */
const PROBE_TIMEOUT_MS = 1_000;

interface Deps {
  /** Every configured service: id and catalog entry. */
  services: () => { id: string; catalogId: string }[];
  /** The service's view, if it's running. */
  contents: (serviceId: string) => WebContents | null;
  /** Brings the service forward, as `focus-service` does. */
  focus: (serviceId: string) => void;
  /** Some service's conversations changed — broadcast. */
  changed: () => void;
  /** For "the rules read nothing here" — where a redesign shows first. */
  log?: (message: string) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

export class ConversationBridge {
  private readonly lists = new Map<string, Conversation[]>();
  private readonly signatures = new Map<string, string>();
  /** Services whose rules matched no rows last time, so it's said once rather than every probe. */
  private readonly unmatched = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly deps: Deps) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), EVERY_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The current lists, for `ShellState`: only services with something waiting. */
  snapshot(): ReadonlyMap<string, Conversation[]> {
    return this.lists;
  }

  /** Shows the service and opens the conversation. Returns whether its row was found. */
  async open(serviceId: string, conversationId: string): Promise<boolean> {
    const rules = this.rulesFor(serviceId);
    this.deps.focus(serviceId);
    const wc = this.deps.contents(serviceId);
    if (!rules || !wc || wc.isDestroyed()) return false;
    // A user gesture, as a click is: some lists only open a chat for one.
    const opened = await withTimeout(wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: openConversationScript(rules, conversationId) }], true), PROBE_TIMEOUT_MS);
    // Opening one reads it: look again soon rather than in five seconds.
    setTimeout(() => void this.tick(), 800);
    return opened === true;
  }

  private rulesFor(serviceId: string): ConversationRule[] | undefined {
    const svc = this.deps.services().find((s) => s.id === serviceId);
    return svc ? catalogById(svc.catalogId)?.conversations : undefined;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let changed = false;
      const seen = new Set<string>();
      for (const svc of this.deps.services()) {
        const rules = catalogById(svc.catalogId)?.conversations;
        if (!rules?.length) continue;
        seen.add(svc.id);
        changed = (await this.probe(svc.id, rules)) || changed;
      }
      for (const id of [...this.lists.keys()]) {
        if (!seen.has(id)) {
          this.lists.delete(id);
          this.signatures.delete(id);
          changed = true;
        }
      }
      if (changed) this.deps.changed();
    } finally {
      this.busy = false;
    }
  }

  /** Probes one service's page; returns whether its list changed. */
  private async probe(serviceId: string, rules: ConversationRule[]): Promise<boolean> {
    const wc = this.deps.contents(serviceId);
    let list: Conversation[] = [];
    if (wc && !wc.isDestroyed()) {
      const probe = asConversationProbe(await withTimeout(wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: conversationProbeScript(rules) }]), PROBE_TIMEOUT_MS));
      if (probe) {
        if (probe.rule === -1 && !this.unmatched.has(serviceId)) {
          this.unmatched.add(serviceId);
          this.deps.log?.(`conversations: no rule matched a row in ${serviceId}'s page`);
        } else if (probe.rule !== -1) {
          this.unmatched.delete(serviceId);
        }
        list = readConversations(rules, probe);
      }
    }
    const signature = JSON.stringify(list);
    if (this.signatures.get(serviceId) === signature) return false;
    this.signatures.set(serviceId, signature);
    if (list.length === 0) this.lists.delete(serviceId);
    else this.lists.set(serviceId, list);
    return true;
  }
}
