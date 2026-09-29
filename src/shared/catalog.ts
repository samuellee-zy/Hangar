import type { CatalogEntry, DomUnreadRule } from './types';

// Seeded with the stack actually in use. Anything else is an "add custom app" away.
//
// allowedHosts is the guard for both in-view navigation and popups: an auth host that's missing
// here means sign-in silently fails, and a missing CDN host means a blank page. Err on including
// the identity provider.

const GOOGLE_AUTH = ['accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com'];
// A personal Microsoft account signs in through the live.com side rather than the AAD side, and
// the flow steps through account/signup pages before it hands back. `msauth.net` and `msftauth.net`
// host the login UI itself for both.
const MS_AUTH = [
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'account.live.com',
  'signup.live.com',
  'msauth.net',
  'msftauth.net',
];
// Atlassian, GitHub and Slack all front their own identity provider. Omitting one of these doesn't
// fail loudly — the sign-in page is treated as an external navigation and opens in Safari, which
// reads as "the service is broken" rather than "one host is missing from a list".
const ATLASSIAN_AUTH = ['id.atlassian.com', 'auth.atlassian.com', 'atlassian.net'];
const GITHUB_AUTH = ['github.com', 'github.githubassets.com'];

/**
 * Chords these services bind themselves, which Hangar therefore does not intercept.
 *
 * Kept short and evidence-based. A wrong entry here is a shortcut of ours that mysteriously stops
 * working in one service, which is harder to diagnose than the reverse — so this lists only chords
 * the service documents, and anything else is one checkbox away in Settings.
 *
 * `mod` is the placeholder for ⌘-or-Ctrl, expanded by `resolvePassthrough` in
 * `core/keyboard/keymap.ts` — a web app's own ⌘K becomes Ctrl+K on Linux exactly as ours does, and
 * this file is bundled into the renderer where `process.platform` doesn't exist to ask.
 */
const QUICK_SWITCHER = ['mod+k'];

/**
 * Unread detection, and why so many entries have none.
 *
 * Some entries read their count out of the tab title. Of the rest, the honest breakdown is
 * that most of them have no unread count to read: Docs, Sheets, Slides, Keep, Drive, OneDrive,
 * SharePoint, Calendar, Meet, Zoom, Obsidian, Evernote, Claude, ChatGPT and Perplexity do not have
 * an inbox, so "no rule" is the correct answer rather than a gap. Signal has no web client at all.
 *
 * The remainder — Notion, Jira, Confluence, Trello, Asana, ClickUp, Monday, Figma — do have a
 * badge, and are deliberately left empty. **A selector nobody has watched a real page render is
 * worse than nothing**: when it matches nothing it is merely useless, but when it matches the wrong
 * node it is a phantom count that never clears and cannot be explained, which is the exact failure
 * the module docstring in core/notify/unread.ts exists to warn about. These sites also ship
 * generated class names that turn over on their own schedule.
 *
 * So the two rules below are the ones with a *published* contract behind them, and everything else
 * is reachable through `ServiceInstance.unreadSelector` — a field for the person who can see the
 * page, which is never going to be this file.
 */

// Salesforce Lightning Design System. `slds-*` is a documented, versioned public class contract,
// which is what makes this one safe to write down. The badge span is present and empty at zero.
const SALESFORCE_UNREAD = {
  dom: [{ selector: '.slds-notification-badge', anchor: '.slds-global-actions' }],
};

/**
 * Gmail's Atom feed — the count for a Gmail that is asleep, which the title pattern above cannot
 * give because a hibernated service has no title.
 *
 * `/u/0/` here, unlike the entry's `url`: within one Hangar account the partition holds a single
 * Google session, so index 0 *is* that session, and the feed has no bare-host form that resolves
 * per-partition.
 *
 * Shipping a rule this specific is a different risk from shipping a speculative CSS selector, and
 * that is the reason the two are treated differently. A selector can match the wrong node and
 * invent a count that never clears. An endpoint rule cannot: a signed-out session redirects and is
 * refused, a changed response fails the regex, and every one of those paths returns "no
 * information" rather than a number. The worst case is that it quietly does nothing.
 */
const GMAIL_FEED = {
  url: 'https://mail.google.com/mail/u/0/feed/atom',
  extract: { regex: '<fullcount>(\\d+)</fullcount>' },
  everySeconds: 300,
};

// GitLab's To-Do counter. Their frontend is open source and `data-testid` here is the same hook
// their own suite asserts on, so it breaking is a change they would notice too. The `js-` class is
// the older markup, still what self-hosted instances serve.
// Notion, Jira, Confluence, Trello, Asana, ClickUp, Monday and Figma have an inbox worth counting
// and no rule here. Not an oversight — a guessed selector matches nothing, which is indistinguishable
// from having read everything, so it fails as a permanent silent zero that nobody investigates.
// Each needs DevTools on a real logged-in page: docs/unread-selectors.md is the procedure.
/**
 * WhatsApp's unread messages: the number on each chat in the list, added up.
 *
 * - `#pane-side` is the chat list, and has been for years; it's also the anchor, so a list that
 *   hasn't drawn says nothing rather than zero.
 * - Each chat's badge is a `span[aria-label]` whose text is the count. Others in the list carry no
 *   number, and `sum` adds nothing for them.
 * - A muted chat's badge sits just after its muted icon — `[data-icon="muted"]` in the element before
 *   the badge's container — and is left out, as WhatsApp's own count leaves it out.
 *
 * The list is drawn only as far as it's scrolled, so a chat far down isn't counted. Chats with new
 * messages move to the top, so in practice that's the rare old one. Ferdium's recipe reads the same
 * nodes.
 */
const WHATSAPP_MESSAGES: DomUnreadRule = {
  selector: '#pane-side span[aria-label]:not(:has([data-icon="muted"]) + * > span)',
  read: 'sum',
  anchor: '#pane-side',
};

const GITLAB_UNREAD = {
  dom: [
    { selector: '[data-testid="todos-counter"]', anchor: '[data-testid="super-sidebar"]' },
    { selector: '.js-todos-count', anchor: 'header.navbar' },
  ],
};

/** Chat and calls: the ones most likely to sit in a rail all day. */
const COMMS: CatalogEntry[] = [
  {
    id: 'discord', icon: 'discord', name: 'Discord', url: 'https://discord.com/app',
    initials: 'Di', color: '#5865F2', provider: 'discord',
    allowedHosts: ['discord.com', 'discordapp.com', 'cdn.discordapp.com'],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
    passthrough: QUICK_SWITCHER,
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
    unread: {
      // Messages, not chats. The title's "(1) WhatsApp" counts chats with something unread, and the
      // tile said 1 beside a chat with 8 waiting; WhatsApp never totals the messages, so they are
      // added up from the chat list's own badges. The title is the fallback, while the list hasn't
      // drawn — or if WhatsApp's markup moves on and this reads nothing.
      titlePattern: '^\\((\\d+)\\+?\\)',
      dom: [WHATSAPP_MESSAGES],
    },
    // "WhatsApp works with Google Chrome 100+", at Chrome 150, until the `Hangar/…` token is gone.
    plainUserAgent: true,
  },
  {
    id: 'signal', icon: 'signal', name: 'Signal', url: 'https://signal.org/',
    initials: 'Sg', color: '#3A76F0', provider: 'signal', allowedHosts: ['signal.org'],
    // Signal has no web client — by design, since linking a device requires key material a browser
    // tab is not trusted with. There is no URL that would make this entry work, so it stays
    // pointing at signal.org and says why. Kept rather than deleted because removing the id would
    // strand anyone who already added it.
    caveat: 'No web app — Signal is desktop and mobile only. This opens signal.org.',
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
    // jsname hooks as the open-source Meet controllers use them (they change with redesigns; this
    // is data so a fix is a one-line edit). The camera's `data-is-muted` is true when it's *off*.
    meeting: {
      inCall: '[jsname="CQylAd"]',
      controls: {
        mute: { selector: 'button[jsname="hw0c9"]', read: 'attr', attr: 'data-is-muted', on: ['true'], off: ['false'] },
        video: { selector: 'button[jsname="psRWwc"]', read: 'attr', attr: 'data-is-muted', on: ['false'], off: ['true'] },
        share: { selector: 'button[aria-label^="Stop presenting" i], button[aria-label^="Present" i], button[aria-label^="Share screen" i]', on: ['Stop presenting'], off: ['Present', 'Share screen'] },
        hand: { selector: 'button[jsname="FpSaz"]', read: 'attr', attr: 'aria-pressed', on: ['true'], off: ['false'] },
        leave: { selector: '[jsname="CQylAd"]' },
      },
    },
  },
  {
    id: 'messenger', aliases: ['facebook'], icon: 'facebook-messenger', name: 'Messenger',
    url: 'https://www.messenger.com/',
    initials: 'Ms', color: '#0084FF', provider: 'facebook',
    // facebook.com is the identity provider here, not a courtesy: messenger.com hands sign-in
    // straight to it and comes back with the session.
    allowedHosts: ['messenger.com', 'www.messenger.com', 'facebook.com'],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'gchat', icon: 'google-chat', name: 'Google Chat', url: 'https://chat.google.com/',
    initials: 'GC', color: '#00AC47', provider: 'google',
    // mail.google.com because Chat is also embedded in Gmail and hops between the two.
    allowedHosts: ['chat.google.com', 'mail.google.com', ...GOOGLE_AUTH],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'element', aliases: ['matrix', 'riot'], icon: 'element', name: 'Element', url: 'https://app.element.io/',
    initials: 'El', color: '#0DBD8B', provider: 'element',
    // Matrix is federated: a homeserver other than matrix.org is normal, and its host cannot be
    // known here. Settings → Connections is where that one gets added.
    allowedHosts: ['element.io', 'app.element.io', 'matrix.org'],
  },
  // --- Added in the Phase 7 catalog pass. None has a vendored icon yet: each shows its initials in
  // --- the picker and captures its own favicon on first load (`captureFavicon`). `npm run icons`
  // --- with a slug added here is how one gets a real logo.
  {
    id: 'gmessages', name: 'Google Messages', url: 'https://messages.google.com/web/conversations',
    initials: 'Ms', color: '#1A73E8', provider: 'google',
    allowedHosts: ['messages.google.com', ...GOOGLE_AUTH],
    caveat: 'Pairs with the Messages app on your Android phone by QR code.',
  },
  {
    id: 'gvoice', name: 'Google Voice', url: 'https://voice.google.com/',
    initials: 'GV', color: '#0F9D58', provider: 'google',
    allowedHosts: ['voice.google.com', ...GOOGLE_AUTH],
  },
  {
    id: 'webex', name: 'Webex', url: 'https://web.webex.com/',
    initials: 'Wx', color: '#07C160', provider: 'webex',
    allowedHosts: ['webex.com', 'ciscospark.com', ...GOOGLE_AUTH, ...MS_AUTH],
  },
];

/** Feeds. Added because they were the obvious hole, not because they're restful. */
const SOCIAL: CatalogEntry[] = [
  {
    id: 'instagram', icon: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/',
    initials: 'Ig', color: '#E4405F', provider: 'instagram',
    // Its own provider rather than sharing Facebook's: the accounts are linkable but routinely
    // separate, and sharing a cookie jar would sign you into the wrong one with no way back.
    allowedHosts: ['instagram.com', 'www.instagram.com', 'facebook.com'],
  },
  {
    id: 'x', aliases: ['twitter'], icon: 'x', name: 'X', url: 'https://x.com/home',
    initials: 'X', color: '#111111', provider: 'x',
    // twitter.com still serves live redirects into x.com, so the old host is a navigation target
    // rather than history.
    allowedHosts: ['x.com', 'twitter.com', ...GOOGLE_AUTH],
  },
  {
    id: 'linkedin', icon: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com/feed/',
    initials: 'Li', color: '#0A66C2', provider: 'linkedin',
    allowedHosts: ['linkedin.com', 'www.linkedin.com', ...GOOGLE_AUTH],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'reddit', icon: 'reddit', name: 'Reddit', url: 'https://www.reddit.com/',
    initials: 'Rd', color: '#FF4500', provider: 'reddit',
    allowedHosts: ['reddit.com', 'www.reddit.com', ...GOOGLE_AUTH],
  },
  {
    id: 'bluesky', icon: 'bluesky', name: 'Bluesky', url: 'https://bsky.app/',
    initials: 'Bs', color: '#0285FF', provider: 'bluesky',
    allowedHosts: ['bsky.app', 'bsky.social'],
  },
  {
    id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/',
    initials: 'YT', color: '#FF0000', provider: 'google',
    allowedHosts: ['youtube.com', ...GOOGLE_AUTH],
  },
  {
    id: 'ytmusic', name: 'YouTube Music', url: 'https://music.youtube.com/',
    initials: 'YM', color: '#FF0000', provider: 'google',
    allowedHosts: ['music.youtube.com', 'youtube.com', ...GOOGLE_AUTH],
  },
  {
    id: 'threads', name: 'Threads', url: 'https://www.threads.net/',
    // Instagram's provider, so it rides the Instagram login it signs in with rather than asking
    // for it again.
    initials: 'Th', color: '#101010', provider: 'instagram',
    allowedHosts: ['threads.net', 'threads.com', 'instagram.com'],
  },
  {
    // One server of many. Anyone on another instance adds it as a custom connection by URL, which
    // gets its own allowlist from that host.
    id: 'mastodon', name: 'Mastodon', url: 'https://mastodon.social/',
    initials: 'Ma', color: '#6364FF', provider: 'mastodon',
    allowedHosts: ['mastodon.social'],
    caveat: 'This is mastodon.social. For another server, add it by URL instead.',
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
    passthrough: QUICK_SWITCHER,
    initials: 'GH', color: '#181717', provider: 'github', allowedHosts: [...GITHUB_AUTH],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'gitlab', icon: 'gitlab', name: 'GitLab', url: 'https://gitlab.com/',
    initials: 'GL', color: '#FC6D26', provider: 'gitlab',
    allowedHosts: ['gitlab.com', ...GOOGLE_AUTH],
    unread: GITLAB_UNREAD,
  },
  {
    id: 'asana', icon: 'asana', name: 'Asana', url: 'https://app.asana.com/',
    passthrough: QUICK_SWITCHER,
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
  {
    id: 'airtable', icon: 'airtable', name: 'Airtable', url: 'https://airtable.com/',
    initials: 'At', color: '#18BFFF', provider: 'airtable',
    allowedHosts: ['airtable.com', ...GOOGLE_AUTH],
  },
  {
    id: 'miro', icon: 'miro', name: 'Miro', url: 'https://miro.com/app/dashboard/',
    initials: 'Mi', color: '#FFD02F', provider: 'miro',
    allowedHosts: ['miro.com', 'app.miro.com', ...GOOGLE_AUTH],
  },
  {
    // No slug upstream — see the Monday entry for why that means omitting the field rather than
    // guessing one.
    id: 'loom', name: 'Loom', url: 'https://www.loom.com/looms/videos',
    initials: 'Lo', color: '#625DF5', provider: 'loom',
    allowedHosts: ['loom.com', 'www.loom.com', ...GOOGLE_AUTH],
  },
  {
    id: 'dropbox', icon: 'dropbox', name: 'Dropbox', url: 'https://www.dropbox.com/home',
    initials: 'Db', color: '#0061FF', provider: 'dropbox',
    allowedHosts: ['dropbox.com', 'www.dropbox.com', ...GOOGLE_AUTH],
  },
  {
    id: 'bitbucket', name: 'Bitbucket', url: 'https://bitbucket.org/',
    initials: 'Bb', color: '#0052CC', provider: 'atlassian',
    allowedHosts: ['bitbucket.org', ...ATLASSIAN_AUTH, ...GOOGLE_AUTH],
  },
  {
    id: 'azuredevops', name: 'Azure DevOps', url: 'https://dev.azure.com/',
    initials: 'AD', color: '#0078D4', provider: 'microsoft',
    allowedHosts: ['dev.azure.com', 'visualstudio.com', ...MS_AUTH],
  },
  {
    id: 'hubspot', name: 'HubSpot', url: 'https://app.hubspot.com/',
    initials: 'HS', color: '#FF7A59', provider: 'hubspot',
    // hubspot.com covers the regional app-eu1 and app-na2 hosts too.
    allowedHosts: ['hubspot.com', ...GOOGLE_AUTH, ...MS_AUTH],
  },
  {
    id: 'intercom', name: 'Intercom', url: 'https://app.intercom.com/',
    initials: 'IC', color: '#1F8DED', provider: 'intercom',
    allowedHosts: ['intercom.com', ...GOOGLE_AUTH],
  },
  {
    id: 'front', name: 'Front', url: 'https://app.frontapp.com/',
    initials: 'Fr', color: '#A857F1', provider: 'front',
    allowedHosts: ['frontapp.com', ...GOOGLE_AUTH, ...MS_AUTH],
  },
  {
    id: 'canva', name: 'Canva', url: 'https://www.canva.com/',
    initials: 'Ca', color: '#00C4CC', provider: 'canva',
    allowedHosts: ['canva.com', ...GOOGLE_AUTH],
  },
];

/** Mail that isn't Google's or Microsoft's. */
const MAIL: CatalogEntry[] = [
  {
    id: 'protonmail', aliases: ['proton'], icon: 'proton-mail', name: 'Proton Mail',
    url: 'https://mail.proton.me/',
    initials: 'Pr', color: '#6D4AFF', provider: 'proton',
    allowedHosts: ['proton.me', 'mail.proton.me', 'account.proton.me'],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'fastmail', icon: 'fastmail', name: 'Fastmail', url: 'https://app.fastmail.com/',
    initials: 'Fm', color: '#0067B9', provider: 'fastmail',
    allowedHosts: ['fastmail.com', 'app.fastmail.com'],
  },
  {
    id: 'icloudmail', name: 'iCloud Mail', url: 'https://www.icloud.com/mail/',
    initials: 'iC', color: '#3693F3', provider: 'apple',
    allowedHosts: ['icloud.com', 'idmsa.apple.com', 'appleid.apple.com'],
  },
  {
    id: 'yahoomail', name: 'Yahoo Mail', url: 'https://mail.yahoo.com/',
    initials: 'Ya', color: '#6001D2', provider: 'yahoo',
    allowedHosts: ['mail.yahoo.com', 'login.yahoo.com', 'yahoo.com'],
  },
  {
    id: 'zohomail', name: 'Zoho Mail', url: 'https://mail.zoho.com/',
    initials: 'Zo', color: '#E42527', provider: 'zoho',
    // Zoho runs a data centre per region, each on its own domain.
    allowedHosts: ['zoho.com', 'zoho.eu', 'zoho.in', 'zoho.com.au', ...GOOGLE_AUTH],
  },
  {
    id: 'hey', name: 'HEY', url: 'https://app.hey.com/',
    initials: 'HE', color: '#5522FA', provider: 'hey',
    allowedHosts: ['hey.com'],
  },
  {
    id: 'tuta', name: 'Tuta Mail', url: 'https://app.tuta.com/',
    initials: 'Tu', color: '#850122', provider: 'tuta',
    allowedHosts: ['tuta.com', 'tutanota.com'],
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
    // `cloud.microsoft`: Microsoft is moving Outlook to outlook.cloud.microsoft, the same move that
    // already took Teams to teams.cloud.microsoft. Missing, the redirect lands off the allowlist and
    // opens in the browser — the failure Notion's .so → .com move caused.
    allowedHosts: [
      'outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'cloud.microsoft', ...MS_AUTH,
    ],
    unread: { titlePattern: '^\\((\\d+)\\+?\\)' },
  },
  {
    id: 'onedrive', icon: 'microsoft-onedrive', name: 'OneDrive',
    url: 'https://onedrive.live.com/',
    initials: 'OD', color: '#0078D4', provider: 'microsoft',
    allowedHosts: ['onedrive.live.com', 'onedrive.com', 'sharepoint.com', 'cloud.microsoft', ...MS_AUTH],
  },
  {
    id: 'sharepoint', icon: 'microsoft-sharepoint', name: 'SharePoint',
    url: 'https://www.office.com/launch/sharepoint',
    initials: 'SP', color: '#038387', provider: 'microsoft',
    // office.com now redirects to m365.cloud.microsoft (and, for some tenants, microsoft365.com).
    allowedHosts: [
      'sharepoint.com', 'office.com', 'www.office.com', 'cloud.microsoft', 'microsoft365.com', ...MS_AUTH,
    ],
  },
  {
    id: 'mstodo', icon: 'microsoft-to-do', name: 'To Do', url: 'https://to-do.office.com/tasks/',
    initials: 'TD', color: '#2564CF', provider: 'microsoft',
    // to-do.live.com is where a personal Microsoft account's To Do lives.
    allowedHosts: ['to-do.office.com', 'to-do.live.com', 'office.com', 'cloud.microsoft', ...MS_AUTH],
  },
  {
    // Word, Excel and PowerPoint in one launcher, which is where Microsoft now sends office.com.
    id: 'm365', name: 'Microsoft 365', url: 'https://m365.cloud.microsoft/',
    initials: 'M3', color: '#D83B01', provider: 'microsoft',
    allowedHosts: ['cloud.microsoft', 'office.com', 'microsoft365.com', 'sharepoint.com', 'officeapps.live.com', ...MS_AUTH],
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
    id: 'chatgpt', aliases: ['openai', 'gpt'], icon: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/',
    initials: 'GP', color: '#10A37F', provider: 'openai',
    allowedHosts: ['chatgpt.com', 'openai.com', 'auth.openai.com', 'auth0.openai.com', ...GOOGLE_AUTH],
  },
  {
    id: 'gemini', aliases: ['bard'], icon: 'google-gemini', name: 'Gemini', url: 'https://gemini.google.com/app',
    initials: 'Ge', color: '#8E75B2', provider: 'google',
    allowedHosts: ['gemini.google.com', ...GOOGLE_AUTH],
  },
  {
    id: 'copilot', icon: 'microsoft-copilot', name: 'Copilot',
    url: 'https://copilot.microsoft.com/',
    initials: 'Cp', color: '#0078D4', provider: 'microsoft',
    // Consumer Copilot is on copilot.microsoft.com; the work one is served from cloud.microsoft,
    // and which you get depends on the account, so both have to be here.
    allowedHosts: ['copilot.microsoft.com', 'cloud.microsoft', ...MS_AUTH],
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
    // publish.obsidian.md serves *published* sites, not your vault — a local folder no web client
    // reaches. The URL is the only real web surface Obsidian has, so the correction is to stop it
    // reading as "your notes, in Hangar".
    caveat: 'Obsidian Publish sites only — your vault is local and has no web client.',
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
    unread: {
      // "Inbox (3) - you@gmail.com - Gmail", with the count after the label — and "(1,234)" once
      // the inbox is big. The pattern everything else uses wants "(3)" first, so a Gmail that was
      // open read zero. Any label before the count, but no dash: past the first " - " is the
      // address, and an open message's subject.
      titlePattern: '^(?:[^()\\-–]+ )?\\((\\d[\\d,.\\s\\u00a0\\u202f]*)\\+?\\)',
      endpoint: GMAIL_FEED,
    },
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
    // `teams.live.com` is consumer Teams, and it is a *different app* rather than a redirect target
    // of the work one — signing in with a personal account routes there. Without it the sign-in
    // step was refused and the pane sat on a half-loaded work Teams with nothing to type into,
    // which is indistinguishable from the service being broken.
    //
    // `cloud.microsoft` is the Microsoft 365 domain the whole suite is moving onto, so the shell
    // hops through it. Microsoft-owned end to end and not a public suffix, so the leading-dot
    // suffix match is safe here in a way shortening to a registrable domain usually is not.
    allowedHosts: [
      'teams.microsoft.com',
      'teams.live.com',
      'cloud.microsoft',
      'sharepoint.com',
      ...MS_AUTH,
    ],
    provider: 'microsoft',
    // The call bar's ids, which Teams has kept across redesigns; state from the mic's `data-state`
    // and the other buttons' labels.
    meeting: {
      inCall: '#hangup-button',
      controls: {
        // No OFF list for the mic: `data-state`'s other values haven't been seen, and it's the page's
        // own state rather than words. The labels below are English; in another language they read
        // as unknown and a `want` press is refused, rather than guessed.
        mute: { selector: '#microphone-button', read: 'attr', attr: 'data-state', on: ['mic-off'] },
        video: { selector: '#video-button', on: ['Turn camera off', 'Turn off camera'], off: ['Turn camera on', 'Turn on camera'] },
        share: { selector: '#share-button', on: ['Stop sharing', 'Stop presenting'], off: ['Share', 'Present'] },
        hand: { selector: '#raisehands-button', on: ['Lower'], off: ['Raise'] },
        leave: { selector: '#hangup-button' },
      },
    },
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
    // ⌘K jump-to, ⌘F search this channel, ⌘[ / ⌘] Slack's own history. All four are chords Hangar
    // would otherwise take, and all four are the reason this feature exists.
    passthrough: ['mod+k', 'mod+f', 'mod+[', 'mod+]'],
    // A huddle runs in its own `about:blank` window, which the allowlist alone would refuse.
    blankPopups: true,
    meeting: {
      inCall: '[data-qa="huddle_toolbar__leave_button"]',
      popups: true,
      controls: {
        mute: { selector: '[data-qa="segmented-mute-button-main"]', on: ['Unmute'], off: ['Mute'] },
        video: { selector: '[data-qa="huddle_camera_huddle_toolbar"]', read: 'child', child: '[data-qa="huddle_video_icon_camera_on"]' },
        share: { selector: '[data-qa="huddle_toolbar_screenshare_button"]', read: 'attr', attr: 'aria-pressed', on: ['true'], off: ['false'] },
        leave: { selector: '[data-qa="huddle_toolbar__leave_button"]' },
      },
    },
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
    // ⌘P is Notion's search, ⌘\ toggles its sidebar, ⌘[ / ⌘] are its history.
    passthrough: ['mod+k', 'mod+p', 'mod+\\', 'mod+[', 'mod+]'],
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
    passthrough: QUICK_SWITCHER,
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
    unread: SALESFORCE_UNREAD,
  },
  ...COMMS,
  ...WORK,
  ...SUITES,
  ...AI_NOTES,
  ...MAIL,
  ...SOCIAL,
  {
    id: 'spotify', icon: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/',
    initials: 'Sp', color: '#1DB954', provider: 'spotify',
    allowedHosts: ['open.spotify.com', 'spotify.com', 'accounts.spotify.com', ...GOOGLE_AUTH],
  },
];

// Deliberately not here: **Skype**. Microsoft retired it in May 2025 and web.skype.com now
// redirects to a migration notice, so an entry for it would be a tile that can never work — the
// exact trap the Signal and Obsidian caveats exist to stop repeating.

export const catalogById = (id: string): CatalogEntry | undefined =>
  catalog.find((c) => c.id === id);

/**
 * A service's effective URL: its own override if it has one (custom connections), otherwise the
 * catalog's current value. Resolving at load time rather than copying at creation time is what
 * lets a catalog fix reach installs that already exist.
 */
export const resolveUrl = (svc: { catalogId: string; url?: string }): string =>
  svc.url ?? catalogById(svc.catalogId)?.url ?? 'about:blank';

/**
 * A service whose `catalogId` no longer resolves and which has no URL of its own.
 *
 * This is what renaming or removing a catalog entry does to installs that already exist, and it
 * fails in the quietest possible way: `resolveUrl` returns `about:blank`, and `isAllowedHost` has
 * no list to check so it refuses *every* navigation. The result is a permanently blank pane with
 * nothing anywhere saying why. Worth naming so the callers can say so instead.
 */
export const isOrphaned = (svc: { catalogId: string; url?: string }): boolean =>
  !svc.url && !catalogById(svc.catalogId);
