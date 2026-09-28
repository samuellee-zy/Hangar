// The attention centre — unread counts, banners, the Dock badge — against a fake window.
//
// It takes a host of getters and closures rather than the window itself, which is what makes it
// testable at all; until now nothing did test it, and the one real bug found in it this phase (a
// page's own badge cleared by merely being on screen) was only ever seen in an end-to-end run.

import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app, Notification } from 'electron';

fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const { AttentionCenter, setNotificationClickRoute } = await import('@main/window/attention');
const { loadConfig } = await import('@main/platform/config');

type Stub = typeof Notification & { shown: Array<{ options: Record<string, unknown>; emit: (e: string) => void }> };
const banners = () => (Notification as unknown as Stub).shown;

function center(over: Partial<ConstructorParameters<typeof AttentionCenter>[0]> = {}) {
  const host = {
    drawnServiceIds: () => new Set<string>(),
    paneServiceIds: () => [] as string[],
    isLive: () => true,
    contentsFor: () => null,
    windowOnScreen: () => true,
    sync: vi.fn(),
    focusService: vi.fn(),
    ...over,
  };
  return { attention: new AttentionCenter(host), host };
}

const service = () => loadConfig().services[0]!;

beforeEach(() => {
  banners().length = 0;
  setNotificationClickRoute(null);
});

describe('a notification', () => {
  it('from a service nobody is looking at counts, raises a banner, and moves the Dock badge', () => {
    const { attention } = center();
    const svc = service();
    attention.handleNotification(svc.id, { title: 'Alex', body: 'are you free?' });

    expect(attention.unread.get(svc.id)).toBe(1);
    expect(banners()).toHaveLength(1);
    expect(app.badgeCount).toBe(1);
  });

  it("NAMES THE SERVICE UNDER THE PAGE'S OWN TITLE — two Slacks' \"Alex\" looked the same", () => {
    const { attention } = center();
    const svc = service();
    attention.handleNotification(svc.id, { title: 'Alex', body: 'hi' });
    expect(banners()[0]!.options['subtitle']).toBe(svc.name);

    // No subtitle when the title already is the service name — it would say it twice.
    attention.handleNotification(svc.id, { title: '', body: 'hi' });
    expect(banners()[1]!.options['title']).toBe(svc.name);
    expect(banners()[1]!.options['subtitle']).toBeUndefined();
  });

  it('a click goes through the app route when there is one, and the window otherwise', () => {
    const { attention, host } = center();
    const svc = service();
    attention.handleNotification(svc.id, { title: 'one' });
    banners()[0]!.emit('click');
    expect(host.focusService).toHaveBeenCalledWith(svc.id);

    // The route outlives the window: after ⌘W, the window that raised a banner is destroyed.
    const route = vi.fn();
    setNotificationClickRoute(route);
    attention.handleNotification(svc.id, { title: 'two' });
    banners()[1]!.emit('click');
    expect(route).toHaveBeenCalledWith(svc.id);
  });
});

describe('what counts as read', () => {
  it('BEING ON SCREEN READS A TALLIED COUNT, NOT ONE THE PAGE REPORTED', () => {
    const { attention } = center({ isLive: () => false });
    const [tallied, reported] = loadConfig().services;

    attention.handleNotification(tallied!.id, { title: 'x' });
    attention.applyEndpointCount(reported!.id, 5); // a count the service itself gave

    attention.acknowledge(tallied!.id);
    attention.acknowledge(reported!.id);
    expect(attention.unread.get(tallied!.id), 'looked at, so read').toBe(0);
    expect(attention.unread.get(reported!.id), "the page's count stands until the page moves it").toBe(5);

    // Marking it read by hand still does.
    attention.clearUnread(reported!.id);
    expect(attention.unread.get(reported!.id)).toBe(0);
  });

  it('a closed window takes the Dock badge back to zero with it', () => {
    const { attention } = center();
    attention.handleNotification(service().id, { title: 'x' });
    expect(app.badgeCount).toBeGreaterThan(0);
    attention.dispose();
    expect(app.badgeCount).toBe(0);
  });
});

describe('what a count was read from', () => {
  // The default config's first service is Gmail, whose count comes from its title.
  it("RECORDS THE TITLE BEHIND A COUNT — so a number that looks wrong can be told from a rule that is", () => {
    const { attention } = center();
    const svc = service();
    attention.handleTitle(svc.id, 'Inbox (3) - you@gmail.com - Gmail');
    expect(attention.unread.get(svc.id)).toBe(3);
    expect(attention.evidenceSnapshot()[svc.id]).toMatchObject({
      source: 'title',
      count: 3,
      detail: 'Inbox (3) - you@gmail.com - Gmail',
    });
  });

  it('a notification is the reading only until the service has something better', () => {
    const { attention } = center();
    const svc = service();
    attention.handleNotification(svc.id, { title: 'Alex', body: 'hi' });
    expect(attention.evidenceSnapshot()[svc.id]).toMatchObject({ source: 'notifications', count: 1 });
    attention.handleTitle(svc.id, 'Inbox (4) - you@gmail.com - Gmail');
    attention.handleNotification(svc.id, { title: 'Sam', body: 'again' });
    expect(attention.evidenceSnapshot()[svc.id], 'the title stays the reading').toMatchObject({ source: 'title', count: 4 });
  });
});
