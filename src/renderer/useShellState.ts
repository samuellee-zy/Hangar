import { useEffect, useState } from 'react';
import type { ShellState } from '@shared/types';

/**
 * The renderer's only source of truth. It fetches once, then subscribes — it never derives or
 * caches shell state locally, because main owns all of it. Keeping this rule is what makes the
 * visual redesign a renderer-only change later.
 */
export function useShellState(): ShellState | null {
  const [state, setState] = useState<ShellState | null>(null);

  useEffect(() => {
    // Pull *then* subscribe, because on first paint the view may still be loading when main
    // broadcasts, and a push-only wiring left the rail blank (decisions #13).
    //
    // But the pull is async and the subscription is not, so a broadcast can land while the initial
    // fetch is still in flight — and the fetch would then overwrite newer state with the snapshot
    // it started with. `sync()` fires on every mutation, so the window is small and real. Once
    // anything has been pushed, the initial fetch is by definition stale and is dropped.
    let pushed = false;
    let live = true;

    void window.hangar.getState().then((s) => {
      if (s && live && !pushed) setState(s);
    });

    const unsubscribe = window.hangar.onState((s) => {
      pushed = true;
      setState(s);
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return state;
}
