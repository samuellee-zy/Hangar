import type { Pane, PaneBar, ServiceView } from '@shared/types';

/**
 * What each pane's bar says: which service, its page's title, whether it can go back or forward.
 * Pure, so the rules for the title — the part with judgement in it — are testable.
 */

/** Where a service's page is, as its view reports it. Null while the service has no page. */
export interface NavState {
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/**
 * A page title worth showing beside the service's name, or empty.
 *
 * Most say nothing the name doesn't: "Slack", "(3) Slack", "Gmail" on a page that hasn't titled
 * itself yet, or the bare address Chromium uses before a page has a title at all. Those would only
 * be the name twice. A count is the rail's to show, so it comes off whatever is left.
 */
export function titleWorthShowing(name: string, title: string): string {
  const trimmed = title.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed === 'about:blank') return '';
  const withoutCount = trimmed
    .replace(/^[([]\d+\+?[)\]]\s*/, '')
    .replace(/\s*[([]\d+\+?[)\]]$/, '')
    .replace(/^[•*●]\s*/, '')
    .trim();
  return withoutCount.toLowerCase() === name.trim().toLowerCase() ? '' : withoutCount;
}

export function paneBars(input: {
  /** The panes drawn — a maximised one alone, or all of them. */
  drawn: readonly Pane[];
  paneCount: number;
  focusedPaneId: string | null;
  maximisedPaneId: string | null;
  services: readonly ServiceView[];
  nav: (serviceId: string) => NavState | null;
}): PaneBar[] {
  const byId = new Map(input.services.map((svc) => [svc.id, svc]));
  return input.drawn.flatMap((pane) => {
    const svc = byId.get(pane.serviceId);
    if (!svc) return [];
    const nav = input.nav(pane.serviceId);
    return [
      {
        paneId: pane.id,
        serviceId: svc.id,
        name: svc.name,
        color: svc.color,
        iconVersion: svc.iconVersion ?? 0,
        title: nav ? titleWorthShowing(svc.name, nav.title) : '',
        canGoBack: nav?.canGoBack ?? false,
        canGoForward: nav?.canGoForward ?? false,
        loading: nav?.loading ?? false,
        focused: pane.id === input.focusedPaneId,
        maximised: input.paneCount > 1 ? pane.id === input.maximisedPaneId : null,
      },
    ];
  });
}
