# Automation: `hangar://` links and the command line

Anything that can open a URL can drive Hangar: Shortcuts, Raycast, a Focus automation, a link in a
note, `open` in a terminal. The command line takes the same things as flags.

```bash
open "hangar://open/Slack"
```

## What a link can do

| Link | Does |
|---|---|
| `hangar://` or `hangar://show` | Brings the window forward |
| `hangar://open/<service>` | Shows the service, in its own workspace if it's in another one |
| `hangar://open/<service>?pane=new` | Opens it beside the focused pane |
| `hangar://workspace/<workspace>` | Switches workspace |
| `hangar://dnd/on` · `hangar://dnd/off` | Do Not Disturb, until it's turned off |
| `hangar://dnd/on?for=45` | For 45 minutes. `?for=tomorrow` is until 9 tomorrow morning |
| `hangar://mute/<service>` | Mutes a service until it's unmuted. `?for=` works here too |
| `hangar://unmute/<service>` | Unmutes it: back to what it was before the mute, badge only included. A service that isn't muted is left alone |
| `hangar://read/<service>` · `hangar://read/all` | Marks one service, or every one, as read |

**Naming a service.** A service is looked up by its id, then by its name, then by which catalog
entry it is. Case doesn't matter.
- With two Gmails, `gmail` is the one higher in the rail (this workspace's first).
- If you renamed one "Work mail", that name finds it.
- Spaces are written `%20`: `hangar://open/Work%20mail`. Shortcuts' URL action does this for you.

**Naming a workspace.** A workspace is found by its name, or by its place in the switcher:
`hangar://workspace/2` is the second.

**The window only comes forward when you're asking to see something:** `open`, `workspace` and
`show`. A Focus automation turning Do Not Disturb on leaves it where it is — and with the window
closed, changes the setting without opening one.

**Links that do nothing.** A link that doesn't name anything, or that isn't one of the above, does
nothing. The reason goes in the log (`[link] ignored: …`). So do links past ten in ten seconds.

## Why a link can't do more

Any page can open a `hangar://` link: a browser tab, an email, a note. (Not the services Hangar
shows: they can't hand the operating system a scheme like this one.) So the list above is the whole
of it.
- A link never becomes an arbitrary command. It is parsed into one of these verbs, and each verb is
  turned into commands from fixed templates (`src/core/runtime/deeplink.ts`).
- Nothing from the link reaches the app except a name to look up.
- Removing a service, importing a config, signing out and custom scripts have no link. Adding one
  would be a decision about who may do that, not a feature.

The worst a hostile page can do with a link is:
- mute a service, or unmute one — including one you'd set to Off in Settings, since that's a mute;
- turn Do Not Disturb on, or off;
- mark something read;
- switch what's on screen, ten times in ten seconds at most.

All of these are visible, and each is undone the way it was done. A browser asks before it opens
an app's link for a site, the first time; saying no there is the way to keep a site from sending
these at all.

## The command line

```bash
/Applications/Hangar.app/Contents/MacOS/Hangar --open Slack --new-pane
```

| Flag | Link it means |
|---|---|
| `--open <service>`, plus `--new-pane` | `open/<service>`, plus `?pane=new` |
| `--workspace <workspace>` | `workspace/<workspace>` |
| `--dnd on\|off`, plus `--for <minutes\|tomorrow>` | `dnd/on\|off?for=…` |
| `--mute <service>`, plus `--for …` | `mute/<service>?for=…` |
| `--unmute <service>` | `unmute/<service>` |
| `--mark-read <service\|all>` | `read/<service\|all>` |

A `hangar://` link given as an argument works too, and `--flag=value` works as well as
`--flag value`.

**When Hangar is already running,** the new process hands its flags to the running copy and exits.
This is the same handoff `--quit` uses.

**When it isn't running,** Hangar starts, and runs the flags once the window is up.

`open -a Hangar --args …` only passes the arguments when Hangar isn't already running; macOS just
activates a running app. Use the binary's path, or a link: `open "hangar://…"` works either way.

## Recipes

**Shortcuts.** Use the "Open URLs" action with a `hangar://` link.
- Add the shortcut to the menu bar or the Dock, or give it a keyboard shortcut in Shortcuts'
  settings.
- One shortcut can run several links in a row: say, `hangar://workspace/Work` then
  `hangar://open/Slack`.

**macOS Focus.** In Shortcuts → Automation, choose "When Work Focus turns on":
- set it to open `hangar://dnd/on` or `hangar://workspace/Work`;
- add a second automation for when it turns off, with `hangar://dnd/off`.

**Raycast.** Use a Quicklink with the link as its URL, or a script command like this:

```bash
#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Hangar: focus time
# @raycast.mode silent
open "hangar://dnd/on?for=50"
```

**Anywhere a link can be clicked.** For example, a note that says
[Standup](hangar://workspace/Team).

## In development

An unpackaged build doesn't register the scheme, and deliberately so: registering `hangar://` from
`npm run dev` would hand it to Electron itself. The packaged app declares it in
`electron-builder.yml`, and makes itself the handler on launch. To try links in development, use the
flags. The e2e tests (`e2e/links.spec.ts`) emit macOS's `open-url` event by hand for the same reason.
