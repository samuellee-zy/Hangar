import type { CatalogEntry } from './types';

// Seeded with the stack actually in use. Anything else is an "add custom app" away.
//
// allowedHosts is the guard for both in-view navigation and popups: an auth host that's missing
// here means sign-in silently fails, and a missing CDN host means a blank page. Err on including
// the identity provider.

const GOOGLE_AUTH = ['accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com'];
const MS_AUTH = ['login.microsoftonline.com', 'login.live.com', 'login.microsoft.com'];
// Atlassian, GitHub and Slack all front their own identity provider. Omitting one of these doesn't
// fail loudly — the sign-in page is treated as an external navigation and opens in Safari, which
// reads as "the service is broken" rather than "one host is missing from a list".
const ATLASSIAN_AUTH = ['id.atlassian.com', 'auth.atlassian.com', 'atlassian.net'];
const GITHUB_AUTH = ['github.com', 'github.githubassets.com'];

/** Chat and calls: the ones most likely to sit in a rail all day. */
const COMMS: CatalogEntry[] = [
  {
    id: 'discord', icon: 'discord', name: 'Discord', url: 'https://discord.com/app',
    initials: 'Di', color: '#5865F2', provider: 'discord',
    allowedHosts: ['discord.com', 'discordapp.com', 'cdn.discordapp.com'],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'telegram', icon: 'telegram', name: 'Telegram', url: 'https://web.telegram.org/a/',
    initials: 'Tg', color: '#26A5E4', provider: 'telegram',
    allowedHosts: ['web.telegram.org', 'telegram.org'],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'whatsapp', icon: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com/',
    initials: 'Wa', color: '#25D366', provider: 'whatsapp',
    allowedHosts: ['web.whatsapp.com', 'whatsapp.com'],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'signal', icon: 'signal', name: 'Signal', url: 'https://signal.org/',
    initials: 'Sg', color: '#3A76F0', provider: 'signal', allowedHosts: ['signal.org'],
  },
  {
    id: 'zoom', icon: 'zoom', name: 'Zoom', url: 'https://app.zoom.us/wc/home',
    initials: 'Zm', color: '#0B5CFF', provider: 'zoom',
    allowedHosts: ['zoom.us', 'app.zoom.us', ...GOOGLE_AUTH],
  },
  {
    id: 'meet', icon: 'google-meet', name: 'Meet', url: 'https://meet.google.com/',
    initials: 'Me', color: '#00897B', provider: 'google',
    allowedHosts: ['meet.google.com', 'workspace.google.com', ...GOOGLE_AUTH],
  },
];

/** Issue trackers, repos and boards. */
const WORK: CatalogEntry[] = [
  {
    // start.atlassian.com, not the /software/jira marketing page: Jira lives on your own
    // <site>.atlassian.net, and `start` is the entry point that routes you there. The marketing
    // page would load a product tour for someone who already has an account.
    id: 'jira', icon: 'jira', name: 'Jira', url: 'https://start.atlassian.com/',
    initials: 'Ji', color: '#0052CC', provider: 'atlassian',
    allowedHosts: [...ATLASSIAN_AUTH, 'start.atlassian.com', ...GOOGLE_AUTH],
  },
  {
    id: 'confluence', icon: 'confluence', name: 'Confluence',
    url: 'https://start.atlassian.com/',
    initials: 'Cf', color: '#172B4D', provider: 'atlassian',
    allowedHosts: [...ATLASSIAN_AUTH, 'start.atlassian.com', ...GOOGLE_AUTH],
  },
  {
    id: 'github', icon: 'github', name: 'GitHub', url: 'https://github.com/',
    initials: 'GH', color: '#181717', provider: 'github', allowedHosts: [...GITHUB_AUTH],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'gitlab', icon: 'gitlab', name: 'GitLab', url: 'https://gitlab.com/',
    initials: 'GL', color: '#FC6D26', provider: 'gitlab',
    allowedHosts: ['gitlab.com', ...GOOGLE_AUTH],
  },
  {
    id: 'asana', icon: 'asana', name: 'Asana', url: 'https://app.asana.com/',
    initials: 'As', color: '#F06A6A', provider: 'asana',
    allowedHosts: ['asana.com', 'app.asana.com', ...GOOGLE_AUTH],
  },
  {
    id: 'trello', icon: 'atlassian-trello', name: 'Trello', url: 'https://trello.com/',
    initials: 'Tr', color: '#0079BF', provider: 'atlassian',
    allowedHosts: ['trello.com', ...ATLASSIAN_AUTH, ...GOOGLE_AUTH],
  },
  {
    id: 'clickup', icon: 'clickup', name: 'ClickUp', url: 'https://app.clickup.com/',
    initials: 'CU', color: '#7B68EE', provider: 'clickup',
    allowedHosts: ['clickup.com', 'app.clickup.com', ...GOOGLE_AUTH],
  },
  {
    // No icon upstream. Omitted rather than pointing at a slug that 404s — `initials` is the
    // designed fallback, and a declared-but-missing slug is indistinguishable from a typo.
    id: 'monday', name: 'Monday', url: 'https://auth.monday.com/',
    initials: 'Mo', color: '#FF3D57', provider: 'monday',
    allowedHosts: ['monday.com', 'auth.monday.com', ...GOOGLE_AUTH],
  },
];

/** The rest of Google and Microsoft — these ride logins you already have. */
const SUITES: CatalogEntry[] = [
  {
    id: 'gdocs', icon: 'google-docs', name: 'Docs', url: 'https://docs.google.com/document/',
    initials: 'Do', color: '#4285F4', provider: 'google',
    allowedHosts: ['docs.google.com', 'drive.google.com', 'workspace.google.com', ...GOOGLE_AUTH],
  },
  {
    id: 'gsheets', icon: 'google-sheets', name: 'Sheets',
    url: 'https://docs.google.com/spreadsheets/',
    initials: 'Sh', color: '#0F9D58', provider: 'google',
    allowedHosts: ['docs.google.com', 'drive.google.com', 'workspace.google.com', ...GOOGLE_AUTH],
  },
  {
    id: 'gslides', icon: 'google-slides', name: 'Slides',
    url: 'https://docs.google.com/presentation/',
    initials: 'Sl', color: '#F4B400', provider: 'google',
    allowedHosts: ['docs.google.com', 'drive.google.com', 'workspace.google.com', ...GOOGLE_AUTH],
  },
  {
    id: 'gkeep', icon: 'google-keep', name: 'Keep', url: 'https://keep.google.com/',
    initials: 'Ke', color: '#FFBB00', provider: 'google',
    allowedHosts: ['keep.google.com', ...GOOGLE_AUTH],
  },
  {
    id: 'outlook', icon: 'microsoft-outlook', name: 'Outlook',
    url: 'https://outlook.office.com/mail/',
    initials: 'Ou', color: '#0078D4', provider: 'microsoft',
    allowedHosts: ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com', ...MS_AUTH],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'onedrive', icon: 'microsoft-onedrive', name: 'OneDrive',
    url: 'https://onedrive.live.com/',
    initials: 'OD', color: '#0078D4', provider: 'microsoft',
    allowedHosts: ['onedrive.live.com', 'onedrive.com', 'sharepoint.com', ...MS_AUTH],
  },
  {
    id: 'sharepoint', icon: 'microsoft-sharepoint', name: 'SharePoint',
    url: 'https://www.office.com/launch/sharepoint',
    initials: 'SP', color: '#038387', provider: 'microsoft',
    allowedHosts: ['sharepoint.com', 'office.com', 'www.office.com', ...MS_AUTH],
  },
  {
    id: 'mstodo', icon: 'microsoft-to-do', name: 'To Do', url: 'https://to-do.office.com/tasks/',
    initials: 'TD', color: '#2564CF', provider: 'microsoft',
    allowedHosts: ['to-do.office.com', 'office.com', ...MS_AUTH],
  },
];

/** Assistants and notes. */
const AI_NOTES: CatalogEntry[] = [
  {
    id: 'claude', icon: 'claude-ai', name: 'Claude', url: 'https://claude.ai/',
    initials: 'Cl', color: '#D97757', provider: 'anthropic',
    allowedHosts: ['claude.ai', 'anthropic.com', ...GOOGLE_AUTH],
  },
  {
    id: 'chatgpt', icon: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/',
    initials: 'GP', color: '#10A37F', provider: 'openai',
    allowedHosts: ['chatgpt.com', 'openai.com', 'auth.openai.com', 'auth0.openai.com', ...GOOGLE_AUTH],
  },
  {
    id: 'perplexity', icon: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/',
    initials: 'Px', color: '#20808D', provider: 'perplexity',
    allowedHosts: ['perplexity.ai', 'www.perplexity.ai', ...GOOGLE_AUTH],
  },
  {
    id: 'todoist', icon: 'todoist', name: 'Todoist', url: 'https://app.todoist.com/app/today',
    initials: 'To', color: '#E44332', provider: 'todoist',
    allowedHosts: ['todoist.com', 'app.todoist.com', ...GOOGLE_AUTH],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'obsidian', icon: 'obsidian', name: 'Obsidian', url: 'https://publish.obsidian.md/',
    initials: 'Ob', color: '#7C3AED', provider: 'obsidian',
    allowedHosts: ['obsidian.md', 'publish.obsidian.md'],
  },
  {
    id: 'evernote', icon: 'evernote', name: 'Evernote', url: 'https://www.evernote.com/client/web',
    initials: 'Ev', color: '#00A82D', provider: 'evernote',
    allowedHosts: ['evernote.com', 'www.evernote.com', ...GOOGLE_AUTH],
  },
];

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
    // notion.so now redirects to notion.com. Both are listed: the old host still resolves, and an
    // allowlist that omits the redirect target sends the service to the system browser on load —
    // which reads as the app being broken. Found by checking every catalog URL's *final* host.
    url: 'https://www.notion.com/',
    initials: 'No',
    color: '#8A8A8A',
    allowedHosts: ['notion.so', 'www.notion.so', 'notion.com', 'www.notion.com', ...GOOGLE_AUTH],
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
  ...COMMS,
  ...WORK,
  ...SUITES,
  ...AI_NOTES,
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
