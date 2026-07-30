// The four gate services from the plan, plus two that sign in via third-party Google/OAuth
// (a different code path — Google's hard block targets the OAuth authorization endpoint).
//
// `sharesSessionWith` points a service at another service's partition. Rambox gives every app its
// own session, which means signing into Google separately for Gmail, Calendar, Drive and so on.
// Services behind one identity provider should be able to share a cookie jar — one sign-in, all of
// them live. Defaults to the service's own id when unset.

module.exports = [
  {
    id: 'gmail',
    name: 'Gmail',
    url: 'https://mail.google.com/mail/u/0/',
    gate: true,
    // Signed in when we've landed on the app and not on an auth host.
    signedIn: (url) => /mail\.google\.com\/mail\/u\/\d/.test(url) && !/accounts\.google\.com/.test(url),
  },
  {
    id: 'gcal',
    name: 'Google Calendar',
    // NOT /calendar/u/0/r — with no session for user index 0, Google redirects to the
    // workspace.google.com marketing page instead of offering a sign-in. The bare host routes
    // correctly whether or not a session exists.
    url: 'https://calendar.google.com/',
    gate: true,
    sharesSessionWith: 'gmail',
    signedIn: (url) => /calendar\.google\.com\/calendar/.test(url) && !/accounts\.google\.com/.test(url),
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    url: 'https://teams.microsoft.com/',
    gate: true,
    // Teams now lands on teams.cloud.microsoft rather than teams.microsoft.com.
    signedIn: (url) =>
      /(teams\.cloud\.microsoft|teams\.microsoft\.com\/(v2|_#))/.test(url) &&
      !/login\.microsoftonline\.com/.test(url),
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    url: 'https://login.salesforce.com/',
    gate: true,
    signedIn: (url) => /(lightning\.force\.com|\.my\.salesforce\.com)/.test(url) && !/\/login/.test(url),
  },
  {
    id: 'slack',
    name: 'Slack',
    url: 'https://app.slack.com/client',
    gate: false,
    signedIn: (url) => /app\.slack\.com\/client\/T/.test(url),
  },
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://www.notion.so/',
    gate: false,
    signedIn: (url) => /notion\.so\//.test(url) && !/notion\.so\/login/.test(url),
  },
];
