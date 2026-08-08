// @vitest-environment jsdom
//
// Whether a browser will accept the catalog's unread selectors, which is a question only a browser
// can answer — hence the one file in `tests/shared` that asks for a DOM.
//
// It matters because the failure is silent in both directions. A selector that throws is caught
// page-side and reported as "no information", so a typo'd rule is indistinguishable from a service
// that has nothing to report; and the `read`/`attr` combinations below produce a rule that matches
// and always answers zero, which looks like a service you have read everything in.

import { describe, it, expect } from 'vitest';
import { catalog } from '@shared/catalog';

const rules = catalog.flatMap((entry) =>
  (entry.unread?.dom ?? []).map((rule) => ({ id: entry.id, rule }))
);

describe('catalog unread selectors', () => {
  it('parses every selector and every anchor', () => {
    for (const { id, rule } of rules) {
      expect(() => document.querySelector(rule.selector), `${id}: ${rule.selector}`).not.toThrow();
      const { anchor } = rule;
      if (anchor) expect(() => document.querySelector(anchor), `${id}: ${anchor}`).not.toThrow();
    }
  });

  it('THE ANCHOR IS NOT THE SELECTOR — an anchor that matches the badge can never report zero', () => {
    // The anchor exists to tell "no badge" apart from "not loaded". Point it at the badge itself
    // and the two collapse: the badge disappearing takes the anchor with it, the rule falls back to
    // "no information", and the count sticks at its last value forever.
    for (const { id, rule } of rules) {
      if (rule.anchor) expect(rule.anchor, id).not.toBe(rule.selector);
    }
  });

  it('is actually looking at some rules', () => {
    // Every assertion above passes vacuously against an empty list, and the list is built by a
    // flatMap over optional fields — one renamed field and this file goes quietly green.
    expect(rules.length).toBeGreaterThan(0);
  });
});
