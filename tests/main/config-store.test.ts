// The highest-stakes tests in the project. The bug these pin is unrecoverable: a crash mid-write
// used to leave truncated JSON, and the next launch would write defaults straight over it —
// destroying every service, account, folder and preference, and orphaning every partition on disk.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findQuarantined, pathsFor, readWithRecovery, writeAtomic } from '../../src/main/config-store';


/** A fresh directory per case, so nothing leaks between them. */
let seq = 0;
function tmp() {
  const dir = path.join(os.tmpdir(), `hangar-store-${process.pid}-${seq++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return pathsFor(dir);
}

// Mirrors the real guard in config.ts. `services: []` is deliberately accepted — see the
// "the empty-config data-loss path" block below for why that distinction is load-bearing.
const parse = (text) => {
  const value = JSON.parse(text);
  if (!Array.isArray(value.services)) throw new Error('no services array');
  return value;
};

const GOOD = JSON.stringify({ services: [{ id: 'a' }] });
const GOOD2 = JSON.stringify({ services: [{ id: 'a' }, { id: 'b' }] });

describe("writing", () => {

  it('a write lands and reads back', () => {
    const p = tmp();
    writeAtomic(p, GOOD);
    assert.deepEqual(readWithRecovery(p, parse).value.services, [{ id: 'a' }]);
  });

  it('no temp file is left behind', () => {
    const p = tmp();
    writeAtomic(p, GOOD);
    assert.equal(fs.existsSync(`${p.main}.tmp`), false);
  });

  it('the previous good copy rotates into the backup before being overwritten', () => {
    const p = tmp();
    writeAtomic(p, GOOD);
    writeAtomic(p, GOOD2);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.backup, 'utf8')).services, [{ id: 'a' }]);
    assert.deepEqual(readWithRecovery(p, parse).value.services.length, 2);
  });

  it('the first write creates no backup — there is nothing yet to back up', () => {
    const p = tmp();
    writeAtomic(p, GOOD);
    assert.equal(fs.existsSync(p.backup), false);
  });
});

describe("reading and recovery", () => {

  it('a missing config is a normal first run, not a corruption', () => {
    const p = tmp();
    const result = readWithRecovery(p, parse);
    assert.equal(result.value, null);
    assert.equal(result.quarantined, undefined, 'nothing to quarantine');
  });

  it('TRUNCATED JSON IS QUARANTINED, NEVER OVERWRITTEN', () => {
    // The exact scenario: killed mid-write.
    const p = tmp();
    fs.writeFileSync(p.main, GOOD.slice(0, 12));
    const result = readWithRecovery(p, parse);

    assert.ok(result.quarantined, 'the bad file must be preserved');
    assert.equal(fs.existsSync(result.quarantined), true);
    assert.equal(fs.readFileSync(result.quarantined, 'utf8'), GOOD.slice(0, 12), 'bytes intact');
    assert.equal(fs.existsSync(p.main), false, 'the corrupt file is moved, not left in place');
  });

  it('a corrupt config recovers from the backup rather than resetting', () => {
    const p = tmp();
    writeAtomic(p, GOOD); // establishes nothing yet
    writeAtomic(p, GOOD2); // now backup holds GOOD
    fs.writeFileSync(p.main, '{"services": [trunc');

    const result = readWithRecovery(p, parse);
    assert.deepEqual(result.value.services, [{ id: 'a' }], 'recovered the previous good state');
    assert.ok(result.note.includes('recovered from backup'));
  });

  it('a corrupt config with no backup yields null — the caller uses defaults, nothing is destroyed', () => {
    const p = tmp();
    fs.writeFileSync(p.main, 'not json at all');
    const result = readWithRecovery(p, parse);
    assert.equal(result.value, null);
    assert.ok(result.quarantined, 'still preserved for inspection');
  });

  it('parseable but empty config is treated as corrupt, not accepted', () => {
    // `{}` is valid JSON. Accepting it would silently replace a real config with nothing.
    const p = tmp();
    fs.writeFileSync(p.main, '{}');
    const result = readWithRecovery(p, parse);
    assert.equal(result.value, null);
    assert.ok(result.quarantined);
  });

  it('a missing main file falls back to the backup', () => {
    const p = tmp();
    fs.writeFileSync(p.backup, GOOD);
    const result = readWithRecovery(p, parse);
    assert.deepEqual(result.value.services, [{ id: 'a' }]);
    assert.ok(result.note.includes('restored from backup'));
  });

  it('a corrupt backup does not mask a good main file', () => {
    const p = tmp();
    fs.writeFileSync(p.main, GOOD);
    fs.writeFileSync(p.backup, 'garbage');
    assert.deepEqual(readWithRecovery(p, parse).value.services, [{ id: 'a' }]);
  });

  it('repeated corruption does not clobber an earlier quarantine', () => {
    const p = tmp();
    fs.writeFileSync(p.main, 'bad one');
    const first = readWithRecovery(p, parse).quarantined;
    fs.writeFileSync(p.main, 'bad two');
    const second = readWithRecovery(p, parse).quarantined;
    assert.notEqual(first, second, 'timestamped, so both survive');
    assert.equal(fs.existsSync(first), true);
    assert.equal(fs.existsSync(second), true);
  });
});

describe("the empty-config data-loss path", () => {

  // This is the P0. Removing your last service writes `services: []` — a state the app itself
  // produces and has an EmptyState view for. Treating it as corruption meant: quarantine the real
  // config, fall back to a backup that the next window-move had already overwritten with the same
  // empty config, then write defaults over everything. Six new services, six new partitions, and
  // the user's real setup only in a `.corrupt-*` file nobody mentioned.
  it('AN EMPTY SERVICES ARRAY IS VALID CONFIG, NOT CORRUPTION', () => {
    const paths = tmp();
    const empty = JSON.stringify({ services: [] });
    writeAtomic(paths, empty);
    const result = readWithRecovery(paths, parse);
    assert.deepEqual(result.value, { services: [] });
    assert.equal(result.quarantined, undefined, 'must not be quarantined');
    assert.equal(fs.existsSync(paths.main), true, 'the file must still be there');
  });

  it('the full remove-last-service sequence survives a restart', () => {
    const paths = tmp();
    // 1. A real config with services.
    writeAtomic(paths, GOOD2);
    // 2. User removes the last service.
    writeAtomic(paths, JSON.stringify({ services: [] }));
    // 3. A window move writes again — this is what used to poison the backup too.
    writeAtomic(paths, JSON.stringify({ services: [] }));
    // 4. Restart.
    const result = readWithRecovery(paths, parse);
    assert.deepEqual(result.value, { services: [] });
    assert.equal(result.quarantined, undefined);
    assert.equal(fs.readdirSync(path.dirname(paths.main)).some((f) => f.includes('corrupt')), false);
  });

  it('a MISSING services key is still corruption — the distinction is structural, not emptiness', () => {
    const paths = tmp();
    // Twice: the first write has nothing to rotate, so the backup only exists after the second.
    writeAtomic(paths, GOOD);
    writeAtomic(paths, GOOD);
    fs.writeFileSync(paths.main, JSON.stringify({ preferences: {} }));
    const result = readWithRecovery(paths, parse);
    assert.ok(result.quarantined, 'should quarantine');
    assert.deepEqual(result.value, { services: [{ id: 'a' }] }, 'and recover the backup');
  });
});

describe("surfacing quarantined copies", () => {

  it('quarantined files are discoverable after the fact', () => {
    const paths = tmp();
    assert.deepEqual(findQuarantined(paths), []);
    writeAtomic(paths, GOOD);
    fs.writeFileSync(paths.main, '{ truncated');
    const { quarantined } = readWithRecovery(paths, parse);
    assert.deepEqual(findQuarantined(paths), [quarantined]);
  });

  it('several are returned newest-first, including same-millisecond collisions', () => {
    const paths = tmp();
    const dir = path.dirname(paths.main);
    // `-2` is the collision suffix; a lexical sort would misplace it, so mtime decides.
    const older = path.join(dir, 'config.json.corrupt-1000');
    const newer = path.join(dir, 'config.json.corrupt-1000-2');
    fs.writeFileSync(older, 'x');
    fs.writeFileSync(newer, 'y');
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(9000), new Date(9000));
    assert.deepEqual(findQuarantined(paths), [newer, older]);
  });

  it('the backup and temp files are never mistaken for quarantined copies', () => {
    const paths = tmp();
    writeAtomic(paths, GOOD);
    writeAtomic(paths, GOOD2); // creates config.backup.json
    assert.deepEqual(findQuarantined(paths), []);
  });
});
