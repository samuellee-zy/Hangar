import { Choice, Num, Toggle } from '../PreferenceControls';
import type { Preferences } from '@shared/types';

/**
 * Pure preference rows — every control is a `set-preference` and nothing else, so this section has
 * no state of its own and no way to disagree with what's stored.
 */
export function Appearance({ appearance }: { appearance: Preferences['appearance'] }) {
  return (
    <section>
      <h2>Appearance</h2>
      <p className="hint">Applies immediately.</p>
      <ul className="rows">
        <Num name="Rail size" note="Thickness in pixels" path="appearance.railSize"
             value={appearance.railSize} min={56} max={120} step={4} />
        <Toggle name="Show labels" note="Service names under each icon"
                path="appearance.showLabels" value={appearance.showLabels} />
        <Toggle name="Show tray icon" note="Menu-bar presence with unread count"
                path="appearance.showTrayIcon" value={appearance.showTrayIcon} />
        <Choice name="Rail position" path="appearance.railPosition" value={appearance.railPosition}
                options={['left', 'right', 'top', 'bottom'] as const} />
        <Choice name="Theme" path="appearance.theme" value={appearance.theme}
                options={['system', 'light', 'dark'] as const} />
        <Choice name="Density" path="appearance.density" value={appearance.density}
                options={['comfortable', 'compact'] as const} />
        <Num name="Pane gutter" note="Space around each pane" path="appearance.gutter"
             value={appearance.gutter} min={0} max={24} />
        <Toggle name="Compact rail" note="Hide the rail behind a chevron"
                path="appearance.compactRail" value={appearance.compactRail} />
      </ul>
    </section>
  );
}
