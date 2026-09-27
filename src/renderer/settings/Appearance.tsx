import { Choice, Num, Toggle } from '../PreferenceControls';
import type { Preferences } from '@shared/types';

/**
 * Pure preference rows — every control is a `set-preference` and nothing else, so this section has
 * no state of its own and no way to disagree with what's stored.
 */
export function Appearance({
  appearance,
  closeToTray = false,
}: {
  appearance: Preferences['appearance'];
  /** Forces the tray icon on, so its toggle has to say so rather than read unchecked. */
  closeToTray?: boolean;
}) {
  const horizontal = appearance.railPosition === 'top' || appearance.railPosition === 'bottom';
  // Rows that read as settings and did nothing: a compact rail is 48px shut and 180px open whatever
  // the size says, and neither it nor a horizontal rail draws labels under icons.
  const sizeIgnored = appearance.compactRail;
  const labelsIgnored = appearance.compactRail || horizontal;
  return (
    <section>
      <h2>Appearance</h2>
      <p className="hint">Applies immediately.</p>
      <ul className="rows">
        <Num name="Rail size"
             note={sizeIgnored ? 'Not used by a compact rail, which has sizes of its own' : 'Thickness in pixels'}
             path="appearance.railSize" value={appearance.railSize} min={56} max={120} step={4}
             disabled={sizeIgnored} />
        <Toggle name="Show labels"
                note={labelsIgnored
                  ? appearance.compactRail
                    ? 'A compact rail shows names in its opened panel instead'
                    : 'A top or bottom rail has no room for names'
                  : 'Service names under each icon'}
                path="appearance.showLabels" value={appearance.showLabels} disabled={labelsIgnored} />
        <Toggle name="Show tray icon"
                note={closeToTray
                  ? 'Always on while Close to tray is on — otherwise a closed window has no way back'
                  : 'Menu-bar presence with unread count'}
                path="appearance.showTrayIcon" value={appearance.showTrayIcon || closeToTray}
                disabled={closeToTray} />
        <Choice name="Rail position" path="appearance.railPosition" value={appearance.railPosition}
                options={['left', 'right', 'top', 'bottom'] as const} />
        <Choice name="Theme" path="appearance.theme" value={appearance.theme}
                options={['system', 'light', 'dark'] as const} />
        <Choice name="Density" path="appearance.density" value={appearance.density}
                options={['comfortable', 'compact'] as const} />
        <Num name="Pane gutter" note="Space around each pane" path="appearance.gutter"
             value={appearance.gutter} min={0} max={24} />
        <Toggle name="Compact rail" note="A 48px strip of icons; the chevron opens a panel with names"
                path="appearance.compactRail" value={appearance.compactRail} />
      </ul>
    </section>
  );
}
