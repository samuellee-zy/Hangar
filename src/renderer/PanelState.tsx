import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const Saved = createContext<Record<string, unknown>>({});

/** Main retains only small UI values when a closed panel's renderer is reclaimed. */
export function PanelState({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let live = true;
    void window.hangar.getPanelState().then((state) => { if (live) setSaved(state); });
    return () => { live = false; };
  }, []);
  return saved ? <Saved.Provider value={saved}>{children}</Saved.Provider> : null;
}

export function usePanelState<T>(key: string, initial: T) {
  const saved = useContext(Saved);
  const [value, setValue] = useState<T>(() => (key in saved ? saved[key] : initial) as T);
  useEffect(() => { window.hangar.savePanelState?.(key, value); }, [key, value]);
  return [value, setValue] as const;
}
