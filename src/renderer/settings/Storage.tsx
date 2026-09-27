import type { ShellState } from '@shared/types';
import { ConfirmButton } from '../ConfirmButton';

export function Data() {
  return (
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
            <span className="pref-note">A file to keep as a backup, or to import on another Mac</span>
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="secondary" onClick={() => window.hangar.send({ type: 'export-config' })}>
              Export…
            </button>
            <button className="secondary" onClick={() => window.hangar.send({ type: 'import-config' })}>
              Import…
            </button>
          </span>
        </li>
      </ul>
    </section>
  );
}

export function Storage({ state }: { state: ShellState }) {
  return (
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
          <ConfirmButton
            disabled={state.orphanPartitions.length === 0}
            confirmLabel={`Delete ${state.orphanPartitions.length}?`}
            onConfirm={() => window.hangar.send({ type: 'purge-orphan-partitions' })}
          >
            Delete
          </ConfirmButton>
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
  );
}
