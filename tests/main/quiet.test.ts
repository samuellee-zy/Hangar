// Timed Do Not Disturb and timed mutes. A timed quiet period sets the same flags a manual one does
// — `dnd`, `notificationLevel: 'muted'` — plus an alarm; these decide when the alarm has gone off.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { expiredQuiet, tomorrowMorning } from '@core/notify/policy';

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('"until tomorrow"', () => {
  it('in the evening, it is 9am the next day', () => {
    assert.equal(tomorrowMorning(at(2026, 9, 26, 18, 30)), at(2026, 9, 27, 9));
  });

  it('IN THE SMALL HOURS IT IS THIS MORNING — not thirty-two hours away', () => {
    assert.equal(tomorrowMorning(at(2026, 9, 27, 1, 15)), at(2026, 9, 27, 9));
  });

  it('crosses a month end', () => {
    assert.equal(tomorrowMorning(at(2026, 9, 30, 20)), at(2026, 10, 1, 9));
  });
});

describe('which quiet periods are over', () => {
  const config = (over: {
    dnd?: boolean;
    dndUntil?: number | null;
    services?: Array<{ id: string; notificationLevel?: 'all' | 'muted'; mutedUntil?: number }>;
  }) => ({
    preferences: { notifications: { dnd: over.dnd ?? false, dndUntil: over.dndUntil ?? null } },
    services: over.services ?? [],
  });

  it('timed DND ends at its time, not before', () => {
    const c = config({ dnd: true, dndUntil: 1_000 });
    assert.equal(expiredQuiet(c, 999).dnd, false);
    assert.equal(expiredQuiet(c, 1_000).dnd, true);
  });

  it('DND "until I turn it off" never expires', () => {
    assert.equal(expiredQuiet(config({ dnd: true, dndUntil: null }), Number.MAX_SAFE_INTEGER).dnd, false);
  });

  it('a timed mute ends; a manual one, and an unmuted service, are left alone', () => {
    const c = config({
      services: [
        { id: 'timed', notificationLevel: 'muted', mutedUntil: 500 },
        { id: 'manual', notificationLevel: 'muted' },
        { id: 'stale', notificationLevel: 'all', mutedUntil: 500 },
      ],
    });
    assert.deepEqual(expiredQuiet(c, 600).services, ['timed']);
  });
});
