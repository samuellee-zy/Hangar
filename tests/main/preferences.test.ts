// `set-preference` carries an arbitrary path and value across the IPC boundary, so it's the one
// place a malformed renderer message could corrupt config on disk. These pin the validation.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, resetPreferences, setPreference, withDefaults } from '@core/config/preferences';


const fresh = () => withDefaults(undefined);

describe("defaults and merging", () => {

  it('defaults produce a complete object', () => {
    const p = fresh();
    assert.equal(p.appearance.railPosition, 'left');
    assert.equal(p.appearance.railSize, 72);
    assert.deepEqual(p.behaviour.spellcheckLanguages, ['en-US']);
  });

  it('a stored config missing whole sections is filled in, not left undefined', () => {
    // This is the upgrade path: a v2 config has no `preferences` key at all.
    const p = withDefaults({ appearance: { railSize: 96 } });
    assert.equal(p.appearance.railSize, 96, 'stored value wins');
    assert.equal(p.appearance.theme, 'system', 'missing sibling filled from defaults');
    assert.equal(p.behaviour.confirmQuit, false, 'missing section filled from defaults');
  });

  it('unknown keys in a stored config are dropped rather than carried', () => {
    const p = withDefaults({ appearance: { fromTheFuture: true } });
    assert.equal('fromTheFuture' in p.appearance, false);
  });

  it('A STORED startHidden IS DROPPED — the setting was removed, not just hidden from Settings', () => {
    // Removed in decision #96: hidden at every packaged start, with a Dock click that only focused
    // and a tray that rendered blank, it left the app running with no way to reach it. Existing
    // configs carry `startHidden: true`, and it must not survive into the merged preferences.
    const p = withDefaults({ behaviour: { startHidden: true, closeToTray: true } });
    assert.equal('startHidden' in p.behaviour, false);
    assert.equal(p.behaviour.closeToTray, true, 'its neighbours are untouched');
  });

  it('a corrupt preferences blob falls back to defaults instead of throwing', () => {
    assert.deepEqual(withDefaults('nonsense'), DEFAULT_PREFERENCES);
    assert.deepEqual(withDefaults(null), DEFAULT_PREFERENCES);
    assert.deepEqual(withDefaults([1, 2, 3]), DEFAULT_PREFERENCES);
  });

  it('AN UNBOUND SHORTCUT SURVIVES THE MERGE', () => {
    // The reason chords are stored as strings rather than objects. `merge` descends *into* an
    // object leaf and fills its missing keys from the default, so an unbound action stored as
    // `{}` would come back holding whatever chord it used to have — and clearing a shortcut would
    // silently not stick. `''` is a scalar, so it replaces.
    const p = withDefaults({ keyboard: { bindings: { palette: '' } } });
    assert.equal(p.keyboard.bindings['palette'], '');
    assert.equal(p.keyboard.bindings['find'], DEFAULT_PREFERENCES.keyboard.bindings['find']);
  });

  it('a binding for an action this build does not have is dropped', () => {
    // Defaults are the schema, including here — so a config synced from a newer build can't leave
    // a chord bound to an action nothing dispatches.
    const p = withDefaults({ keyboard: { bindings: { 'time-travel': 'meta+t' } } });
    assert.equal('time-travel' in p.keyboard.bindings, false);
  });

  it('bindings are copied, not aliased to the shared defaults', () => {
    // `DEFAULT_PREFERENCES` is a module constant: a merge that handed back the same object would
    // let one rebind change the defaults for the rest of the process.
    const p = fresh();
    p.keyboard.bindings['palette'] = 'meta+j';
    assert.notEqual(DEFAULT_PREFERENCES.keyboard.bindings['palette'], 'meta+j');
  });
});

describe("setPreference validation", () => {

  it('a valid nested path is applied', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'appearance.theme', 'dark'), true);
    assert.equal(p.appearance.theme, 'dark');
  });

  it('an unknown path is rejected and changes nothing', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'appearance.nope', 1), false);
    assert.equal(setPreference(p, 'nope.theme', 1), false);
    assert.equal('nope' in p, false);
  });

  it('a type mismatch is rejected — no strings into numbers', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'appearance.railSize', 'wide'), false);
    assert.equal(p.appearance.railSize, 72);
    assert.equal(setPreference(p, 'appearance.showLabels', 'yes'), false);
    assert.equal(p.appearance.showLabels, false);
  });

  it('null is allowed only where the default is already nullable', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'notifications.dndUntil', null), true, 'nullable default');
    assert.equal(setPreference(p, 'downloads.folder', null), true, 'nullable default');
    assert.equal(setPreference(p, 'appearance.theme', null), false, 'not nullable');
    assert.equal(p.appearance.theme, 'system');
  });

  it('arrays and scalars are not interchangeable', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'behaviour.spellcheckLanguages', 'en-US'), false);
    assert.equal(setPreference(p, 'behaviour.spellcheckLanguages', ['en-GB', 'fr']), true);
    assert.deepEqual(p.behaviour.spellcheckLanguages, ['en-GB', 'fr']);
  });

  it('writing to a branch rather than a leaf is rejected', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'appearance', { railSize: 1 }), false);
    assert.equal(p.appearance.railSize, 72);
  });

  it('an empty path is rejected', () => {
    assert.equal(setPreference(fresh(), '', 1), false);
  });
});

// Settings sends these and nothing tested them. Every one is a path the renderer actually uses,
// and a rejected write is silent — the control snaps back and nobody knows why.
describe('deep paths — three levels, all reachable from Settings', () => {
  it('accepts every proxy field with the right type', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'network.proxy.host', 'proxy.local'), true);
    assert.equal(p.network.proxy.host, 'proxy.local');
    assert.equal(setPreference(p, 'network.proxy.port', 8080), true);
    assert.equal(p.network.proxy.port, 8080);
    assert.equal(setPreference(p, 'network.proxy.mode', 'socks5'), true);
  });

  it('rejects a proxy port sent as a string, which is what an <input> naturally produces', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'network.proxy.port', '8080'), false);
    assert.equal(p.network.proxy.port, 0);
  });

  it('accepts all four Firebase fields and rejects non-strings', () => {
    const p = fresh();
    for (const key of ['projectId', 'appId', 'apiKey', 'messagingSenderId']) {
      assert.equal(setPreference(p, `notifications.firebase.${key}`, 'x'), true, key);
      assert.equal(setPreference(p, `notifications.firebase.${key}`, 42), false, key);
    }
    assert.equal(p.notifications.firebase.apiKey, 'x');
  });

  it('a branch write at depth two is still refused', () => {
    // Replacing a whole section wholesale bypasses per-key type validation.
    const p = fresh();
    assert.equal(setPreference(p, 'network.proxy', { mode: 'none', host: '', port: 0 }), false);
    assert.equal(setPreference(p, 'notifications.firebase', { apiKey: 'x' }), false);
  });

  it('an unknown leaf under a real branch is refused', () => {
    const p = fresh();
    assert.equal(setPreference(p, 'network.proxy.username', 'admin'), false);
    assert.equal(setPreference(p, 'notifications.firebase.secret', 'x'), false);
  });

  it('A CORRUPT BRANCH RETURNS FALSE rather than throwing out of the IPC handler', () => {
    // The path check used to look only at the schema, which proves the path is *real* and says
    // nothing about the config actually having an object there. `withDefaults` rebuilds any branch
    // that isn't one, so this needs to be forced — but the whole job of this function is to be the
    // validator standing between an IPC message and the config, and a validator that assumes its
    // input is well-formed is not one.
    for (const corrupt of ['a string', 42, null, [], true]) {
      const p = fresh();
      (p as unknown as Record<string, unknown>).network = corrupt;
      assert.equal(
        setPreference(p, 'network.proxy.port', 8080),
        false,
        `network = ${JSON.stringify(corrupt)}`
      );
    }
  });

  it('a corrupt branch at depth two is refused the same way', () => {
    const p = fresh();
    (p.network as unknown as Record<string, unknown>).proxy = 'nope';
    assert.equal(setPreference(p, 'network.proxy.port', 8080), false);
  });
});

describe('reset to defaults', () => {
  it('resets one section and leaves the others alone', () => {
    const p = fresh();
    setPreference(p, 'appearance.railPosition', 'right');
    setPreference(p, 'behaviour.confirmQuit', true);

    const next = resetPreferences(p, 'appearance');
    assert.equal(next.appearance.railPosition, 'left');
    assert.equal(next.behaviour.confirmQuit, true, 'behaviour must survive an appearance reset');
  });

  it('resets everything when given no section', () => {
    const p = fresh();
    setPreference(p, 'appearance.railPosition', 'bottom');
    setPreference(p, 'behaviour.confirmQuit', true);

    const next = resetPreferences(p);
    assert.equal(next.appearance.railPosition, 'left');
    assert.equal(next.behaviour.confirmQuit, false);
  });

  it('AN UNKNOWN SECTION CHANGES NOTHING — it must not reset everything', () => {
    // This arrives over IPC. Falling through to a full reset on a typo'd section would be a far
    // worse failure than doing nothing.
    const p = fresh();
    setPreference(p, 'appearance.railPosition', 'top');
    assert.equal(resetPreferences(p, 'nonsense').appearance.railPosition, 'top');
  });

  it('never returns a value aliasing DEFAULT_PREFERENCES', () => {
    // The Phase 2 bug: returning the shared constant meant the first edit afterwards mutated the
    // defaults for the rest of the process.
    const next = resetPreferences(fresh());
    next.appearance.railSize = 999;
    assert.equal(DEFAULT_PREFERENCES.appearance.railSize, 72);
  });

  it('a reset section is deep-copied, not shared', () => {
    const a = resetPreferences(fresh(), 'behaviour');
    const b = resetPreferences(fresh(), 'behaviour');
    a.behaviour.spellcheckLanguages.push('fr');
    assert.deepEqual(b.behaviour.spellcheckLanguages, ['en-US']);
  });
});

describe('what a full reset preserves', () => {
  it('KEEPS the sync repo path — Reset all must not silently disable sync', () => {
    // The UI omits `sync` from the per-section list, then Reset all wiped it anyway under a hint
    // promising only preferences were affected.
    const p = fresh();
    setPreference(p, 'sync.repoPath', '/Users/me/dotfiles');
    setPreference(p, 'appearance.railPosition', 'right');

    const next = resetPreferences(p);
    assert.equal(next.sync.repoPath, '/Users/me/dotfiles');
    assert.equal(next.appearance.railPosition, 'left', 'everything else still resets');
  });

  it('KEEPS the Firebase credentials — retyping them means a trip to a console', () => {
    const p = fresh();
    setPreference(p, 'notifications.firebase.apiKey', 'AIza-secret');
    setPreference(p, 'notifications.sound', false);

    const next = resetPreferences(p);
    assert.equal(next.notifications.firebase.apiKey, 'AIza-secret');
    assert.equal(next.notifications.sound, true, 'the rest of notifications still resets');
  });

  it('but a SECTION reset still clears them — that path is explicit', () => {
    const p = fresh();
    setPreference(p, 'notifications.firebase.apiKey', 'AIza-secret');
    assert.equal(resetPreferences(p, 'notifications').notifications.firebase.apiKey, '');
  });

  it('preserved values are copies, not references into the previous object', () => {
    const p = fresh();
    setPreference(p, 'notifications.firebase.apiKey', 'k');
    const next = resetPreferences(p);
    next.notifications.firebase.apiKey = 'changed';
    assert.equal(p.notifications.firebase.apiKey, 'k');
  });
});
