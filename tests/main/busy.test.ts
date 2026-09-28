// What Hangar asks before ending a call or silencing a page. The wording is the part a person
// reads in a hurry, so it says which service, what it's doing, and what will happen.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { interruptPrompt, quitPrompt } from '@core/runtime/busy';

describe('before sleeping or popping out a busy service', () => {
  it('names the service and says the call ends', () => {
    const prompt = interruptPrompt({ name: 'Slack', reason: 'call' }, 'sleep');
    assert.equal(prompt.message, 'Slack is in a call. Put it to sleep?');
    assert.match(prompt.detail, /end the call/);
    assert.equal(prompt.confirm, 'Put to sleep');
  });

  it('popping out reloads the page, so it says that', () => {
    const prompt = interruptPrompt({ name: 'Spotify', reason: 'audio' }, 'pop-out');
    assert.equal(prompt.message, 'Spotify is playing audio. Pop it out?');
    assert.match(prompt.detail, /loads the page afresh.*stop the sound/);
    assert.equal(prompt.confirm, 'Pop out');
  });
});

describe('before quitting', () => {
  it('nothing busy: no prompt of its own', () => {
    assert.equal(quitPrompt([]), null);
  });

  it('one, or several, each named', () => {
    assert.equal(quitPrompt([{ name: 'Teams', reason: 'call' }])?.message, 'Teams is in a call. Quit Hangar?');
    const several = quitPrompt([
      { name: 'Teams', reason: 'call' },
      { name: 'Slack', reason: 'call' },
      { name: 'Spotify', reason: 'audio' },
    ]);
    assert.equal(several?.message, 'Teams is in a call, Slack is in a call and Spotify is playing audio. Quit Hangar?');
    assert.match(several!.detail, /ends every call/);
    assert.match(quitPrompt([{ name: 'Spotify', reason: 'audio' }])!.detail, /stops the sound/);
  });
});
