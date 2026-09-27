import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { useFocusTrap } from './useFocusTrap';
import { useShellState } from './useShellState';

/**
 * Recent notifications and downloads, in the window.
 *
 * Both were kept all along — thirty notifications, the last downloads — and shown only in the menu
 * of a tray icon that is off by default, so out of the box there was no way to see either. A banner
 * you missed, or one Do Not Disturb held back, is here, and so is the way to the file you just got.
 */
export function ActivitySheet() {
  const state = useShellState();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);

  const close = () => window.hangar.send({ type: 'close-overlay' });
  const nameOf = (id: string) => state?.allServices.find((s) => s.id === id)?.name ?? 'A removed service';
  const recent = state?.recentNotifications ?? [];
  const downloads = state?.downloads ?? [];
  const unread = (state?.allServices ?? []).reduce((sum, s) => sum + s.unread, 0);

  return (
    <div className="scrim" onClick={close}>
      <div
        className="sheet activity-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Recent notifications and downloads"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <header className="shortcut-head">
          <h2>Recent</h2>
          <button ref={closeRef} className="shortcut-close" aria-label="Close" onClick={close}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="activity-body">
          <section aria-labelledby="activity-notifications">
            <div className="activity-section-head">
              <h3 id="activity-notifications">Notifications</h3>
              {unread > 0 && (
                <button className="activity-action" onClick={() => window.hangar.send({ type: 'mark-all-read' })}>
                  Mark all as read
                </button>
              )}
            </div>
            {recent.length === 0 ? (
              <p className="activity-empty">Nothing yet. Notifications you miss, or that Do Not Disturb holds back, collect here.</p>
            ) : (
              <ul className="activity-list">
                {recent.map((n) => (
                  <li key={`${n.serviceId}:${n.at}`}>
                    <button
                      className="activity-row"
                      onClick={() => {
                        close();
                        window.hangar.send({ type: 'focus-service', serviceId: n.serviceId });
                      }}
                    >
                      <span className="activity-title">
                        <strong>{nameOf(n.serviceId)}</strong> · {n.title}
                      </span>
                      {n.body && <span className="activity-detail">{n.body}</span>}
                      <time className="activity-time" dateTime={new Date(n.at).toISOString()}>
                        {ago(n.at)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="activity-downloads">
            <div className="activity-section-head">
              <h3 id="activity-downloads">Downloads</h3>
            </div>
            {downloads.length === 0 ? (
              <p className="activity-empty">Nothing downloaded this session.</p>
            ) : (
              <ul className="activity-list">
                {downloads.map((d) => (
                  <li key={d.id}>
                    <button
                      className="activity-row"
                      disabled={d.state !== 'completed'}
                      onClick={() => window.hangar.send({ type: 'reveal-download', id: d.id })}
                    >
                      <span className="activity-title">{d.name}</span>
                      <span className="activity-detail">
                        {d.state === 'completed'
                          ? 'Show in Finder'
                          : d.state === 'progressing'
                            ? d.total
                              ? `${Math.floor((d.received / d.total) * 100)}%`
                              : 'Downloading…'
                            : d.state === 'cancelled'
                              ? 'Cancelled'
                              : 'Failed'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** "just now", "5 min ago", "2 h ago", or the time of day for anything older. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 12) return `${hours} h ago`;
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
