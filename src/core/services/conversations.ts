import type { Conversation, ConversationRule } from '@shared/types';

/**
 * Who's waiting on you in a chat service — its conversation list, read from its own UI — for the
 * control socket (and so a Stream Deck's Chats screen). The same split as unread (#90) and
 * meetings (#115): the page-side probe only collects strings, and deciding what they mean is here,
 * where a test can reach it. Probed and clicked in an isolated world from main
 * (main/features/conversation-bridge.ts), so the page's scripts can't see or answer for it.
 */

/** A page can't hand main an unbounded list or string. */
export const MAX_ROWS = 80;
export const MAX_CONVERSATIONS = 30;
const MAX_NAME = 120;
const MAX_COUNT = 9_999;

/** What the probe found in one row: strings and flags, nothing decided. */
export interface RowProbe {
  name: string;
  id: string;
  badge: string | null;
  unread: boolean;
  label: string;
  mention: boolean;
  muted: boolean;
}

export interface ConversationProbe {
  /** Which rule's `row` matched (index into the entry's rules), or -1 for none. */
  rule: number;
  rows: RowProbe[];
}

/**
 * The script that reads a page's conversation list. Only selectors and attribute names go in —
 * JSON-encoded, so a rule can't break out of the string it's in.
 */
export function conversationProbeScript(rules: ConversationRule[]): string {
  return `(() => {
  const rules = ${JSON.stringify(rules)};
  const find = (root, selector) => { if (!selector) return null; try { return root.matches?.(selector) ? root : root.querySelector(selector); } catch { return null; } };
  const all = (selector) => { try { return [...document.querySelectorAll(selector)]; } catch { return []; } };
  const text = (el) => String(el?.textContent || '').trim();
  for (let index = 0; index < rules.length; index++) {
    const r = rules[index];
    const rows = all(r.row).slice(0, ${MAX_ROWS});
    if (rows.length === 0) continue;
    return {
      rule: index,
      rows: rows.map((row) => {
        const nameEl = find(row, r.name);
        const name = (r.nameAttr ? nameEl?.getAttribute(r.nameAttr) : text(nameEl)) || '';
        const idEl = r.idFrom ? find(row, r.idFrom) : row;
        const id = (r.idAttr ? idEl?.getAttribute(r.idAttr) : '') || '';
        const badge = r.badge ? find(row, r.badge) : null;
        return {
          name: String(name).trim().slice(0, ${MAX_NAME}),
          id: String(id).slice(0, ${MAX_NAME}),
          badge: badge ? text(badge).slice(0, 20) || String(badge.getAttribute('aria-label') || '•').slice(0, 40) : null,
          unread: Boolean(r.unread && find(row, r.unread)),
          label: String(row.getAttribute('aria-label') || '').slice(0, 300),
          mention: Boolean(r.mention && find(row, r.mention)),
          muted: Boolean(r.muted && find(row, r.muted)),
        };
      }),
    };
  }
  return { rule: -1, rows: [] };
})()`;
}

/** A page's probe result, if it has the right shape — anything else is nothing. */
export function asConversationProbe(value: unknown): ConversationProbe | null {
  if (!value || typeof value !== 'object') return null;
  const { rule, rows } = value as { rule?: unknown; rows?: unknown };
  if (typeof rule !== 'number' || !Number.isInteger(rule) || !Array.isArray(rows)) return null;
  const clean: RowProbe[] = [];
  for (const raw of rows.slice(0, MAX_ROWS)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    clean.push({
      name: str(row.name, MAX_NAME),
      id: str(row.id, MAX_NAME),
      badge: typeof row.badge === 'string' ? row.badge.slice(0, 40) : null,
      unread: row.unread === true,
      label: str(row.label, 300),
      mention: row.mention === true,
      muted: row.muted === true,
    });
  }
  return { rule, rows: clean };
}

/** A badge's count: its number; a badge with no number (a dot) is 1. */
function badgeCount(badge: string): number {
  const digits = /(\d[\d,]*)/.exec(badge)?.[1]?.replace(/,/g, '');
  return digits ? Math.min(MAX_COUNT, Number(digits)) : 1;
}

/**
 * The conversations with something unread, in the app's own order, muted ones left out. Rows with
 * no name are skipped: they're placeholders while the list draws, and nothing a key could say.
 */
export function readConversations(rules: ConversationRule[], probe: ConversationProbe): Conversation[] {
  const rule = rules[probe.rule];
  if (!rule) return [];
  const out: Conversation[] = [];
  const seen = new Set<string>();
  probe.rows.forEach((row, order) => {
    if (!row.name || row.muted) return;
    const labelled = rule.unreadLabel ? row.label.toLowerCase().includes(rule.unreadLabel.toLowerCase()) : false;
    const unread = row.badge !== null ? badgeCount(row.badge) : row.unread || labelled ? 1 : 0;
    if (unread === 0) return;
    const id = row.id || row.name;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: row.name, unread, mention: row.mention, order });
  });
  return out.slice(0, MAX_CONVERSATIONS);
}

/**
 * The script that opens one conversation: the row with that id (or name), clicked as a person
 * would — pointer and mouse events, then a click, since chat lists listen for any of them.
 * Returns whether it found the row.
 */
export function openConversationScript(rules: ConversationRule[], conversationId: string): string {
  return `(() => {
  const rules = ${JSON.stringify(rules)};
  const wanted = ${JSON.stringify(conversationId)};
  const find = (root, selector) => { if (!selector) return null; try { return root.matches?.(selector) ? root : root.querySelector(selector); } catch { return null; } };
  for (const r of rules) {
    let rows = [];
    try { rows = [...document.querySelectorAll(r.row)]; } catch { continue; }
    if (rows.length === 0) continue;
    const row = rows.find((row) => {
      const idEl = r.idFrom ? find(row, r.idFrom) : row;
      const id = r.idAttr ? idEl?.getAttribute(r.idAttr) : '';
      if (id) return id === wanted;
      const nameEl = find(row, r.name);
      const name = r.nameAttr ? nameEl?.getAttribute(r.nameAttr) : nameEl?.textContent;
      return String(name || '').trim() === wanted;
    });
    if (!row) return false;
    const target = (r.click && find(row, r.click)) || row;
    target.scrollIntoView?.({ block: 'nearest' });
    const at = { bubbles: true, cancelable: true, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try { target.dispatchEvent(new (type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent)(type, at)); } catch {}
    }
    target.click();
    return true;
  }
  return false;
})()`;
}
