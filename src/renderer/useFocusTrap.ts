import { useCallback, useRef } from 'react';

/**
 * Keeps Tab inside a dialog.
 *
 * Without it, tabbing past the last control moves focus to nothing visible — the overlay is its own
 * `WebContentsView`, so there is no surrounding page to land on and the user is stuck with no way
 * to see where focus went.
 *
 * **Restoration is deliberately not here.** An earlier version tried, and couldn't work: it captured
 * `document.activeElement` inside `useEffect`, which runs *after* commit, and `AddConnection`'s
 * input has `autoFocus` applied *during* commit — so it captured an element inside the dialog. It
 * was also redundant, because `close-overlay` in the main process already calls `focusActivePane()`.
 * Focus restoration crosses a `WebContentsView` boundary, so main is the only place that can do it.
 */
export function useFocusTrap<T extends HTMLElement>() {
  const detach = useRef<(() => void) | null>(null);

  // A callback ref, not `useRef` plus a mount-only effect. The effect ran once, on the first
  // render — and `AddConnection` renders nothing until state arrives, which is always *after* the
  // first render. So the trap looked for its container, found null, and never looked again: Tab
  // walked straight out of the picker. A callback ref runs whenever the element actually mounts.
  return useCallback((container: T | null) => {
    detach.current?.();
    detach.current = null;
    if (!container) return;

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
    detach.current = () => container.removeEventListener('keydown', onKeyDown);
  }, []);
}
