import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Appearance } from './settings/Appearance';
import { Behaviour } from './settings/Behaviour';
import { Accounts, Connections, CustomHosts, Folders, PerService, Workspaces } from './settings/Connections';
import { Keyboard } from './settings/Keyboard';
import { Downloads, Network } from './settings/Network';
import { Notifications } from './settings/Notifications';
import { About, Reset } from './settings/Reset';
import { Data, Storage } from './settings/Storage';
import { Sync } from './settings/Sync';
import { Unread } from './settings/Unread';
import { useShellState } from './useShellState';
import type { ShellState } from '@shared/types';

/**
 * Its own window rather than another overlay mode, so it can sit beside the app while you change
 * things and watch the effect. Reads every service, not just the active workspace's, since removing
 * or renaming should reach services you can't currently see.
 *
 * Composition only. Each section lives in `settings/` and takes the slice of state it needs — this
 * file was 679 lines of markup in one function, which meant nothing inside it could be rendered on
 * its own and the conflict-resolution UI, the most consequential thing here, had no test at all.
 *
 * Grouped, with a sidebar and a search. It had grown to eighteen sections in one scroll, with the
 * same services listed five times over, and finding "the proxy" meant scrolling past all of
 * notifications to get there. A group is one screen; the search looks through every group at once.
 */

interface Group {
  id: string;
  label: string;
  render: (state: ShellState) => ReactNode;
}

const GROUPS: Group[] = [
  {
    id: 'general',
    label: 'General',
    render: (s) => (
      <>
        <Appearance appearance={s.preferences.appearance} closeToTray={s.preferences.behaviour.closeToTray} />
        <Behaviour behaviour={s.preferences.behaviour} />
      </>
    ),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    render: (s) => (
      <>
        <Notifications notifications={s.preferences.notifications} />
        <Unread state={s} />
      </>
    ),
  },
  {
    id: 'connections',
    label: 'Connections',
    render: (s) => (
      <>
        <Connections state={s} />
        <PerService state={s} />
        <CustomHosts state={s} />
        <Accounts state={s} />
      </>
    ),
  },
  {
    id: 'workspaces',
    label: 'Workspaces & folders',
    render: (s) => (
      <>
        <Workspaces state={s} />
        <Folders state={s} />
      </>
    ),
  },
  { id: 'keyboard', label: 'Keyboard', render: (s) => <Keyboard state={s} /> },
  {
    id: 'network',
    label: 'Network & downloads',
    render: (s) => (
      <>
        <Network network={s.preferences.network} />
        <Downloads downloads={s.preferences.downloads} />
      </>
    ),
  },
  {
    id: 'data',
    label: 'Data & sync',
    render: (s) => (
      <>
        <Sync sync={s.preferences.sync} status={s.syncStatus} />
        <Data />
        <Storage state={s} />
        <Reset />
      </>
    ),
  },
  { id: 'about', label: 'About', render: (s) => <About state={s} /> },
];

/**
 * Hides every section inside `root` that says nothing matching `query`.
 *
 * Done on the rendered DOM rather than on some index of section names, because what people search
 * for is whatever they can see — a row's name, its note, a service they know is in there — and the
 * DOM is the only complete list of that. Field values count too, so a proxy host or a service name
 * typed into an input is findable.
 */
function useSectionFilter(root: React.RefObject<HTMLElement | null>, query: string, deps: unknown[]) {
  const [matches, setMatches] = useState(0);
  useEffect(() => {
    const sections = [...(root.current?.querySelectorAll<HTMLElement>('section') ?? [])];
    const q = query.trim().toLowerCase();
    let shown = 0;
    for (const section of sections) {
      const values = [...section.querySelectorAll<HTMLInputElement>('input, select')].map((i) => i.value);
      const text = `${section.textContent ?? ''} ${values.join(' ')}`.toLowerCase();
      const hit = !q || text.includes(q);
      section.hidden = !hit;
      if (hit) shown++;
    }
    setMatches(shown);
  }, [query, ...deps]);
  return matches;
}

export function Settings() {
  // Same channel as every other surface. Settings used to have its own, which is precisely why it
  // went stale whenever a change originated elsewhere.
  const state = useShellState();
  const [groupId, setGroupId] = useState('general');
  const [query, setQuery] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== '';
  const matches = useSectionFilter(content, query, [groupId, state]);

  if (!state) return null;
  const groups = searching ? GROUPS : GROUPS.filter((g) => g.id === groupId);

  return (
    <div className="settings has-nav">
      <nav className="settings-nav" aria-label="Settings sections">
        <input
          className="field settings-search"
          type="search"
          aria-label="Search settings"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
        <ul>
          {GROUPS.map((g) => (
            <li key={g.id}>
              <button
                className={!searching && g.id === groupId ? 'is-current' : ''}
                aria-current={!searching && g.id === groupId ? 'page' : undefined}
                onClick={() => {
                  setQuery('');
                  setGroupId(g.id);
                  if (content.current) content.current.scrollTop = 0;
                }}
              >
                {g.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-content" ref={content}>
        <h1>{searching ? `Results for “${query.trim()}”` : GROUPS.find((g) => g.id === groupId)?.label}</h1>
        {groups.map((g) => (
          <div key={g.id} className="settings-group">
            {g.render(state)}
          </div>
        ))}
        {searching && matches === 0 && <p className="hint">Nothing in Settings mentions that.</p>}
      </div>
    </div>
  );
}
