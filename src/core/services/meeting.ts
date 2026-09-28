import type { MeetingControl, MeetingControlRule, MeetingRules, MeetingState } from '@shared/types';

/**
 * Meeting controls in a service's page — Teams, Slack huddles, Meet — for the control socket (and
 * so a Stream Deck). The same split as unread (#90): the page-side probe only collects strings,
 * and everything that decides what they mean is here, where a test can reach it.
 *
 * The probe and the click run in an isolated world (main/features/meeting-bridge.ts), so the page's
 * own scripts can't see them or stand in for `document.querySelector`. What comes back is still
 * checked for shape, like anything else a page produces.
 */

export const MEETING_CONTROLS: readonly MeetingControl[] = ['mute', 'video', 'share', 'hand', 'leave'];

/** What the probe found for one control: its label, and the attribute or child its rule asks about. */
export interface ControlProbe {
  label: string;
  attr: string | null;
  child: boolean | null;
}

export interface MeetingProbe {
  inCall: boolean;
  found: Partial<Record<MeetingControl, ControlProbe>>;
}

/** Longer than any control's label; a page can't hand main an unbounded string. */
const MAX_LABEL = 200;

/**
 * The script that probes a page. Only the selectors, attribute names and child selectors go in —
 * JSON-encoded, so a rule can't break out of the string it's in.
 */
export function probeScript(rules: MeetingRules): string {
  const spec = {
    inCall: rules.inCall,
    controls: Object.fromEntries(
      Object.entries(rules.controls).map(([name, rule]) => [
        name,
        { selector: rule.selector, attr: rule.read === 'attr' ? (rule.attr ?? null) : null, child: rule.read === 'child' ? (rule.child ?? null) : null },
      ])
    ),
  };
  return `(() => {
  const spec = ${JSON.stringify(spec)};
  const find = (selector, root = document) => { try { return root.querySelector(selector); } catch { return null; } };
  const found = {};
  for (const [name, c] of Object.entries(spec.controls)) {
    const el = find(c.selector);
    if (!el) continue;
    found[name] = {
      label: String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, ${MAX_LABEL}),
      attr: c.attr ? el.getAttribute(c.attr) : null,
      child: c.child ? find(c.child, el) !== null : null,
    };
  }
  return { inCall: find(spec.inCall) !== null, found };
})()`;
}

/** The script that presses one control. Returns whether it found something to press. */
export function clickScript(rule: MeetingControlRule): string {
  return `(() => { try { const el = document.querySelector(${JSON.stringify(rule.selector)}); if (!el) return false; el.click(); return true; } catch { return false; } })()`;
}

/** A page's probe result, if it has the right shape — anything else is nothing. */
export function asMeetingProbe(value: unknown): MeetingProbe | null {
  if (!value || typeof value !== 'object') return null;
  const { inCall, found } = value as { inCall?: unknown; found?: unknown };
  if (typeof inCall !== 'boolean' || !found || typeof found !== 'object') return null;
  const clean: MeetingProbe['found'] = {};
  for (const name of MEETING_CONTROLS) {
    const raw = (found as Record<string, unknown>)[name];
    if (!raw || typeof raw !== 'object') continue;
    const { label, attr, child } = raw as { label?: unknown; attr?: unknown; child?: unknown };
    clean[name] = {
      label: typeof label === 'string' ? label.slice(0, MAX_LABEL) : '',
      attr: typeof attr === 'string' ? attr.slice(0, MAX_LABEL) : null,
      child: typeof child === 'boolean' ? child : null,
    };
  }
  return { inCall, found: clean };
}

/** ON/OFF for one control from what the probe saw; null when it's there but says neither. */
function readControl(rule: MeetingControlRule, probe: ControlProbe): boolean | null {
  const read = rule.read ?? 'label';
  // A child's presence is the answer on its own; no ON values to compare with.
  if (read === 'child') return probe.child;
  const on = rule.on ?? [];
  if (on.length === 0) return null;
  switch (read) {
    case 'attr':
      return probe.attr === null ? null : on.includes(probe.attr);
    default: {
      if (!probe.label) return null;
      const label = probe.label.toLowerCase();
      return on.some((prefix) => label.startsWith(prefix.toLowerCase()));
    }
  }
}

export function readMeeting(rules: MeetingRules, probe: MeetingProbe): MeetingState {
  const controls: MeetingState['controls'] = {};
  for (const name of MEETING_CONTROLS) {
    const rule = rules.controls[name];
    const found = probe.found[name];
    if (rule && found) controls[name] = readControl(rule, found);
  }
  return { inCall: probe.inCall, controls };
}

/**
 * Several windows (the service's view and its popups) into one meeting: in a call if any window is,
 * and each control from the first window that has it — the huddle window, not the channel behind it.
 */
export function mergeMeetings(states: MeetingState[]): MeetingState {
  const merged: MeetingState = { inCall: states.some((s) => s.inCall), controls: {} };
  for (const state of [...states].sort((a, b) => Number(b.inCall) - Number(a.inCall))) {
    for (const name of MEETING_CONTROLS) {
      if (merged.controls[name] === undefined && state.controls[name] !== undefined) merged.controls[name] = state.controls[name];
    }
  }
  return merged;
}
