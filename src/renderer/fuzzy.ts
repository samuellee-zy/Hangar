/**
 * Subsequence match — "gml" finds Gmail, "gcal" finds Google Calendar.
 *
 * Deliberately not a scored fuzzy matcher: the candidate lists here are a handful of services and
 * a couple of dozen catalog entries, so ranking buys nothing that ordering by relevance-of-source
 * doesn't already give. Shared so the palette and the connection picker can't diverge.
 */
export function fuzzy(needle: string, haystack: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let i = 0;
  for (const ch of h) if (ch === n[i] && ++i === n.length) return true;
  return i === n.length;
}
