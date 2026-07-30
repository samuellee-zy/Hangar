# Web Push

## What it's for

Notification parity (Phase 3.1) forwards `window.Notification` from a page that's **loaded**. That
covers the ordinary case and none of the interesting one: a hibernated service, or one you haven't
opened since launch, can't fire a notification because nothing is running.

So hibernation currently means *going silent* on a service — a memory saving whose cost is
invisible until you miss something. Web Push is what removes that trade-off.

## How it works

The Push API has three parties: the page, a push service, and the site's own server.

1. The page calls `pushManager.subscribe({applicationServerKey})` and gets a **subscription** —
   an endpoint URL plus two keys (`p256dh`, `auth`).
2. It POSTs that subscription to its own servers.
3. Later, the server encrypts a payload against those keys and POSTs it to the endpoint.
4. The push service routes it to whoever holds the matching registration.

Hangar inserts itself at step 1. It registers with Firebase Cloud Messaging *on the site's behalf*,
hands the site an FCM endpoint, and keeps the receiving socket in the main process. When the push
arrives, main decrypts it and raises a native notification.

The page is never involved, which is the entire point.

```
Slack's server ──encrypted──▶ FCM ──MCS socket──▶ Hangar (main) ──▶ native notification
                                                        │
                            no renderer required ───────┘
```

## Why you have to supply a Firebase project

**This is the part that can't be designed away.** FCM web registration goes through
`firebaseinstallations.googleapis.com`, which requires `apiKey`, `appId` and `projectId`. Google
decommissioned the older sender-id-only subscribe path, so anonymous registration no longer exists.

Hangar can't ship a project of its own. The `apiKey` would sit in the repository in plain text;
every user's notifications would route through one quota; and any one person's abuse would get that
project revoked for everybody. Rambox can embed one because Rambox is a company with a support
channel. A repo you cloned is not.

So the credentials are yours. A Firebase project on the free Spark tier costs nothing, FCM is not
metered on it, and setup is about three minutes.

### Setup

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and **Add project**.
   Analytics is not needed — turn it off.
2. In the project, click the **web** icon (`</>`) to register a web app. Any nickname. You do not
   need Firebase Hosting.
3. Firebase shows you a `firebaseConfig` block. Four values from it go into Hangar:

   | Firebase | Hangar (Settings → Notifications → Web Push) |
   | --- | --- |
   | `projectId` | Project ID |
   | `appId` | App ID |
   | `apiKey` | API key |
   | `messagingSenderId` | Messaging sender ID |

4. Turn on **Enable Web Push**. The toggle stays disabled until all four are filled in, and tells
   you which are missing.
5. Open each service you want push for. Registration happens the first time the site calls
   `subscribe()`, which is usually immediately on load.

The `apiKey` is not a secret in the way a password is — it identifies the project, and Firebase
docs say as much — but Hangar masks the field anyway, because screenshots of a settings pane get
shared.

## Design notes

**Opt-in at every level.** Global toggle, credentials present, the service's own notification
toggle, and not muted. Intercepting `pushManager.subscribe` changes how a site behaves — its
service worker stops receiving push events — so it never happens to a service that didn't ask.

**One socket per service, and that's not an accident.** A registration is bound to the VAPID key it
was created with; FCM rejects a push signed by a key that doesn't match. So registrations can't be
shared between services, and five push-enabled services means five connections to
`mtalk.google.com`. That cost is the reason push is per-service rather than on by default.

**Registrations are persisted.** Re-registering on each launch would hand the site a fresh endpoint
and orphan the one its servers are already pushing to. Credentials also *rotate*, and a rotation
that isn't saved means the next launch presents a stale registration, FCM rejects it, and push
quietly stops working — so `onCredentialsChanged` writes through immediately.

**Replays are suppressed.** FCM redelivers unacknowledged messages on reconnect, which is right for
a transport and wrong for a notification centre. Delivered `persistentId`s are remembered, capped at
512 and trimmed oldest-first.

**Payload shape is site-defined.** There is no schema for a web push body — it's whatever the
site's own service worker expects. `extractNotification` tries the shapes that actually occur
(`notification`, `data.notification` as a nested JSON string, `data`, top level) and several field
aliases, then gives up rather than guessing. A payload with a body and no title still gets the
service name attached: with four Slacks configured, "ping" from an unnamed source is useless.

**Failures degrade to the status quo ante.** `subscribePush` resolves to `null` rather than
rejecting whenever push is unavailable, and the page then calls the browser's original `subscribe`.
A misconfigured project means the service behaves exactly as it did before this feature existed.

## Known limitations

**Only `aesgcm` payloads decrypt.** The receiver library implements draft-03 encryption, not the
final RFC 8291 `aes128gcm`. Sites that use the newer scheme will have their pushes dropped with a
warning in the log. This is upstream, not something Hangar can work around locally.

**Non-JSON payloads are dropped.** The library `JSON.parse`s the decrypted body unconditionally, so
a site sending plain text throws inside the receiver and the message is lost.

**Delivery to a sleeping service is verified; the transport is not.** For its entire first version
this feature did **not** work for the case it exists for — `handleNotification` bailed on a missing
runtime, and a hibernated service has no runtime by definition, so every push it was built to
deliver was decrypted, deduplicated, marked consumed, and discarded. See
[decisions #56](decisions.md).

That went unnoticed because verification stopped at "subscribe is intercepted", on the assumption
that testing delivery needed a Firebase project and a real inbound message. It needed neither:
`handlePushMessage` receives an *already decrypted* payload, so a synthetic one exercises everything
downstream of decryption — which is exactly where the bug was. `HANGAR_PROBE` now sleeps a service,
injects a payload, and asserts the count rises:

```
[probe] hibernated push to "Calendar": sleeping=true, unread 1 -> 2 (badge 2)
```

What remains unverified is the **transport** — FCM registration, the MCS socket, and real
end-to-end decryption. That does need your Firebase project and a real message. Test it with a DM
to yourself with the service hibernated.

**The site's service worker never sees the push.** We notify from main instead. Anything the worker
would have done beyond showing a notification — syncing read state, badging in-page — doesn't
happen.

## Where the code is

| File | Role |
| --- | --- |
| [`src/core/push/policy.ts`](../src/core/push/policy.ts) | Pure policy: eligibility, dedupe, payload extraction, backoff |
| [`src/main/features/push-manager.ts`](../src/main/features/push-manager.ts) | Sockets, registration, reconnect, persistence |
| [`src/preload/service.ts`](../src/preload/service.ts) | The `PushManager.prototype` patch, in the page's world |
| [`src/core/notify/unread.ts`](../src/core/notify/unread.ts) | Counts keyed by service id, surviving hibernation — what makes delivery possible |
| [`tests/main/push.test.ts`](../tests/main/push.test.ts) | 25 checks over the policy |
