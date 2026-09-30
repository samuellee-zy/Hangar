# Preferences

Everything configurable, reachable from the gear in the rail or ⌘,.

## How it works

`core/config/preferences.ts` holds `DEFAULT_PREFERENCES`, and **the defaults are the schema**. Two
consequences worth understanding before adding a setting:

**A stored config is merged onto the defaults.** A key added in a later version can never be missing
at runtime, and an older build ignores keys it doesn't know. The reverse holds too: a key the
defaults no longer define is dropped on load, which is how removing `startHidden` needed no
migration. That's what makes the v2→v3 migration
purely additive.

**`setPreference` validates against the defaults rather than trusting the renderer.** `set-preference`
carries an arbitrary path and value across IPC — the one command where a malformed message could
corrupt config on disk. Unknown paths, type mismatches, non-nullable nulls, array/scalar swaps and
writes to a *branch* rather than a leaf are all rejected and logged.

Adding a setting is: add it to `Preferences` in `shared/types.ts`, add its default, render a control
in the matching `renderer/settings/*.tsx` section. No migration needed.

## Appearance

| Setting | Effect |
| --- | --- |
| Rail position | `left` · `right` · `top` · `bottom`. Repositions the rail and relayouts panes |
| Rail size | Thickness in px on whichever edge |
| Show labels | Service names under icons. Suppressed in compact and horizontal rails |
| Compact rail | A 48px strip that still shows every icon; on a left or right rail the chevron opens a 180px panel with names, and the panes reflow around it — see below. A top or bottom rail has no room for names, so it stays a strip |
| Theme | `system` · `light` · `dark` via `nativeTheme.themeSource` |
| Tile spacing | Comfortable or tight gaps between tiles, on a rail of any size (stored as `density`) |
| Pane gutter | Space around each pane, 0–24px |
| Pane headers | A 30px bar above each pane: icon, name and page title, back, forward and reload, pop out, maximise and close. Off by default. A click on it focuses its pane, and a double-click maximises the pane |

Wherever there's a top strip, it holds a title bar for the focused pane, whether or not headers are on. The strip exists whenever the rail doesn't hold the traffic lights: on a right or bottom rail, or a compact left one. The title bar shows back, forward and reload, and the service's name and page. All of it except the buttons still drags the window.

Rail position is constrained by the macOS window buttons, not by the layout maths — see
[decisions #21](decisions.md). `setWindowButtonPosition()` moves them at runtime, so changing
position doesn't recreate the window.

Theme needs no class plumbing: Electron drives `prefers-color-scheme` from `themeSource`, so the
renderer honours a plain media query.

## Behaviour

| Setting | Effect |
| --- | --- |
| Keep every service running | Every service loads at launch, half a second apart after the panes, and never hibernates — as if each had its own Keep running on. Each is its own set of processes, so this is memory. Takes effect at once |
| Hibernate after | Minutes idle before a background service is unloaded. **0 = never**. Unused while every service is kept running |
| Launch at login | Writes a user LaunchAgent, which needs no signature where `setLoginItemSettings` did ([decisions #93](decisions.md)). Ignored in development — an unpackaged binary would register Electron, not Hangar. **Applies from the next login** |
| Relaunch if it stops unexpectedly | Adds `KeepAlive` to the same job, so launchd restarts Hangar after a crash or Force Quit but never after a deliberate quit. Needs launch at login, since launchd can only supervise what it started |
| Close to tray | Closing the window hides it instead of quitting. The Dock icon, Window → Show Hangar, the Dock menu and the tray all bring it back. (There is no "start hidden": [decisions #96](decisions.md)) |
| Global shortcut | One accelerator to summon/hide. The only `globalShortcut` in the app — everything else goes through `before-input-event` |
| Confirm before quitting | Shows a Quit/Cancel dialog on ⌘Q. With a service in a call or playing sound, ⌘Q asks whether or not this is on; `Hangar --quit` and a logout never ask |
| Default zoom | A percentage, applied to newly added services; existing ones keep their own |

Hibernation never touches a visible service, one in a call or playing sound, one you've opted out
per-service or set to keep running, or anything when the timeout is 0. The decision is a pure
function so it can be tested exhaustively — [decisions #22](decisions.md) and #116.

## Notifications

A service's own notifications are intercepted and attributed, driving the dock badge, tray count and
folder roll-ups.

| Setting | Effect |
| --- | --- |
| Enabled | Global off switch — behaves like muting every service |
| Play sound | Passed through to the native notification |
| Do not disturb | **Silences the banner but keeps counting**, so a focus session doesn't end with a badge of zero and no idea what happened |

Per-service `notificationLevel` is `all` or `muted`. There's deliberately no "mentions only" — we'd
have to guess what counts as a mention from a title string, and a filter that silently drops real
messages is worse than no filter. See [decisions #32](decisions.md).

## Workspaces

Separate rails for separate contexts, each remembering its own pane layout. Create, rename, delete
and switch with ⌘⌥1…9.

Deleting one **keeps its services** — anything not referenced by another workspace moves to the
first. The last workspace can't be deleted. See [decisions #33](decisions.md).

## Network and downloads

Proxy: `system` · `none` · `http` · `socks4` · `socks5`, applied to every live session via
`session.setProxy`. `system` means "don't set one", which is already the default.

`network.blockAds` — ad and tracker blocking from the prebuilt Ghostery lists, on by default. A
service pane is a browser tab you cannot install an extension into, so the alternative is no blocker
rather than your own. One engine is shared by every session (~18MB; per-partition would cost that
again per account) and serialised to `adblock-engine.bin` in the config directory, refetched weekly.
Building from the lists takes ~530ms and spikes RSS ~275MB, against ~8ms to read the cache — hence
the cache. Applied in `sessionFor`, not a bulk pass, so a view woken from hibernation is covered.
A failed fetch is non-fatal: no blocking, services load as normal.

Downloads: target folder, ask-where-to-save, open-on-complete, and notify. Attached per session,
since each service has its own. With notify on (the default), a finished download shows a banner
naming the file and the service it came from, and clicking it shows the file in Finder; a failed
one says so too. Not for one that opens by itself, or one cancelled at the save dialog. Whatever
the setting, the Dock icon shows progress while anything downloads, and the Downloads stack
bounces when a file lands in it ([decisions #118](decisions.md)).

## Sync

Config sync over a git repo you control. `sync.repoPath` points at a local clone; empty disables
it. What travels and what doesn't is an **allowlist**, so a field added later does not sync until
someone says so.

**[sync.md](sync.md) is the guide** — setting it up across two Macs, what stays local, and how
conflicts resolve. What follows here is the settings reference and the public-repo guard.

| Setting | Notes |
| --- | --- |
| Repository path | A local clone. Hangar writes `hangar.config.json` into it, commits with `--only` so it can never sweep up your unrelated work, and pushes |
| Allow a public repository | Off by default. See below |

**The public-repo guard.** Before every reconcile, Hangar reads `git remote get-url origin` and — if
the host is one of `github.com`, `gitlab.com`, `bitbucket.org` or `codeberg.org` — makes one
anonymous `HEAD` request to the repo's web URL. A **200 means anyone can read it**, and sync refuses
with a reason naming the repo. The synced file carries no credentials, but it does carry service
names, account labels (usually addresses) and any custom connection URLs.

Three things about the design are deliberate:

- **It fails open.** 404 is *private or nonexistent* — GitHub refuses to distinguish them, precisely
  so that probing can't enumerate private repos — and every other outcome (offline, DNS failure,
  rate limit, timeout) also allows the sync. Publishing your own service list to your own repo is a
  risk you configured and can see; sync breaking on a train is the failure that gets a feature
  switched off for good.
- **The host list marks where a 200 can be believed, not where sync is forbidden.** The first draft
  had it the other way round and refused every repo on github.com — which is where private dotfiles
  repos live. A self-hosted forge is deliberately absent: an internal GitLab will answer 200 to a
  laptop on the VPN for a repo no outsider can reach.
- **The request is Node's `fetch`, not Electron's `net.fetch`.** It has to be anonymous. Going
  through a session would attach whatever GitHub cookies your browsing has left behind, turning
  "the public can read this" into "I can read this" — true of every private repo you own.

The probe is cached per URL: a `public` verdict forever, anything else for ten minutes, so a
debounced reconcile isn't a request per keystroke.

`allowPublicRepo` is machine-local and never syncs, for the same reason `repoPath` doesn't — and
because writing "yes, I know this is public" *into* the public repo would be its own small absurdity.

## Per-service

Separate from global preferences and stored on the `ServiceInstance`:

| Setting | Notes |
| --- | --- |
| Name | Commits on blur, not per keystroke ([decisions #4](decisions.md) neighbourhood) |
| Account | Which cookie jar it signs in with |
| Keep running | Loads at launch and never hibernates. On for all, and not changeable here, while Keep every service running is on |
| Hibernate | Per-service opt-out |
| Zoom | Applies immediately |
| Custom CSS / JS | Injected on every `dom-ready`, not just the first — an SPA navigation drops injected styles. A syntax error in custom JS is caught and logged rather than taking the service down |
| User agent | Override. Unused by default: Phase 0 found the global scrub sufficient |
| Cookie TTL | How long to extend session cookies. The *shortest* TTL among services sharing a partition wins |
| Mic / camera | Custom connections only — denied by default, since a typed URL isn't reviewed the way a catalog entry is |
| Keyboard passthrough | Chords Hangar leaves to the page. Absent follows the catalog (Slack keeps its own ⌘K); an empty list claims nothing. See [keyboard.md](keyboard.md) |
| Unread selector | CSS selector for the service's own unread badge. Absent follows the catalog; the empty string is "detect nothing" |
| Unread endpoint | A URL of the service's own, asked over its own login while the service is asleep. Config-only, and enforced to be on that service's host allowlist ([decisions #91](decisions.md)) |
| `allowedHosts` | Custom connections only. Add an identity provider's domain here if its login opens in your browser |

## What isn't wired

Everything in Settings now does something. The one honest caveat is the pair of **launchd settings**,
which are skipped when running from source — an unpackaged binary would register Electron rather
than Hangar — and which apply from the next login rather than immediately, because the app writes
the job file and deliberately never runs `launchctl` on itself ([decisions #93](decisions.md)).

**Keyboard rebinding** is wired, and the storage format ended up the opposite of what this file used
to promise. Chords are canonical *strings* — `alt+meta+arrowleft` — not `{ key, meta, alt, shift,
ctrl }` objects, for a reason that only shows up in the merge: `withDefaults` descends into an
object leaf and fills its missing keys from the default, so an unbound action stored as `{}` would
come back holding whatever chord it used to have and clearing a shortcut would silently not stick.
A string is a scalar, so `''` replaces — and it stays legible in a config people resolve git
conflicts in. [keyboard.md](keyboard.md) covers what can't be rebound and why.

**Compact rail opens on a click, and the panes make room.** Collapsed it is 48px and still draws every
tile, so switching service stays one click; on a left or right rail the chevron opens a 180px panel
with names (a top or bottom rail has no chevron — there is no room beside its icons for a name), and
the panes are laid out against whichever width it currently is — the rail is never over a pane, so it
never swallows a click meant for one. It used to expand over the panes on hover, and could not be
made to close reliably: the pointer leaves into a different `WebContentsView`, which gets no leave
event. [decisions #88](decisions.md) and [#95](decisions.md) have the reasoning.

## Export and import

Writes services, folders, accounts and preferences. **Sessions and cookies are excluded** —
partitions live beside the config and aren't portable. The file carries a `_note` saying so and the
import dialog repeats it, because an export that looked like a full backup while silently dropping
every login would be worse than no export at all ([decisions #24](decisions.md)).

Window bounds are not imported: they describe the exporting machine's display.
