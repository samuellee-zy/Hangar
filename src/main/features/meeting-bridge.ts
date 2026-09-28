import type { WebContents } from 'electron';
import { catalogById } from '@shared/catalog';
import { asMeetingProbe, clickScript, mergeMeetings, probeScript, readMeeting } from '@core/services/meeting';
import type { MeetingControl, MeetingRules, MeetingState } from '@shared/types';

/**
 * Reads and presses meeting controls in services' pages — Teams, Slack huddles, Meet — for the
 * control socket. The rules are catalog data and the reading is core/services/meeting.ts; this
 * only runs the probe and keeps the result. Decision #115.
 *
 * Probed from main rather than the preload because Slack's huddle is a popup, and popups don't get
 * the preload. Run in an isolated world: the page's scripts can't observe the probe, or answer in
 * `document.querySelector`'s place. Every two seconds to notice a call, twice a second in one, and
 * only for services whose entry has meeting rules — the rest cost nothing.
 */

/** An isolated world of our own, separate from the preload's. */
const WORLD = 1_108;
const IDLE_MS = 2_000;
const IN_CALL_MS = 500;
/** A busy or hung page mustn't stall the loop. */
const PROBE_TIMEOUT_MS = 1_000;

interface Deps {
  /** Every configured service: id and catalog entry. */
  services: () => { id: string; catalogId: string }[];
  /** The service's view, if it's running. */
  contents: (serviceId: string) => WebContents | null;
  /** Some service's meeting changed — broadcast. */
  changed: () => void;
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

export class MeetingBridge {
  private readonly states = new Map<string, MeetingState>();
  private readonly signatures = new Map<string, string>();
  private readonly lastProbe = new Map<string, number>();
  /** Popups each service opened (Slack's huddle window), while they're open. */
  private readonly popups = new Map<string, Set<WebContents>>();
  /** For each service, the window that last had each control — where a press goes. */
  private readonly where = new Map<string, Map<MeetingControl, WebContents>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly deps: Deps) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), IN_CALL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The current meetings, for `ShellState`: only services with a state worth reporting. */
  snapshot(): ReadonlyMap<string, MeetingState> {
    return this.states;
  }

  /** A window a service's page opened. Tracked until it closes. */
  notePopup(serviceId: string, wc: WebContents): void {
    const rules = this.rulesFor(serviceId);
    if (!rules?.popups) return;
    let set = this.popups.get(serviceId);
    if (!set) this.popups.set(serviceId, (set = new Set()));
    set.add(wc);
    wc.once('destroyed', () => {
      set.delete(wc);
      // Probe straight away: closing a huddle window is leaving the huddle.
      this.lastProbe.delete(serviceId);
    });
    this.lastProbe.delete(serviceId);
  }

  /**
   * Presses a control. With `want`, only when it isn't already in that state. Returns whether the
   * control was found and pressed (or needed no press).
   */
  async control(serviceId: string, control: MeetingControl, want: boolean | null): Promise<boolean> {
    const rules = this.rulesFor(serviceId);
    const rule = rules?.controls[control];
    if (!rules || !rule) return false;
    const current = this.states.get(serviceId)?.controls[control];
    if (want !== null && current === want) return true;
    const known = this.where.get(serviceId)?.get(control);
    const windows = known && !known.isDestroyed() ? [known] : this.windowsFor(serviceId, rules);
    for (const wc of windows) {
      // A user gesture, because starting a screen share is refused without one (see session.ts).
      const pressed = await withTimeout(wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: clickScript(rule) }], true), PROBE_TIMEOUT_MS);
      if (pressed === true) {
        this.lastProbe.delete(serviceId);
        setTimeout(() => void this.tick(), 150);
        return true;
      }
    }
    return false;
  }

  private rulesFor(serviceId: string): MeetingRules | undefined {
    const svc = this.deps.services().find((s) => s.id === serviceId);
    return svc ? catalogById(svc.catalogId)?.meeting : undefined;
  }

  private windowsFor(serviceId: string, rules: MeetingRules): WebContents[] {
    const view = this.deps.contents(serviceId);
    const windows = view && !view.isDestroyed() ? [view] : [];
    if (rules.popups) for (const wc of this.popups.get(serviceId) ?? []) if (!wc.isDestroyed()) windows.push(wc);
    return windows;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      let changed = false;
      const seen = new Set<string>();
      for (const svc of this.deps.services()) {
        const rules = catalogById(svc.catalogId)?.meeting;
        if (!rules) continue;
        seen.add(svc.id);
        const inCall = this.states.get(svc.id)?.inCall === true;
        if (now - (this.lastProbe.get(svc.id) ?? 0) < (inCall ? IN_CALL_MS : IDLE_MS) - 50) continue;
        this.lastProbe.set(svc.id, now);
        changed = (await this.probe(svc.id, rules)) || changed;
      }
      // Services removed since: forget them.
      for (const id of [...this.states.keys()]) {
        if (!seen.has(id)) {
          this.states.delete(id);
          this.signatures.delete(id);
          changed = true;
        }
      }
      if (changed) this.deps.changed();
    } finally {
      this.busy = false;
    }
  }

  /** Probes a service's windows; returns whether its meeting changed. */
  private async probe(serviceId: string, rules: MeetingRules): Promise<boolean> {
    const windows = this.windowsFor(serviceId, rules);
    const script = probeScript(rules);
    const results: MeetingState[] = [];
    const where = new Map<MeetingControl, WebContents>();
    for (const wc of windows) {
      const probe = asMeetingProbe(await withTimeout(wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: script }]), PROBE_TIMEOUT_MS));
      if (!probe) continue;
      const state = readMeeting(rules, probe);
      results.push(state);
      for (const control of Object.keys(probe.found) as MeetingControl[]) if (!where.has(control)) where.set(control, wc);
    }
    this.where.set(serviceId, where);
    const merged = results.length ? mergeMeetings(results) : { inCall: false, controls: {} };
    const signature = JSON.stringify(merged);
    if (this.signatures.get(serviceId) === signature) return false;
    this.signatures.set(serviceId, signature);
    // Not in a call and nothing found is the resting state; keep it out of the broadcast.
    if (!merged.inCall && Object.keys(merged.controls).length === 0) this.states.delete(serviceId);
    else this.states.set(serviceId, merged);
    return true;
  }
}
