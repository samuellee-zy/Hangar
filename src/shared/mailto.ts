/**
 * Turning a `mailto:` link into the compose screen of a web mail service.
 *
 * With Hangar as the default email app, clicking an email address anywhere on the Mac opens a new
 * message in your mail service here, rather than in Mail.app you never set up. Each service takes
 * the message differently, so each has its own template — and only services whose compose URL is a
 * documented, stable entry point are listed. A guessed template that half-works (the address but
 * not the subject) is worse than the service not being offered.
 */

export interface Mailto {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

/** `mailto:a@x.com,b@y.com?subject=Hi&cc=c@z.com&body=…` → its parts, decoded. */
export function parseMailto(raw: string): Mailto | null {
  if (!/^mailto:/i.test(raw)) return null;
  const rest = raw.slice('mailto:'.length);
  const [addresses = '', query = ''] = rest.split('?', 2) as [string?, string?];
  const params = new URLSearchParams(query);
  const get = (key: string) => {
    // Keys are case-insensitive in practice: `Subject=` appears in the wild.
    for (const [k, v] of params) if (k.toLowerCase() === key) return v;
    return '';
  };
  let to: string;
  try {
    to = decodeURIComponent(addresses);
  } catch {
    to = addresses;
  }
  return { to, cc: get('cc'), bcc: get('bcc'), subject: get('subject'), body: get('body') };
}

type Template = (raw: string, mail: Mailto) => string;

const q = encodeURIComponent;

/** Catalog id → compose URL for a message. */
const TEMPLATES: Record<string, Template> = {
  // Gmail's own registered handler: it takes the mailto link whole and parses it itself.
  gmail: (raw) => `https://mail.google.com/mail/?extsrc=mailto&url=${q(raw)}`,
  // Outlook on the web's compose deep link, the same for work and personal accounts.
  outlook: (_raw, m) =>
    `https://outlook.office.com/mail/deeplink/compose?to=${q(m.to)}&cc=${q(m.cc)}&bcc=${q(m.bcc)}` +
    `&subject=${q(m.subject)}&body=${q(m.body)}`,
  yahoomail: (_raw, m) =>
    `https://compose.mail.yahoo.com/?to=${q(m.to)}&cc=${q(m.cc)}&bcc=${q(m.bcc)}` +
    `&subject=${q(m.subject)}&body=${q(m.body)}`,
};

/** Whether a catalog entry can take a `mailto:` link. */
export const canCompose = (catalogId: string): boolean => catalogId in TEMPLATES;

/** The compose URL for this link in this service, or null when the service can't take one. */
export function composeUrlFor(catalogId: string, raw: string): string | null {
  const template = TEMPLATES[catalogId];
  const mail = parseMailto(raw);
  if (!template || !mail) return null;
  return template(raw, mail);
}
