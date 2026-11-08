# Surfaces contract

Everything that reads or drives gmod is a *surface*: the pane, the CLI, CI,
Skiff, Linear, other agents. They all use one contract, so gmod changes once
per release, not once per surface. This page is that contract for gmod 1.7; until 1.7 is released, parts of it are still being built (see the plan's Surfaces contract phase).

## The surfaces

| Surface | Where it runs | Needs from gmod |
|---|---|---|
| Claude Code mod / pane | inside the repo, live | reads gmod directly (same modules) |
| CLI | a person in a terminal | the same actions, in words |
| CI gate + reviewer | pull requests on the forge | stable verdicts; sees only what's pushed |
| Skiff (Mac app) | many repos, in the background | change stamp, state, signals, act on decisions |
| Linear | remote, a team | shared state; decide from outside the repo |
| Other agents (Codex, pi) | a terminal, no mod | the CLI and its JSON only |

Every surface except the pane goes through the CLI: `gmod <command> --json`.
The pane imports the same modules, so it can't disagree with the CLI.

## 1. The change stamp

One cheap value that moves whenever anything a surface shows may have changed.

- **File:** `<git-common-dir>/gmod/stamp`, a counter gmod rewrites on every
  write a signal or state depends on: proposal and ADR drafts (drafted, edited,
  approved, rejected), check runs, claims and releases, and any `refs/gmod/*`
  or `main` its own syncs move. One per clone, shared by every worktree.
- **Value:** `gmod stamp` prints, and `state --json` and `signals --json`
  carry as `stamp`, `<counter>-<hash>`, where the hash covers the tips of
  `main` (local and origin's) and every `refs/gmod/*`. So a plain `git fetch`
  that brings a teammate's draft moves it too, even though gmod didn't write.
- **Use:** watch the stamp file (FSEvents/inotify) for this clone's writes;
  poll `gmod stamp` (one `for-each-ref`, no plan read) to see fetched ones.
  Re-read state and signals only when the stamp differs from the last one seen.
- The stamp is opaque: compare for equality, never parse or order it.

## 2. Shared and local state

Decided in [ADR 0002](adr/0002-what-gmod-shares-and-what-stays-local.md). In short:

| What | Where | Seen by |
|---|---|---|
| Plan, accepted ADRs, managed switch | committed on `main` | everyone |
| Claims | `refs/gmod/claims/<job>` (as since 1.0) | everyone with the remote |
| Plan proposal | `refs/gmod/proposal` | everyone with the remote |
| ADR drafts | `refs/gmod/adr-drafts/<slug>` | everyone with the remote |
| A job's latest check verdict | `refs/gmod/runs/<job>` | everyone with the remote |
| Each run's full evidence, the worktree's claim, caches | the worktree's git dir | this worktree only |
| The stamp | the common git dir | this clone only |

Shared verdicts are signals, never proof: the gate proves every pull request
again and never reads `refs/gmod/runs/*`. Without a remote everything still
works, locally, as before.

## 3. `gmod decide`

```
gmod decide <signal-id> <action> [--rev <rev>] [--note <text>] [--json]
```

One action command for every surface, for the signals of kind `decide`:

| Signal | Actions |
|---|---|
| plan proposal | `approve`, `ask-changes` (with `--note`), `reject` |
| ADR draft | `accept`, `reject` |

The actions a signal offers are its `actions` field; `decide` refuses any
other. For a proposal, `--rev` names the version the person saw; if the
proposal changed since, `decide` refuses rather than approve something unseen.
Signals of kind `unstick` (red jobs, rebases) are not decisions: `decide`
answers them with the command to run, and does nothing.

**Only a person decides.** Every decision commit carries
`Decided-By: <who>` and `Decided-Via: <surface>` trailers. `decide` refuses
when it runs under an agent: gmod's agent identity, or an agent's environment
(Claude Code, Codex, pi, CI). In a terminal it asks the person to type the
signal's id back. A background app (Skiff) runs it with `--via <app>` from a
person's click, without a terminal, and with none of those environments.
This keeps an agent from deciding by accident or by habit; it does not stop a
determined program running as you. The forge is the last line: decisions land
as pull requests of their own that the owners review.

## 4. Stable signal ids

A signal's `id` is a hash of its cause, never of where or when it was
computed. With proposals and drafts shared, the same signal has the same id on
every clone and machine, so a mute or a decision made on one surface holds on
all of them. Mutes belong to the surface; gmod only keeps the ids stable.

- proposal: `{ proposal: <when it was first drafted> }`; edits keep the id and
  change its `rev`
- ADR draft: `{ adr: <slug> }`
- red job: `{ stuck: <job> }`
- main moved under a job: `{ moved: <job>, level }`

## 5. Versioning

Protocol v1, additive only. New fields (`stamp`, `rev`, `shared`) and new
commands (`stamp`, `decide`) are added to v1; readers ignore fields and
commands they don't know, and ask `gmod capabilities --json` what this gmod
speaks. Protocol v2 is for a real break only: a field removed or its meaning
changed.

## Core or managed

The stamp, shared state, `decide` and stable ids are core: every surface,
including the CLI and the pane, uses them, and `decide` is the CLI form of the
approve, reject and accept that core already has. Anything only Skiff needs
(voyages, requests, packs) stays behind managed mode (ADR 0001).
