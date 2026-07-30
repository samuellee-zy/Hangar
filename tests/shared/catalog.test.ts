// Catalog data invariants.
//
// The catalog is plain data, which makes it feel safe to edit — and that's exactly why it needs
// tests. Every failure mode here is silent at runtime: a wrong icon slug falls back to initials, a
// missing allowlist entry sends the service's own URL to the system browser, and a duplicate id
// shadows an entry with no error anywhere.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { catalog, catalogById, resolveUrl } from '@shared/catalog';
import { isAllowedHost } from '@main/platform/session';

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

  it('every icon slug resolves to a vendored file', () => {
    // A typo here is invisible: the tile silently falls back to initials.
    for (const e of catalog) {
      expect(fs.existsSync(path.join(dir, `${e.icon}.svg`)), `${e.id} → ${e.icon}.svg`).toBe(true);
    }
  });

  it('slugs are safe to interpolate into a path', () => {
    // icons.ts builds a filesystem path from this. Anything that could climb out is a traversal.
    for (const e of catalog) expect(e.icon, e.id).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('host allowlists', () => {
  it("EVERY ENTRY ALLOWS ITS OWN URL — otherwise the service won't load at all", () => {
    // This is the check that catches vendor drift, e.g. Teams moving from teams.microsoft.com to
    // teams.cloud.microsoft. The symptom is the service bouncing to the system browser on launch,
    // which reads as "the app is broken" rather than "one host is stale".
    for (const e of catalog) {
      const svc = { catalogId: e.id, allowedHosts: undefined };
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
