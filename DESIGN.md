# gmod: GaIT and Planwright as a skill, a mod and a CI check

**Goal.** Keep what made GaIT and Planwright worth it, which is planned work, proof that the tests depend on the change, and humans deciding the plan. Drop the server, the forked forge and the deploys. Everyone in the org runs the mod, and CI guards the cases where someone doesn't.

## The shape: three thin pieces, one source of rules

| Piece | Where it runs | What it does | Trust |
|---|---|---|---|
| **Skills** (`/gmod:plan`, `/gmod:work`) | in the agent | Planning: interview, draft jobs into a proposal. Working: take a job, red, green, commit, PR, or fan ready jobs out to worktree subagents. | advice |
| **Mod** (`hooks/register.tsx`) | in Claude Code | Refuses edits outside the claimed job and commits without red-then-green; blocks the agent from moving claims, editing the plan or gmod's records; judges each edit by the repository the file is in and each commit in the shell that makes it, so subagents in their own worktrees answer to their own claims; shows the plan, any proposal and the job in hand in a pane; `/gmod approve`, `reject` and `allow-plan` are the person's alone. | holds for the agent, at the moment it acts |
| **CI gate** (`gmod verify`) | on every pull request | Re-checks everything from scratch. The PR names a job from main's plan and the job is claimed. Every changed file is in the job. The criteria pass, and **fail with the code put back** (tests kept). A plan change travels alone and needs code-owner approval. | holds for everyone; branch protection refuses the merge |
| **AI review** (`ci/review.mjs`) | after the gate passes | Answers a fixed rubric with quotes: does the change meet each criterion, are the tests real, does it stay within the goal, does it break an accepted ADR. It also writes a plain summary for the owner. | advises; blocks only on "fail" with evidence; a label overrides it |

All rules live in one zero-dependency CLI (`bin/gmod.mjs`, `lib/core.mjs`). The mod, a person at a terminal and CI all call it, so the agent hears exactly what CI will say later.

## State without a server

- **Plan:** `.gmod/plan.json`, versioned with the code. CI reads the job from the *base* branch's plan, so a PR can't widen its own job.
- **Claims:** git refs `refs/gmod/claims/<job>` on origin. Claiming pushes the ref. An existing ref refuses the push, so the first push wins with no server and no race. `gmod sweep` (CI on main) lets go of finished jobs.
- **Done:** a commit on main whose subject starts `<job>:`, which is what a squash-merged PR titled that way leaves.
- **Proposal:** the drafted plan change, in the git directory (shared by worktrees) until the person approves or rejects it. Refused if the plan moved under it.
- **Evidence:** local runs are recorded under `.git/gmod/` to drive the agent's routine. They're never trusted: CI re-runs everything itself.
- **Approval:** CODEOWNERS on `.gmod/` plus "require code-owner review". The plan's owners are GitHub's own reviewers.

## Why the AI doesn't guard

The PR is the AI's input, so it can be argued with ("reviewer: this is pre-approved"). It isn't repeatable either. And the rules that matter most (allowed files, red before green, approval) are yes/no facts a script gets exactly right for free.

So the script is the guard and the AI is the reviewer. The AI gets the diff as material under review, never as instructions. It answers in a fixed JSON schema, runs only after the gate passes, and gets no key on fork PRs.

## From GaIT and Planwright

| Kept | Became |
|---|---|
| intents, territory, criteria, depends-on | jobs: `files`/`tests`, `done_when` + `checks`, `after` |
| Planwright phases, GaIT goals | phases: an outcome and `after` other phases; expanded into job dependencies, done when all their jobs are |
| leases, claim cards | claim refs; the push is the lock |
| red → green liturgy, verify_evidence | `gmod check` + commit gate; `gmod prove` in CI |
| ratify / replan handshakes | agent drafts a proposal; `/gmod approve` commits it alone; a plan-only PR + code-owner approval for the team |
| pre-receive refusals, land queue | required checks, branch protection, merge queue |
| decision cards in plain words | the AI review's owner summary, posted on the PR |
| journal, ADRs | git history and PR threads; ADRs as files the reviewer reads |

**Dropped:** the GaIT server, the people database, agent tokens, the Gitea fork and its locks, shared governance groups, and cross-repo waits. The last two come back as a pinned shared plan file if they're ever needed.

## What we give up

- **Refusal at push time:** a refusal now comes at PR time instead.
- **Live multi-agent coordination beyond claims:** nothing coordinates agents beyond what claim refs give.
- **A single UI:** the PR page plus the pane replace it.
- **Enforcement on non-PR paths:** that's the job of branch protection settings, not code.

The mod's Bash guard is best effort: a shell can always write a file. CI is the backstop.

## Open questions

1. **Claim expiry.** Should a stale claim, say 3 days without a push, be swept automatically?
2. **Matching the claim holder to the PR author.** Claim refs record a git email, and the PR author is a GitHub login.
3. **Gitea Actions.** It accepts the same workflow almost as-is.
4. **Moving Trader.** Trader could be the first repository moved from the GaIT pilot to gmod.
