/**
 * Structural types for what the receiver hands back.
 *
 * Declared locally rather than imported from `@eneris/push-receiver` so `push.ts` stays free of
 * runtime imports and can be bundled and run under plain node by the check suite. The library's
 * own types are used in `push-manager.ts`, where the socket actually lives.
 */

export interface MessageEnvelope {
  /** The decrypted payload. Site-defined — see `extractNotification`. */
  message: unknown;
  /** FCM's id for the delivery, used to suppress replays on reconnect. */
  persistentId: string;
}

/** The three values a site needs to complete `pushManager.subscribe()`. */
export interface PushSubscriptionData {
  endpoint: string;
  p256dh: string;
  auth: string;
}
