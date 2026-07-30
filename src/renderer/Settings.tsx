import { catalogById } from '@shared/catalog';
import { Choice, Num, Text, Toggle } from './PreferenceControls';
import { CommitOnBlur } from './CommitOnBlur';
import { useShellState } from './useShellState';

/**
 * Its own window rather than another overlay mode, so it can sit beside the app while you change
 * things and watch the effect. Reads every service, not just the active workspace's, since removing
 * or renaming should reach services you can't currently see.
 */
export function Settings() {
  // Same channel as every other surface. Settings used to have its own, which is precisely why it
  // went stale whenever a change originated elsewhere.
  const state = useShellState();
  if (!state) return null;

  const labelFor = (accountId: string) =>
    state.accounts.find((a) => a.id === accountId)?.label ?? 'unknown';

  const { appearance, behaviour, notifications, network, downloads } = state.preferences;

  // Mirrors main/push.ts. Duplicated rather than imported because the renderer bundle shouldn't
  // pull in a main-process module — the two are four field names long and tested on the main side.
  const firebaseFields = ['projectId', 'appId', 'apiKey', 'messagingSenderId'] as const;
  const missing = firebaseFields.filter((f) => !notifications.firebase[f]?.trim());
  const pushStatus =
    missing.length === 0 ? 'ready' : missing.length === firebaseFields.length ? 'unset' : 'incomplete';

  return (
    <div className="settings">
      <h1>Settings</h1>

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
          <Toggle name="Compact rail" note="Collapse to a sliver, expand on hover"
                  path="appearance.compactRail" value={appearance.compactRail} />
        </ul>
      </section>

      <section>
        <h2>Behaviour</h2>
        <ul className="rows">
          <Num name="Hibernate after" note="Minutes idle before a background service is unloaded. 0 = never"
               path="behaviour.hibernateAfterMinutes" value={behaviour.hibernateAfterMinutes}
               min={0} max={240} step={5} />
          <Toggle name="Launch at login"
                  note="Needs a packaged, code-signed build — no effect from source or an unsigned build"
                  path="behaviour.launchAtLogin" value={behaviour.launchAtLogin} />
          <Toggle name="Start hidden" note="Launch to the tray rather than a window"
                  path="behaviour.startHidden" value={behaviour.startHidden} />
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

      <section>
        <h2>Notifications</h2>
        <ul className="rows">
          <Toggle name="Enabled" path="notifications.enabled" value={notifications.enabled} />
          <Toggle name="Play sound" path="notifications.sound" value={notifications.sound} />
          <Toggle name="Do not disturb" path="notifications.dnd" value={notifications.dnd} />
        </ul>

        <h3>Web Push</h3>
        <p className="hint">
          Lets a service notify you while it's asleep or has never been opened — without this,
          hibernating a service means going silent on it. Hangar registers with Firebase Cloud
          Messaging on the site's behalf and holds the receiving connection itself.
          {' '}
          <b>This needs a free Firebase project of your own.</b> Hangar can't ship one: the API key
          would sit in the source, on a quota shared by everyone. See <code>docs/push.md</code> for
          the three-minute setup.
        </p>
        <ul className="rows">
          <Toggle
            name="Enable Web Push"
            note={
              pushStatus === 'ready'
                ? 'Applies to services with notifications on'
                : pushStatus === 'incomplete'
                  ? `Still needed: ${missing.join(', ')}`
                  : 'Fill in the Firebase project below first'
            }
            path="notifications.push"
            value={notifications.push}
            pending={pushStatus !== 'ready'}
          />
          <Text name="Project ID" path="notifications.firebase.projectId"
                value={notifications.firebase.projectId} placeholder="my-project" />
          <Text name="App ID" path="notifications.firebase.appId"
                value={notifications.firebase.appId} placeholder="1:123…:web:abc…" />
          <Text name="API key" password path="notifications.firebase.apiKey"
                value={notifications.firebase.apiKey} placeholder="AIza…" />
          <Text name="Messaging sender ID" path="notifications.firebase.messagingSenderId"
                value={notifications.firebase.messagingSenderId} placeholder="123456789012" />
        </ul>
      </section>

      <section>
        <h2>Workspaces</h2>
        <p className="hint">
          Each workspace has its own rail contents and remembers its own pane layout. Deleting one
          keeps its services — anything not in another workspace moves to the first.
        </p>
        <ul className="rows">
          {state.workspaces.map((ws) => (
            <li key={ws.id}>
              <CommitOnBlur
                value={ws.name}
                onCommit={(name) =>
                  window.hangar.send({ type: 'rename-workspace', workspaceId: ws.id, name })
                }
              />
              <span className="meta">
                {ws.id === state.activeWorkspaceId ? 'active · ' : ''}
                {ws.items.length} item{ws.items.length === 1 ? '' : 's'}
              </span>
              <button
                className="danger"
                disabled={state.workspaces.length <= 1}
                title={
                  state.workspaces.length <= 1
                    ? 'The last workspace cannot be deleted'
                    : `Delete ${ws.name}`
                }
                onClick={() =>
                  window.hangar.send({ type: 'delete-workspace', workspaceId: ws.id })
                }
              >
                Delete
              </button>
            </li>
          ))}
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">New workspace</span>
              <span className="pref-note">Switch with ⌘⌥1…9</span>
            </span>
            <button
              className="danger"
              onClick={() => window.hangar.send({ type: 'create-workspace', name: 'Workspace' })}
            >
              Add
            </button>
          </li>
        </ul>
      </section>

      <section>
        <h2>Network</h2>
        <p className="hint">
          Applies to every service, including ones woken from hibernation. "System" uses macOS
          settings.
        </p>
        <ul className="rows">
          <Choice name="Proxy" path="network.proxy.mode" value={network.proxy.mode}
                  options={['system', 'none', 'http', 'socks4', 'socks5'] as const} />
          {network.proxy.mode !== 'system' && network.proxy.mode !== 'none' && (
            <li className="pref">
              <span className="pref-label">
                <span className="pref-name">Host and port</span>
                <span className="pref-note">Applied on change</span>
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <CommitOnBlur
                  value={network.proxy.host}
                  onCommit={(host) =>
                    window.hangar.send({ type: 'set-preference', path: 'network.proxy.host', value: host })
                  }
                />
                <input
                  type="number"
                  value={network.proxy.port}
                  min={0}
                  max={65535}
                  style={{ width: 82 }}
                  onChange={(e) => {
                    const port = Number(e.target.value);
                    if (Number.isFinite(port)) {
                      window.hangar.send({
                        type: 'set-preference',
                        path: 'network.proxy.port',
                        value: Math.min(65535, Math.max(0, port)),
                      });
                    }
                  }}
                />
              </span>
            </li>
          )}
        </ul>
      </section>

      <section>
        <h2>Downloads</h2>
        <ul className="rows">
          <Toggle name="Ask where to save each file" path="downloads.askWhereToSave"
                  value={downloads.askWhereToSave} />
          <Toggle name="Open when complete" path="downloads.openOnComplete"
                  value={downloads.openOnComplete} />
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Folder</span>
              <span className="pref-note">Blank uses your system Downloads folder</span>
            </span>
            <CommitOnBlur
              value={downloads.folder ?? ''}
              onCommit={(folder) =>
                window.hangar.send({
                  type: 'set-preference',
                  path: 'downloads.folder',
                  value: folder.trim() || null,
                })
              }
            />
          </li>
        </ul>
      </section>

      <section>
        <h2>Connections</h2>
        <p className="hint">
          Reorder by dragging tiles in the rail. Removing a connection leaves its account signed in.
        </p>
        <ul className="rows">
          {state.allServices.map((svc) => (
            <li key={svc.id}>
              <CommitOnBlur
                value={svc.name}
                onCommit={(name) =>
                  window.hangar.send({ type: 'rename-service', serviceId: svc.id, name })
                }
              />
              <span className="meta">{labelFor(svc.accountId)}</span>
              <button
                className="danger"
                onClick={() =>
                  window.hangar.send({ type: 'remove-service', serviceId: svc.id })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Accounts</h2>
        <p className="hint">
          An account is one cookie jar. Services sharing an account share a login — signing out
          affects all of them.
        </p>
        <ul className="rows">
          {state.accounts.map((account) => {
            const users = state.allServices.filter((s) => s.accountId === account.id);
            return (
              <li key={account.id}>
                <CommitOnBlur
                  value={account.label}
                  onCommit={(label) =>
                    window.hangar.send({ type: 'rename-account', accountId: account.id, label })
                  }
                />
                <span className="meta">
                  {users.length ? users.map((s) => s.name).join(', ') : 'unused'}
                </span>
                <button
                  className="danger"
                  title={`Clear cookies for ${account.label}`}
                  onClick={() =>
                    window.hangar.send({
                      type: 'sign-out-account',
                      accountId: account.id,
                    })
                  }
                >
                  Sign out
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2>Custom connection hosts</h2>
        <p className="hint">
          A custom connection only stays in-app for these domains. If it signs in with Google or
          Okta, add that provider's domain here — otherwise its login opens in your browser.
        </p>
        <ul className="rows">
          {state.allServices.filter((s) => s.allowedHosts).length === 0 && (
            <li className="empty">No custom connections yet.</li>
          )}
          {state.allServices
            .filter((s) => s.allowedHosts)
            .map((svc) => (
              <li key={svc.id}>
                <span className="meta grow">{svc.name}</span>
                <span className="meta">{svc.allowedHosts?.join(', ')}</span>
              </li>
            ))}
        </ul>
      </section>

      <section>
        <h2>Keyboard</h2>
        <p className="hint">
          Rebinding isn't built yet. Shortcuts are intercepted before the page, so a service that
          wants a chord for itself currently loses it.
        </p>
        <ul className="rows keys">
          {[
            ['⌘K', 'Command palette'],
            ['⌘N', 'Add a connection'],
            ['⌘1…9', 'Jump to service'],
            ['⌘⌥1…9', 'Switch workspace'],
            ['⌘\\', 'Split pane'],
            ['⌘⌥← / →', 'Move focus between panes'],
            ['⌘W', 'Close pane'],
            ['⌘[ / ⌘]', 'Back / forward'],
            ['Escape', 'Close overlay'],
          ].map(([chord, label]) => (
            <li key={chord}>
              <kbd>{chord}</kbd>
              <span className="meta grow">{label}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Per-service</h2>
        <p className="hint">
          Zoom applies immediately. Custom CSS, JS and user agent need a reload of that service.
        </p>
        <ul className="rows">
          {state.allServices.map((svc) => (
            <li key={svc.id} className="pref">
              <span className="pref-label">
                <span className="pref-name">{svc.name}</span>
                <span className="pref-note">
                  {svc.customCss ? 'custom CSS · ' : ''}
                  {svc.customJs ? 'custom JS · ' : ''}
                  {svc.hibernate ? 'may hibernate' : 'never hibernates'}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {!catalogById(svc.catalogId) && (
                  <label
                    className="pref-note"
                    style={{ display: 'flex', gap: 4 }}
                    title="Custom connections are denied the microphone and camera unless allowed here"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(svc.allowMedia)}
                      onChange={(e) =>
                        window.hangar.send({
                          type: 'update-service',
                          serviceId: svc.id,
                          patch: { allowMedia: e.target.checked },
                        })
                      }
                    />
                    mic/camera
                  </label>
                )}
                <label className="pref-note" style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={svc.hibernate}
                    onChange={(e) =>
                      window.hangar.send({
                        type: 'update-service',
                        serviceId: svc.id,
                        patch: { hibernate: e.target.checked },
                      })
                    }
                  />
                  hibernate
                </label>
                <input
                  type="number"
                  value={svc.zoom}
                  min={0.5}
                  max={2}
                  step={0.1}
                  style={{ width: 66 }}
                  title="Zoom"
                  onChange={(e) => {
                    const zoom = Number(e.target.value);
                    if (Number.isFinite(zoom)) {
                      window.hangar.send({
                        type: 'update-service',
                        serviceId: svc.id,
                        patch: { zoom: Math.min(2, Math.max(0.5, zoom)) },
                      });
                    }
                  }}
                />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Data</h2>
        <p className="hint">
          Export writes your services, folders and preferences. Cookies and sessions are not
          included — they live beside the config and are specific to this machine.
        </p>
        <ul className="rows">
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Configuration</span>
              <span className="pref-note">No cloud sync by design, so backup is manual</span>
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button className="danger" onClick={() => window.hangar.send({ type: 'export-config' })}>
                Export…
              </button>
              <button className="danger" onClick={() => window.hangar.send({ type: 'import-config' })}>
                Import…
              </button>
            </span>
          </li>
        </ul>
      </section>

      <section>
        <h2>Storage</h2>
        <p className="hint">
          Each account keeps its cookies in its own partition on disk. Removing a connection leaves
          its session behind in case you add it back.
        </p>
        <ul className="rows">
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Unused sessions</span>
              <span className="pref-note">
                {state.orphanPartitions.length === 0
                  ? 'None — nothing to clean up'
                  : `${state.orphanPartitions.length} left by removed connections`}
              </span>
            </span>
            <button
              className="danger"
              disabled={state.orphanPartitions.length === 0}
              onClick={() => window.hangar.send({ type: 'purge-orphan-partitions' })}
            >
              Delete
            </button>
          </li>
        </ul>

        {/* Only rendered when there's something to say. A permanently-empty row inviting you to
            worry about config corruption is worse than no row. */}
        {state.quarantinedConfigs.length > 0 && (
          <>
            <h3>Recovered configuration</h3>
            <p className="hint">
              Hangar couldn't read your configuration at some point and kept the original rather
              than overwriting it. If services or accounts went missing, the copy below is what you
              had. Nothing here is deleted automatically.
            </p>
            <ul className="rows">
              {state.quarantinedConfigs.map((file) => (
                <li className="pref" key={file}>
                  <span className="pref-label">
                    <span className="pref-name">Saved copy</span>
                    <span className="pref-note">{file}</span>
                  </span>
                  <button onClick={() => window.hangar.send({ type: 'reveal-path', path: file })}>
                    Show in Finder
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h2>About</h2>
        <p className="hint">
          Config lives at <code>~/Library/Application Support/Hangar/config.json</code>. No cloud
          account, no telemetry. Catalog services:{' '}
          {state.allServices.filter((s) => catalogById(s.catalogId)).length}, custom:{' '}
          {state.allServices.filter((s) => !catalogById(s.catalogId)).length}.
        </p>
      </section>
    </div>
  );
}
