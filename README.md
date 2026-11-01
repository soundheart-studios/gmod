# gmod

Planned work with proof, on plain git. A Claude Code mod, one small CLI, and a CI gate with an AI reviewer. No server.

- **The plan** is `.gmod/plan.json` in the repository: jobs with a goal, the files each may change, and "done when" criteria that name a check command. Bigger plans group jobs into **phases**, each with an outcome and ordered after other phases: every job of a phase waits for every job of the phases before it.
- **The mod** keeps an agent honest while it works: it claims a job before editing, changes only that job's files, records a failing run before a passing one, and commits only what passed. A pane and the status line show where the job stands.
- **CI** keeps everyone honest, mod or not. It checks the pull request names a claimed job, stays in its files, and that its tests pass with the change and **fail without it**. Then an AI reviewer reads the change against the job, its tests and the accepted ADRs.

See [DESIGN.md](DESIGN.md) for the why.

## Try it

```sh
cd <a repository>
claude --plugin-dir ~/gmod
```

| You type | What happens |
|---|---|
| `/gmod:plan` (+ what you want built) | Claude interviews you and drafts jobs into a **proposal**; the pane shows it beside the plan (`+` new, `~` changed, `−` dropped) |
| **Approve** · **Ask for changes…** · **Reject** on the pane's proposal card (or `/gmod approve` · `/gmod reject [why]`) | Your decision, and only yours: approve commits `.gmod/plan.json` alone (`plan: add …`); asking sends your note to Claude; reject drops the draft. The card shows why, each job, before → after, the order, Claude's assumptions and warnings. |
| `/gmod:work` (or just "do the next job") | Claude claims a job, writes a failing test, makes it pass, commits `<job>: …` |
| "work the ready jobs in parallel" | One subagent per job, each in its own worktree with its own claim, held to its own files |
| `/gmod` | The pane: progress, **Needs you** (the proposal card, red jobs), and every job on its stage track (claim → red → green → commit → push → merge), across every worktree. Press a row to open it. |
| `/gmod next` · `claim <job>` · `check` · `release` · `proposal` · `sweep` | The same as the CLI |
| `/gmod allow-plan` · `lock-plan` | Let the agent edit `.gmod/plan.json` directly (bulk edits), then lock it again |

Agent tools: `mcp__gmod__next`, `claim`, `check`, `release`, `status` for work; `propose_phase`, `edit_phase`, `drop_phase`, `propose_job`, `edit_job`, `drop_job`, `describe_proposal` for drafting. Each work tool takes an optional `dir` for a subagent in its own worktree.

At a terminal, the same CLI: `node ~/gmod/bin/gmod.mjs plan | next | claim <job> | check | release | proposal | approve | reject` (`npm link` here puts `gmod` on your PATH).

**What the mod refuses, for the main agent and every subagent:** edits outside the claimed job's files (judged by the repository the file is in); a `git commit` without a failing check first and a passing one on exactly what's committed (checked in the shell that commits); writing `.gmod/plan.json` or gmod's records; moving claims; approving or rejecting the plan.

## CI

`/gmod:ci` sets it up and proves it with a real pull request. Underneath, three commands:

```sh
gmod ci init --reviewer claude --gmod-repo your-org/gmod@v0.2.0          # GitHub, hosted runners
gmod ci init --reviewer local --review-url http://127.0.0.1:8080/v1 \
             --runs-on ai-local --gmod-home /home/me/gmod                  # Gitea, a self-hosted runner
gmod ci protect [--token-file <gitea token>]   # require the gate on up-to-date branches; no direct pushes
gmod ci check   [--token-file <gitea token>]   # workflow, protection, runner, reviewer: what's missing
```

The review starts as advice (`--blocking` makes it a gate); a maintainer overrides a fail with the `gmod-override` label. `--owners @a,@b` writes CODEOWNERS for `.gmod/`. Commit the workflow before protecting main.

## Tests

```sh
npm test                        # the CLI, end to end, against real git repositories
claude plugin test ~/gmod       # the mod's hooks
```
