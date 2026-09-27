import { useState } from 'react';
import { toAccelerator } from '@shared/keyboard';
import { canCompose } from '@shared/mailto';
import { Num, Toggle } from '../PreferenceControls';
import { ChordCapture } from './Keyboard';
import type { Preferences, ShellState } from '@shared/types';

/** Electron's `Command+Shift+H`, shown the way macOS writes it. */
const showAccelerator = (accel: string) =>
  accel
    .replace(/(Command|Cmd|CommandOrControl|CmdOrCtrl)\+/gi, '⌘')
    .replace(/(Control|Ctrl)\+/gi, '⌃')
    .replace(/(Alt|Option)\+/gi, '⌥')
    .replace(/Shift\+/gi, '⇧');

const STATUS_NOTE: Record<NonNullable<ShellState['globalShortcutStatus']>, string> = {
  off: 'Summons or hides Hangar from anywhere',
  active: 'Works from any app',
  taken: 'Another app already uses this — choose a different one',
  invalid: "macOS won't accept this as a global shortcut — choose a different one",
};

export function Behaviour({
  behaviour,
  shortcutStatus = 'off',
  services = [],
  isDefaultMailApp = false,
}: {
  behaviour: Preferences['behaviour'];
  shortcutStatus?: ShellState['globalShortcutStatus'];
  /** Every service, to offer the mail ones as where `mailto:` links go. */
  services?: ShellState['allServices'];
  isDefaultMailApp?: boolean;
}) {
  const mailServices = services.filter((s) => canCompose(s.catalogId));
  // Recorded rather than typed. It was a free-text field for an Electron accelerator string, and
  // what it did with a typo — or a chord another app owned — was write a line to the log.
  const [capturing, setCapturing] = useState(false);
  const setShortcut = (value: string | null) => {
    setCapturing(false);
    window.hangar.send({ type: 'set-preference', path: 'behaviour.globalShortcut', value });
  };
  const current = behaviour.globalShortcut;
  const failed = shortcutStatus === 'taken' || shortcutStatus === 'invalid';

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
                note={behaviour.launchAtLogin
                  ? 'Restarts Hangar after a crash or a force quit, never after you quit it. Applies from your next login'
                  : 'Needs Launch at login — launchd can only restart what it started'}
                path="behaviour.relaunchOnCrash" value={behaviour.relaunchOnCrash}
                disabled={!behaviour.launchAtLogin} />
        <Toggle name="Close to tray" note="Closing the window keeps Hangar running"
                path="behaviour.closeToTray" value={behaviour.closeToTray} />
        {mailServices.length > 0 && (
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Email links open in</span>
              <span className="pref-note">
                {isDefaultMailApp
                  ? 'Hangar is your default email app — clicking an address anywhere starts a message here'
                  : 'Clicking an email address in another app opens Mail until Hangar is the default'}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <select
                aria-label="Email links open in"
                value={behaviour.mailtoServiceId}
                onChange={(e) =>
                  window.hangar.send({
                    type: 'set-preference',
                    path: 'behaviour.mailtoServiceId',
                    value: e.target.value,
                  })
                }
              >
                <option value="">First mail service</option>
                {mailServices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {!isDefaultMailApp && (
                <button
                  className="secondary"
                  onClick={() => window.hangar.send({ type: 'make-default-mail-app' })}
                >
                  Make default
                </button>
              )}
            </span>
          </li>
        )}
        <Toggle name="Open links in your services"
                note="A link to Jira from Slack opens in your Jira, not the browser — when you have that service here"
                path="behaviour.routeLinks" value={behaviour.routeLinks} />
        <Toggle name="Confirm before quitting" path="behaviour.confirmQuit"
                value={behaviour.confirmQuit} />
        <Num name="Default zoom" note="Percent, applied to newly added services"
             path="behaviour.defaultZoom" value={behaviour.defaultZoom}
             min={50} max={200} step={10} scale={100} />
        <li className="pref">
          <span className="pref-label">
            <span className="pref-name">Global shortcut</span>
            <span className={`pref-note${failed ? ' refused' : ''}`} role={failed ? 'alert' : undefined}>
              {current ? STATUS_NOTE[shortcutStatus] : STATUS_NOTE.off}
            </span>
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            {capturing ? (
              <ChordCapture
                onCapture={(chord) => {
                  const accel = toAccelerator(chord);
                  if (accel) setShortcut(accel);
                  else setCapturing(false);
                }}
                onCancel={() => setCapturing(false)}
              />
            ) : (
              <button
                className="chord"
                aria-label={current ? `Global shortcut ${showAccelerator(current)}, change` : 'Set a global shortcut'}
                onClick={() => setCapturing(true)}
              >
                {current ? showAccelerator(current) : 'Set…'}
              </button>
            )}
            {current && !capturing && (
              <button className="secondary" onClick={() => setShortcut(null)}>
                Clear
              </button>
            )}
          </span>
        </li>
      </ul>
    </section>
  );
}
