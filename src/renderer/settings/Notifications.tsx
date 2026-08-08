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
