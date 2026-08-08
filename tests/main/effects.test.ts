// Which preference needs which side effect.
//
// This was an if/else chain inside AppWindow, so the question "does changing the API key restart
// push?" could not be asked without an Electron session. It also drifted: the reset path iterated a
// second, hand-written list of representative paths under a comment claiming a new branch "can't be
// forgotten here" — it could, because nothing tied the list to the chain.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  ALL_PREFERENCE_EFFECTS,
  preferenceEffectFor,
  trayWanted,
} from '@core/config/effects';
import { DEFAULT_PREFERENCES, withDefaults } from '@core/config/preferences';

describe('mapping a path to its effect', () => {
  it('every login-item path maps to it — they are all one launchd job', () => {
    assert.equal(preferenceEffectFor('behaviour.launchAtLogin'), 'login-item');
    assert.equal(preferenceEffectFor('behaviour.startHidden'), 'login-item');
    // Without this, turning relaunch on writes the preference and never touches the plist, so it
    // takes effect the next time some *other* login-item setting happens to change.
    assert.equal(preferenceEffectFor('behaviour.relaunchOnCrash'), 'login-item');
  });

  it('EVERY proxy field re-applies the proxy, not just the mode', () => {
    // Prefix-matched, because host and port changing without a re-apply means the new proxy is in
    // the config and not in any session.
    for (const path of ['network.proxy.mode', 'network.proxy.host', 'network.proxy.port']) {
      assert.equal(preferenceEffectFor(path), 'proxy', path);
    }
  });

  it('CLOSE-TO-TRAY IS A TRAY EFFECT, not just showTrayIcon', () => {
    // The pairing that is easy to miss: turning closeToTray on has to create the icon, or the next
    // window close hides the app with nothing left that leads back to it.
    assert.equal(preferenceEffectFor('appearance.showTrayIcon'), 'tray');
    assert.equal(preferenceEffectFor('behaviour.closeToTray'), 'tray');
  });

  it('every Firebase field restarts push, not only the push toggle', () => {
    // Editing the API key while push is on has to reconnect with it; otherwise the sockets keep
    // using the credential the user just replaced.
    assert.equal(preferenceEffectFor('notifications.push'), 'push');
    for (const key of ['projectId', 'appId', 'apiKey', 'messagingSenderId']) {
      assert.equal(preferenceEffectFor(`notifications.firebase.${key}`), 'push', key);
    }
  });

  it('the remaining two map to themselves', () => {
    assert.equal(preferenceEffectFor('behaviour.globalShortcut'), 'shortcut');
    assert.equal(preferenceEffectFor('behaviour.spellcheckLanguages'), 'spellcheck');
  });

  it('an ordinary preference needs NO effect beyond being written', () => {
    // Re-running everything on each write meant adjusting the rail size re-registered the global
    // shortcut and kicked off an unawaited proxy fan-out across every session.
    for (const path of [
      'appearance.railSize',
      'appearance.theme',
      'behaviour.defaultZoom',
      'notifications.dnd',
      'downloads.folder',
      'sync.repoPath',
    ]) {
      assert.equal(preferenceEffectFor(path), null, path);
    }
  });

  it('an unknown path is null rather than a throw', () => {
    assert.equal(preferenceEffectFor(''), null);
    assert.equal(preferenceEffectFor('made.up.path'), null);
  });
});

describe('the effect list stays in step with the mapping', () => {
  it('EVERY EFFECT THE MAPPING CAN RETURN IS IN THE LIST — the drift this replaces', () => {
    // The reset path iterates the list. An effect reachable from `preferenceEffectFor` but absent
    // from it is an effect that a "reset everything" silently skips.
    const paths = [
      'behaviour.launchAtLogin',
      'behaviour.relaunchOnCrash',
      'behaviour.startHidden',
      'network.proxy.mode',
      'network.blockAds',
      'behaviour.globalShortcut',
      'appearance.showTrayIcon',
      'behaviour.closeToTray',
      'notifications.push',
      'notifications.firebase.apiKey',
      'behaviour.spellcheckLanguages',
    ];

    for (const path of paths) {
      const effect = preferenceEffectFor(path);
      assert.ok(effect, `${path} maps to nothing`);
      assert.ok(ALL_PREFERENCE_EFFECTS.includes(effect), `${effect} is missing from the list`);
    }
  });

  it('and the list contains nothing unreachable', () => {
    // The other direction: a tag in the list that no path produces is an effect run on reset that
    // can never be run by changing a preference, which means one of the two is wrong.
    const reachable = new Set(
      [
        'behaviour.launchAtLogin',
        'network.proxy.mode',
        'network.blockAds',
        'behaviour.globalShortcut',
        'appearance.showTrayIcon',
        'notifications.push',
        'behaviour.spellcheckLanguages',
      ].map(preferenceEffectFor)
    );

    for (const effect of ALL_PREFERENCE_EFFECTS) {
      assert.ok(reachable.has(effect), `${effect} is in the list but no path produces it`);
    }
  });

  it('has no duplicates, so a reset runs each effect once', () => {
    assert.equal(new Set(ALL_PREFERENCE_EFFECTS).size, ALL_PREFERENCE_EFFECTS.length);
  });
});

describe('whether a tray icon should exist', () => {
  const prefs = (over: { showTrayIcon?: boolean; closeToTray?: boolean }) =>
    withDefaults({
      appearance: { ...DEFAULT_PREFERENCES.appearance, showTrayIcon: over.showTrayIcon ?? false },
      behaviour: { ...DEFAULT_PREFERENCES.behaviour, closeToTray: over.closeToTray ?? false },
    });

  it('CLOSE-TO-TRAY FORCES AN ICON even with showTrayIcon off', () => {
    // Otherwise closing the window hides it behind nothing, and the app is unreachable.
    assert.equal(trayWanted(prefs({ showTrayIcon: false, closeToTray: true })), true);
  });

  it('showTrayIcon alone is enough', () => {
    assert.equal(trayWanted(prefs({ showTrayIcon: true, closeToTray: false })), true);
  });

  it('neither means no icon — destroyTray existed and was never called', () => {
    assert.equal(trayWanted(prefs({ showTrayIcon: false, closeToTray: false })), false);
  });

  it('both is still one icon', () => {
    assert.equal(trayWanted(prefs({ showTrayIcon: true, closeToTray: true })), true);
  });
});
