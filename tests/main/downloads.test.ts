// "Open when complete" must open a document, never run a program a page chose to download.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { downloadNotice, downloadProgress, safeToAutoOpen } from '@core/runtime/downloads';

describe('which downloads open by themselves', () => {
  it('documents, images, media and archives do', () => {
    for (const name of ['invoice.pdf', 'photo.JPG', 'notes.txt', 'deck.pptx', 'song.mp3', 'bundle.zip', 'README']) {
      assert.equal(safeToAutoOpen(name), true, name);
    }
  });

  it('A SCRIPT OR APP DOES NOT — a page could otherwise run code by downloading it', () => {
    for (const name of ['invoice.command', 'setup.sh', 'Installer.pkg', 'Tool.app', 'disk.dmg', 'run.scpt', 'x.workflow', 'profile.mobileconfig']) {
      assert.equal(safeToAutoOpen(name), false, name);
    }
  });

  it('the check is on the last extension, case-insensitively', () => {
    assert.equal(safeToAutoOpen('report.pdf.command'), false);
    assert.equal(safeToAutoOpen('SETUP.SH'), false);
    assert.equal(safeToAutoOpen('archive.command.zip'), true);
  });

  it('dotfiles and trailing dots are not mistaken for extensions', () => {
    assert.equal(safeToAutoOpen('.bashrc'), true);
    assert.equal(safeToAutoOpen('weird.'), true);
  });
});

describe('what a finished download says', () => {
  it('A FINISHED ONE NAMES THE FILE AND THE SERVICE — it used to land without a word', () => {
    assert.deepEqual(downloadNotice({ name: 'report.pdf', state: 'completed' }, 'Slack'), {
      title: 'Downloaded report.pdf',
      body: 'From Slack. Click to show it in Finder.',
    });
  });

  it('a failed one says so; a cancelled or running one says nothing', () => {
    assert.equal(downloadNotice({ name: 'big.zip', state: 'interrupted' }, 'WhatsApp')?.title, "Couldn't download big.zip");
    assert.equal(downloadNotice({ name: 'big.zip', state: 'cancelled' }, 'WhatsApp'), null);
    assert.equal(downloadNotice({ name: 'big.zip', state: 'progressing' }, 'WhatsApp'), null);
  });

  it('no service, no "From"', () => {
    assert.equal(downloadNotice({ name: 'a.png', state: 'completed' }, null)?.body, 'Click to show it in Finder.');
  });
});

describe("the Dock's progress bar", () => {
  const d = (state: string, received: number, total: number) => ({ state, received, total });

  it('none running: no bar', () => {
    assert.equal(downloadProgress([]), -1);
    assert.equal(downloadProgress([d('completed', 10, 10)]), -1);
  });

  it('across everything still running, by bytes', () => {
    assert.equal(downloadProgress([d('progressing', 25, 100), d('progressing', 75, 100), d('completed', 5, 5)]), 0.5);
  });

  it('A SIZE NOBODY SENT COUNTS AS NOT STARTED — so the bar never runs backwards', () => {
    assert.equal(downloadProgress([d('progressing', 500, 0)]), 0);
    assert.equal(downloadProgress([d('progressing', 50, 100), d('progressing', 500, 0)]), 0.5);
  });
});
