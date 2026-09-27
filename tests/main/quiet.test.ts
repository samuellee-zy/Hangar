// Timed Do Not Disturb and timed mutes. A timed quiet period sets the same flags a manual one does
// — `dnd`, `notificationLevel: 'muted'` — plus an alarm; these decide when the alarm has gone off.

import { describe, it, expect } from 'vitest';
import assert from 'node:assert/strict';
import { expiredQuiet, muteUntil, settleMute, tomorrowMorning, unmute, type MuteFields } from '@core/notify/policy';

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

describe('what a mute goes back to', () => {
  it('A BADGE-ONLY SERVICE MUTED FOR AN HOUR COMES BACK BADGE-ONLY — it came back with banners', () => {
    const svc: MuteFields = { notificationLevel: 'badge' };
    muteUntil(svc, 1_000);
    expect(svc).toEqual({ notificationLevel: 'muted', mutedUntil: 1_000, mutedFrom: 'badge' });
    unmute(svc);
    expect(svc).toEqual({ notificationLevel: 'badge' });
  });

  it('a re-mute moves the end and keeps what it goes back to', () => {
    const svc: MuteFields = { notificationLevel: 'badge' };
    muteUntil(svc, 1_000);
    muteUntil(svc, 5_000);
    expect(svc).toEqual({ notificationLevel: 'muted', mutedUntil: 5_000, mutedFrom: 'badge' });
  });

  it("UNMUTING WHAT ISN'T MUTED CHANGES NOTHING — a badge-only service kept its banners off", () => {
    const svc: MuteFields = { notificationLevel: 'badge' };
    unmute(svc);
    expect(svc).toEqual({ notificationLevel: 'badge' });
  });

  it('a level chosen outright forgets the memory; Off from badge-only remembers it', () => {
    const svc: MuteFields = { notificationLevel: 'muted', mutedFrom: 'badge' };
    svc.notificationLevel = 'all';
    settleMute(svc, 'muted');
    expect(svc.mutedFrom).toBeUndefined();

    const other: MuteFields = { notificationLevel: 'muted' };
    settleMute(other, 'badge');
    expect(other.mutedFrom).toBe('badge');
    unmute(other);
    expect(other.notificationLevel).toBe('badge');
  });

  it('an ordinary service unmutes to all', () => {
    const svc: MuteFields = {};
    muteUntil(svc, 1_000);
    unmute(svc);
    expect(svc).toEqual({ notificationLevel: 'all' });
  });
});
