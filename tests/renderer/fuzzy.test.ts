// Subsequence matching for the palette and the connection picker. Fifteen lines, shared by both
// surfaces, and previously untested — a regression here makes search quietly return the wrong
// things rather than failing.

import { describe, it, expect } from 'vitest';
import { fuzzy } from '../../src/renderer/fuzzy';

describe('fuzzy', () => {
  it('matches a subsequence, which is the whole point', () => {
    expect(fuzzy('gml', 'Gmail')).toBe(true);
    expect(fuzzy('gcal', 'Google Calendar')).toBe(true);
    expect(fuzzy('slk', 'Slack')).toBe(true);
  });

  it('is case-insensitive in both directions', () => {
    expect(fuzzy('GML', 'gmail')).toBe(true);
    expect(fuzzy('gml', 'GMAIL')).toBe(true);
  });

  it('requires the right ORDER — a subsequence, not a bag of letters', () => {
    expect(fuzzy('lmg', 'Gmail')).toBe(false);
    expect(fuzzy('kcals', 'Slack')).toBe(false);
  });

  it('an empty needle matches everything, so an empty palette shows the full list', () => {
    expect(fuzzy('', 'anything')).toBe(true);
    expect(fuzzy('', '')).toBe(true);
  });

  it('a needle longer than the haystack cannot match', () => {
    expect(fuzzy('gmail plus', 'Gmail')).toBe(false);
  });

  it('matches across word boundaries and punctuation', () => {
    expect(fuzzy('mst', 'Microsoft Teams')).toBe(true);
    expect(fuzzy('gd', 'Google Drive')).toBe(true);
  });

  it('a repeated letter needs a repeated match', () => {
    expect(fuzzy('aa', 'Salesforce')).toBe(false); // only one 'a'
    expect(fuzzy('ll', 'Slack')).toBe(false);
    expect(fuzzy('ll', 'Fully')).toBe(true);
  });

  it('handles a haystack with no match at all', () => {
    expect(fuzzy('zzz', 'Gmail')).toBe(false);
  });
});
