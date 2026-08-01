## What this changes

<!-- What behaviour is different afterwards, and why. Not a list of files. -->

## How it was verified

<!--
Say what you actually ran, not what should pass. CI runs `npm run check` and `npm run test:e2e`
and will block the merge on its own — this section is for the part CI can't see.

If the change adds a guard, an assertion or a rule, the useful thing to record here is that you
broke the thing it guards and watched it fail. Several guards in this repo were found to be inert
that way, having passed for months.
-->

- [ ] `npm run check` (typecheck, 350 unit tests, dependency-cruiser boundaries)
- [ ] `npm run test:e2e` (real Electron)
- [ ] Manually exercised in the running app

## Anything left undone

<!-- Known gaps, follow-ups, or a docs/backlog.md entry. "Nothing" is a fine answer. -->
