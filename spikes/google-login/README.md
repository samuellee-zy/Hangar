# Phase 0 — Google login spike

The gate for the Hangar build. Google blocks sign-in inside detected embedded webviews
(`disallowed_useragent`); Ferdium is plagued by it with no maintainer fix, while Rambox works. This
measures which of the seven strategies in `strategies.js` actually clears it, before any real app
code gets written.

Throwaway by design — the only artifact that matters is `results.md`.

## Run

```bash
npm install
```

**Part 1 — headless, no credentials.** Hits the `accounts.google.com` sign-in page and the OAuth
authorization endpoint under each strategy and checks for the rejection interstitial. ~40s.

```bash
npm run probe
```

**Part 2 — interactive.** Opens a window with a strategy × service picker. Pick a pair, sign in for
real, and mark the outcome. The URL, detected block state, and live user agent are shown in the
control bar; verdicts persist to `results.json`.

```bash
npm start
```

**Merge both into `results.md`:**

```bash
npm run report
```

**Start over:**

```bash
npm run reset
```

## Gate criteria

Sign into Gmail, Google Calendar, Teams and Salesforce → quit → relaunch → all four still signed in.
Stop at the first strategy that clears it; that one becomes `src/main/ua.ts` in Phase 1.

## Layout

| File | What it is |
| --- | --- |
| `strategies.js` | The seven-rung fallback ladder. Strategy 1 is Rambox 2.7.0's verbatim production regex — don't "improve" it |
| `services.js` | The four gate services plus Slack and Notion (third-party Google/OAuth sign-in, a different code path) |
| `main.js` | Interactive harness: `BaseWindow` + control bar + swappable test view, one partition per (strategy, service) |
| `probe-headless.js` | Part 1 |
| `report.js` | Merges both result sets into `results.md` |
| `preload-service.js` | Mirrors `Sec-CH-UA*` into `navigator.userAgentData` for the client-hints strategy |

Each (strategy, service) pair gets its own persistent partition, so a login under one strategy
can't mask a failure under another.

## Notes

- Sessions live in `sessions/` and `sessions-headless/` inside this directory — nothing touches
  your real browser profiles or the installed Rambox.
- The `FIDO: ... Bluetooth metadata` and `task_policy_set` lines in the console are unsigned-dev-build
  noise, not failures.
