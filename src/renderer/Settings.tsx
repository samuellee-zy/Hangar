import { Appearance } from './settings/Appearance';
import { Behaviour } from './settings/Behaviour';
import { Accounts, Connections, CustomHosts, PerService, Workspaces } from './settings/Connections';
import { Keyboard } from './settings/Keyboard';
import { Downloads, Network } from './settings/Network';
import { Notifications } from './settings/Notifications';
import { About, Reset } from './settings/Reset';
import { Data, Storage } from './settings/Storage';
import { Sync } from './settings/Sync';
import { Unread } from './settings/Unread';
import { useShellState } from './useShellState';

/**
 * Its own window rather than another overlay mode, so it can sit beside the app while you change
 * things and watch the effect. Reads every service, not just the active workspace's, since removing
 * or renaming should reach services you can't currently see.
 *
 * Composition only. Each section lives in `settings/` and takes the slice of state it needs — this
 * file was 679 lines of markup in one function, which meant nothing inside it could be rendered on
 * its own and the conflict-resolution UI, the most consequential thing here, had no test at all.
 */
export function Settings() {
  // Same channel as every other surface. Settings used to have its own, which is precisely why it
  // went stale whenever a change originated elsewhere.
  const state = useShellState();
  if (!state) return null;

  const { appearance, behaviour, notifications, network, downloads, sync } = state.preferences;

  return (
    <div className="settings">
      <h1>Settings</h1>

      <Appearance appearance={appearance} />
      <Behaviour behaviour={behaviour} />
      <Notifications notifications={notifications} />
      <Unread state={state} />
      <Workspaces state={state} />
      <Network network={network} />
      <Downloads downloads={downloads} />
      <Connections state={state} />
      <Accounts state={state} />
      <CustomHosts state={state} />
      <Keyboard state={state} />
      <PerService state={state} />
      <Data />
      <Storage state={state} />
      <Sync sync={sync} status={state.syncStatus} />
      <Reset />
      <About state={state} />
    </div>
  );
}
