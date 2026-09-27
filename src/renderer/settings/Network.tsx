import { CommitOnBlur } from '../CommitOnBlur';
import { Choice, Toggle } from '../PreferenceControls';
import type { Preferences } from '@shared/types';

export function Network({ network }: { network: Preferences['network'] }) {
  const manual = network.proxy.mode !== 'system' && network.proxy.mode !== 'none';

  return (
    <section>
      <h2>Network</h2>
      <p className="hint">
        Applies to every service, including ones woken from hibernation. "System" uses macOS
        settings.
      </p>
      <ul className="rows">
        <Toggle
          name="Block ads and trackers"
          note="Filter lists are downloaded once and cached. Turn off if a service misbehaves."
          path="network.blockAds"
          value={network.blockAds}
        />
        <Choice name="Proxy" path="network.proxy.mode" value={network.proxy.mode}
                options={['system', 'none', 'http', 'socks4', 'socks5'] as const}
                labels={{ system: 'System settings', none: 'No proxy', http: 'HTTP', socks4: 'SOCKS4', socks5: 'SOCKS5' }} />
        {manual && (
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Host and port</span>
              <span className="pref-note">
                Applied when you finish editing. Until both are set, the system proxy is used
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <CommitOnBlur
                aria-label="Proxy host"
                placeholder="proxy.example.com"
                value={network.proxy.host}
                onCommit={(host) =>
                  window.hangar.send({ type: 'set-preference', path: 'network.proxy.host', value: host })
                }
              />
              {/* Commit on blur, like the host beside it. On change, every character was an atomic
                  config.json write, a sync reconcile reschedule *and* a proxy re-apply across every
                  live session — typing "8080" did all three four times. */}
              <CommitOnBlur
                className="field"
                type="number"
                aria-label="Proxy port"
                min={0}
                max={65535}
                style={{ width: 82 }}
                value={String(network.proxy.port)}
                onCommit={(next) => {
                  const port = Number(next);
                  if (!Number.isFinite(port)) return;
                  window.hangar.send({
                    type: 'set-preference',
                    path: 'network.proxy.port',
                    value: Math.min(65535, Math.max(0, port)),
                  });
                }}
              />
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}

export function Downloads({ downloads }: { downloads: Preferences['downloads'] }) {
  return (
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
            aria-label="Downloads folder"
            placeholder="~/Downloads"
            value={downloads.folder ?? ''}
            onCommit={(folder) =>
              window.hangar.send({
                type: 'set-preference',
                path: 'downloads.folder',
                value: folder.trim() || null,
              })
            }
          />
          {/* A picker as well as the field: typing a path by hand is how the sync repo ended up
              holding a `~` nothing expanded. */}
          <button
            className="secondary"
            onClick={() => window.hangar.send({ type: 'choose-folder', purpose: 'downloads' })}
          >
            Choose…
          </button>
        </li>
      </ul>
    </section>
  );
}
