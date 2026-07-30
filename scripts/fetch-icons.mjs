// Vendors the catalog's icons from homarr-labs/dashboard-icons into assets/icons/.
//
// Committed rather than fetched at runtime: an app that phones a CDN on every launch leaks the
// list of services you use, which defeats the point of storing everything locally. There's no npm
// package for these, hence a script.
//
// Only pulls the slugs the catalog actually references, and records the upstream commit so a
// refresh is reproducible. Apache-2.0 — see assets/icons/NOTICE.
//
// Run: npm run icons

import fs from 'node:fs/promises';
import path from 'node:path';

const REPO = 'homarr-labs/dashboard-icons';
const OUT = path.join(import.meta.dirname, '..', 'assets', 'icons');

// Parsed out of the catalog rather than duplicated, so the two can't drift.
async function slugsFromCatalog() {
  const src = await fs.readFile(
    path.join(import.meta.dirname, '..', 'src', 'shared', 'catalog.ts'),
    'utf8'
  );
  return [...src.matchAll(/icon:\s*'([^']+)'/g)].map((m) => m[1]);
}

async function headCommit() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`);
  if (!res.ok) return 'unknown';
  return (await res.json()).sha.slice(0, 12);
}

async function main() {
  const slugs = await slugsFromCatalog();
  await fs.mkdir(OUT, { recursive: true });
  const commit = await headCommit();

  const results = await Promise.all(
    slugs.map(async (slug) => {
      const url = `https://cdn.jsdelivr.net/gh/${REPO}@main/svg/${slug}.svg`;
      const res = await fetch(url);
      if (!res.ok) return { slug, ok: false, status: res.status };
      const svg = await res.text();
      await fs.writeFile(path.join(OUT, `${slug}.svg`), svg);
      return { slug, ok: true, bytes: svg.length };
    })
  );

  for (const r of results) {
    console.log(r.ok ? `  ✓ ${r.slug} (${r.bytes} bytes)` : `  ✗ ${r.slug} — HTTP ${r.status}`);
  }

  const missing = results.filter((r) => !r.ok);
  await fs.writeFile(
    path.join(OUT, 'NOTICE'),
    [
      'Icons vendored from https://github.com/homarr-labs/dashboard-icons',
      'Licensed Apache-2.0. Brand marks remain the property of their respective owners.',
      '',
      `Upstream commit: ${commit}`,
      `Fetched slugs: ${results.filter((r) => r.ok).map((r) => r.slug).join(', ')}`,
      '',
      'Refresh with: npm run icons',
      '',
    ].join('\n')
  );

  console.log(`\n${results.length - missing.length}/${results.length} fetched at ${commit}`);
  if (missing.length) {
    console.log(`Missing slugs fall back to initials: ${missing.map((m) => m.slug).join(', ')}`);
  }
}

main();
