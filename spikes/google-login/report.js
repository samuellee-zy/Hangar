// Merges both halves of the Phase 0 gate into results.md:
//   probe-results.json  — headless, pre-credential checkpoints (npm run probe)
//   results.json        — interactive verdicts recorded by hand (npm start)
//
// Run: npm run report

const fs = require('node:fs');
const path = require('node:path');

const { strategies } = require('./strategies');
const services = require('./services');

const read = (f) => {
  const p = path.join(__dirname, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

const probes = read('probe-results.json') || [];
const interactive = read('results.json') || {};

const cell = (r) => {
  if (!r) return '·';
  if (r.verdict === 'pass') return '**PASS**';
  if (r.verdict === 'fail') return 'fail';
  if (r.blocked) return 'blocked?';
  if (r.signedInSeen) return 'in?';
  return '·';
};

const byId = Object.fromEntries(probes.map((p) => [p.strategy, p]));
const defaultUa = byId.baseline?.ua || '(run npm run probe)';

const headlessRows = strategies.map((s) => {
  const p = byId[s.id];
  return `| ${s.name} | ${p?.signin ?? '·'} | ${p?.oauth ?? '·'} |`;
});

const interactiveHeader =
  '| Strategy | ' + services.map((s) => (s.gate ? '★ ' : '') + s.name).join(' | ') + ' |';
const interactiveRows = strategies.map((st) => {
  const cells = services.map((sv) => cell(interactive[`${st.id}::${sv.id}`]));
  return `| ${st.name} | ${cells.join(' | ')} |`;
});

const anyInteractive = Object.keys(interactive).length > 0;

const uaTable = strategies
  .map((s) => {
    const ua = byId[s.id]?.ua;
    return `**${s.name}**\n\n${s.note}\n\n\`\`\`\n${ua || '(not run)'}\n\`\`\`\n`;
  })
  .join('\n');

const md = `# Phase 0 — Google login spike results

Generated ${new Date().toISOString()}

## Part 1 — Headless pre-credential probe

Two checkpoints per strategy, no credentials involved: the \`accounts.google.com\` sign-in page,
and the OAuth 2.0 authorization endpoint (the surface that returns \`disallowed_useragent\`).

| Strategy | accounts.google.com | OAuth endpoint |
| --- | --- | --- |
${headlessRows.join('\n')}

### Reading this

A row of \`ok\` means Google did **not** reject the request shape at either checkpoint. It does not
prove a full sign-in succeeds — Google commonly serves "This browser or app may not be secure" at
the *password* step, which is past where an unauthenticated probe can reach. Part 2 settles that.

The result to note is **baseline**: an untouched UA containing \`Electron/43.2.0\` was not rejected
at either checkpoint. If that holds through Part 2, the Rambox scrub is belt-and-braces at this
stage rather than load-bearing, and Ferdium's reported failures are likely down to something other
than the bare presence of an Electron token.

## Part 2 — Interactive sign-in

${anyInteractive ? '' : '_Not yet run. `npm start`, sign in, mark PASS/fail, then `npm run report`._\n'}
Legend: **PASS** = signed in and still signed in after an app relaunch · \`fail\` = could not sign in ·
\`blocked?\` = block text detected · \`in?\` = reached a signed-in URL, persistence unconfirmed ·
\`·\` = not run. ★ marks the four gate services.

${interactiveHeader}
| --- |${services.map(() => ' --- |').join('')}
${interactiveRows.join('\n')}

### Gate criteria

Sign into Gmail, Google Calendar, Teams and Salesforce; quit; relaunch; all four still signed in.
Stop at the first strategy that clears it — that becomes \`src/main/ua.ts\` in Phase 1.

## Baseline user agent

\`\`\`
${defaultUa}
\`\`\`

## Per-strategy detail

${uaTable}
`;

fs.writeFileSync(path.join(__dirname, 'results.md'), md);
console.log('Wrote results.md');
