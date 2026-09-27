import { HOUR_MS, tomorrowMorning } from '@shared/time';
import { Text, Toggle } from '../PreferenceControls';
import type { Preferences } from '@shared/types';

/**
 * Mirrors `main/push.ts`. Duplicated rather than imported because the renderer bundle shouldn't
 * pull in a main-process module — the two are four field names long and tested on the main side.
 */
const FIREBASE_FIELDS = ['projectId', 'appId', 'apiKey', 'messagingSenderId'] as const;

export type PushStatus = 'ready' | 'incomplete' | 'unset';

/**
 * Which of the three states the Firebase credential is in, and what's missing.
 *
 * Exported and pure so the "Enable Web Push" note can be tested without rendering: the distinction
 * between *nothing filled in* and *half filled in* is the difference between "set this up" and
 * "you're two fields from done", and getting it backwards is silently unhelpful.
 */
export function pushReadiness(firebase: Preferences['notifications']['firebase']): {
  status: PushStatus;
  missing: string[];
} {
  const missing = FIREBASE_FIELDS.filter((f) => !firebase[f]?.trim());
  if (missing.length === 0) return { status: 'ready', missing };
  return { status: missing.length === FIREBASE_FIELDS.length ? 'unset' : 'incomplete', missing };
}

export function Notifications({
  notifications,
}: {
  notifications: Preferences['notifications'];
}) {
  const { status, missing } = pushReadiness(notifications.firebase);

  return (
    <section>
      <h2>Notifications</h2>
      <ul className="rows">
        <Toggle name="Enabled" path="notifications.enabled" value={notifications.enabled} />
        <Toggle name="Play sound" path="notifications.sound" value={notifications.sound} />
        <DoNotDisturb dnd={notifications.dnd} until={notifications.dndUntil} />
      </ul>

      <h3>Web Push</h3>
      <p className="hint">
        Lets a service notify you while it's asleep or has never been opened — without this,
        hibernating a service means going silent on it. Hangar registers with Firebase Cloud
        Messaging on the site's behalf and holds the receiving connection itself.
        {' '}
        <b>This needs a free Firebase project of your own.</b> Hangar can't ship one: the API key
        would sit in the source, on a quota shared by everyone. The three-minute setup is
        in <code>docs/push.md</code> in the Hangar repository.
      </p>
      <ul className="rows">
        <Toggle
          name="Enable Web Push"
          note={
            status === 'ready'
              ? 'Applies to services with notifications on'
              : status === 'incomplete'
                ? `Still needed: ${missing.join(', ')}`
                : 'Fill in the Firebase project below first'
          }
          path="notifications.push"
          value={notifications.push}
          pending={status !== 'ready'}
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
  );
}

/**
 * Do Not Disturb with a time limit, the same four choices as the tray. It was an on/off toggle, which
 * is a focus session you have to remember to end.
 */
function DoNotDisturb({ dnd, until }: { dnd: boolean; until: number | null }) {
  const current = !dnd ? 'off' : until === null ? 'on' : 'timed';
  const set = (choice: string) => {
    const now = Date.now();
    if (choice === 'off') window.hangar.send({ type: 'set-dnd', on: false, until: null });
    if (choice === 'hour') window.hangar.send({ type: 'set-dnd', on: true, until: now + HOUR_MS });
    if (choice === 'tomorrow') window.hangar.send({ type: 'set-dnd', on: true, until: tomorrowMorning(now) });
    if (choice === 'on') window.hangar.send({ type: 'set-dnd', on: true, until: null });
  };
  const ends = until
    ? new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <li className="pref">
      <span className="pref-label">
        <span className="pref-name">Do not disturb</span>
        <span className="pref-note">
          {current === 'timed'
            ? `On until ${ends}. Banners are held back; unread still counts`
            : 'Banners are held back; unread still counts'}
        </span>
      </span>
      <select aria-label="Do not disturb" value={current === 'timed' ? 'timed' : current} onChange={(e) => set(e.target.value)}>
        <option value="off">Off</option>
        {current === 'timed' && <option value="timed">Until {ends}</option>}
        <option value="hour">For 1 hour</option>
        <option value="tomorrow">Until tomorrow</option>
        <option value="on">Until I turn it off</option>
      </select>
    </li>
  );
}
