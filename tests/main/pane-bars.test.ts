// What a pane's bar says. The judgement is in the title: most pages' titles are the service's name,
// or the name and a count, and showing those beside the name is only saying it twice.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { paneBars, titleWorthShowing } from '@core/workspace/pane-bars';
import { splitCard, PANE_HEADER, PANE_RADIUS } from '@core/workspace/layout';
import type { ServiceView } from '@shared/types';

describe('a title worth showing', () => {
  it('NOTHING WHEN IT IS ONLY THE NAME — with or without a count', () => {
    for (const title of ['Slack', 'slack', '(3) Slack', 'Slack (12)', '[99+] Slack', '• Slack', '  Slack  ', '']) {
      assert.equal(titleWorthShowing('Slack', title), '', JSON.stringify(title));
    }
  });

  it("nothing for the address Chromium shows before a page has titled itself", () => {
    assert.equal(titleWorthShowing('Gmail', 'https://mail.google.com/mail/u/0/'), '');
    assert.equal(titleWorthShowing('Gmail', 'about:blank'), '');
  });

  it('the rest, without its count — the rail shows that', () => {
    assert.equal(titleWorthShowing('Slack', '(3) #general - Acme - Slack'), '#general - Acme - Slack');
    assert.equal(titleWorthShowing('Notion', 'Roadmap'), 'Roadmap');
  });
});

describe('the bars for the panes on screen', () => {
  const svc = (id: string, name: string) => ({ id, name, color: '#123456', iconVersion: 2 }) as unknown as ServiceView;
  const nav = { title: 'Roadmap', canGoBack: true, canGoForward: false, loading: true };

  it('one per drawn pane, in order, focused and maximised marked', () => {
    const bars = paneBars({
      drawn: [
        { id: 'p1', serviceId: 'a' },
        { id: 'p2', serviceId: 'b' },
      ],
      paneCount: 2,
      focusedPaneId: 'p2',
      maximisedPaneId: null,
      services: [svc('a', 'Alpha'), svc('b', 'Beta')],
      nav: (id) => (id === 'b' ? nav : null),
    });
    assert.deepEqual(
      bars.map((b) => [b.paneId, b.focused, b.maximised, b.title, b.canGoBack, b.loading]),
      [
        ['p1', false, false, '', false, false],
        ['p2', true, false, 'Roadmap', true, true],
      ],
    );
    assert.equal(bars[1]!.iconVersion, 2);
  });

  it('with one pane, maximise is not a thing — null, not false', () => {
    const [bar] = paneBars({
      drawn: [{ id: 'p1', serviceId: 'a' }],
      paneCount: 1,
      focusedPaneId: 'p1',
      maximisedPaneId: null,
      services: [svc('a', 'Alpha')],
      nav: () => null,
    });
    assert.equal(bar!.maximised, null);
  });

  it('a pane whose service is gone gets no bar', () => {
    assert.deepEqual(
      paneBars({
        drawn: [{ id: 'p1', serviceId: 'gone' }],
        paneCount: 1,
        focusedPaneId: 'p1',
        maximisedPaneId: null,
        services: [],
        nav: () => null,
      }),
      [],
    );
  });
});

describe("a pane's card, split into header and page", () => {
  const card = { x: 10, y: 20, width: 400, height: 600 };

  it('THE HEADER RUNS ON UNDER THE PAGE — so the page’s rounded corners show header, not a pinch', () => {
    const { header, page } = splitCard(card, true);
    assert.deepEqual(page, { x: 10, y: 20 + PANE_HEADER, width: 400, height: 600 - PANE_HEADER });
    assert.deepEqual(header, { x: 10, y: 20, width: 400, height: PANE_HEADER + PANE_RADIUS });
    assert.ok(header!.y + header!.height > page.y, 'overlapping');
  });

  it('without headers, or in a card too short for one, the page is the card', () => {
    assert.deepEqual(splitCard(card, false), { header: null, page: card });
    assert.deepEqual(splitCard({ ...card, height: 50 }, true).header, null);
  });
});
