import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';

/**
 * A button for things that can't be taken back: the first click arms it, a second within a few
 * seconds does it.
 *
 * Settings had four of these as ordinary buttons — Remove a connection, Sign out (which wipes an
 * account's cookies), Delete a workspace, Reset all — each one misclick away from its consequence,
 * while the rail's right-click path for the same removal already asked first. Two clicks rather
 * than a dialog: it keeps you where you were, nothing else is blocked, and it cannot be dismissed
 * by reflex the way a modal's default button can.
 *
 * Disarms itself after a pause, on Escape, and when focus leaves, so an armed button is never left
 * waiting for a click meant for something else.
 */
const ARMED_FOR_MS = 4_000;

export function ConfirmButton({
  confirmLabel,
  onConfirm,
  children,
  className = 'danger',
  ...button
}: {
  /** What the button says once armed — the question, e.g. "Remove Gmail?". */
  confirmLabel: string;
  onConfirm: () => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };
  useEffect(() => disarm, []);

  return (
    <button
      {...button}
      className={[className, armed ? 'is-armed' : ''].filter(Boolean).join(' ')}
      // Announced, so a screen-reader user knows the first press did something and what the second
      // will do.
      aria-live="polite"
      onClick={() => {
        if (armed) {
          disarm();
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = setTimeout(disarm, ARMED_FOR_MS);
      }}
      onBlur={disarm}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation();
          disarm();
        }
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
