// @vitest-environment jsdom
// Meeting controls in services' pages (decision #115). The page-side probe only collects strings;
// what they mean is decided in core/services/meeting.ts. These run the real probe script against
// markup shaped like each service's, then check what core makes of it.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { catalogById } from '@shared/catalog';
import { asMeetingProbe, clickScript, mergeMeetings, probeScript, readMeeting } from '@core/services/meeting';
import type { MeetingRules } from '@shared/types';

const rules = (id: string): MeetingRules => {
  const found = catalogById(id)?.meeting;
  if (!found) throw new Error(`${id} has no meeting rules`);
  return found;
};

/** Runs the probe the bridge would run, against the current document. */
const probe = (r: MeetingRules) => asMeetingProbe((0, eval)(probeScript(r)));

describe('reading a call from the page', () => {
  it('Teams: the mic from data-state, the camera from its label, in a call while hang-up is there', () => {
    document.body.innerHTML = `
      <button id="microphone-button" data-state="mic-off" aria-label="Unmute (⌘+Shift+M)"></button>
      <button id="video-button" aria-label="Turn camera off"></button>
      <button id="share-button" aria-label="Share (⌘+Shift+E)"></button>
      <button id="hangup-button" aria-label="Leave"></button>`;
    const state = readMeeting(rules('teams'), probe(rules('teams'))!);
    assert.equal(state.inCall, true);
    assert.deepEqual(state.controls, { mute: true, video: true, share: false, leave: null });
  });

  it("Meet: data-is-muted — and the camera's means OFF, so it reads the other way round", () => {
    document.body.innerHTML = `
      <button jsname="hw0c9" data-is-muted="false" aria-label="Turn off microphone"></button>
      <button jsname="psRWwc" data-is-muted="true" aria-label="Turn on camera"></button>
      <button jsname="FpSaz" aria-pressed="true" aria-label="Lower hand"></button>
      <button jsname="CQylAd" aria-label="Leave call"></button>`;
    const state = readMeeting(rules('meet'), probe(rules('meet'))!);
    assert.equal(state.inCall, true);
    assert.equal(state.controls.mute, false, 'mic live');
    assert.equal(state.controls.video, false, 'camera off');
    assert.equal(state.controls.hand, true);
  });

  it('Slack: the camera from which icon it holds, share from aria-pressed', () => {
    document.body.innerHTML = `
      <button data-qa="segmented-mute-button-main" aria-label="Mute microphone"></button>
      <button data-qa="huddle_camera_huddle_toolbar"><span data-qa="huddle_video_icon_camera_on"></span></button>
      <button data-qa="huddle_toolbar_screenshare_button" aria-pressed="false"></button>
      <button data-qa="huddle_toolbar__leave_button" aria-label="Leave huddle"></button>`;
    const state = readMeeting(rules('slack'), probe(rules('slack'))!);
    assert.deepEqual(state, { inCall: true, controls: { mute: false, video: true, share: false, leave: null } });
  });

  it('no call: nothing found, not in a call', () => {
    document.body.innerHTML = `<main>#general</main>`;
    assert.deepEqual(readMeeting(rules('teams'), probe(rules('teams'))!), { inCall: false, controls: {} });
  });

  it('a press clicks the control, and reports whether there was one', () => {
    let clicks = 0;
    document.body.innerHTML = `<button id="microphone-button"></button>`;
    document.getElementById('microphone-button')!.addEventListener('click', () => clicks++);
    assert.equal((0, eval)(clickScript(rules('teams').controls.mute!)), true);
    assert.equal(clicks, 1);
    assert.equal((0, eval)(clickScript(rules('teams').controls.share!)), false, 'no share button');
  });
});

describe('what a page hands back is checked', () => {
  it('SHAPE: anything but the probe shape is nothing', () => {
    for (const bad of [null, 1, 'x', [], { inCall: 'yes', found: {} }, { inCall: true }]) {
      assert.equal(asMeetingProbe(bad), null, JSON.stringify(bad));
    }
  });

  it('only known controls, and labels clamped', () => {
    const cleaned = asMeetingProbe({ inCall: true, found: { mute: { label: 'x'.repeat(10_000), attr: null, child: null }, evil: { label: 'y' } } });
    assert.ok(cleaned);
    assert.equal(cleaned.found.mute?.label.length, 200);
    assert.equal('evil' in cleaned.found, false);
  });

  it('a selector with quotes in it stays inside its string', () => {
    const script = probeScript({ inCall: `a"]); alert(1); //`, controls: {} });
    // The selector is JSON: evaluating the script must not run anything but the probe.
    document.body.innerHTML = '';
    const result = (0, eval)(script) as { inCall: boolean };
    assert.equal(result.inCall, false);
  });
});

describe('several windows, one meeting', () => {
  it("Slack's huddle window wins over the channel behind it", () => {
    const channel = { inCall: false, controls: {} };
    const huddle = { inCall: true, controls: { mute: true } };
    assert.deepEqual(mergeMeetings([channel, huddle]), { inCall: true, controls: { mute: true } });
  });
});

describe('the catalog rules', () => {
  it('every rule has a selector, and ON tests where it has state', () => {
    for (const id of ['teams', 'slack', 'meet']) {
      const r = rules(id);
      assert.ok(r.inCall, id);
      for (const [name, rule] of Object.entries(r.controls)) {
        assert.ok(rule?.selector, `${id}.${name}`);
        if (name !== 'leave') assert.ok(rule?.on?.length || rule?.read === 'child', `${id}.${name} needs an ON test`);
      }
    }
  });

  it('BLANK POPUPS ONLY WHERE A HUDDLE NEEDS THEM', () => {
    assert.equal(catalogById('slack')?.blankPopups, true);
    for (const id of ['teams', 'meet', 'gmail']) assert.notEqual(catalogById(id)?.blankPopups, true, id);
  });
});
