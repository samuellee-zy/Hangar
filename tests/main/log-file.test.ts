// Keeping the log a sane size, and keeping sign-in secrets out of it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { rotateIfLarge } from '@main/platform/log-file';
import { redactUrlsIn } from '@core/runtime/urls';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-log-'));

describe('rotating the log at boot', () => {
  it('a log past the limit is kept once as .1 and truncated in place', () => {
    const dir = scratch();
    const file = path.join(dir, 'hangar.log');
    fs.writeFileSync(file, 'x'.repeat(2048));

    assert.equal(rotateIfLarge(file, 1024), true);
    assert.equal(fs.statSync(file).size, 0, 'truncated, not renamed — launchd holds it open');
    assert.equal(fs.statSync(`${file}.1`).size, 2048);
  });

  it('IN PLACE: A DESCRIPTOR OPENED IN APPEND MODE KEEPS WRITING TO THE LIVE FILE', () => {
    // What launchd does with StandardOutPath. A rename would have sent the rest of the session to .1.
    const dir = scratch();
    const file = path.join(dir, 'hangar.log');
    fs.writeFileSync(file, 'old'.repeat(1000));
    const fd = fs.openSync(file, 'a');

    rotateIfLarge(file, 100);
    fs.writeSync(fd, 'after rotation\n');
    fs.closeSync(fd);

    assert.equal(fs.readFileSync(file, 'utf8'), 'after rotation\n', 'no hole, no old content');
  });

  it('a small log, or none, is left alone', () => {
    const dir = scratch();
    const file = path.join(dir, 'hangar.log');
    assert.equal(rotateIfLarge(file, 1024), false, 'missing');
    fs.writeFileSync(file, 'small');
    assert.equal(rotateIfLarge(file, 1024), false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'small');
  });
});

describe('redacting URLs inside log lines we did not write', () => {
  it("ELECTRON'S OWN LOAD-FAILURE WARNING LOSES ITS QUERY STRING — the email address was in it", () => {
    const line =
      'electron: Failed to load URL: https://login.microsoftonline.com/t/oauth2/v2.0/authorize?login_hint=alice%40example.com&state=abc with error: ERR_INTERNET_DISCONNECTED';
    const out = redactUrlsIn(line);
    assert.ok(!out.includes('alice'), out);
    assert.ok(!out.includes('state=abc'), out);
    assert.ok(out.includes('https://login.microsoftonline.com/t/oauth2/v2.0/authorize?…'), out);
    assert.ok(out.endsWith('with error: ERR_INTERNET_DISCONNECTED'), 'the rest of the line survives');
  });

  it('text with no URL is unchanged', () => {
    assert.equal(redactUrlsIn('[boot] single-instance lock: acquired'), '[boot] single-instance lock: acquired');
  });
});
