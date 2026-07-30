// `set-preference` carries an arbitrary path and value across the IPC boundary, so it's the one
// place a malformed renderer message could corrupt config on disk. These pin the validation.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, setPreference, withDefaults } from '../../src/main/preferences';


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

  it('a corrupt preferences blob falls back to defaults instead of throwing', () => {
    assert.deepEqual(withDefaults('nonsense'), DEFAULT_PREFERENCES);
    assert.deepEqual(withDefaults(null), DEFAULT_PREFERENCES);
    assert.deepEqual(withDefaults([1, 2, 3]), DEFAULT_PREFERENCES);
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
