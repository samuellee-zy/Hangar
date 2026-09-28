# Keyboard and menus

## Shortcuts

Every chord above the rule is rebindable in Settings. The rows below it are not — see
[What can't be rebound](#what-cant-be-rebound).

| Key | Action |
| --- | --- |
| `⌘/` | Every shortcut on one sheet, read from the live keymap |
| `⌘K` | Command palette — services in every workspace, and workspaces |
| `⌘N` | Add a connection |
| `⌘,` | Settings |
| `⌘F` | Find in page — `↵` next, `⇧↵` previous, `esc` closes |
| `⌘+` / `⌘−` / `⌘0` | Zoom the focused service; `⌘0` resets to your default zoom |
| `⌘P` | Print the focused service |
| `⌘\` | Split — opens the next unshown service alongside |
| `⌘⇧↵` | Maximise the focused pane; again to restore the split. `⌘⌥←/→` while maximised shows the next pane full size |
| `⌘⌥←` / `⌘⌥→` | Move focus between panes |
| `⌃⌘→` / `⌃⌘←` | Widen or narrow the focused pane, 48px a press — the keyboard's splitter. Double-click a splitter, or View → Make panes equal size, to even them out |
| `⌘W` | Close the focused pane; closes the window when it's the last one |
| `⌘[` / `⌘]` | Back / forward within the focused service |
| `⌘R` / `⇧⌘R` | Reload the focused service / reload it ignoring the cache |
| — | Sleep background services — a real action with no default chord, which is what rebinding is for |
| | |
| `⌘1`…`⌘9` | Jump to the *n*th service in the current workspace |
| `⌘⌥1`…`⌘⌥9` | Switch workspace |
| `Escape` | Close the overlay |
| `⌥`-click a tile | Open alongside instead of replacing |
| `⌥↑` / `⌥↓` on a tile | Move it one place up or down the rail (`⌥←` / `⌥→` on a top or bottom rail) |
| `⌃Space` on a tile | Lift for keyboard drag; arrows move, `⌃Space` drops, `Esc` cancels. Also macOS's input-source switch — with two keyboard layouts, use `⌥` and an arrow instead |

Plus one optional **global** shortcut, set in Settings, to summon or hide the window from anywhere.

## Why `before-input-event` and not `globalShortcut`

`before-input-event` fires in main *before* the page sees the key, so a web app can't swallow ⌘K —
Slack and Notion both bind it. `globalShortcut` would steal keys system-wide even when Hangar isn't
focused, which is hostile for a background app.

The one exception is the summon shortcut, which exists precisely to work while unfocused. It's
explicit, single, and user-configurable.

## Five things this got wrong first

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

**Only two of the five shell surfaces had shortcuts.** The rail and the service views were wired by
hand; the overlay had a bespoke Escape handler and nothing else, and the find bar and empty view had
none at all — so ⌘K was dead on three of them. Every one of our renderers now goes through
`AppWindow.adoptSurface`, which registers it for state *and* attaches the keymap, because the two
were forgotten separately.

## One table

`src/core/keyboard/keymap.ts` holds every action: its label, its command, which menu it belongs
under, and its default chord. Three places used to hold their own copy — `translate` in main, the
menu template, and a hand-written list in Settings — and they had already drifted: Settings never
mentioned ⌘F or ⌘P.

Collapsing them is not tidying. **Rebinding is impossible while a second copy exists.** An
accelerator registered by the menu fires at the application level, ahead of `before-input-event`, so
a ⌘K moved to ⌘J would keep opening the palette from the menu's copy of the fact. Our menu items
are therefore declared with `registerAccelerator: false` — the chord is *drawn* beside the label and
Electron does not bind it — which leaves `before-input-event` as the only dispatcher.

What a chord *is* lives one level down, in `src/shared/keyboard.ts`: parsing, the canonical string
form, and how to draw one. It's in `shared/` rather than `core/` because Settings needs it too, and
`renderer-is-sandboxed` forbids the renderer importing core. Nothing in it reads `process.platform`,
so it survives being bundled into a page; which chords are *taken* is a property of this host's menu
bar and stays in `core/`.

## Rebinding

Click a shortcut in Settings and press the new one. A chord is stored canonically —
`alt+meta+arrowleft`, modifiers in ⌃⌥⇧⌘ order — as a **string**, not an object, because
`withDefaults` merges an object leaf *into* the default rather than replacing it, and an unbound
action has to be storable as `''`.

**Taking a chord unbinds its previous holder** rather than being refused. Refusing means telling
someone to go and clear a different row first; displacing is what every shortcut editor people
already use does, and the displaced action then reads "Not bound", which is visible. Two actions
quietly sharing one chord would not be — so a config that *does* hold one (hand-edited, or synced
from a build with different defaults) is flagged in red on both rows, and `KEY_ACTIONS` order breaks
the tie so the answer doesn't depend on JSON key order.

### What can't be rebound

- **A chord with no ⌘ or ⌃.** It would fire in every text field in every service.
- **Escape.** It's the way out of an overlay whose renderer has failed, so it isn't a preference.
- **Chords the menu bar's roles own** — ⌘Q, ⌘C, ⌘V, ⌘Z and the rest. Roles keep their real
  accelerators (see below), so binding an action to one produces a shortcut that silently never
  fires, which is worse than refusing it.
- **⌘1–9 and ⌘⌥1–9.** Positional families — nine chords meaning "the *n*th thing" — which a
  one-chord-per-action table can't express. Their *shifted* forms are bindable, and a binding wins
  over the family, which is why bindings are matched first.

## Per-service passthrough

Hangar reads every keystroke before the page does, which is the whole reason ⌘K works at all — and
also why Slack's own quick switcher was unreachable. Each service has a list of chords Hangar leaves
alone, editable in Settings under **Service shortcuts**.

Slack, Notion, Linear, Discord, GitHub and Asana ship with theirs listed in the catalog, which
writes them as `mod+k` — the placeholder for ⌘-or-Ctrl, expanded per platform by
`resolvePassthrough`. The catalog is bundled into the renderer and has no `process.platform` to ask.

The stored field is deliberately optional: absent means "follow the catalog", and an empty array
means "claim nothing". Collapsing the two would make giving ⌘K *back* to Hangar impossible for any
service the catalog has an opinion about.

## Menu ownership

Electron ships a default menu whose Window submenu binds ⌘W to the `close` role, and that
accelerator fires at app level regardless of `before-input-event` — so ⌘W closed the whole window
when the intent was "close this pane". Owning the menu is the only way to own the key
([decisions #11](decisions.md)).

The Edit menu's roles are load-bearing for a second reason: without them ⌘C/⌘V/⌘A don't reliably
work inside the web apps. Roles are also the one exception to `registerAccelerator: false` — ⌘C has
to work whether or not our keymap has an opinion, which is exactly why those chords are refused to
rebinding.

The Settings window carries its own two-line ⌘W handler. It used to rely on the menu's registered
accelerator, which dispatched `close-pane` at the *main* window — so closing Settings from the
keyboard closed a pane behind it instead.

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

Chord *sequences* (`⌘K` then `S`), and rebinding the positional families as a group. Neither has
been asked for, and both would need the one-chord-per-action table to become something else.
