import { useEffect, useRef, useState } from 'react';
import { catalogById } from '@shared/catalog';
import { NumberField } from '../PreferenceControls';
import { CommitOnBlur } from '../CommitOnBlur';
import { ConfirmButton } from '../ConfirmButton';
import { Icon } from '../Icon';
import { ServiceIcon } from '../ServiceIcon';
import type { ServiceInstance, ServiceView, ShellState } from '@shared/types';

/**
 * Connections: one list of services, and a page for each.
 *
 * Every service used to be listed four times on this page — its name, its toggles, its "more"
 * fields and its allowed hosts, each a separate list — and twice more elsewhere. With twenty
 * services that was eighty rows, and changing one service meant finding it in each. Now the list
 * is a list, and everything about a service is on its page, which the tile's own menu opens too.
 *
 * Both read `allServices`, not `services`: a service in a workspace you aren't looking at is still
 * one you can rename, change or remove.
 */

export function ServiceList({ state, onOpen }: { state: ShellState; onOpen: (serviceId: string) => void }) {
  const labelFor = (accountId: string) =>
    state.accounts.find((a) => a.id === accountId)?.label ?? 'unknown';
  return (
    <section>
      <h2>Connections</h2>
      <p className="hint">
        Everything about a service is on its page. Reorder them by dragging tiles in the rail.
      </p>
      <ul className="rows">
        {state.allServices.length === 0 && <li className="empty">No connections yet.</li>}
        {state.allServices.map((svc) => (
          <li key={svc.id} className="service-row">
            <span className="service-row-icon" aria-hidden="true">
              <ServiceIcon serviceId={svc.id} initials={svc.initials} name="" version={svc.iconVersion} />
            </span>
            <span className="grow">{svc.name}</span>
            <span className="meta">{labelFor(svc.accountId)}</span>
            <button className="secondary" aria-label={`Settings for ${svc.name}`} onClick={() => onOpen(svc.id)}>
              Settings…
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Splits what was typed into hosts. Main validates each one; this only has to find them. */
export const parseHosts = (text: string): string[] =>
  [...new Set(text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))];

export function ServiceSettings({
  state,
  svc,
  onBack,
}: {
  state: ShellState;
  svc: ServiceView;
  onBack: () => void;
}) {
  const entry = catalogById(svc.catalogId);
  const send = (patch: Partial<ServiceInstance>) =>
    window.hangar.send({ type: 'update-service', serviceId: svc.id, patch });
  const account = state.accounts.find((a) => a.id === svc.accountId);
  const sharing = state.allServices.filter((s) => s.accountId === svc.accountId && s.id !== svc.id);

  return (
    <>
      <p>
        <button className="secondary with-icon" onClick={onBack}>
          <Icon name="chevron-left" size={12} />
          All connections
        </button>
      </p>

      <section>
        <h2>Name and account</h2>
        <ul className="rows">
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Name</span>
            </span>
            <CommitOnBlur
              aria-label={`Connection name, ${svc.name}`}
              value={svc.name}
              onCommit={(name) => window.hangar.send({ type: 'rename-service', serviceId: svc.id, name })}
            />
          </li>
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Account</span>
              <span className="pref-note">
                {sharing.length
                  ? `Signed in together with ${sharing.map((s) => s.name).join(', ')}`
                  : 'Its own sign-in'}
              </span>
            </span>
            <span className="meta">{account?.label ?? 'unknown'}</span>
            {/* A service misbehaving after an update is usually a stale cache, and the only fix on
                offer was Sign out, which cleared everything. */}
            {account && (
              <button
                className="secondary"
                title="Clears cached files and service workers — not cookies, so it stays signed in"
                onClick={() => window.hangar.send({ type: 'clear-account-cache', accountId: account.id })}
              >
                Clear cache
              </button>
            )}
          </li>
        </ul>
      </section>

      <section>
        <h2>Running</h2>
        <ul className="rows">
          <Check
            name="Keep running"
            note="Loads at launch and never hibernates, so it can notify without being in a pane"
            checked={Boolean(svc.keepRunning)}
            onChange={(keepRunning) => send({ keepRunning })}
          />
          <Check
            name="Hibernate when idle"
            note={svc.keepRunning ? 'Not while it is set to keep running' : 'After the time set under General'}
            checked={svc.hibernate}
            disabled={Boolean(svc.keepRunning)}
            onChange={(hibernate) => send({ hibernate })}
          />
          {/* One choice, three answers. "Off" is a mute: it stops the badge as well as the banner —
              the count is pushed back to the page as an empty rule set, so a muted service stops
              watching for a number it is not allowed to report. */}
          <li className="pref">
            <label className="pref-label" htmlFor={`${svc.id}-level`}>
              <span className="pref-name">Notifications</span>
              <span className="pref-note">
                {svc.notificationLevel === 'badge'
                  ? 'Counted on its tile and the Dock, without banners'
                  : svc.notificationLevel === 'muted' || !svc.notifications
                    ? 'No banners and no unread count'
                    : 'Banners, and a count on its tile and the Dock'}
              </span>
            </label>
            <select
              id={`${svc.id}-level`}
              value={!svc.notifications ? 'muted' : (svc.notificationLevel ?? 'all')}
              onChange={(e) => {
                const level = e.target.value as 'all' | 'badge' | 'muted';
                send(level === 'muted' ? { notificationLevel: 'muted' } : { notificationLevel: level, notifications: true });
              }}
            >
              <option value="all">All</option>
              <option value="badge">Badge only</option>
              <option value="muted">Off</option>
            </select>
          </li>
          {!entry && (
            <Check
              name="Microphone and camera"
              note="Custom connections are denied them unless allowed here"
              checked={Boolean(svc.allowMedia)}
              onChange={(allowMedia) => send({ allowMedia })}
            />
          )}
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Zoom</span>
              <span className="pref-note">Percent. Applies immediately</span>
            </span>
            {/* Committed on blur: on change, every digit of "125" was its own config write and sync
                reschedule, and the zoom jumped through each partial value on the way. */}
            <CommitOnBlur
              className="field"
              type="number"
              min={50}
              max={200}
              step={10}
              style={{ width: 66 }}
              aria-label={`Zoom for ${svc.name}, percent`}
              value={String(Math.round(svc.zoom * 100))}
              onCommit={(next) => {
                const percent = Number(next);
                if (!Number.isFinite(percent)) return;
                send({ zoom: Math.min(2, Math.max(0.5, percent / 100)) });
              }}
            />
          </li>
        </ul>
      </section>

      <section>
        <h2>Start page and colour</h2>
        <StartPageAndColour svc={svc} />
      </section>

      <section>
        <h2>Allowed hosts</h2>
        <AllowedHosts svc={svc} />
      </section>

      <section>
        <h2>Advanced</h2>
        <Advanced svc={svc} />
      </section>

      <section>
        <h2>Remove</h2>
        <ul className="rows">
          <li className="pref">
            <span className="pref-label">
              <span className="pref-name">Remove {svc.name}</span>
              <span className="pref-note">
                The tile goes. The account stays signed in, for the other services on it or for next time
              </span>
            </span>
            <ConfirmButton
              title={`Remove ${svc.name}`}
              confirmLabel={`Remove ${svc.name}?`}
              onConfirm={() => {
                window.hangar.send({ type: 'remove-service', serviceId: svc.id });
                onBack();
              }}
            >
              Remove
            </ConfirmButton>
          </li>
        </ul>
      </section>
    </>
  );
}

function Check({
  name,
  note,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  note: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <li className="pref">
      <label className="pref-label">
        <span className="pref-name">{name}</span>
        <span className="pref-note">{note}</span>
      </label>
      <input
        type="checkbox"
        aria-label={name}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </li>
  );
}

/**
 * A different start page — which is also how a catalog entry points at a self-hosted copy: GitLab,
 * Jira or Mattermost on your own domain. That domain is added to the service's extra hosts in the
 * same change, or the page it now opens on would be sent to the browser.
 */
function StartPageAndColour({ svc }: { svc: ServiceView }) {
  const entry = catalogById(svc.catalogId);
  const send = (patch: Partial<ServiceInstance>) =>
    window.hangar.send({ type: 'update-service', serviceId: svc.id, patch });

  const setUrl = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const url = text.includes('://') ? text : `https://${text}`;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    const allowed = [...(svc.allowedHosts ?? entry?.allowedHosts ?? []), ...(svc.extraAllowedHosts ?? [])];
    const covered = allowed.some((h) => host === h || host.endsWith(`.${h}`));
    send(covered ? { url } : { url, extraAllowedHosts: [...(svc.extraAllowedHosts ?? []), host] });
  };

  return (
    <div className="service-more-fields">
      <label>
        <span>Start page</span>
        <CommitOnBlur
          aria-label={`Start page for ${svc.name}`}
          placeholder={entry?.url ?? svc.url ?? 'https://'}
          value={svc.url ?? ''}
          onCommit={setUrl}
        />
      </label>
      <label>
        <span>Colour</span>
        <ColourField svc={svc} onCommit={(color) => send({ color })} />
      </label>
    </div>
  );
}

/**
 * The picker, written once when you let go of it. It sent an update on every change event, so
 * dragging across the swatch wrote the config — and scheduled a sync — dozens of times a second.
 */
function ColourField({ svc, onCommit }: { svc: ServiceView; onCommit: (colour: string) => void }) {
  const stored = /^#[0-9a-f]{6}$/i.test(svc.color) ? svc.color : '#666666';
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  return (
    <input
      type="color"
      aria-label={`Colour for ${svc.name}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== stored && onCommit(draft)}
    />
  );
}

/**
 * Where the service may navigate without being sent to the browser, and a field to add more.
 *
 * What you type is additive — `extraAllowedHosts` — and never replaces the catalog's own list, for
 * the reason on that field. Main keeps only valid hostnames, so the field showing back what was
 * accepted is the feedback when something wasn't.
 */
function AllowedHosts({ svc }: { svc: ServiceView }) {
  const base = svc.allowedHosts ?? catalogById(svc.catalogId)?.allowedHosts ?? [];
  return (
    <>
      <p className="hint">
        It only stays in the app on these domains; anything else opens in your browser. If it signs
        in through Google, Okta or your company's SSO, add that domain — separate several with commas.
      </p>
      <ul className="rows">
        <li>
          <span className="meta grow" title={base.join(', ')}>
            {base.length ? base.join(', ') : 'None of its own'}
          </span>
        </li>
        <li>
          <CommitOnBlur
            aria-label={`Extra allowed hosts for ${svc.name}`}
            placeholder="login.example.com"
            allowEmpty
            value={(svc.extraAllowedHosts ?? []).join(', ')}
            onCommit={(text) =>
              window.hangar.send({
                type: 'update-service',
                serviceId: svc.id,
                patch: { extraAllowedHosts: parseHosts(text) },
              })
            }
          />
        </li>
      </ul>
    </>
  );
}

function Advanced({ svc }: { svc: ServiceView }) {
  const send = (patch: Partial<ServiceInstance>) =>
    window.hangar.send({ type: 'update-service', serviceId: svc.id, patch });
  return (
    <div className="service-more-fields">
      <label>
        <span>Keep signed in for</span>
        <NumberField
          aria-label={`Days to keep ${svc.name} signed in`}
          value={svc.cookieTtlDays ?? 30}
          min={0}
          max={400}
          onCommit={(days) => send({ cookieTtlDays: days })}
        />
        <span className="meta">days · 0 leaves its cookies alone</span>
      </label>
      <label>
        <span>User agent</span>
        <CommitOnBlur
          aria-label={`User agent for ${svc.name}`}
          placeholder="Hangar's default"
          allowEmpty
          value={svc.userAgent ?? ''}
          onCommit={(ua) => send({ userAgent: ua })}
        />
        <span className="meta">applies from the next page load</span>
      </label>
      <label className="stack">
        <span>Custom CSS — applied on every page load</span>
        <CommitArea
          aria-label={`Custom CSS for ${svc.name}`}
          placeholder="/* e.g. hide a banner */"
          value={svc.customCss ?? ''}
          onCommit={(css) => send({ customCss: css })}
        />
      </label>
      <label className="stack">
        <span>Custom JavaScript — runs in the page, and stays on this Mac (it never syncs)</span>
        <CommitArea
          aria-label={`Custom JavaScript for ${svc.name}`}
          value={svc.customJs ?? ''}
          onCommit={(js) => send({ customJs: js })}
        />
      </label>
    </div>
  );
}

/** A textarea that commits on blur, for CSS and JS — both far too long for an input. */
function CommitArea({
  value,
  onCommit,
  ...area
}: {
  value: string;
  onCommit: (next: string) => void;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onBlur'>) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <textarea
      className="field code"
      spellCheck={false}
      rows={4}
      {...area}
      value={draft}
      onFocus={() => (editing.current = true)}
      onChange={(e) => {
        editing.current = true;
        setDraft(e.target.value);
      }}
      onBlur={() => {
        editing.current = false;
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}
