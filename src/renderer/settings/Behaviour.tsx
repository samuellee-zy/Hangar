import { CommitOnBlur } from '../CommitOnBlur';
import { Num, Toggle } from '../PreferenceControls';
import type { Preferences } from '@shared/types';

export function Behaviour({ behaviour }: { behaviour: Preferences['behaviour'] }) {
  return (
    <section>
      <h2>Behaviour</h2>
      <ul className="rows">
        <Num name="Hibernate after" note="Minutes idle before a background service is unloaded. 0 = never"
             path="behaviour.hibernateAfterMinutes" value={behaviour.hibernateAfterMinutes}
             min={0} max={240} step={5} />
        <Toggle name="Launch at login"
                note="Starts Hangar when you log in. Takes effect from your next login"
                path="behaviour.launchAtLogin" value={behaviour.launchAtLogin} />
        <Toggle name="Relaunch if it stops unexpectedly"
                note="Restarts Hangar after a crash or a force quit, never after you quit it. Needs launch at login, and applies from your next login"
                path="behaviour.relaunchOnCrash" value={behaviour.relaunchOnCrash} />
        <Toggle name="Close to tray" note="Closing the window keeps Hangar running"
                path="behaviour.closeToTray" value={behaviour.closeToTray} />
        <Toggle name="Confirm before quitting" path="behaviour.confirmQuit"
                value={behaviour.confirmQuit} />
        <Num name="Default zoom" note="Applied to newly added services"
             path="behaviour.defaultZoom" value={behaviour.defaultZoom}
             min={0.5} max={2} step={0.1} />
        <li className="pref">
          <span className="pref-label">
            <span className="pref-name">Global shortcut</span>
            <span className="pref-note">
              Summons or hides Hangar from anywhere. e.g. Cmd+Shift+H — blank to disable
            </span>
          </span>
          <CommitOnBlur
            aria-label="Global shortcut"
            placeholder="Cmd+Shift+H"
            value={behaviour.globalShortcut ?? ''}
            onCommit={(accel) =>
              window.hangar.send({
                type: 'set-preference',
                path: 'behaviour.globalShortcut',
                value: accel.trim() || null,
              })
            }
          />
        </li>
      </ul>
    </section>
  );
}
