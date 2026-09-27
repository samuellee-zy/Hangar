import { useState } from 'react';
import { chordFromInput, displayChord, formatChord, isChordShapeBindable, parseChord } from '@shared/keyboard';
import type { ShellState } from '@shared/types';

/**
 * Rebinding, and the per-service passthrough list.
 *
 * The rows come from `state.keyboard`, projected by main: the table lives in `core/`, which
 * `renderer-is-sandboxed` puts out of reach, and resolving a service's passthrough needs a
 * `process.platform` a page doesn't have. Chords themselves are this file's business — it captures
 * a keystroke and canonicalises it with the same `shared/keyboard.ts` module main will parse it
 * with, so the string that travels is the string that gets stored.
 *
 * Nothing here is stateful except which row is listening. Main revalidates every message and
 * broadcasts the result, so a chord that comes back unchanged was refused.
 */

/** Listens for one keystroke. Escape or a click elsewhere gives up. */
export function ChordCapture({
  onCapture,
  onCancel,
}: {
  onCapture: (chord: string) => void;
  onCancel: () => void;
}) {
  return (
    <button
      className="chord is-capturing"
      autoFocus
      onBlur={onCancel}
      onKeyDown={(event) => {
        // Before anything else: ⌘W here would close the window rather than be captured.
        event.preventDefault();
        if (event.key === 'Escape') return onCancel();
        // A DOM KeyboardEvent is structurally a `KeyInput` apart from the two names, which is the
        // point of having one chord module rather than one per process.
        const chord = chordFromInput({
          type: 'keyDown',
          key: event.key,
          meta: event.metaKey,
          control: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
        });
        // A bare modifier is not a chord — keep listening, or holding ⌘ before K would commit ⌘.
        if (chord) onCapture(formatChord(chord));
      }}
    >
      Press a shortcut…
    </button>
  );
}

export function Keyboard({ state }: { state: ShellState }) {
  const [capturing, setCapturing] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const assign = (actionId: string, chord: string) => {
    setCapturing(null);
    // Checked here as well as in main, purely so there is something to say. Main answers a bad
    // chord by leaving the map alone, which on its own is indistinguishable from a missed keypress.
    if (state.keyboard.reserved.includes(chord)) {
      return setRefused(`${displayChord(chord)} belongs to the menu bar and can't be reassigned.`);
    }
    if (!isChordShapeBindable(parseChord(chord))) {
      return setRefused('A shortcut needs ⌘ or ⌃ — without one it would fire while you type.');
    }
    setRefused(null);
    window.hangar.send({ type: 'rebind', actionId, chord });
  };

  return (
    <>
      <section>
        <h2>Keyboard</h2>
        <p className="hint">
          Click a shortcut and press the new one. Taking a chord that another action already has
          unbinds it there, rather than leaving two actions on one key and one of them losing.
        </p>
        {/* An alert: the chord you pressed was just refused, and the reason is only on screen. */}
        {refused && (
          <p className="hint refused" role="alert">
            {refused}
          </p>
        )}
        <ul className="rows keys">
          {state.keyboard.actions.map((action) => (
            <li key={action.id}>
              {capturing === action.id ? (
                <ChordCapture
                  onCapture={(chord) => assign(action.id, chord)}
                  onCancel={() => setCapturing(null)}
                />
              ) : (
                <button
                  className={`chord${action.conflict ? ' is-conflicted' : ''}`}
                  title={
                    action.conflict
                      ? 'Another action holds this chord — only the first of them fires'
                      : `Rebind ${action.label}`
                  }
                  onClick={() => {
                    setRefused(null);
                    setCapturing(action.id);
                  }}
                >
                  {action.chord ? displayChord(action.chord) : 'Not bound'}
                </button>
              )}
              <span className="meta grow">{action.label}</span>
              <button
                className="danger"
                disabled={!action.chord}
                title={`Unbind ${action.label}`}
                onClick={() =>
                  window.hangar.send({ type: 'rebind', actionId: action.id, chord: null })
                }
              >
                Clear
              </button>
            </li>
          ))}
          <li className="empty">
            ⌘1…9 jumps to a service and ⌘⌥1…9 switches workspace — positional, so there is no single
            chord to move. Escape always closes an overlay.
          </li>
        </ul>
      </section>

      <Passthrough state={state} />
    </>
  );
}

/**
 * Chords a service keeps for itself.
 *
 * The motivating case, and the reason the rest of this exists: Hangar reads every keystroke before
 * the page does, so Slack's own ⌘K switcher was simply unreachable. Slack, Notion, Linear, Discord,
 * GitHub and Asana arrive with theirs already listed; this is for everything else, and for taking
 * one back.
 */
function Passthrough({ state }: { state: ShellState }) {
  const [capturing, setCapturing] = useState<string | null>(null);

  return (
    <section>
      <h2>Service shortcuts</h2>
      <p className="hint">
        Chords listed here are left to the service. Removing one of a service's own defaults pins
        the rest, so a later catalog change won't quietly give it back.
      </p>
      <ul className="rows">
        {state.allServices.map((svc) => {
          const { chords, fromCatalog } = state.keyboard.passthrough[svc.id] ?? {
            chords: [],
            fromCatalog: true,
          };
          const set = (next: string[]) =>
            window.hangar.send({
              type: 'update-service',
              serviceId: svc.id,
              patch: { keyboardPassthrough: next },
            });

          return (
            <li key={svc.id}>
              <span className="meta grow">
                {svc.name}
                {chords.length > 0 && fromCatalog && <span className="pref-note"> · default</span>}
              </span>
              {chords.map((chord) => (
                <button
                  key={chord}
                  className="chord"
                  title={`Give ${displayChord(chord)} back to Hangar`}
                  onClick={() => set(chords.filter((c) => c !== chord))}
                >
                  {displayChord(chord)} ✕
                </button>
              ))}
              {capturing === svc.id ? (
                <ChordCapture
                  onCapture={(chord) => {
                    setCapturing(null);
                    if (!chords.includes(chord)) set([...chords, chord]);
                  }}
                  onCancel={() => setCapturing(null)}
                />
              ) : (
                <button
                  className="secondary"
                  title={`Leave a chord to ${svc.name}`}
                  onClick={() => setCapturing(svc.id)}
                >
                  Add
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
