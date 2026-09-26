// The launchd job that makes Hangar start at login and come back if it dies.
//
// This is the one feature whose failure mode is invisible: a plist launchd cannot parse, or one
// missing a key, does nothing at all and reports nothing anywhere. Nobody finds out until the next
// login, and what they see then is "the setting doesn't work" rather than an error. So the shape of
// the output is pinned here rather than trusted.

import { describe, it, expect } from 'vitest';
import {
  LAUNCH_AGENT_LABEL,
  isInstalledCopy,
  launchAgentWanted,
  renderLaunchAgent,
} from '@core/config/launch-agent';
import { DEFAULT_PREFERENCES } from '@core/config/preferences';
import type { Preferences } from '@shared/types';

const prefs = (over: Partial<Preferences['behaviour']> = {}): Preferences => ({
  ...DEFAULT_PREFERENCES,
  behaviour: { ...DEFAULT_PREFERENCES.behaviour, ...over },
});

const PATHS = {
  program: '/Applications/Hangar.app/Contents/MacOS/Hangar',
  log: '/Users/alice/Library/Logs/Hangar/hangar.log',
};

describe('whether the job should exist at all', () => {

  it('is written only when launch at login is on', () => {
    expect(launchAgentWanted(prefs({ launchAtLogin: true }))).toBe(true);
    expect(launchAgentWanted(prefs({ launchAtLogin: false }))).toBe(false);
  });

  it('RELAUNCH ALONE IS NOT ENOUGH, because there would be nothing to supervise', () => {
    // launchd only restarts processes it started itself. A Hangar opened from the Dock is not one,
    // so a job that never launches it can never bring it back — the toggle would be a promise
    // nothing could keep.
    expect(launchAgentWanted(prefs({ launchAtLogin: false, relaunchOnCrash: true }))).toBe(false);
  });
});

describe('the plist itself', () => {

  it('carries the label, the executable and the bundle association', () => {
    const plist = renderLaunchAgent(prefs({ launchAtLogin: true }), PATHS);
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>/Applications/Hangar.app/Contents/MacOS/Hangar</string>');
    // Without this key, System Settings lists the item anonymously and it looks like malware.
    expect(plist).toContain('<key>AssociatedBundleIdentifiers</key>');
  });

  it('always runs at load, since that is the only reason the job exists', () => {
    const plist = renderLaunchAgent(prefs({ launchAtLogin: true }), PATHS);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
  });

  it('supervises only when asked, and ONLY ON AN UNSUCCESSFUL EXIT', () => {
    // The critical detail. A bare `KeepAlive: true` restarts after *any* exit, including a
    // deliberate one — which would make Hangar impossible to quit, by design, with no way out from
    // inside the app.
    const on = renderLaunchAgent(prefs({ launchAtLogin: true, relaunchOnCrash: true }), PATHS);
    expect(on).toContain('<key>KeepAlive</key>');
    expect(on).toContain('<key>SuccessfulExit</key>');
    expect(on).toContain('<false/>');
    expect(on).not.toContain('<key>KeepAlive</key>\n  <true/>');
  });

  it('omits KeepAlive entirely when relaunch is off', () => {
    const off = renderLaunchAgent(prefs({ launchAtLogin: true, relaunchOnCrash: false }), PATHS);
    expect(off).not.toContain('KeepAlive');
    expect(off).not.toContain('SuccessfulExit');
  });

  it('sends output somewhere, because a Finder-launched app has no terminal', () => {
    const plist = renderLaunchAgent(prefs({ launchAtLogin: true }), PATHS);
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${PATHS.log}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>${PATHS.log}</string>`);
  });

  it('throttles restarts, so a crash on startup can still be interrupted', () => {
    const plist = renderLaunchAgent(prefs({ launchAtLogin: true, relaunchOnCrash: true }), PATHS);
    expect(plist).toContain('<key>ThrottleInterval</key>');
  });

  it('escapes paths, so an ampersand cannot produce a plist launchd refuses to read', () => {
    const plist = renderLaunchAgent(prefs({ launchAtLogin: true }), {
      program: '/Users/a&b/Hangar.app/Contents/MacOS/Hangar',
      log: '/Users/a&b/log',
    });
    expect(plist).toContain('/Users/a&amp;b/Hangar.app/Contents/MacOS/Hangar');
    expect(plist).not.toContain('/Users/a&b/');
  });

  it('is well-formed XML with a single root, for every combination', () => {
    // Cheap structural check standing in for a parser: launchd rejects the whole file on a
    // mismatch, and the failure is silent.
    for (const relaunchOnCrash of [true, false]) {
      const plist = renderLaunchAgent(prefs({ launchAtLogin: true, relaunchOnCrash }), PATHS);
      expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(plist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
      expect(plist.match(/<plist version="1\.0">/g)).toHaveLength(1);
      expect(plist.match(/<\/plist>/g)).toHaveLength(1);
      expect(plist.match(/<dict>/g)?.length).toBe(plist.match(/<\/dict>/g)?.length);
      expect(plist.match(/<key>/g)?.length).toBe(plist.match(/<\/key>/g)?.length);
    }
  });
});

describe('which copy may claim the login item', () => {
  const home = '/Users/alice';

  it('the copy in /Applications, or in ~/Applications, may', () => {
    expect(isInstalledCopy('/Applications/Hangar.app/Contents/MacOS/Hangar', home)).toBe(true);
    expect(isInstalledCopy('/Users/alice/Applications/Hangar.app/Contents/MacOS/Hangar', home)).toBe(true);
    expect(isInstalledCopy('/Users/alice/Applications/Hangar.app/Contents/MacOS/Hangar', `${home}/`)).toBe(true);
  });

  it('A dist/ BUILD BEING TRIED OUT MAY NOT — it would repoint login at a directory the next build deletes', () => {
    expect(
      isInstalledCopy('/Users/alice/Projects/hangar/dist/mac-arm64/Hangar.app/Contents/MacOS/Hangar', home)
    ).toBe(false);
  });

  it('neither may a copy run from the DMG, or anything that merely mentions Applications', () => {
    expect(isInstalledCopy('/Volumes/Hangar 0.1.0/Hangar.app/Contents/MacOS/Hangar', home)).toBe(false);
    expect(isInstalledCopy('/Users/bob/Applications/Hangar.app/Contents/MacOS/Hangar', home)).toBe(false);
    expect(isInstalledCopy('/tmp/Applications/Hangar.app/Contents/MacOS/Hangar', home)).toBe(false);
  });
});
