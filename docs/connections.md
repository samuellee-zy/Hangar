# Connections

## Four concepts

**Catalog entry** — a template (`src/shared/catalog.ts`). Name, URL, icon slug, brand colour,
allowed hosts, and a `provider`. Not user data; edited in code.

**Account** — a signed-in identity owning one cookie jar. Two Gmails are two Accounts. Gmail and
Calendar on the same Google login share one.

**Service instance** — a configured tile. Points at a catalog entry and an Account.

**Folder** — an ordered group of services in the rail, one level deep.

The account split exists because Rambox gives every app its own jar, which means signing into Google
separately for Gmail, then Calendar, then Drive. Grouping by provider means one sign-in covers all
of them, while still letting a second Gmail be genuinely separate.

## Adding

The `+` at the foot of the rail, ⌘N, or right-click the rail background.

For a service whose provider already has an Account, the tile reads "via Google" and reuses it.
**"+ another account"** forces a new Account with a new partition — that's how you get two mailboxes
rather than two views of one.

A service you already have shows **"✓ added"** and clicking it *opens* rather than duplicating.
Adding a duplicate on the same account looks identical to nothing happening, which is precisely how
that bug was reported ([decisions #18](decisions.md)).

New services are appended to the **active workspace**. Skipping that step makes them invisible,
since the rail renders workspace members only.

## Folders

Right-click a tile → Move to folder ▸, or the rail background → New folder. A folder shows a 2×2
grid of its members' icons with unread rolled up; clicking expands it inline.

Two invariants, both pinned by `check:folders`:

- **A service appears exactly once.** Moving detaches first — without that, moving between folders
  leaves it in both and you get a duplicate tile.
- **Folders never nest.** `moveToFolder` only resolves service ids, so a folder id isn't found.

**Ungroup keeps the services**, promoting them to the top level in place. There is no "delete folder
and contents" — that's two destructive operations wearing one label.

Dragging reorders the **top level**. Filing into a folder is menu-only: cross-container nested
dragging in dnd-kit is fiddly enough that a half-working gesture would be worse than a reliable menu.

## Custom connections

"Add any website by URL". Gets its own Account, a colour derived from the host, and an
`allowedHosts` of **the exact host**. `isAllowedHost` matches subdomains via a leading-dot suffix
check, so `app.example.com` is covered.

Deriving a "registrable domain" by taking the last two labels was actively dangerous —
`foo.example.co.uk` yielded `co.uk`, allowing every `.co.uk` site to navigate inside the app
([decisions #19](decisions.md)).

**The trap:** if the site signs in with Google, Okta or similar, that provider's domain is *not* in
the allowlist, so its own login opens in your system browser and the service looks broken. Add the
provider's host under Settings → Custom connection hosts.

Custom connections have no vendored logo, so their icon comes from the page's own favicon — see
[icons.md](icons.md).

## Managing

Settings (⌘,) renames and removes services, renames accounts, and signs an account out — which
clears that partition's cookie jar and reloads every service using it.

Right-click a tile for the same things without the trip: Open, Open in new pane, Move to folder,
Add another account, Reload, Put to sleep, Remove.

Removing a service keeps its account **unless nothing else uses it**, in which case the account is
pruned too. The confirm dialog is explicit that cookies survive, so re-adding later is still signed
in.

## Partitions

`Account.partition` is the Chromium partition name, written once at creation and never recomputed.
Accounts created before the v2 migration keep their original `persist:grp-*` names; new ones use
`persist:acct-<uuid>`. Both are opaque once written.

**Do not "tidy" this into a derived value.** A partition name is the identity of a cookie jar; make
it a function of anything mutable and a rename signs the user out of everything
([decisions #7](decisions.md)).

## Session durability

Some services issue session cookies with no expiry, which never reach disk. `persist-cookies.ts`
promotes them so a restart doesn't sign you out — on quit, on a timer, on sign-in detection, and on
`powerMonitor`'s suspend, because a closing lid is an unclean exit as far as unwritten cookies go.

This is client-side only; the service's own server-side timeout still applies.
`CatalogEntry.sessionNotPersistable` opts a service out where promotion is pointless. Salesforce is
the one known case ([decisions #4](decisions.md)).

## Adding a catalog entry

1. Add to `src/shared/catalog.ts` with a `provider` and an `icon` slug from
   [dashboard-icons](https://dashboardicons.com).
2. `npm run icons`.
3. Include the identity provider's hosts in `allowedHosts` — omitting them breaks sign-in in a way
   that looks like the page failing to load.
4. Use the bare host for Google properties, never `/u/<n>/` paths ([decisions #5](decisions.md)).
