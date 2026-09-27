import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/styles.css'), 'utf8');

describe('colour tokens', () => {
  // A token defined as itself — `--focus: var(--focus)` — is invalid at computed-value time, so
  // every property using it falls back to its initial value. Nothing errors: in the dark theme focus
  // outlines, the drop target's border and danger text all quietly lost their colour this way.
  it('never defines a custom property in terms of itself', () => {
    const selfReferences = [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
      .filter(([, name, value]) => new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(value!))
      .map(([declaration]) => declaration);
    expect(selfReferences).toEqual([]);
  });

  // `--text` and `--surface-hover` were used for months and defined nowhere.
  it('defines every token it uses', () => {
    const defined = new Set([
      ...[...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name),
      // Set per element from script, as an inline style: a service's own colour for each theme,
      // between which the stylesheet chooses `--accent` (renderer/accent.ts).
      '--accent-dark',
      '--accent-light',
    ]);
    const used = [...css.matchAll(/var\((--[\w-]+)\s*\)/g)].map(([, name]) => name);
    expect([...new Set(used.filter((name) => !defined.has(name)))]).toEqual([]);
  });
});
