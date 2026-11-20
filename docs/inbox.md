# Unified chats

This describes the Slack-first pilot installed locally on 18 October 2026. It is not a completed multi-provider Phase 1 release; see the [combined implementation plan](unified-dm-chat-plan.md#execution-status-and-remaining-gates). The user explicitly resumed testing on 18 October. The installed app's existing Decagon connection successfully listed DMs and displayed real message bodies; no messages were sent during testing.

The clarified Phase 1 target also requires group chats, New conversation and inline text sending/replies across Slack, WhatsApp and Messenger. Those interactions and the WhatsApp/Messenger message adapters are not implemented in this pilot. [Planned chat flow](unified-dm-chat-plan.md#starting-and-continuing-conversations).

Open **Chats** in the rail or View menu, or with **⌘⇧I** (Ctrl⇧I elsewhere). The list contains verified one-to-one conversations with message-reading support. Slack channels, Gmail and names-only web-page observations stay outside it. Search and app panes remain available independently.

Use the local conversation filter, app/account selector or **Unread only**. Unknown read states are excluded from Unread only. The current workspace is the default; all workspaces is explicit. Each conversation keeps its source account and app identity. App colours are accompanied by labels.

## Connect an account

The normal flow is **Connections → Connect Slack → sign in in your browser → approve read access**. Hangar's publisher must register and configure its Slack app once; users should not need their own developer apps. A workplace may require admin approval. When a build has no registration, Connections explains that message access is not configured instead of asking for a client ID. Optional **Developer connection settings** remain available for integration work.

API authorization is separate from an embedded app's web login. Signing into Slack's pane does not authorize this reader. The API account identity is displayed so mismatches remain visible. WhatsApp and Messenger message adapters are not enabled yet; their existing app panes still work.

For maintainers: the [Hangar Slack manifest](../config/connectors/slack-app-manifest.json) is registered in the publisher's personal workspace, with PKCE and token rotation enabled. The [public registration](../config/connectors/registrations.json) supplies the client ID; `HANGAR_SLACK_CLIENT_ID` can override it at build time. There is no bundled client secret. The registered redirect is `hangar://oauth/slack`, handled by the installed app with an in-memory, single-use state check. Development builds must not start sign-in while an older installed Hangar owns that URL scheme. Slack's distribution screen rejected the original HTTP loopback callback; the native callback passed its prerequisites and cross-workspace distribution is enabled. [Slack PKCE](https://docs.slack.dev/authentication/using-pkce/).

The current grant requests user scopes `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `im:read` and `users:read`; it covers existing search as well as Chats. No send or mark-read scopes are requested. Existing connections need reauthorization for newly added scopes. On 18 October 2026, the initial live OAuth trial in Sam Workspace loaded three DM entries and displayed a real Slack system message; it used the original loopback callback in an isolated profile. A subsequent installed-app test verified Decagon access, conversation pagination from 20 to 40, message reading and refresh. The connection was already present when inspected, so this is not independent observation of a fresh native-callback sign-in.

Gmail remains a separate email/search capability, outside Chats. Its developer connection uses a Google Desktop OAuth client, Gmail API and `gmail.readonly`. Public distribution still needs the applicable Google verification. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).

Tokens remain encrypted through Electron `safeStorage` in `connector-credentials.enc`, separate from config/export/sync. Locked credential protection and Linux's insecure `basic_text` backend fail closed. Disconnect clears the local connection, profiles and fetched content; upstream OAuth revocation is a separate provider action.

## Reading and limits

- Slack enumerates verified `is_im` conversations in pages of 20. Names are resolved when the grant permits it. Unknown timestamps/read states remain unknown; third-party roster responses may omit latest-message previews.
- Selecting a DM fetches 15 history messages at a time, renders chronological text with incoming/outgoing direction, and supports older-page loading. The view is bounded to 500 messages. Retention and rate limits can prevent older access.
- The visible list and selected message window refresh every 90 seconds. The reader preserves position and offers a new-activity button when scrolled away from the bottom. Refresh replaces the latest history window, including deleted messages; durable deletion synchronization across older pages is still pending.
- **Reply in Slack** opens the account's original conversation. The API reader never sends or marks messages read; opening the original app may do so. Attachments are explicit placeholders.
- Gmail and names-only probes are not refreshed just to populate Chats. They remain usable by the existing separately scoped search flow.
- Bodies are still in memory. Encrypted durable history/session storage, WhatsApp/Messenger adapters and their live-account verification are outstanding Phase 1 gates. Closing/restarting does not provide offline history.

## Architecture and verification

`src/connectors/` is the platform-free capability broker. It enforces account grants, capability versions, execution targets, cancellation/deadlines and bounded JSON. `src/main/connectors/modules.ts` adapts existing Slack/Gmail readers into resource envelopes while keeping credentials and AbortSignals in the desktop host. A synthetic document adapter tests domain independence. `tsconfig.portable.json` and dependency checks prohibit platform imports in portable code.

The owned Chats main frame alone can invoke the validated inbox IPC. Provider text is rendered as text. Sender identity, capability scope, revocation, pagination and Gmail isolation have automated tests. Electron tests cover native views, layout and accessibility. The iOS JavaScriptCore probe establishes only a core-runtime compatibility result; phone login, vault, background work, push and Android support remain to be validated.
