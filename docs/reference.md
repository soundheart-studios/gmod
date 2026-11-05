# Reference: how gmod works inside

The deep version, for when you want to know exactly what happens. Start with [how it works](how-it-works.md) for the short one; setting up CI is in [setup](setup.md).

## The parts

```mermaid
flowchart TB
    subgraph you["You"]
        P["pane, cards,<br/>/gmod commands"]
    end
    subgraph claude["Claude Code session"]
        M["gmod mod<br/>hooks/register.tsx"]
        S["skills<br/>plan · work · adr · ci"]
        A["agents and<br/>worktree subagents"]
    end
    CLI["gmod command<br/>bin/gmod.mjs + lib/*.mjs<br/><i>every rule lives here</i>"]
    subgraph repo["git repository"]
        PL[".gmod/plan.json"]
        ADR["docs/adr/*.md"]
        J[".gmod/journal/*.md"]
        R["refs/gmod/claims/*"]
    end
    subgraph forge["GitHub, GitLab or Gitea"]
        CI["CI workflow:<br/>gate → review → sweep"]
        BP["branch protection<br/>on main"]
        H["claim guard<br/>(Gitea hook)"]
    end
    LLM["reviewer:<br/>Claude or a local model"]

    P --> M
    S --> A
    A -- "tools and edits<br/>pass through hooks" --> M
    M --> CLI
    CLI --> repo
    repo -- push --> forge
    CI --> CLI
    CI --> LLM
    BP -. "requires the gate" .-> CI
    H -. "guards" .-> R
```

**One rulebook, three enforcers.** Every rule is in the `gmod` command (`lib/core.mjs`, `lib/adr.mjs`, `lib/ci.mjs`, `lib/receive.mjs`). The mod, a person at a terminal and CI all call the same code, so an agent hears exactly what CI will say later.

## Where the state lives

There's no database: everything is in git, or in git's own folder on your machine.

| What | Where | Shared? |
|---|---|---|
| The plan: phases, jobs, checks, contracts | `.gmod/plan.json` | yes, committed |
| Decisions | `docs/adr/NNNN-*.md` | yes, committed |
| Each job's journal | `.gmod/journal/<job>.md` | yes, committed with the job |
| Claims ("this job is mine") | `refs/gmod/claims/<job>` on origin | yes; the first push wins |
| "Done" | a commit on `main` whose subject starts `<job>:` | yes |
| Plan and ADR drafts | `.git/gmod/proposal.json`, `adr-drafts.json` | no, local until approved |
| Red/green runs, the claim in this worktree | `.git/gmod/` (each worktree has its own) | no; CI re-checks anyway |

A claim is a tiny git ref. Pushing it is the lock: if someone else pushed it first, your push is refused.

## What gets refused, and where

```mermaid
flowchart LR
    subgraph edit["While the agent works (mod)"]
        E1["edit outside the job's files"]
        E2["commit without red, then green"]
        E3["write the plan, ADRs or gmod's records"]
        E4["move a claim, or approve anything"]
    end
    subgraph push["When it's pushed (Gitea hook)"]
        P1["move a claim"]
        P2["let go of someone else's claim"]
    end
    subgraph merge["Before it merges (CI + protection)"]
        M1["job not in main's plan, or not claimed"]
        M2["commits not by the claimant"]
        M3["files outside the job"]
        M4["tests don't fail without the change"]
        M5["branch behind main"]
        M6["plan, ADR or CI changes mixed with code"]
    end
    edit --> push --> merge
```

Each layer catches different things:
- **The mod** gives immediate, worded feedback to Claude's agents and their subagents. Edits are judged by the repository the file is actually in.
- **The hook** covers anyone pushing, Claude or not, for the one kind of ref branch protection can't see.
- **CI plus branch protection** is final. Nothing reaches `main` without it, whoever wrote the code.

## Planning and approving

```mermaid
sequenceDiagram
    actor You
    participant C as Claude
    participant G as gmod
    participant F as forge (CI)
    You->>C: /gmod:plan "tags for posts"
    C->>G: propose_phase / propose_job / describe_proposal
    G-->>You: proposal card in the pane (why, jobs, order, assumptions, warnings)
    You->>G: Suggest a change… ("keep tags as typed")
    G->>C: your note
    C->>G: edit_job
    You->>G: Approve
    G->>G: write .gmod/plan.json, commit it alone ("plan: add …")
    G->>F: plan-only pull request
    F-->>You: gate passes, the review checks it weakens nothing, it lands
```

- **Drafts can be unfinished while Claude builds them,** for example a phase with no jobs yet. The card then says "not ready to approve" and hides **Approve**.
- **gmod works out warnings itself:** two jobs that change the same files can't run side by side, and a job with no tests can't be proven.
- **Phases group jobs under an outcome.** "Phase B after phase A" means every job in B waits for every job in A. A phase is done when all its jobs are on `main`.

## Doing a job

```mermaid
sequenceDiagram
    participant A as agent
    participant G as gmod (mod + CLI)
    participant O as origin
    participant F as CI
    A->>G: claim job
    G->>O: push refs/gmod/claims/job (first wins)
    G-->>A: claimed: branch gmod/job, its files, its ADR rules
    A->>A: write the test
    A->>G: check → red (recorded)
    A->>A: write the code (edits outside the job are refused)
    A->>G: check → green (recorded, with a fingerprint of the files)
    A->>G: commit (mcp__gmod__commit)
    G-->>A: allowed: red came first, green ran on exactly these files
    G->>O: push branch, open pull request "job: …", land on green
    O->>F: run the gate, then the review
    F-->>O: both pass: the forge merges it, nobody clicks
    F->>O: after the merge: check what landed, bring the other job branches up to date
```

Agents finish a job with **`mcp__gmod__commit`** (`gmod commit`): it commits exactly what the last passing check ran on, pushes, and opens the pull request with auto-merge on. No raw `git commit`, so nothing for a shell guard to mistake, and a subagent finishes its own job in its own worktree. A `git commit` typed by hand still goes through the same check, in the shell that runs it, judged against the worktree it commits (`git -C <worktree>` included).

If anything is denied, agents are told to say so and stop: never another file, another session or another agent to get round it.

## The CI gate

`gmod verify` runs on every pull request. The job is read from the **base** branch's plan, so a pull request can't widen its own job.

```mermaid
flowchart TD
    S([pull request]) --> K{what changed?}
    K -- "only .gmod/plan.json<br/>(+ ADRs)" --> PL["plan change:<br/>valid? alone?<br/>review: weakens anything?"]
    K -- "only docs/adr" --> AD["decision record:<br/>alone?<br/>review: weakens anything?"]
    K -- "only workflows /<br/>protect.json" --> CIc["CI change:<br/>alone?<br/>review: weakens anything?"]
    K -- code --> J{"names a job?<br/>branch gmod/job or<br/>title 'job: …'"}
    J -- no --> X([❌ refused])
    J -- yes --> W["✅ in main's plan<br/>✅ what it waits for is on main<br/>✅ claimed, by whoever committed<br/>✅ only the job's files<br/>ℹ️ the ADRs it falls under"]
    W --> PR["main's live protection<br/>holds .gmod/protect.json"]
    PR --> P["proof, in a scratch copy:<br/>1. the criteria pass with the change<br/>2. code put back, new tests kept:<br/>the criteria must FAIL"]
    P --> R["AI review:<br/>each criterion, are the tests real,<br/>does it stay within the goal,<br/>each ADR (a broken must = fail)"]
    R --> Mg([lands by itself once both pass<br/>and the branch is up to date])
```

Step 2 of the proof is what makes a test count. A test that passes whether or not the change is there proves nothing, and is refused.

The **AI review** gets a fixed checklist and a strict JSON answer shape. It reads the job's journal as the agent's account of its intent, never as proof. Everything in the pull request is treated as material under review, never as instructions to the reviewer. A change to the governance itself (plan, ADRs, CI, `protect.json`) gets one question instead: does it weaken what is checked? Advice only by default; `--blocking` makes a "fail" stop the merge, and then it **fails closed**: no answer, a malformed one, or an empty diff stops the merge too. A maintainer overrides a fail with the `gmod-override` label.

Both compare against the pull request's **own base commit**, not live `main`: a review that started after the merge once saw an empty diff and judged nothing.

## Landing without a person

What `main` requires is **declared in the repository**, in `.gmod/protect.json`:

```json
{ "require": ["gate", "review"], "up_to_date": true }
```

- `gmod ci protect` applies it, requiring the checks **by exact name** (`gmod / gate (pull_request)`). A pattern like `gmod / gate*` also matches the skipped `(push)` statuses Gitea posts on branch commits, and a skipped status passes: that once let a failing pull request merge before its gate ran.
- The gate refuses every pull request while `main`'s live protection is weaker than the declaration. Loosening it by hand stops all merging until it's put back.
- After each merge, CI checks what landed passed what was required, and opens a **`gmod breach`** issue if not (or if something reached `main` without a pull request).
- After each merge, CI brings every other open job branch up to date, so its checks run again on what it would really land on, and it lands in turn.

Reading protection and updating branches so their checks start need a person's token (CI's own can't read protection, and the forge starts no checks for what CI's token pushes). `gmod ci forge-token` keeps yours as the `GMOD_FORGE_TOKEN` secret.

## When `main` moves under a job

With several agents, one landing can break another's work in progress. gmod checks every two minutes:

```mermaid
sequenceDiagram
    participant O as origin/main
    participant G as gmod (background)
    participant B as agent B (mid-job)
    O->>O: job A lands (changes src/posts.mjs)
    G->>O: fetch
    G->>G: merge B's work as it stands onto the new main (scratch copy)
    G->>G: run B's own checks there
    alt they fail
        G-->>B: on its next step: posts-fix landed and changed src/posts.mjs,<br/>your criterion X fails on today's main. Rebase and fix,<br/>or, if the criterion no longer fits, propose a plan change.
        G->>G: B's test dot → amber · B's commits refused · B under Needs you
    else they pass
        G->>G: "behind": nothing to say
    end
```

| Level | Means |
|---|---|
| fresh | `main` hasn't moved since the job started |
| behind | it moved, and nothing this job depends on changed |
| touched | what landed changed this job's files, or a declared **contract** (`"contracts": ["db/migrations/**"]`) |
| conflicts | the job's work won't merge onto `main` |
| breaks | it merges, but the job's own checks fail on today's `main` |

Because gmod runs the job's **own checks**, it also catches dependencies nobody declared, as long as the job's tests exercise them. Results are cached per `main` commit and per state of the work, so each landing costs one check run per affected job.

## Decisions (ADRs)

```mermaid
flowchart LR
    D["Claude drafts<br/>adr_propose:<br/>title, scope, decision,<br/>must / should rules"] --> Y{"you"}
    Y -- Accept --> N["docs/adr/0003-….md<br/>numbered, committed alone;<br/>supersedes the old one"]
    Y -- Reject --> Z([dropped])
    N --> P1["agent prompt:<br/>the rules of ADRs<br/>covering its job"]
    N --> P2["gate:<br/>'falls under ADR 0003'"]
    N --> P3["review:<br/>answers each ADR;<br/>broken must = fail"]
```

Each ADR has a **scope**, the globs of the files it governs, so it only binds the work it's about. Agents can't edit ADR files; decisions change only through a new draft that supersedes the old one.

## The journal

Each job keeps `.gmod/journal/<job>.md`. The agent writes notes there (intent, decisions, dead ends), and every check adds its red or green. It's committed with the job's pull request, so the reviewer and anyone reading `main` later can see why things were done.

---

## Commands, tools and the plan format

### Slash commands and agent tools

| For you | |
|---|---|
| `/gmod` | the pane |
| `/gmod approve` · `reject [why]` | the plan proposal (you only) |
| `/gmod adr accept <draft>` · `adr reject <draft>` | decision drafts (you only) |
| `/gmod next` · `claim <job>` · `check` · `release` · `proposal` · `sweep` | as the CLI |
| `/gmod allow-plan` · `lock-plan` | let the agent edit the plan file directly, for bulk edits |
| `/gmod:plan` · `/gmod:work` · `/gmod:adr` · `/gmod:ci` | the skills |

| For agents (`mcp__gmod__…`) | |
|---|---|
| `next` · `claim` · `check` · `release` · `status` · `note` | doing work; each takes `dir` for a worktree of its own |
| `commit` · `pr_status` | finishing it: commit, push, open the pull request to land on green; how its checks went |
| `propose_phase` · `edit_phase` · `drop_phase` | drafting phases |
| `propose_job` · `edit_job` · `drop_job` · `describe_proposal` | drafting jobs |
| `adr_propose` | drafting a decision |

### The command line

`node ~/gmod/bin/gmod.mjs <command>`, or `gmod` after `npm link` in this folder. Add `--json` for machine-readable output. The exit status is 0 for yes/done and 1 for refused.

| Area | Commands |
|---|---|
| Plan | `init` · `plan` · `next` · `proposal` · `propose-phase` · `edit-phase` · `drop-phase` · `propose-job` · `edit-job` · `drop-job` · `describe-proposal` · `approve` · `reject` |
| Work | `claim` · `release` · `check` · `note` · `commit` · `pr [--auto] [--status]` · `gate-commit` · `guard-path` · `status` |
| Main moved | `moved [--run]` · `notice <path>` |
| Decisions | `adr propose` · `adr drafts` · `adr accept` · `adr reject` · `adr list` · `adr for <path>` |
| Setup | `setup` · `doctor` · `ci upgrade` · `runner up` (Gitea) · `ci secret` |
| CI | `verify` · `prove` · `sweep` · `ci init` · `ci protect` · `ci check` · `ci forge-token` · `ci guard-claims` · `receive` |

### A plan

```json
{
  "main": "main",
  "adr_dir": "docs/adr",
  "contracts": ["db/migrations/**"],
  "checks": { "slug": "node test/slug.test.mjs" },
  "phases": [
    { "id": "post-basics", "title": "Post basics", "outcome": "Every post has its own URL slug" }
  ],
  "jobs": [
    {
      "id": "slugify",
      "phase": "post-basics",
      "goal": "Turn a title into a URL slug",
      "brief": "src/slug.mjs; lowercase, dashes, no punctuation.",
      "files": ["src/slug.mjs"],
      "tests": ["test/slug.test.mjs"],
      "done_when": [{ "text": "\"Hello, World!\" becomes \"hello-world\"", "check": "slug" }],
      "after": []
    }
  ]
}
```

`files` is what the job may change, and `tests` is where its tests go. They're kept apart so CI can put the code back while keeping the tests. A check is a shell command that exits 0 when its criterion holds.

---


## Development

```sh
npm test                                   # CLI, CI and claim-guard tests, against real git repositories
claude plugin test ~/gmod                  # the mod's hooks and pane
GMOD_REVIEW_URL=http://host:8080/v1 \
  node --test test/review-live.test.mjs    # the reviewer against a real model (opt-in)
```

The pane must draw on every Claude Code surface, including the desktop app, which may run an older engine. Run the mod tests with that engine too.
