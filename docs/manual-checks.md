# Checks only a real page can prove

The tests drive fixture pages shaped like each service's. They can't sign in to WhatsApp, join a
Teams call or run a Shortcut, so the rules below are written from the services' markup as best it
can be read, and are confirmed here. Go through this list in the installed app after a release
that touches them.

Each check says what to do, and where to read the result: a line in Settings, a line in the log
(**Help → Show the log file**), or the control socket. A check that fails usually means a rule to
adjust, in `src/shared/catalog.ts`, not a code change.

To watch the control socket, in a terminal:

```bash
nc -U ~/Library/Application\ Support/Hangar/control.sock
```

It prints the state on connecting and again on every change. A service's `id` in that output is
what a command names.

## Unread counts

| Check | Do | Read |
|---|---|---|
| **WhatsApp counts messages** | Leave a few chats unread, one with several messages. | The tile shows the total of the green badges in WhatsApp's chat list, not the number of chats. **Settings → Notifications → Unread badges** says "Read N from the page". |
| **WhatsApp loads** | Add WhatsApp, or reload it. | The chat list, not a page asking you to update your browser. |
| **Outlook, Teams, Slack, Google Chat** | Leave something unread in each, then read it. | Each one's line under **Unread badges** names where its count came from, and the tile goes up and back down with it. |

## Calls

In a call in Teams, Google Meet, or a Slack huddle, with `nc -U` running:

| Check | Do | Read |
|---|---|---|
| **The call is seen** | Join. | Within two seconds the service has `"meeting":{"inCall":true,…}`. It goes away when you leave. |
| **Each control reads** | Toggle mute, camera, share and raise-hand in the page. | Each value follows: `true` for muted, camera on, sharing, hand raised. `null` means the button's label wasn't recognised. That's expected in a language other than English, and worth a line in the catalog in English. |
| **Each control presses** | Send the line below with `control` set to each of `mute`, `video`, `share`, `hand`. | The page does it. `share` opens the screen picker; it goes no further without you. |
| **A press on an unknown state is refused** | With a control reading `null`, send it with `"want":true`. | Nothing happens, and the log says `[meeting] … state unknown — not pressed`. |

```json
{"type":"command","command":{"type":"meeting-control","serviceId":"<id>","control":"mute","want":null}}
```

`"want":null` just presses. `true` or `false` presses only if the control isn't already that way.
`leave` ends the call, so try it last.

**A Slack huddle,** on its own:
- Start one. The huddle window opens, and the others can hear you.
- Share your screen from the huddle. The picker opens, and what you choose is shared.
- Click a link someone posted in the huddle's chat. It opens in your browser, or in the service
  it belongs to if **Open links in your services** is on, and the huddle stays up.
- The log has no `[nav] Slack: a blank window opened by … — closed` line for the huddle itself.
  That line is for a window something other than Slack tried to open.

**Staying in the call:**
- In a huddle, show another service in Slack's pane, wait out **Hibernate after**, then choose
  **Sleep background services**. The huddle stays up, and the log says `[sleep] kept …: in a call`.
- Put Slack to sleep from its tile's menu, and pop it out. Each asks first, and Cancel leaves the
  call up.
- Quit with ⌘Q. It asks "Slack is in a call. Quit Hangar?", even with **Confirm before quitting**
  off.
- Play something in a service that isn't in a pane, then **Sleep background services**. It keeps
  playing.

## Links and the window

| Check | Do | Read |
|---|---|---|
| **A link from Shortcuts** | Make a shortcut with **Open URLs** and `hangar://open/Slack`, and run it. Only the installed app is registered for `hangar://`. | Hangar comes forward on Slack. |
| **A link with the window closed** | Close the window with ⌘W, then run one with `hangar://dnd/on`. | No window opens, and `nc -U` shows `"dnd":true`. |
| **Double-clicking the title bar** | Double-click the strip above the panes. | The window zooms, or minimises, as **System Settings → Desktop & Dock → Double-click a window's title bar** says. |
| **Full screen** | Enter full screen. | The rail starts at the top. No gap is left where the traffic lights were. |
