// Link routing: a link leaving one service opens in another of yours when it belongs there.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { routeTarget } from '@core/services/routing';

const services = [
  { id: 'slack', startUrl: 'https://app.slack.com/client' },
  { id: 'gmail', startUrl: 'https://mail.google.com/mail/' },
  { id: 'docs', startUrl: 'https://docs.google.com/document/' },
  { id: 'sheets', startUrl: 'https://docs.google.com/spreadsheets/' },
  { id: 'jira', startUrl: 'https://acme.atlassian.net/jira/your-work' },
  { id: 'github', startUrl: 'https://github.com/' },
];

describe('which service a link belongs in', () => {
  it('a Jira link from Slack goes to Jira', () => {
    assert.equal(routeTarget('https://acme.atlassian.net/jira/browse/ENG-12', services, 'slack'), 'jira');
  });

  it('DOCS AND SHEETS SHARE A HOST — the product path decides', () => {
    assert.equal(routeTarget('https://docs.google.com/spreadsheets/d/abc/edit', services, 'gmail'), 'sheets');
    assert.equal(routeTarget('https://docs.google.com/document/d/abc/edit', services, 'gmail'), 'docs');
  });

  it('A SIGN-IN HOST IS NOT A DESTINATION — every Google service allows accounts.google.com', () => {
    assert.equal(routeTarget('https://accounts.google.com/signin', services, 'slack'), null);
  });

  it('a service with no product path takes anything on its host', () => {
    assert.equal(routeTarget('https://github.com/acme/app/pull/3', services, 'slack'), 'github');
    assert.equal(routeTarget('https://www.github.com/acme', services, 'slack'), 'github', 'www is cosmetic');
  });

  it('never back into the service the link came from', () => {
    assert.equal(routeTarget('https://github.com/acme', services, 'github'), null);
  });

  it('the open web stays with the browser', () => {
    assert.equal(routeTarget('https://example.com/article', services, 'slack'), null);
    assert.equal(routeTarget('mailto:someone@example.com', services, 'slack'), null);
    assert.equal(routeTarget('not a url', services, 'slack'), null);
  });

  it('a lookalike domain is not a subdomain', () => {
    assert.equal(routeTarget('https://notgithub.com/x', services, 'slack'), null);
  });
});
