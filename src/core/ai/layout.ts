import type { Rect } from '@shared/types';

/** Reserve native view space; a small window gets one usable screen with a clear return action. */
export function assistantLayout(area: Rect, open: boolean, preferred = 420): { panel: Rect | null; content: Rect; reserved: number; covered: boolean } {
  if (!open) return { panel: null, content: area, reserved: 0, covered: false };
  const width = Math.round(Math.max(320, Math.min(600, Number.isFinite(preferred) ? preferred : 420)));
  const covered = area.width < width + 520;
  if (covered) return { panel: area, content: { ...area, width: 0 }, reserved: 0, covered: true };
  return { panel: { ...area, x: area.x + area.width - width, width }, content: { ...area, width: area.width - width }, reserved: width, covered: false };
}
