import { useEffect, useRef } from 'react';
import { displayChord } from '@shared/keyboard';
import { useFocusTrap } from './useFocusTrap';
import { useShellState } from './useShellState';
import { Icon } from './Icon';

/**
 * Every keyboard shortcut, on one sheet (⌘/).
 *
 * Read from main's keymap rather than written here, so a rebound chord shows as rebound and an
 * unbound action says so. The positional families and the gestures that aren't bindings — ⌘1–9,
 * ⌥-click, ⌥-arrows on a tile — are listed too, since nothing else on screen mentions them.
 */
const FIXED: Array<[string, string]> = [
  ['⌘1 … ⌘9', 'The nth service in the rail'],
  ['⌘⌥1 … ⌘⌥9', 'The nth workspace'],
  ['⌥-click a tile', 'Open it beside the focused pane'],
  ['Drag a tile onto a pane', 'Open it there — between two panes, beside them'],
  ['Drag a tile onto a folder', 'File it in the folder'],
  ['Drag the gap between panes', 'Resize them — double-click it for equal widths'],
  ["Drag a pane's header", 'Swap it with another pane, or move it beside one'],
  ['Right-click a tile', 'Everything else it can do'],
  ['⌥↑ ⌥↓ on a tile', 'Move it along the rail (⌥← ⌥→ on a top or bottom rail)'],
  ['⌃Space on a tile', 'Pick it up to move with the arrows'],
  ['⇧↵ in Find', 'The previous match'],
  ['Double-click a tile', 'Rename it, in an opened compact rail'],
];

/** The menu bar's order, so the sheet reads the way the menus do. */
const GROUPS: Array<[string, string]> = [
  ['app', 'Hangar'],
  ['file', 'File'],
  ['view', 'View'],
  ['go', 'Go'],
  ['help', 'Help'],
];

export function ShortcutSheet() {
  const state = useShellState();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);

  const close = () => window.hangar.send({ type: 'close-overlay' });
  const actions = state?.keyboard?.actions ?? [];

  return (
    <div className="scrim" onClick={close}>
      <div
        className="sheet shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <header className="shortcut-head">
          <h2>Keyboard shortcuts</h2>
          <button ref={closeRef} className="shortcut-close" aria-label="Close" onClick={close}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="shortcut-list">
          {/* In menu order, under each menu's name: the internal table's order put ⌘K sixth, after
              Print, and nothing said which were whose. */}
          {GROUPS.map(([menu, heading]) => {
            const inMenu = actions.filter((a) => (a.menu ?? 'view') === menu);
            if (!inMenu.length) return null;
            return (
              <section key={menu} aria-label={heading}>
                <h3 className="shortcut-group-head">{heading}</h3>
                <dl>
                  {inMenu.map((action) => (
                    <div key={action.id} className="shortcut-row">
                      <dt>{action.label.replace(/…$/, '')}</dt>
                      <dd>
                        {action.chord ? (
                          <kbd>{displayChord(action.chord)}</kbd>
                        ) : (
                          <span className="unbound">not set</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
          <section aria-label="Tiles, panes and gestures">
            <h3 className="shortcut-group-head">Tiles, panes and gestures</h3>
            <dl>
              {FIXED.map(([keys, what]) => (
                <div key={keys} className="shortcut-row">
                  <dt>{what}</dt>
                  <dd>
                    <kbd>{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <footer className="palette-footer">
          Change any of these in Settings → Keyboard · <kbd>esc</kbd> to close
        </footer>
      </div>
    </div>
  );
}
