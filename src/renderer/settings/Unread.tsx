import { catalogById } from '@shared/catalog';
import { CommitOnBlur } from '../CommitOnBlur';
import type { ServiceInstance, ShellState } from '@shared/types';

/**
 * Where a service's badge number comes from, and the escape hatch for the ones it comes from
 * nowhere.
 *
 * Some catalog entries put their count in the tab title and a couple more publish a stable enough
 * badge to name a selector for. For the rest, the number was a running tally of `new Notification()`
 * calls: it only ever rose, it never noticed you'd read something on your phone, and it sat at zero
 * for anyone who had turned that site's notifications off. Pointing this field at the badge the
 * page already draws replaces all of that with the number the service itself is showing.
 */

export type UnreadSource = 'off' | 'disabled' | 'custom' | 'title' | 'catalog' | 'events';

/**
 * Whether this service also gets asked directly while it is asleep.
 *
 * Reported separately rather than as a seventh `UnreadSource`, because it is not an alternative to
 * the others: an endpoint answers exactly when the page-reading mechanisms cannot, so a service can
 * legitimately have both and the note should say both.
 */
export function hasSleepingEndpoint(svc: ServiceInstance): boolean {
  if (!svc.notifications || svc.notificationLevel === 'muted') return false;
  if (svc.unreadEndpoint !== undefined) return svc.unreadEndpoint !== null;
  return Boolean(catalogById(svc.catalogId)?.unread?.endpoint);
}

/**
 * Exported and pure because the note is the whole feature: "custom selector" and "no detection"
 * look identical in a screenshot and mean opposite things, and getting the order of these checks
 * wrong is a label that quietly lies about which of six paths a count is taking.
 */
export function unreadSourceOf(svc: ServiceInstance): UnreadSource {
  // Detection is skipped entirely for a muted service, so say that rather than describing a rule
  // that will never run.
  if (!svc.notifications || svc.notificationLevel === 'muted') return 'off';
  if (svc.unreadSelector !== undefined) {
    return svc.unreadSelector.trim() === '' ? 'disabled' : 'custom';
  }
  const detection = catalogById(svc.catalogId)?.unread;
  if (detection?.titlePattern) return 'title';
  if (detection?.dom?.length) return 'catalog';
  return 'events';
}

const NOTES: Record<UnreadSource, string> = {
  off: 'notifications off — not counted',
  disabled: 'detection off',
  custom: 'your selector',
  title: 'from the tab title',
  catalog: "from the page's own badge",
  events: 'counting notifications only',
};

export function Unread({ state }: { state: ShellState }) {
  // Only services in the current workspace have a live count to show, and that live count is what
  // makes a selector tunable: type one, watch the number appear.
  const counts = new Map(state.services.map((s) => [s.id, s.unread]));

  return (
    <section>
      <h2>Unread badges</h2>
      <p className="hint">
        A CSS selector for the element a service uses to show its unread count — the number in its
        sidebar or on its inbox. Hangar reads that element and uses it as the count, so the badge
        goes <i>down</i> when you read something, which counting notifications can never do.
        Applies immediately: open the service beside this window and watch the number.
      </p>
      <p className="hint">
        Prefer a <code>data-testid</code> or another attribute the service's own tests use, and
        never a generated class like <code>.css-1x2y3z</code> — those change on every deploy. See
        docs/unread-selectors.md for the full procedure.
      </p>
      <p className="hint">
        Reading the page needs the page, so a hibernated service has nothing to read. Where a
        service publishes a count at a URL of its own, Hangar asks for it directly instead — over
        that service's own signed-in session, so nothing here holds a password or a token.
      </p>
      <ul className="rows">
        {state.allServices.map((svc) => {
          const source = unreadSourceOf(svc);
          const count = counts.get(svc.id);
          return (
            <li key={svc.id} className="pref">
              <span className="pref-label">
                <span className="pref-name">{svc.name}</span>
                <span className="pref-note">
                  {NOTES[source]}
                  {hasSleepingEndpoint(svc) ? ' · asks its API while asleep' : ''}
                  {count ? ` · showing ${count}` : ''}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <CommitOnBlur
                  className="field"
                  allowEmpty
                  style={{ width: 220 }}
                  placeholder={source === 'title' ? 'title pattern in use' : '.unread-badge'}
                  title={`CSS selector for ${svc.name}'s unread badge`}
                  value={svc.unreadSelector ?? ''}
                  onCommit={(unreadSelector) =>
                    window.hangar.send({
                      type: 'update-service',
                      serviceId: svc.id,
                      patch: { unreadSelector },
                    })
                  }
                />
                {/* Clearing the field means "read nothing", which is a real setting — it's how you
                    switch off a catalog rule that has started matching the wrong node. Going back
                    to the catalog therefore needs its own button rather than an empty box. */}
                <button
                  className="secondary"
                  disabled={svc.unreadSelector === undefined}
                  title={`Follow the catalog for ${svc.name}`}
                  onClick={() =>
                    window.hangar.send({
                      type: 'update-service',
                      serviceId: svc.id,
                      patch: { unreadSelector: undefined },
                    })
                  }
                >
                  Default
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
