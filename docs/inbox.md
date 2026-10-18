# Unified inbox

Open **Inbox** in the rail, the View menu, or with **⌘⇧I** (Ctrl⇧I on other platforms; rebindable in Settings). It is a read-only destination alongside the existing app panes. Switch back with **Back to apps** or any app tile.

Group by category or app, filter an account, and select a conversation to read its plain-text preview. The default scope is the current workspace. All workspaces is an explicit choice. **Filter loaded conversations** is a local filter over recent results, not a historical search. Opening the original source may trigger its own read receipt; previews in Hangar never issue mark-read, archive or send requests.

## Connect Slack and Gmail

Use **Connections → Connect read access** for an existing Slack/Gmail pane. API access is independent of the pane's web login; the returned remote identity is shown so an account mismatch is visible. One remote account can be connected once. No production OAuth app registration is bundled in this repository.

- **Slack:** create/configure your Slack app as a public PKCE client. Register `http://localhost:53682/oauth/callback`. Paste its client ID, then continue in the system browser. Hangar requests user scopes `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`; no bot or write scopes. Enabling PKCE is a one-way Slack app setting. [Slack's setup instructions](https://docs.slack.dev/authentication/using-pkce/).
- **Gmail:** enable Gmail API in your Google Cloud project and create a **Desktop app** OAuth client. Configure the consent screen/test users, then enter the issued client ID and desktop client secret if required. Hangar requests only `gmail.readonly` and uses a random loopback callback with PKCE. Public distribution requires the applicable Google verification. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

The browser lets you choose the actual account. Hangar verifies its remote identity before storing tokens. Sign-in can be cancelled and expires after three minutes. Locked or unavailable OS credential protection fails closed. Tokens are encrypted with Electron `safeStorage` in `connector-credentials.enc` under Hangar's user-data directory, separate from `config.json`, exports and Git config sync. Linux's insecure `basic_text` backend is refused.

**Disconnect & clear** cancels local work and deletes the local connection and cached content. It does not revoke the OAuth app grant at the provider; manage that in Google/Slack account settings if needed. Removing the app also forgets its API connection. Signing out of the embedded website is a separate web-session operation.

## Coverage and freshness

- Slack shows up to 40 recent search matches per page, from the last 30 days. Thread previews fetch up to 50 messages. Slack search provides no reliable unread flag; those rows say **Read state unknown** and are excluded from Unread only. Workspace retention, membership and API rate limits apply.
- Gmail lists 20 inbox threads per page, with subject, sender, snippet and exact unread labels. Full-thread previews are plain text, up to the latest 50 messages. HTML-only bodies, remote images, attachments and truncated threads direct you to Gmail.
- Load more is bounded to 200 summaries per connected account and 500 visible summaries overall. Snapshots refresh every 90 seconds while the inbox is open and visible, or manually. Refresh replaces the snapshot so deleted/archived results disappear. New activity waits for an explicit list update while you read.
- Other apps can contribute the existing **limited rendered unread names** probe. Missing rows never imply an empty remote inbox. Sleeping apps are not awakened for a scan. Messenger/Teams selectors still require real-page validation; no personal message-history API is claimed.
- Bodies and summaries stay in process memory, with no persistent message index. Quit clears them. Read results arriving after disconnect, scope changes or selection changes are discarded. Source errors and stale update times remain visible.

## Boundaries and validation

`src/main/connectors/` owns OAuth, credentials and source requests; `core/inbox/` owns normalization/validation; `shared/inbox.ts` owns DTOs; `renderer/inbox/` owns the UI. Only the owned inbox main frame can invoke `inbox:request`. App panes, the rail and control socket cannot request message bodies or tokens. Received text is rendered as text, never privileged HTML.

Contract tests cover workspace grants, cancellation, revocation, pagination, replaced snapshots, deduplication, rate limiting, PKCE/state validation and plain-text email. Renderer tests cover unknown unread state, limited previews and stale reads. Electron tests cover sender rejection, light/dark accessibility, native view detachment, throttling, resizing and the reader. Tests use synthetic data and do not prove real-account OAuth approval or provider retention/access. Complete a live test with registered test clients before public distribution.

The [AI search panel](ai-search.md) uses these same read connections. Choose **Ask AI about this thread** to include selected context, or open Ask AI from the rail for a broader question. The model receives scoped search/read tools and source references, never connector credentials.
