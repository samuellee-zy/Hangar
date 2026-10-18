// @vitest-environment jsdom
// Who's waiting in chat services' lists (decision #119). The page-side probe only collects strings;
// what they mean is decided in core/services/conversations.ts. These run the real probe script
// against markup shaped like each service's, then check what core makes of it.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { catalogById } from '@shared/catalog';
import {
  asConversationProbe,
  conversationProbeScript,
  MAX_CONVERSATIONS,
  openConversationScript,
  readConversations,
} from '@core/services/conversations';
import type { ConversationRule } from '@shared/types';

const rules = (id: string): ConversationRule[] => {
  const found = catalogById(id)?.conversations;
  if (!found) throw new Error(`${id} has no conversation rules`);
  return found;
};

/** Runs the probe the bridge would run, against the current document. */
const read = (r: ConversationRule[]) => readConversations(r, asConversationProbe((0, eval)(conversationProbeScript(r)))!);

describe('reading who is waiting', () => {
  it('WhatsApp: names from the title, counts from the badge, muted and read chats left out', () => {
    document.body.innerHTML = `
      <div id="pane-side"><div role="grid">
        <div role="row"><span dir="auto" title="Sophie">Sophie</span><span aria-label="3 unread messages"><span>3</span></span></div>
        <div role="row"><span dir="auto" title="Family">Family</span><span data-icon="muted"></span><span aria-label="12 unread messages">12</span></div>
        <div role="row"><span dir="auto" title="Jon">Jon</span></div>
        <div role="row"><span dir="auto" title="Kelsey">Kelsey</span><span aria-label="Unread"></span></div>
      </div></div>`;
    assert.deepEqual(read(rules('whatsapp')), [
      { id: 'Sophie', name: 'Sophie', unread: 3, mention: false, order: 0 },
      { id: 'Kelsey', name: 'Kelsey', unread: 1, mention: false, order: 3 },
    ]);
  });

  it("Slack: the channel id as the id, the --unread class, a badge as a mention, DMs as mentions", () => {
    document.body.innerHTML = `
      <div data-qa-channel-sidebar-channel-id="C1" data-qa-channel-sidebar-channel-type="channel">
        <a class="p-channel_sidebar__channel p-channel_sidebar__channel--unread"><span class="p-channel_sidebar__name">deal-asos</span></a>
      </div>
      <div data-qa-channel-sidebar-channel-id="C2" data-qa-channel-sidebar-channel-type="channel">
        <a class="p-channel_sidebar__channel"><span class="p-channel_sidebar__name">random</span></a>
      </div>
      <div data-qa-channel-sidebar-channel-id="D3" data-qa-channel-sidebar-channel-type="im">
        <a class="p-channel_sidebar__channel p-channel_sidebar__channel--unread"><span class="p-channel_sidebar__name">Jon Manning</span><span class="p-channel_sidebar__badge">2</span></a>
      </div>
      <div data-qa-channel-sidebar-channel-id="C4" data-qa-channel-sidebar-channel-type="channel">
        <a class="p-channel_sidebar__channel p-channel_sidebar__channel--unread p-channel_sidebar__channel--muted"><span class="p-channel_sidebar__name">noisy</span></a>
      </div>`;
    assert.deepEqual(read(rules('slack')), [
      { id: 'C1', name: 'deal-asos', unread: 1, mention: false, order: 0 },
      { id: 'D3', name: 'Jon Manning', unread: 2, mention: true, order: 2 },
    ]);
  });

  it('nothing matched: an empty list, not an error', () => {
    document.body.innerHTML = `<main>loading…</main>`;
    const probe = asConversationProbe((0, eval)(conversationProbeScript(rules('slack'))))!;
    assert.equal(probe.rule, -1);
    assert.deepEqual(readConversations(rules('slack'), probe), []);
  });

  it('a page returns a bounded list, whatever it holds', () => {
    document.body.innerHTML = `<div id="pane-side">${Array.from({ length: 200 }, (_, i) => `<div role="row"><span dir="auto" title="Chat ${i}">x</span><span aria-label="1 unread message">1</span></div>`).join('')}</div>`;
    assert.equal(read(rules('whatsapp')).length, MAX_CONVERSATIONS);
  });

  it("refuses a probe result that isn't the right shape", () => {
    assert.equal(asConversationProbe(null), null);
    assert.equal(asConversationProbe({ rule: 'x', rows: [] }), null);
    assert.deepEqual(asConversationProbe({ rule: 0, rows: [null, { name: 7 }] })?.rows, [{ name: '', id: '', badge: null, unread: false, label: '', mention: false, muted: false }]);
  });
});

describe('opening one', () => {
  it('clicks the row with that id, and says when there is none', () => {
    document.body.innerHTML = `
      <div data-qa-channel-sidebar-channel-id="C1"><a class="p-channel_sidebar__channel"><span class="p-channel_sidebar__name">deal-asos</span></a></div>
      <div data-qa-channel-sidebar-channel-id="C2"><a class="p-channel_sidebar__channel"><span class="p-channel_sidebar__name">random</span></a></div>`;
    const clicked: string[] = [];
    for (const a of document.querySelectorAll('a')) a.addEventListener('click', () => clicked.push(a.textContent ?? ''));
    assert.equal((0, eval)(openConversationScript(rules('slack'), 'C2')), true);
    assert.deepEqual(clicked, ['random']);
    assert.equal((0, eval)(openConversationScript(rules('slack'), 'C9')), false);
  });

  it('finds a WhatsApp chat by its name, and an id with quotes in it stays a string', () => {
    document.body.innerHTML = `<div id="pane-side"><div role="row"><span dir="auto" title="Sophie">Sophie</span></div></div>`;
    let clicked = 0;
    document.querySelector('[role="row"]')!.addEventListener('click', () => clicked++);
    assert.equal((0, eval)(openConversationScript(rules('whatsapp'), 'Sophie')), true);
    assert.equal(clicked, 1);
    assert.equal((0, eval)(openConversationScript(rules('whatsapp'), `"); throw 1; ("`)), false);
  });
});
