# Config sync

Keeping your services, accounts and workspaces the same on two Macs, over a git repo you control.

There is no Hangar server and no account. The transport is a repo you already have — a private one,
or the dotfiles repo you keep anyway. Git is doing the work it is good at: history, a diff, and an
honest answer when two machines disagree.

## What it does not do

Worth stating first, because one of these surprises everyone:

**Sessions do not sync.** Cookie jars are partition directories on disk, not config. Machine B gets
your service list and your account *labels*, and then you sign in. That is not a gap to be closed
later — a cookie jar is bound to the browser that made it — and the UI says so rather than letting it
look like a failure.

Window bounds and pane layouts stay local too. A four-pane split from a 32" monitor is not something
you want restored on a 13" laptop, and `restoreBounds` from a desktop can strand the window offscreen
on a machine that never had that display.

## Setup

1. **Make a private repo** and clone it on each machine. It needs an `origin` remote. A bare repo you
   push to, or a normal GitHub/GitLab private repo, both work.
2. **Check git can commit unattended.** You need `git` on `PATH`, `user.email` set, and
   authentication that never prompts — an SSH agent, or a credential helper. Hangar runs git with
   `GIT_TERMINAL_PROMPT=0` deliberately, so a missing credential fails immediately instead of hanging
   for 30 seconds on a prompt nobody can see.
3. **Point Hangar at your clone**: Settings → Sync → repository path. It is a *local path*, and each
   machine has its own — which is why that setting is one of the few that never travels.
4. Hangar writes `hangar.config.json` and pushes. If the repo had no config, this seeds it.
5. **On the second machine**, repeat with that machine's own clone path. Expect to sign in to your
   services again.

To stop syncing, clear the path.

Sharing a dotfiles repo with other things is fine. Hangar stages one path and commits with `--only`,
so it can never sweep up work you had staged.

## What travels

An **allowlist**, not a blocklist — `PORTABLE_KEYS` in
[`core/config/sync.ts`](../src/core/config/sync.ts). A blocklist means every field added later syncs
by default and someone has to remember to exclude it, which is exactly how a machine-local secret
reaches a shared repo.

| Travels | Stays here |
| --- | --- |
| `services`, `accounts`, `workspaces`, `activeWorkspaceId` | Cookie jars — not in the config at all |
| Most of `preferences` | `window` bounds and `layouts` |
| | `pushRegistrations` — an FCM registration belongs to one receiver; two machines claiming it means neither gets the notification |

And a handful of preference *leaves* are held back even though `preferences` as a whole travels:

| Path | Why |
| --- | --- |
| `notifications.firebase` | **A credential.** The one that really matters — syncing it commits an API key |
| `sync.repoPath`, `sync.allowPublicRepo` | Absolute local path, and an override about one repo on one machine. The transport config travelling over the transport would disable sync on arrival |
| `network.proxy` | A work proxy should not follow you home |
| `downloads.folder` | Absolute local path |
| `notifications.dndUntil` | A timestamp; transient state, not a preference |
| `behaviour.launchAtLogin`, `behaviour.relaunchOnCrash` | A launchd job registered on *this* Mac ([#93](decisions.md)) |

`notifications.push` does travel. Without credentials the second machine shows the toggle as pending
with "Fill in the Firebase project below first", which is honest.

A service travels without its **custom JavaScript** (`LOCAL_SERVICE_FIELDS`). It is code that runs
inside a signed-in page, so anyone who could push to the repo could run it in your Gmail. It's
written by hand, on the machine that needs it.

**Upgrade the Macs you sync between together.** Builds before Phase 8 synced custom JavaScript and
took a service from the repo whole. If one Mac upgrades and another doesn't, the upgraded Mac pushes
services without their scripts. The old one then adopts them and loses its own. After it upgrades,
nothing brings the scripts back, so copy them out of Settings first if you rely on them.

## How a reconcile works

One pass, not a pull and a push. Splitting them was the original design and the mistake
([#80](decisions.md)): two entry points meant two chances to interleave, and git against one
repository from two directions fights over `index.lock`.

It runs on launch, five seconds after any config change — debounced, because window bounds alone
would otherwise produce a repo full of noise — and on demand from the Sync section.

```
Mac A ──commit hangar.config.json──▶  git repo you control  ──fetch, ff-only──▶ Mac B
                                              │
                                              ▼
                                    sync-base.json (userData)
                              "what this machine last agreed to"
                                              │
                                              ▼
                            local vs base  ×  repo vs base  ──▶ apply · push · conflict
```

The decision is three-way, against a snapshot of what was last synced. That snapshot,
`sync-base.json`, lives in `userData` and deliberately not in the config, so it cannot sync itself:

| This machine | The repo | Result |
| --- | --- | --- |
| unchanged | changed | apply the repo's copy |
| changed | unchanged | push |
| unchanged | unchanged | nothing |
| changed | changed | **conflict** |

Without that base you cannot tell "the remote is newer" from "I have local changes that never
pushed", and treating the second as the first silently deletes them — a data-loss path reachable on a
single machine ([#78](decisions.md)).

Incoming configs are validated before they are applied. A file that would orphan a service from its
account, or empty a rail that is not empty, is refused rather than adopted: the first makes services
permanently unloadable, and the second is indistinguishable from a sync that worked.

## Conflicts

**Nothing is ever auto-merged.** A structural merge would have to decide what happens when both
machines renamed the same service, and every answer is a guess about intent — sometimes one that
costs an account-to-partition mapping. Git has a model for that disagreement; this defers to it.

You will see a conflict when both sides changed since the last sync, when git's own history has
diverged so a fast-forward is impossible, or on the first sync of a machine with no base where the
two copies already differ.

Resolve it in Settings → Sync. **Keep local** pushes this machine's copy over the repo's; **keep
repo** applies the repo's over this machine's. Each discards the other side's changes to the portable
half, which is the point — you are choosing, not merging. Neither touches your sessions, layouts or
window bounds.

The way to avoid them is boring and effective: let one machine finish before you start editing on the
other.

## Status

| State | Means |
| --- | --- |
| `off` | No repository path set |
| `unavailable` | Set, but unusable: not a git repo, no `git` on `PATH`, no `user.email`, or the public-repo guard refused |
| `idle` | Working, with the time of the last successful pass |
| `conflict` | Both sides moved; waiting for you to choose |
| `error` | Something else — a failed push, unparseable JSON in the repo |

## Safety

The synced file carries **no credentials**, and a test pins that by asserting the output contains
neither the Firebase key nor the string `apiKey`. It is still not public-safe: account labels are
usually email addresses, and custom connection URLs are plausibly internal hostnames.

So Hangar checks whether the repo is world-readable before it writes, and refuses if it is unless you
override. The guard fails *open* — offline, or a self-hosted forge, and the sync proceeds — because
the first version of it was backwards, refusing exactly the private-repo-on-GitHub case that is the
normal one, and a guard that trains you to switch it off is worse than no guard. The full reasoning,
including why only an anonymous HTTP 200 counts as evidence, is in
[preferences.md](preferences.md#sync) and [#85](decisions.md).

Use a private repo.

## When it goes wrong

| Message | Fix |
| --- | --- |
| `git is not available on PATH` | Install the command line tools |
| `… is not a git repository` | The path must be a clone, not just a folder |
| `git has no user.email configured` | `git config --global user.email you@example.com` |
| Push fails, or a conflict you did not cause | Someone changed the repo's history. Sort it out with git directly, then sync |
| Sync appears to do nothing | Check the status line. `off` means no path; `unavailable` says why |

## Where the code is

| Path | Role |
| --- | --- |
| [`core/config/sync.ts`](../src/core/config/sync.ts) | Allowlists, the three-way decision, validation, the public-repo verdict. Pure |
| [`main/features/sync.ts`](../src/main/features/sync.ts) | The git transport, the debounce, the module-level mutex |
| [`main/platform/sync-base.ts`](../src/main/platform/sync-base.ts) | The last-synced snapshot |
| [`renderer/settings/Sync.tsx`](../src/renderer/settings/Sync.tsx) | Settings section and conflict resolution |

Design notes are [decisions](decisions.md) #74 to #83 and #85. Two are worth reading before changing
anything here: #74 on why this is an allowlist, and #82 on the conflict buttons, which at one point
did the opposite of what they said.
