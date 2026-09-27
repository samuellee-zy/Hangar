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
      {/* Ordered so each setting comes before the ones it switches off: Compact rail above the size
          and labels it overrides, position above the compact rail whose opening depends on it. */}
      <ul className="rows">
        <Choice name="Rail position" path="appearance.railPosition" value={appearance.railPosition}
                options={['left', 'right', 'top', 'bottom'] as const}
                labels={{ left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' }} />
        <Toggle name="Compact rail"
                note={horizontal
                  ? 'A 48px strip of icons'
                  : 'A 48px strip of icons; the chevron opens a panel with names'}
                path="appearance.compactRail" value={appearance.compactRail} />
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
        {/* Named for what it does. As "Density: compact" it sat beside "Compact rail", two settings
            with one word between them — and until their CSS classes were told apart, they did the
            same thing. */}
        <Choice name="Tile spacing" path="appearance.density" value={appearance.density}
                options={['comfortable', 'compact'] as const}
                labels={{ comfortable: 'Comfortable', compact: 'Tight' }} />
        <Choice name="Theme" path="appearance.theme" value={appearance.theme}
                options={['system', 'light', 'dark'] as const}
                labels={{ system: 'Match the system', light: 'Light', dark: 'Dark' }} />
        <Num name="Pane gutter" note="Space around each pane" path="appearance.gutter"
             value={appearance.gutter} min={0} max={24} />
        <Toggle name="Pane headers"
                note="A bar above each pane: its name and page, back, forward and reload, pop out, maximise and close"
                path="appearance.paneHeaders" value={appearance.paneHeaders} />
        <Toggle name="Show tray icon"
                note={closeToTray
                  ? 'Always on while Close to tray is on — otherwise a closed window has no way back'
                  : 'Menu-bar presence with unread count'}
                path="appearance.showTrayIcon" value={appearance.showTrayIcon || closeToTray}
                disabled={closeToTray} />
      </ul>
    </section>
  );
}
