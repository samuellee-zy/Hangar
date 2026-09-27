import { displayChord } from '@shared/keyboard';
import type { ShellState } from '@shared/types';

/**
 * The chord currently bound to an action, as it should be shown — or '' when it is unbound.
 *
 * Shortcut hints were written into the UI as text ("⌘N to add", "Settings (⌘,)"), so rebinding an
 * action left five places advertising a key that no longer did anything. Everything that names a
 * shortcut reads it from here, which reads it from main's keymap.
 */
export function chordFor(state: ShellState | null, actionId: string): string {
  const chord = state?.keyboard?.actions.find((a) => a.id === actionId)?.chord ?? '';
  return chord ? displayChord(chord) : '';
}

/** `label (⌘K)`, or just `label` when the action is unbound. */
export function withChord(state: ShellState | null, label: string, actionId: string): string {
  const chord = chordFor(state, actionId);
  return chord ? `${label} (${chord})` : label;
}
