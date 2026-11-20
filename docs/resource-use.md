# Resource use

Hangar can bound the number of inactive apps it keeps loaded while leaving essential apps available for notifications. Under **Settings → Behaviour**, set an idle sleep timeout and **Cached background services**. The cache limit counts eligible inactive services, excluding current panes, services set to **Keep running**, and protected activity. `0` means unlimited cache; an idle timeout of `0` disables automatic sleeping. Existing installations retain their settings.

The memory-focused local profile uses a five-minute timeout and two cached inactive apps. Gmail, Calendar, Messenger, Slack and WhatsApp stay running. Other services become eligible after leaving a pane, with at least one minute of warm retention before cache eviction. Current panes remain protected when the window is hidden or minimised.

Automatic sleeping and wake refreshes check for calls, audio, popouts, service popups, downloads, capture and edited fields. Failed/unknown activity probes retain the page; a `beforeunload` veto is respected. Removed edited fields are treated conservatively. This is best-effort detection of third-party page state, not a guarantee for every custom editor or embedded frame. Use **Keep running** for a service whose important work Hangar cannot recognise. Sleeping destroys the web contents and restores the last allowlisted address when reopened; it does not serialise arbitrary page state.

Background services start one at a time, with a one-second gap after load completion and a twenty-second load ceiling. A timed-out load is stopped and eligible recovery attempts use bounded backoff. After a long system sleep, safe visible and essential services refresh through the queue; other cached pages refresh when next opened. Foreground user opens do not wait for queued startup work. Chromium background throttling is enabled from creation and native visibility determines whether ordinary pages slow down. Calls and audio temporarily opt out.

Closed overlays, find bars, drag surfaces, unused pane headers/splitters, Inbox and Assistant renderers are reclaimed after sixty seconds. Small Inbox/Assistant UI values remain in memory; pending operations, connection setup forms and oversized UI drafts keep their renderer. Conversation inspection runs only for an open, visible Inbox or a connected control client. Meeting checks run every two seconds at rest and every half second during calls, with no repeating check when there are no eligible pages. Persistence and endpoint sweeps do not overlap themselves.

## Measuring

**Settings → Resource use → Measure resource use** samples only while enabled and visible. Rows represent OS processes, with all known service/interface labels sharing that process. CPU and wakeups are interval averages; the first sample establishes a baseline. Summed resident memory can include shared pages and excludes compressed pages on macOS. It is not Activity Monitor's physical footprint.

The repeatable synthetic benchmark uses twelve isolated local pages, five kept running, each with a touched 16 MiB allocation and a 100 ms timer. It visits every page, hides the window for ten minutes, then measures a simulated long wake. It uses an IPC-only native Electron driver: no Playwright debugger, focus emulation or scheduler-disabling flags. No real accounts are used.

```sh
npm run build
# Save the pre-change build before implementing changes:
# mkdir -p out-check/resource-baseline && cp -R out out-check/resource-baseline/
node scripts/benchmark-resources.mjs --entry out-check/resource-baseline/out/main/index.js --output out-check/resources-before.json
node scripts/benchmark-resources.mjs --optimised --output out-check/resources-after.json
# Short native visibility/timer check:
node scripts/benchmark-resources.mjs --visibility-only
```

Compare the last settled samples, startup maxima and wake maxima, including process/content counts. Run the two benchmark profiles sequentially. These numbers demonstrate the fixture's behaviour; real Gmail, Slack and other web apps have different memory costs. Real account notification delivery, long-running calls, and battery endurance require separate use with those services.

`e2e/resources.spec.ts` checks native scheduling, draft/capture/unload guards, last-address restoration, deferred wake reloads, demand-driven probes, panel state and fifty repeated service/panel release cycles. The cycle assertion counts actual remaining web contents; it does not claim that Chromium immediately returns every allocated page to macOS.

## Local validation — 7 November 2026

On this Mac (24 GiB RAM), sequential native runs retained the same five essential fixture services. Both visited twelve services and idled hidden for ten minutes. The desktop was in ordinary use, including isolated regression tests; these are observations, not a controlled power or battery benchmark.

| Observation | Before: 30 min, unlimited cache | After: 5 min, cache of 2 |
| --- | ---: | ---: |
| Loaded services after ten minutes | 12 | 6 |
| OS processes after ten minutes | 16 | 10 |
| Live web contents after ten minutes | 13 | 7 |
| Median resident memory, final idle minute | 435.0 MiB | 566.5 MiB |
| Peak resident memory during simulated wake | 1,251.3 MiB | 860.5 MiB |
| Peak sampled CPU during simulated wake | 4.578% | 2.471% |
| Median idle wakeups/s, final idle minute | 7 | 2 |

The six retained services are the five essentials plus the current pane. At the earlier cache-limit checkpoint there were eight loaded services; the remaining two inactive pages slept after the five-minute deadline. The native timer check observed 30 foreground ticks and 3 background ticks over three seconds for 100 ms timers.

Idle resident memory was **higher** in the optimised run despite six renderer processes being released. RSS excludes compressed memory and is sensitive to macOS and concurrent workload; these samples do not establish a reduction in total idle physical footprint. Wake peak resident memory was about 31% lower in this fixture. No battery-life improvement or real-account notification/call endurance has been measured.

Raw local results are in the ignored `out-check/resources-before.json`, `out-check/resources-after.json` and `out-check/resource-comparison.json`. The benchmark uses the same resource policy as the final build; the last follow-up only fixes recovery of a navigation stopped before its first document commits.

Validation: type checks, lint, dependency boundaries and all 1,193 unit/renderer tests pass. The full desktop suite passed all 106 tests before that final recovery follow-up. All eleven resource regressions pass on the final rebuilt app, including the blank-page recovery follow-up and fifty sleep/wake and panel release cycles with no extra web contents remaining.

Local rollout completed after explicit approval on 7 November 2026. The installed signed archive matches the tested packaged build. The saved personal profile uses a five-minute timeout, two cached inactive services, and Keep running for Gmail, Calendar, Messenger, Slack and WhatsApp. After restart, the control socket reported those five loaded and the other seven services sleeping. The previous application and configuration were retained as rollback copies. Other installations retain their existing preferences.
