# Icons

## Two sources

**Vendored brand logos** for catalog services, committed under `assets/icons/`. Pulled from
[dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (Apache-2.0, ~1800 full-colour
SVGs) by `npm run icons`, which reads the slugs out of the catalog so the two can't drift, and
records the upstream commit in `assets/icons/NOTICE`.

**Captured favicons** for custom connections, which have no brand mark, and for catalog entries
not yet vendored (`npm run icons` fills those in). A new one shows without a restart: the icon URL
carries a version that moves when a favicon is cached. Grabbed from the page's own
`page-favicon-updated` event and fetched through *that service's session*, so authenticated
favicons work and the request follows the same proxy as everything else.

Cached to `userData/icons/<serviceId>.<ext>`, where the extension comes from **sniffing the magic
bytes** rather than assuming. Writing everything as `.png` meant an `.ico` or `.svg` might simply
never render, and the failure was silent. Any earlier cache for that service is removed first, so a
format change can't leave two files fighting.

Vendored wins where both exist — a captured favicon is often a 16px bitmap.

## Why committed, not fetched

An app that hits a CDN on every launch hands a remote server the list of services you use. That
defeats the entire premise of keeping your config local. Same reason there's no Google `s2/favicons`
or DuckDuckGo `ip3` call: both work fine and both would leak exactly what we're trying not to leak.

There's no npm package for dashboard-icons, hence a vendoring script rather than a dependency.

## Two protocols

| Scheme | Keyed on | Used by |
| --- | --- | --- |
| `hangar-icon://<serviceId>` | A configured service | The rail |
| `hangar-catalog://<slug>` | A catalog slug | The Add Connection picker |

The picker needs the second because it shows services that **don't exist yet** — there's no service
id to key on before you've added one. Its slugs are validated against `^[a-z0-9-]+$`, since that
handler is reachable from renderer markup and a path is being built from the input.

Both are registered with `registerSchemesAsPrivileged` **before app-ready** — later is too late and
`protocol.handle` won't serve them to an `<img>`.

## CSP

`src/renderer/index.html` must allow them:

```
img-src 'self' data: hangar-icon: hangar-catalog:
```

Omit it and images are blocked **silently** — a blocked `<img>` renders nothing and logs nothing
obvious, so it looks like the icon simply doesn't exist.

## Colour

Brand hexes are published for use on white, and several are unreadable on a dark tile — Slack's
`#4A154B` scores 1.07:1 against our `#26262c`. `src/renderer/accent.ts` lifts lightness toward white
until the colour clears 4.5:1, preserving hue, so it still reads as the brand. Slack ends at 4.86:1.

This runs at render time rather than being a second hand-tuned hex per entry, because custom
connections and favicon-derived colours need it too.

## Fallback

No vendored logo and no captured favicon yet → initials on the tile, coloured with the lifted
accent. `ServiceIcon` decides this from the image failing to load rather than from state: main
resolves the icon from either source and the renderer has no business knowing which.

The failure flag **resets when the service identity changes**. Latching it forever meant a favicon
that arrived after the first load could never appear without restarting the app.

## Adding icons

```bash
npm run icons
```

Only fetches slugs the catalog references. A missing slug is reported and falls back to initials
rather than failing the build.
