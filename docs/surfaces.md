# Surfaces contract

Everything that reads or drives gmod is a *surface*: the pane, the CLI, CI,
Skiff, Linear, other agents. They all use one contract, so gmod changes once
per release, not once per surface. This page is that contract as of gmod 1.8.

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
| An agent's request, and the answer | `refs/gmod/requests/<id>` | everyone with the remote |
| A signal the person set aside | `refs/gmod/resolved/<signal-id>` | everyone with the remote |
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
| an agent's request | `answer` (with `--note`), `resolve` |
| red job, main moved under a job | `rebrief` (with `--note`), `resolve` |

The actions a signal offers are its `actions` field; `decide` refuses any
other. For a proposal, `--rev` names the version the person saw; if the
proposal changed since, `decide` refuses rather than approve something unseen.
For the rest of an `unstick` signal's actions (`open`, `rebase`), `decide`
answers with the command to run, and does nothing.

- **`answer`** records the person's answer to an agent's request; when the
  request has options, the answer is one of them. **`resolve`** on a request
  closes it without one.
- **`resolve`** on a red or moved job sets its signal aside: a mark at
  `refs/gmod/resolved/<signal-id>` holds the signal's `rev`, and the signal
  stays hidden on every clone until its `rev` changes (a new red run, a new
  landing).
- **`rebrief`** replaces the job's brief as the person's decision, committed
  alone (`plan: rebrief <job>`) like an approve, with no proposal, and lets
  the job's claim go wherever it's held, so the next worker starts from the
  new brief. It's refused for a job done on main, and while a pending proposal
  changes the same job: the refusal names that proposal and its signal id.

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
- red job: `{ stuck: <job> }`; its `rev` moves with each new red run
- main moved under a job: `{ moved: <job>, level }`; its `rev` moves with what landed
- an agent's request: `{ request: <request id> }`

## 5. Requests

An agent asks the person about its job, and the person answers:

```
gmod ask <question> [--options '<json list>'] [--json]   # the agent, on its claimed job
gmod requests [--all] [--job <id>] [--json]              # open ones; --all with the answers
```

In Claude Code the agent asks with `mcp__gmod__ask`, and the person answers in
the pane (`/gmod answer <id> <answer>`, `/gmod resolve <id>`). Every other
surface uses `gmod decide <id> answer --note <text>` on the request's signal.
The request lives at `refs/gmod/requests/<id>` with its question, options, who
asked and when, and once answered the answer, who answered (`answeredBy`) and
when (`answeredAt`). The worktree that asked hears the answer once, on its
agent's next step (`gmod notice`); `gmod requests --all --job <id>` keeps it
readable for any fresh agent on the job until the job is done. There is no
blocking wait: a surface that runs headless workers (Skiff) restarts the
worker with the answer.

## 6. `setup --json` and `doctor --json`

For a person's surface (Skiff's Govern):

```
gmod setup --json [--runs-on <label>] [--reviewer …] [--managed] [--yes]
gmod doctor --json
```

- **`setup --json`** writes the CI workflow and `.gmod/protect.json`, a
  starter plan when main has none, and with `--managed` turns managed mode on,
  then opens its pull request. It prints one result: `steps` (each an `id`, a
  `status` of `done`, `skipped` or `failed`, and a `detail`), `pr` (`{ url }`),
  and `left`, what the person still does (a secret to add, say). `--managed`
  is the person's switch, as `gmod manage on` is: refused under an agent, and
  without a terminal it needs `--yes`. On a new repository it goes in setup's
  own pull request; on a governed one, the switch lands alone as its own
  decision.
- **`doctor --json`** keeps its `findings` and adds `checks`: `plan`,
  `managed`, `workflow` (and its gmod pin), `runner`, `reviewer`,
  `protection` and `installed`, each `ok`, `missing` or `differs`, with a
  one-line `fix` when not ok. Where a forge can't tell (a runner on GitLab),
  the check is `missing` and says so.

## 7. Fixtures

Recorded outputs live in `test/fixtures/v1/`: `signals-request.json` (an
agent's request and a stuck job, with their actions), `requests-answered.json`,
`doctor.json` and `setup.json`. They come from real runs, and gmod's tests fail
when what gmod prints drifts from their shape, so they are what a surface can
build against. Skiff copies them into its `crates/gmod-contract`.

## 8. Versioning

Protocol v1, additive only. New fields (`stamp`, `rev`, `shared`, `requests`,
`checks`, `left`) and new commands (`stamp`, `decide`, `ask`, `requests`,
`setup --json`, `doctor --json`) are added to v1; readers ignore fields and
commands they don't know, and ask `gmod capabilities --json` what this gmod
speaks. Protocol v2 is for a real break only: a field removed or its meaning
changed.

## Core or managed

The stamp, shared state, `decide`, stable ids, requests, resolve, rebrief,
`setup --json` and `doctor --json` are core: every surface, including the CLI
and the pane, uses them, and `decide` is the CLI form of decisions core
already has. Anything only a managed face needs (voyages, rules, packs) stays
behind managed mode (ADR 0001).
