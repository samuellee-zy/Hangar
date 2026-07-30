import { useEffect, useState } from 'react';
import type { ShellState } from '../shared/types';

/**
 * The renderer's only source of truth. It fetches once, then subscribes — it never derives or
 * caches shell state locally, because main owns all of it. Keeping this rule is what makes the
 * visual redesign a renderer-only change later.
 */
export function useShellState(): ShellState | null {
  const [state, setState] = useState<ShellState | null>(null);

  useEffect(() => {
    void window.hangar.getState().then((s) => s && setState(s));
    return window.hangar.onState(setState);
  }, []);

  return state;
}
