import { nativeTheme } from 'electron';
import { CLASSIC_WINDOW_BUTTONS, type WindowButtonMetrics } from '@core/workspace/layout';

/**
 * The app's own background — `--bg` in styles.css, in whichever theme is showing — for anything
 * native that paints before, or around, a renderer.
 *
 * The main window's was fixed dark. It shows wherever no view is drawn, which is the strip holding
 * the traffic lights and the gutters between panes, so a light theme drew a black band across the
 * top of a light rail.
 */
export function appBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f4f4f6';
}

/**
 * How big the traffic lights are, which the OS decides and Electron doesn't report.
 *
 * macOS 26 drew them larger — 14pt buttons 9pt apart, a 60pt span, where every release before had
 * 12pt buttons in 52pt. Laid out for the old size they sat off-centre in a left rail, 10pt from
 * one edge and 2pt from the other, and crowded the first tile of a top rail.
 */
export function windowButtonMetrics(): WindowButtonMetrics {
  const major = Number.parseInt(process.getSystemVersion().split('.')[0] ?? '', 10);
  return major >= 26 ? { span: 60, height: 14 } : CLASSIC_WINDOW_BUTTONS;
}
