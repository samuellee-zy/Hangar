// "Open when complete" must open a document, never run a program a page chose to download.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { safeToAutoOpen } from '@core/runtime/downloads';

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
