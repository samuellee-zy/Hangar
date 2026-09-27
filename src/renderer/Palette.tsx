import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { displayChord } from '@shared/keyboard';
import type { Command, ServiceView, ShellState } from '@shared/types';
import { badgeText } from './badge';
import { fuzzy } from './fuzzy';
import { ServiceIcon } from './ServiceIcon';
import { useFocusTrap } from './useFocusTrap';
import { useShellState } from './useShellState';

/**
 * The ⌘K command palette: every service, every workspace, and every action there is a name for.
 *
 * It was called a command palette and could only jump — services and workspaces, nothing you could
 * *do*. Now the keymap's actions are in it by their menu names with their current chords, and so are
 * the things you do to the service you're looking at: reload it, mark it read, mute it, put it to
 * sleep, pop it out.
 *
 * Before anything is typed it lists services in the order you last used them, which is the order
 * the next jump is most likely to want. Actions appear once you type, so the empty palette stays a
 * switcher.
 *
 * Shares the overlay view with the connection picker (`OverlayRoot` swaps between them), so it
 * inherits the same lifecycle: attached on open, *removed* on close. Never merely hidden — a
 * transparent attached view hit-tests across its whole bounds and would swallow every click.
 *
 * ⌘↵ opens a service in a new pane rather than replacing the focused one.
 */

type Group = 'Services' | 'Workspaces' | 'Actions';

type Item =
  | { kind: 'service'; group: Group; key: string; label: string; hint: string; svc: ServiceView }
  | { kind: 'workspace'; group: Group; key: string; label: string; hint: string; workspaceId: string }
  | { kind: 'action'; group: Group; key: string; label: string; hint: string; command: Command };

const HOUR_MS = 60 * 60 * 1000;

/**
 * Every word typed begins a word of the label. Looser subsequence matching is right for a short
 * list of names — "gml" for Gmail — and far too loose for sixty sentences, where two letters match
 * half of them.
 */
function matchesWords(query: string, label: string): boolean {
  const words = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => words.some((word) => word.startsWith(part)));
}

/** Things to do to the focused service, by name. */
function serviceActions(svc: ServiceView): Item[] {
  const muted = svc.notificationLevel === 'muted';
  const action = (key: string, label: string, command: Command): Item => ({
    kind: 'action',
    group: 'Actions',
    key: `svc:${key}`,
    label,
    hint: svc.name,
    command,
  });
  return [
    action('reload', `Reload ${svc.name}`, { type: 'reload-service', serviceId: svc.id }),
    ...(svc.unread > 0
      ? [action('read', `Mark ${svc.name} as read`, { type: 'mark-read', serviceId: svc.id })]
      : []),
    muted
      ? action('unmute', `Unmute ${svc.name}`, { type: 'mute-service', serviceId: svc.id, until: null })
      : action('mute', `Mute ${svc.name} for an hour`, {
          type: 'mute-service',
          serviceId: svc.id,
          until: Date.now() + HOUR_MS,
        }),
    action('sleep', `Put ${svc.name} to sleep`, { type: 'sleep-service', serviceId: svc.id }),
    action('popout', `Open ${svc.name} in a separate window`, {
      type: 'pop-out-service',
      serviceId: svc.id,
    }),
  ];
}

/** The keymap's actions — by the names the menu gives them — and Do Not Disturb. */
function globalActions(state: ShellState): Item[] {
  const { dnd } = state.preferences.notifications;
  const keyed: Item[] = (state.keyboard?.actions ?? [])
    // The palette itself would only close the palette.
    .filter((a) => a.id !== 'palette')
    .map((a) => ({
      kind: 'action',
      group: 'Actions',
      key: `key:${a.id}`,
      label: a.label.replace(/…$/, ''),
      hint: a.chord ? displayChord(a.chord) : '',
      command: a.command,
    }));
  const dndItem: Item = dnd
    ? {
        kind: 'action',
        group: 'Actions',
        key: 'dnd:off',
        label: 'Turn off Do Not Disturb',
        hint: '',
        command: { type: 'set-dnd', on: false, until: null },
      }
    : {
        kind: 'action',
        group: 'Actions',
        key: 'dnd:hour',
        label: 'Do Not Disturb for an hour',
        hint: '',
        command: { type: 'set-dnd', on: true, until: Date.now() + HOUR_MS },
      };
  return [...keyed, dndItem];
}

function buildItems(state: ShellState, query: string): Item[] {
  // Where each service lives, for a hint on the ones outside this workspace — `focus-service`
  // switches workspace for them, so they belong in the list, just labelled.
  const home = new Map<string, string>();
  for (const ws of state.workspaces) {
    for (const item of ws.items) {
      const ids = item.kind === 'service' ? [item.id] : item.serviceIds;
      for (const id of ids) if (!home.has(id)) home.set(id, ws.name);
    }
  }
  const here = new Set(state.services.map((s) => s.id));
  const inPane = new Set(state.panes.map((p) => p.serviceId));
  // Most recently used first, then this workspace's, then everywhere else's.
  const recency = new Map((state.recentServiceIds ?? []).map((id, i) => [id, i]));
  const rank = (s: ServiceView) => recency.get(s.id) ?? (here.has(s.id) ? 1000 : 2000);

  const services: Item[] = [...state.allServices]
    .sort((a, b) => rank(a) - rank(b))
    .filter((s) => fuzzy(query, s.name))
    .map((s) => ({
      kind: 'service',
      group: 'Services',
      key: `service:${s.id}`,
      label: s.name,
      hint: inPane.has(s.id)
        ? 'In a pane'
        : !here.has(s.id)
          ? (home.get(s.id) ?? '')
          : s.sleeping
            ? 'Asleep'
            : '',
      svc: s,
    }));

  const workspaces: Item[] = state.workspaces
    .filter((w) => fuzzy(query, w.name))
    .map((w) => ({
      kind: 'workspace',
      group: 'Workspaces',
      key: `workspace:${w.id}`,
      label: w.name,
      hint: w.id === state.activeWorkspaceId ? 'This workspace' : 'Workspace',
      workspaceId: w.id,
    }));

  if (!query.trim()) return [...services, ...workspaces];

  const focused = state.services.find(
    (s) => s.id === state.panes.find((p) => p.id === state.focusedPaneId)?.serviceId,
  );
  const actions = [...(focused ? serviceActions(focused) : []), ...globalActions(state)].filter(
    (a) => matchesWords(query, a.label),
  );
  return [...services, ...workspaces, ...actions];
}

export function Palette() {
  const state = useShellState();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>();

  // OverlayRoot remounts on every open via key={mode}, so state resets itself — only focus needs
  // doing here.
  useEffect(() => inputRef.current?.focus(), []);

  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  const results = useMemo(() => (state ? buildItems(state, query) : []), [state, query]);

  // Narrowing the query shrinks `results`, but `index` stayed where it was — pointing past the
  // end, so the highlight vanished and Enter silently did nothing. Clamp whenever the list changes.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  // The arrows moved the highlight past the bottom of the list and it stayed out of sight.
  // `scrollIntoView` is optional-called because jsdom doesn't implement it.
  useEffect(() => {
    document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [listId, index]);

  const run = (i: number, newPane: boolean) => {
    const item = results[i];
    if (!item) return;
    if (item.kind === 'workspace') {
      window.hangar.send({ type: 'set-workspace', workspaceId: item.workspaceId });
    } else if (item.kind === 'service') {
      window.hangar.send(
        newPane
          ? { type: 'open-in-new-pane', serviceId: item.svc.id }
          : { type: 'focus-service', serviceId: item.svc.id },
      );
    } else {
      // Closed first: an action may open something of its own — Settings, the shortcut sheet — and
      // the palette would otherwise sit over it until dismissed.
      window.hangar.send({ type: 'close-overlay' });
      window.hangar.send(item.command);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return window.hangar.send({ type: 'close-overlay' });
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(index, e.metaKey);
    }
  };

  return (
    // Clicking the scrim closes — the overlay is removed from the view tree, restoring clicks.
    <div className="scrim" onClick={() => window.hangar.send({ type: 'close-overlay' })}>
      <div
        className="palette"
        // A real dialog: `aria-modal` tells a screen reader the rest of the view is inert, and the
        // trap makes that true for the keyboard too. The overlay is its own WebContentsView, so
        // tabbing out of it lands on nothing at all rather than on a page behind.
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        {/* A combobox over a listbox, so a screen reader hears which result is highlighted as the
            arrows move — the highlight was a class name and nothing else. */}
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to a service, or type to find an action…"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results[index] ? optionId(index) : undefined}
          aria-label="Jump to a service or workspace, or find an action"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-results" id={listId} role="listbox" aria-label="Results">
          {results.map((item, i) => (
            <PaletteRow
              key={item.key}
              item={item}
              id={optionId(i)}
              active={i === index}
              heading={i === 0 || results[i - 1]!.group !== item.group ? item.group : null}
              onHover={() => i !== index && setIndex(i)}
              onRun={(newPane) => run(i, newPane)}
            />
          ))}
          {/* Only once there is state to have searched: before it arrives, "No matches" was a
              claim about data that hadn't loaded yet. */}
          {state && results.length === 0 && <li className="palette-empty">No matches</li>}
        </ul>
        <footer className="palette-footer">
          <kbd>↵</kbd> open · <kbd>⌘↵</kbd> open in new pane · <kbd>esc</kbd> dismiss
        </footer>
      </div>
    </div>
  );
}

function PaletteRow({
  item,
  id,
  active,
  heading,
  onHover,
  onRun,
}: {
  item: Item;
  id: string;
  active: boolean;
  /** The group's name, on the first row of each group. */
  heading: Group | null;
  onHover: () => void;
  onRun: (newPane: boolean) => void;
}) {
  return (
    <>
      {heading && (
        // Presentational: the options carry their own names, and a heading in the option sequence
        // would be counted as a result by a screen reader.
        <li className="palette-group" role="presentation" aria-hidden="true">
          {heading}
        </li>
      )}
      <li
        id={id}
        role="option"
        aria-selected={active}
        className={active ? 'is-active' : ''}
        // Move, not enter: scrolling the list under a pointer that hasn't moved "entered" a new
        // row each time and dragged the highlight away from the arrow keys.
        onMouseMove={onHover}
        onClick={(e) => onRun(e.metaKey)}
      >
        {item.kind === 'service' && (
          <span className="palette-icon" aria-hidden="true">
            <ServiceIcon
              serviceId={item.svc.id}
              initials={item.svc.initials}
              name=""
              version={item.svc.iconVersion}
            />
          </span>
        )}
        <span className="palette-label">{item.label}</span>
        {item.kind === 'service' && item.svc.unread > 0 && (
          <span className="palette-unread">{badgeText(item.svc.unread)}</span>
        )}
        <span className="palette-hint">{item.hint}</span>
      </li>
    </>
  );
}
