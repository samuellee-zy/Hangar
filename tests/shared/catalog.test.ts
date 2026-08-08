// Catalog data invariants.
//
// The catalog is plain data, which makes it feel safe to edit — and that's exactly why it needs
// tests. Every failure mode here is silent at runtime: a wrong icon slug falls back to initials, a
// missing allowlist entry sends the service's own URL to the system browser, and a duplicate id
// shadows an entry with no error anywhere.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { catalog, catalogById, isOrphaned, resolveUrl } from '@shared/catalog';
import { isAllowedHost } from '@main/platform/session';
import type { ServiceInstance } from '@shared/types';

describe('identity', () => {
  it('ids are unique', () => {
    const ids = catalog.map((e) => e.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('catalogById finds every entry and nothing else', () => {
    for (const entry of catalog) expect(catalogById(entry.id)).toBe(entry);
    expect(catalogById('nope')).toBeUndefined();
    // The sentinel used for custom connections must never collide with a real entry.
    expect(catalogById('__custom')).toBeUndefined();
  });

  it('every entry has the fields the rail renders', () => {
    for (const e of catalog) {
      expect(e.name, e.id).toBeTruthy();
      expect(e.initials, e.id).toBeTruthy();
      expect(e.provider, e.id).toBeTruthy();
      // Brand colours go through brightenForDark, which only understands hex.
      expect(e.color, e.id).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe('icons', () => {
  const dir = path.resolve('assets/icons');

  it('every DECLARED icon slug resolves to a vendored file', () => {
    // A typo is otherwise invisible: the tile silently falls back to initials, which is also the
    // legitimate no-icon behaviour, so the two are indistinguishable at runtime. Entries with no
    // icon at all are fine — what must not happen is declaring one that isn't there.
    for (const e of catalog) {
      if (!e.icon) continue;
      expect(fs.existsSync(path.join(dir, `${e.icon}.svg`)), `${e.id} → ${e.icon}.svg`).toBe(true);
    }
  });

  it('an entry without an icon still has initials to fall back to', () => {
    for (const e of catalog) {
      if (!e.icon) expect(e.initials, e.id).toBeTruthy();
    }
  });

  it('slugs are safe to interpolate into a path', () => {
    // icons.ts builds a filesystem path from this. Anything that could climb out is a traversal.
    for (const e of catalog) {
      if (e.icon) expect(e.icon, e.id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('host allowlists', () => {
  it("EVERY ENTRY ALLOWS ITS OWN URL — otherwise the service won't load at all", () => {
    // This is the check that catches vendor drift, e.g. Teams moving from teams.microsoft.com to
    // teams.cloud.microsoft. The symptom is the service bouncing to the system browser on launch,
    // which reads as "the app is broken" rather than "one host is stale".
    for (const e of catalog) {
      // isAllowedHost only reads `catalogId` and `allowedHosts`; the rest of ServiceInstance is
      // irrelevant to the host check, so this stands in rather than being spelled out.
      const svc = { catalogId: e.id, allowedHosts: undefined } as unknown as ServiceInstance;
      expect(isAllowedHost(svc, e.url), `${e.id}: ${e.url}`).toBe(true);
    }
  });

  it('no allowlist is empty, and none contains a bare public suffix', () => {
    for (const e of catalog) {
      expect(e.allowedHosts.length, e.id).toBeGreaterThan(0);
      for (const host of e.allowedHosts) {
        expect(host, e.id).not.toMatch(/^(com|net|org|io|co\.uk|app)$/);
        expect(host, e.id).toContain('.');
      }
    }
  });

  it('Teams allows consumer Teams, not just the work one', () => {
    // The bug this pins: a personal Microsoft account is routed to teams.live.com, which is a
    // separate app rather than a redirect of teams.microsoft.com. It was refused, so the pane
    // stalled on a work Teams that never finished loading and could not be typed into.
    const svc = { catalogId: 'teams' } as ServiceInstance;
    for (const url of [
      'https://teams.live.com/v2/',
      'https://teams.microsoft.com/v2/',
      'https://teams.cloud.microsoft/',
      'https://login.live.com/oauth20_authorize.srf',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    ]) {
      expect(isAllowedHost(svc, url), url).toBe(true);
    }
    // Still an allowlist: widening it for consumer Teams must not have let the web in.
    expect(isAllowedHost(svc, 'https://example.com/')).toBe(false);
  });

  it('NO ENTRY DECLARES BOTH A TITLE PATTERN AND DOM RULES', () => {
    // Both write an *absolute* count, so two of them on one service is a badge flapping between
    // whichever reported last — a bug that looks like the count being random.
    for (const e of catalog) {
      const both = Boolean(e.unread?.titlePattern) && Boolean(e.unread?.dom?.length);
      expect(both, e.id).toBe(false);
    }
  });

  it('every title pattern is anchored', () => {
    // An unanchored pattern finds a number anywhere in the title, so "Re: budget (2024 draft)"
    // reads as 2024 unread. The failure is a plausible-looking count rather than an error, which
    // is why this is worth a test rather than a review comment.
    for (const e of catalog) {
      const pattern = e.unread?.titlePattern;
      if (pattern) expect(pattern, e.id).toMatch(/^\^/);
    }
  });

  it('a caveat says something', () => {
    // The field exists to be read in the picker before adding. An empty or one-word one renders as
    // a stray line of grey text that reads as a rendering bug.
    for (const e of catalog) {
      if (e.caveat === undefined) continue;
      expect(e.caveat.trim().length, e.id).toBeGreaterThan(20);
    }
  });

  it('a DOM rule that could only ever report zero is a typo', () => {
    for (const e of catalog) {
      for (const rule of e.unread?.dom ?? []) {
        expect(rule.selector.trim(), e.id).not.toBe('');
        // `attr` mode with no attribute name reads the empty string off every match, so the rule
        // matches, answers zero, and looks like a service you have read everything in.
        if (rule.read === 'attr') expect(rule.attr, e.id).toBeTruthy();
      }
    }
  });
});

describe('resolveUrl', () => {
  it('an instance override wins over the catalog', () => {
    expect(resolveUrl({ catalogId: 'gmail', url: 'https://example.com' })).toBe(
      'https://example.com'
    );
  });

  it('a catalog-backed service with no override follows the catalog', () => {
    const gmail = catalogById('gmail')!;
    expect(resolveUrl({ catalogId: 'gmail' })).toBe(gmail.url);
  });

  it('an unknown catalog id with no url does not throw', () => {
    // Custom connections always carry a url; a missing one is corrupt config, not a crash.
    expect(() => resolveUrl({ catalogId: '__custom' })).not.toThrow();
  });
});

describe('isOrphaned', () => {
  it('is true only when there is nothing at all to load', () => {
    // The state a removed or renamed catalog entry leaves behind on an existing install. It has
    // to be nameable, because both of its symptoms are silent: about:blank, and an allowlist with
    // nothing in it that therefore refuses every navigation.
    expect(isOrphaned({ catalogId: 'was-removed' })).toBe(true);
    expect(isOrphaned({ catalogId: 'gmail' })).toBe(false);
    // A custom connection carries its own URL, so a missing catalog entry costs it nothing.
    expect(isOrphaned({ catalogId: '__custom', url: 'https://example.com' })).toBe(false);
  });

  it('no catalog entry is orphaned — the guard would be dead code if one were', () => {
    for (const e of catalog) expect(isOrphaned({ catalogId: e.id }), e.id).toBe(false);
  });
});
