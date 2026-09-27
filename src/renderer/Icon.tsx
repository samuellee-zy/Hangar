/**
 * The app's own icons, drawn in `currentColor` on one 16-unit grid.
 *
 * They were text characters — ⚙ + ☾ ▦ ‹ › ✕ ↑ ↓ — each falling back to whichever font happened to
 * have it, on its own baseline, sized by hand at 15, 17 and 20px to look roughly alike, with ⌃ (the
 * Control key's symbol) standing in for an up-chevron. One set of strokes, one size, one alignment.
 *
 * Decorative by default (`aria-hidden`): every place that uses one gives the control a name of its
 * own, and a glyph read aloud was never that name.
 */

export type IconName =
  | 'gear'
  | 'plus'
  | 'moon'
  | 'bell-off'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'arrow-up'
  | 'arrow-down'
  | 'folder'
  | 'help'
  | 'reload'
  | 'pop-out'
  | 'maximise'
  | 'restore';

const PATHS: Record<IconName, string> = {
  gear:
    'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z M6.9 1.5h2.2l.35 1.7 1.1.45 1.45-.95 1.55 1.55-.95 1.45.45 1.1 1.7.35v2.2l-1.7.35-.45 1.1.95 1.45-1.55 1.55-1.45-.95-1.1.45-.35 1.7H6.9l-.35-1.7-1.1-.45-1.45.95-1.55-1.55.95-1.45-.45-1.1-1.7-.35V6.9l1.7-.35.45-1.1-.95-1.45 1.55-1.55 1.45.95 1.1-.45Z',
  plus: 'M8 3v10 M3 8h10',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z',
  'bell-off':
    'M6.2 13a1.9 1.9 0 0 0 3.6 0 M4 11.5h8.5l-1.3-1.8V7a3.2 3.2 0 0 0-5.6-2.1 M4.8 6.4V9.7L3.5 11.5 M2.5 2.5l11 11',
  'chevron-left': 'M10 3.5 5.5 8l4.5 4.5',
  'chevron-right': 'M6 3.5 10.5 8 6 12.5',
  close: 'M4 4l8 8 M12 4l-8 8',
  'arrow-up': 'M8 13V3 M4 7l4-4 4 4',
  'arrow-down': 'M8 3v10 M4 9l4 4 4-4',
  folder: 'M2.5 4.5h4l1.5 1.5h5.5v6.5h-11Z',
  help: 'M6.2 6.2a1.9 1.9 0 1 1 2.6 1.75c-.5.2-.8.6-.8 1.1V9.6 M8 11.8v.2 M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z',
  reload: 'M13 8a5 5 0 1 1-1.46-3.54 M13 2.5v3h-3',
  'pop-out': 'M9 3h4v4 M13 3 7.5 8.5 M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3',
  maximise: 'M3 6V3h3 M10 3h3v3 M13 10v3h-3 M6 13H3v-3',
  restore: 'M6 3v3H3 M13 6h-3V3 M10 13v-3h3 M3 10h3v3',
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={['icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
