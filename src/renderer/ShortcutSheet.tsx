import { useEffect, useRef } from 'react';
import { displayChord } from '@shared/keyboard';
import { useFocusTrap } from './useFocusTrap';
import { useShellState } from './useShellState';

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
  ['⌥↑ ⌥↓ on a tile', 'Move it up or down the rail'],
  ['Double-click a tile', 'Rename it, in an opened compact rail'],
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
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <dl className="shortcut-list">
          {actions.map((action) => (
            <div key={action.id} className="shortcut-row">
              <dt>{action.label.replace(/…$/, '')}</dt>
              <dd>
                {action.chord ? <kbd>{displayChord(action.chord)}</kbd> : <span className="unbound">not set</span>}
              </dd>
            </div>
          ))}
          {FIXED.map(([keys, what]) => (
            <div key={keys} className="shortcut-row">
              <dt>{what}</dt>
              <dd>
                <kbd>{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <footer className="palette-footer">
          Change any of these in Settings → Keyboard · <kbd>esc</kbd> to close
        </footer>
      </div>
    </div>
  );
}
