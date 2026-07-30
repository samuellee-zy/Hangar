# Keyboard and menus

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘K` | Command palette — services and workspaces |
| `⌘N` | Add a connection |
| `⌘,` | Settings |
| `⌘F` | Find in page — `↵` next, `⇧↵` previous, `esc` closes |
| `⌘+` / `⌘−` / `⌘0` | Zoom the focused service; `⌘0` resets to your default zoom |
| `⌘P` | Print the focused service |
| `⌘1`…`⌘9` | Jump to the *n*th service in the current workspace |
| `⌘⌥1`…`⌘⌥9` | Switch workspace |
| `⌘\` | Split — opens the next unshown service alongside |
| `⌘⌥←` / `⌘⌥→` | Move focus between panes |
| `⌘W` | Close the focused pane; closes the window when it's the last one |
| `⌘[` / `⌘]` | Back / forward within the focused service |
| `Escape` | Close the overlay |
| `⌥`-click a tile | Open alongside instead of replacing |
| `⌃Space` on a tile | Lift for keyboard drag; arrows move, `⌃Space` drops, `Esc` cancels |

Plus one optional **global** shortcut, set in Settings, to summon or hide the window from anywhere.

## Why `before-input-event` and not `globalShortcut`

`before-input-event` fires in main *before* the page sees the key, so a web app can't swallow ⌘K —
Slack and Notion both bind it. `globalShortcut` would steal keys system-wide even when Hangar isn't
focused, which is hostile for a background app.

The one exception is the summon shortcut, which exists precisely to work while unfocused. It's
explicit, single, and user-configurable.

## Four things this got wrong first

**Listeners must attach once per view.** They were bound on the focus path, so every focus added
another listener to the same `webContents` — three focuses meant one `⌘\` splitting three times.
`attachShortcuts` is now idempotent via a `WeakSet`, and bound where the view is created.

**Escape has to be bound everywhere.** `before-input-event` only fires for the `webContents` that
holds focus, and the overlay doesn't reliably win focus from a service view. Binding Escape to the
overlay alone left a blank overlay unclosable.

**…but only swallowed when used.** The command sink returns whether it acted, and the keystroke is
consumed only then. Otherwise Escape would stop dismissing dialogs inside Slack and Gmail.

**dnd-kit's keyboard sensor shadowed plain activation.** Its listeners bind Space/Enter to "lift",
so on a rail tile a keyboard user could never simply *open* a service. Keyboard dragging moved
behind ⌃Space ([decisions #25](decisions.md)).

## Menu ownership

Accelerators also live in `src/main/boot/menu.ts`, and that isn't duplication — it's the point. Electron
ships a default menu whose Window submenu binds ⌘W to the `close` role, and that accelerator fires
at app level regardless of `before-input-event`. Owning the menu is the only way to own the key
([decisions #11](decisions.md)).

The Edit menu's roles are also load-bearing: without them ⌘C/⌘V/⌘A don't reliably work inside the
web apps.

## Context menus

Native `Menu.popup()`, not React — correct macOS styling and keyboard navigation for free, and it
renders outside the triggering view's bounds. A React menu in a 72px rail would be clipped.

**Inside a web view.** Electron provides no context menu at all by default, so before this,
right-clicking in Gmail did nothing. Built from the `context-menu` event's params:

- Cut / Copy / Paste / Select all, gated on `editFlags` so Paste isn't offered outside an editable
  field
- Open link in browser · Copy link
- Copy image · Save image
- Back · Forward · Reload · Copy current URL · Open page in browser
- **Spelling suggestions**, applied with `replaceMisspelling` (not `insertText`, which has a history
  of crashing), plus Add to dictionary
- Inspect element, in development only

Spelling needs `webPreferences.spellcheck: true`. Setting spellchecker *languages* alone does
nothing — `dictionarySuggestions` comes back empty.

**On a rail tile.** Open · Open in new pane · Move to folder ▸ · Rename · Add another account ·
Reload · Close pane / Put to sleep · Remove (with a confirm).

**On a folder.** Collapse / Expand · Rename · Ungroup.

**On the rail background.** Add connection · New folder · Settings.

## Not yet built

Rebinding, conflict detection, and a per-service passthrough list so a service can keep a chord for
itself (⌘K in Slack). Settings shows the map read-only for that reason.
