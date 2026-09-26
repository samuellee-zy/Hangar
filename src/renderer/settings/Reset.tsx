import { catalogById } from '@shared/catalog';
import { ConfirmButton } from '../ConfirmButton';
import type { ShellState } from '@shared/types';

/** The sections a reset can target. Sync and Firebase are excluded — see the hint below. */
const RESETTABLE = [
  'appearance',
  'behaviour',
  'keyboard',
  'notifications',
  'network',
  'downloads',
] as const;

export function Reset() {
  return (
    <section>
      <h2>Reset</h2>
      <p className="hint">
        Restores defaults. Only preferences — your services, accounts and sessions are untouched.
        {' '}
        <b>Reset all leaves the sync repository and your Firebase credentials alone</b>, since
        those are things you fetched from elsewhere rather than settings. Reset those sections
        individually if you do want them cleared.
      </p>
      <ul className="rows">
        {RESETTABLE.map((section) => (
          <li className="pref" key={section}>
            <span className="pref-label">
              <span className="pref-name" style={{ textTransform: 'capitalize' }}>
                {section}
              </span>
            </span>
            <button onClick={() => window.hangar.send({ type: 'reset-preferences', section })}>
              Reset
            </button>
          </li>
        ))}
        <li className="pref">
          <span className="pref-label">
            <span className="pref-name">Everything</span>
            <span className="pref-note">All preferences at once</span>
          </span>
          <ConfirmButton
            confirmLabel="Reset every preference?"
            onConfirm={() => window.hangar.send({ type: 'reset-preferences' })}
          >
            Reset all
          </ConfirmButton>
        </li>
      </ul>
    </section>
  );
}

export function About({ state }: { state: ShellState }) {
  const fromCatalog = state.allServices.filter((s) => catalogById(s.catalogId)).length;

  return (
    <section>
      <h2>About</h2>
      <p className="hint">
        Config lives at <code>~/Library/Application Support/Hangar/config.json</code>. No cloud
        account, no telemetry. Catalog services: {fromCatalog}, custom:{' '}
        {state.allServices.length - fromCatalog}.
      </p>
    </section>
  );
}
