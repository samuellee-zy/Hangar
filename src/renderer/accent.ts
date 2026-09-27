import { useEffect, useState } from 'react';

export { accentFor, brightenForDark, type ColorScheme } from '@shared/accent';

const LIGHT = '(prefers-color-scheme: light)';

/**
 * The theme this renderer is drawing, following changes live. Electron drives
 * `prefers-color-scheme` from `nativeTheme.themeSource`, so this is the `theme` preference.
 */
export function useColorScheme(): 'dark' | 'light' {
  const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(LIGHT) : null);
  const [light, setLight] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const update = () => setLight(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return light ? 'light' : 'dark';
}
