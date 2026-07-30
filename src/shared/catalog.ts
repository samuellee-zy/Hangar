import type { CatalogEntry } from './types';

// Seeded with the stack actually in use. Anything else is an "add custom app" away.
//
// allowedHosts is the guard for both in-view navigation and popups: an auth host that's missing
// here means sign-in silently fails, and a missing CDN host means a blank page. Err on including
// the identity provider.

const GOOGLE_AUTH = ['accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com'];
const MS_AUTH = ['login.microsoftonline.com', 'login.live.com', 'login.microsoft.com'];

export const catalog: CatalogEntry[] = [
  {
    id: 'gmail',
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
    icon: 'gmail',
    name: 'Gmail',
    // Bare host, NOT /mail/u/0/ — same trap as Calendar. With no session at user index 0, Google
    // serves the gmail.com *marketing* page ("AI-powered email for everyone") instead of a sign-in
    // page, so the service looks broken rather than logged out. The bare host routes correctly
    // whether or not a session exists. Applies to every Google property with a /u/<n>/ path.
    url: 'https://mail.google.com/',
    initials: 'Gm',
    color: '#EA4335',
    allowedHosts: ['mail.google.com', 'contacts.google.com', ...GOOGLE_AUTH],
    provider: 'google',
  },
  {
    id: 'gcal',
    icon: 'google-calendar',
    name: 'Calendar',
    // NOT /calendar/u/0/r — with no session at user index 0 Google redirects to its marketing
    // page, which looks exactly like a login failure. Phase 0 lost an hour to this.
    url: 'https://calendar.google.com/',
    initials: 'Ca',
    color: '#4285F4',
    allowedHosts: ['calendar.google.com', ...GOOGLE_AUTH],
    provider: 'google',
  },
  {
    id: 'gdrive',
    icon: 'google-drive',
    name: 'Drive',
    url: 'https://drive.google.com/',
    initials: 'Dr',
    color: '#0F9D58',
    allowedHosts: ['drive.google.com', 'docs.google.com', ...GOOGLE_AUTH],
    provider: 'google',
  },
  {
    id: 'teams',
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
    icon: 'microsoft-teams',
    name: 'Teams',
    url: 'https://teams.microsoft.com/',
    initials: 'Tm',
    // Teams now lands on teams.cloud.microsoft rather than teams.microsoft.com.
    color: '#6264A7',
    allowedHosts: ['teams.microsoft.com', 'teams.cloud.microsoft', 'sharepoint.com', ...MS_AUTH],
    provider: 'microsoft',
  },
  {
    id: 'slack',
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
    icon: 'slack',
    name: 'Slack',
    url: 'https://app.slack.com/client',
    initials: 'Sl',
    color: '#4A154B',
    allowedHosts: ['app.slack.com', 'slack.com'],
    provider: 'slack',
  },
  {
    id: 'notion',
    icon: 'notion',
    name: 'Notion',
    url: 'https://www.notion.so/',
    initials: 'No',
    color: '#8A8A8A',
    allowedHosts: ['notion.so', 'www.notion.so', ...GOOGLE_AUTH],
    provider: 'notion',
  },
  {
    id: 'linear',
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
    icon: 'linear',
    name: 'Linear',
    url: 'https://linear.app/',
    initials: 'Li',
    color: '#5E6AD2',
    allowedHosts: ['linear.app', ...GOOGLE_AUTH],
    provider: 'linear',
  },
  {
    id: 'figma',
    icon: 'figma',
    name: 'Figma',
    url: 'https://www.figma.com/files',
    initials: 'Fi',
    color: '#F24E1E',
    allowedHosts: ['figma.com', 'www.figma.com', ...GOOGLE_AUTH],
    provider: 'figma',
  },
  {
    id: 'salesforce',
    icon: 'salesforce',
    name: 'Salesforce',
    url: 'https://login.salesforce.com/',
    initials: 'Sf',
    color: '#00A1E0',
    allowedHosts: ['salesforce.com', 'force.com', 'my.salesforce.com', 'lightning.force.com'],
    provider: 'salesforce',
    // Phase 0: sid is a session cookie and the org invalidates it on browser close. Client-side
    // promotion demonstrably does not help. Belongs on Tier 2 (connected app + refresh token).
    sessionNotPersistable: true,
  },
];

export const catalogById = (id: string): CatalogEntry | undefined =>
  catalog.find((c) => c.id === id);

/**
 * A service's effective URL: its own override if it has one (custom connections), otherwise the
 * catalog's current value. Resolving at load time rather than copying at creation time is what
 * lets a catalog fix reach installs that already exist.
 */
export const resolveUrl = (svc: { catalogId: string; url?: string }): string =>
  svc.url ?? catalogById(svc.catalogId)?.url ?? 'about:blank';
