import { useEffect, useRef } from 'react';

/**
 * Keeps Tab inside a dialog, and puts focus back where it came from on close.
 *
 * Without a trap, tabbing past the last control in the palette moves focus to nothing visible —
 * the overlay is its own `WebContentsView`, so there is no surrounding page to land on. The user
 * is simply stuck with no way to see where focus went.
 *
 * Restoring matters as much: the overlay view is *removed* from the window on close, not hidden,
 * so whatever had focus is gone and focus falls back to the document body unless we put it back.
 */
export function useFocusTrap<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = () =>
      [
        ...container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;

      // Wrap at both ends. Shift+Tab off the first is the case people forget, and it's the one
      // that strands you outside the dialog with no visible focus at all.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Only if focus is still somewhere in here — if the user has already moved on, yanking it
      // back is worse than leaving it.
      if (previouslyFocused && container.contains(document.activeElement)) {
        previouslyFocused.focus?.();
      }
    };
  }, []);

  return ref;
}
