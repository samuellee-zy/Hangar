// What an update-service patch is allowed to write.
//
// The handler was a bare `Object.assign(svc, command.patch)`, so this file is mostly a list of
// things that used to reach config.json unchallenged. None of them threw at the time — they
// persisted, survived a restart, and broke something else later.

import { describe, it, expect } from 'vitest';
import { isValidHost, sanitiseServicePatch } from '@core/services/patch';

describe('sanitiseServicePatch', () => {
  it('passes through the fields Settings actually edits', () => {
    expect(
      sanitiseServicePatch({
        name: 'Work Teams',
        zoom: 1.25,
        hibernate: false,
        notificationLevel: 'muted',
        customCss: 'body { zoom: 1 }',
      })
    ).toEqual({
      name: 'Work Teams',
      zoom: 1.25,
      hibernate: false,
      notificationLevel: 'muted',
      customCss: 'body { zoom: 1 }',
    });
  });

  it('refuses to rewrite identity', () => {
    // `accountId` decides which cookie jar the service uses, so a patch that could change it is a
    // patch that can move a signed-in service onto someone else's session.
    expect(sanitiseServicePatch({ id: 'other', accountId: 'other', catalogId: 'gmail' })).toEqual(
      {}
    );
  });

  it('drops a notification level that is not one of the two', () => {
    expect(sanitiseServicePatch({ notificationLevel: 'mentions' })).toEqual({});
    expect(sanitiseServicePatch({ notificationLevel: 'all' })).toEqual({
      notificationLevel: 'all',
    });
  });

  it('clamps zoom and drops a non-number', () => {
    expect(sanitiseServicePatch({ zoom: 99 })).toEqual({ zoom: 2 });
    expect(sanitiseServicePatch({ zoom: 0 })).toEqual({ zoom: 0.5 });
    expect(sanitiseServicePatch({ zoom: Number.NaN })).toEqual({});
    expect(sanitiseServicePatch({ zoom: '1.5' })).toEqual({});
  });

  it('drops an empty name rather than writing an unlabelled tile', () => {
    expect(sanitiseServicePatch({ name: '   ' })).toEqual({});
  });

  it('allows only http(s) urls', () => {
    // A `javascript:` or `file:` URL here would load with the service preload attached.
    expect(sanitiseServicePatch({ url: 'https://example.com' })).toEqual({
      url: 'https://example.com',
    });
    expect(sanitiseServicePatch({ url: 'javascript:alert(1)' })).toEqual({});
    expect(sanitiseServicePatch({ url: 'file:///etc/passwd' })).toEqual({});
  });

  it('keeps the good fields when one beside them is bad', () => {
    // Rejecting the whole patch would mean an unrelated bad value silently discarding the edit the
    // user actually made.
    expect(sanitiseServicePatch({ zoom: Number.NaN, hibernate: true })).toEqual({
      hibernate: true,
    });
  });

  it('normalises host lists and drops what is not a host', () => {
    expect(
      sanitiseServicePatch({
        extraAllowedHosts: ['Teams.Live.com', 'teams.live.com', 'not a host', '', 'com', 42],
      })
    ).toEqual({ extraAllowedHosts: ['teams.live.com'] });
  });

  it('survives a patch that is not an object', () => {
    for (const value of [null, undefined, 'patch', 42, []]) {
      expect(sanitiseServicePatch(value)).toEqual({});
    }
  });
});

describe('isValidHost', () => {
  it('accepts hostnames and nothing else', () => {
    expect(isValidHost('teams.live.com')).toBe(true);
    expect(isValidHost('example.co.uk')).toBe(true);
    // A bare label would allowlist a whole TLD; a URL is not a host; wildcards are not supported
    // by the leading-dot suffix match the allowlist uses.
    expect(isValidHost('com')).toBe(false);
    expect(isValidHost('https://example.com')).toBe(false);
    expect(isValidHost('*.example.com')).toBe(false);
    expect(isValidHost('example.com/path')).toBe(false);
    expect(isValidHost('')).toBe(false);
  });
});
