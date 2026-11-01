---
name: work
description: Do planned work in a repository governed by gmod (.gmod/plan.json) - take a job, stay in its files, prove it fails then passes, commit, open the pull request; or fan several ready jobs out to subagents. Use whenever .gmod/plan.json exists and there is work to do.
---

# Working a gmod plan

The plan is `.gmod/plan.json`: jobs, each with a goal, the files it may change (`files`, `tests`), what "done" means (`done_when`, each criterion naming a `check` command), and the jobs it waits for (`after`). A job is done once a commit on main starts with `<job>:`.

## One job

1. **Take work.** `mcp__gmod__next`, then `mcp__gmod__claim` with that job. The claim is a git ref on origin: if someone else holds it, take another. Claiming switches to branch `gmod/<job>` when the worktree is clean.
2. **Read the job.** `mcp__gmod__status` gives the goal, the files you may change and the criteria. Edits outside them are refused; don't look for ways around that. If the job needs a file it doesn't list, stop and say so: draft the change with `mcp__gmod__edit_job` and let the person approve it.
3. **Red.** Write or change the tests for the criteria, then `mcp__gmod__check`. It must fail. A check that passes before the code changed proves nothing.
4. **Green.** Change the code until `mcp__gmod__check` passes.
5. **Commit.** `git add -A && git commit -m "<job>: <what changed, plainly>"`. The commit is refused unless a red was recorded and the last green ran on exactly these files.
6. **Hand over.** Push the branch (`git push -u origin gmod/<job>`), then `gmod pr`: it opens the pull request, titled by your `<job>:` commit, with the journal in it (or answers with the one already open). If it says a token is missing, tell the person it goes in `~/.config/gmod/gitea-token`; never ask them to paste it. CI re-runs the criteria, puts the code back to main's while keeping your tests, and requires them to fail then; an AI reviewer reads the change against the job. Fix what they find and repeat 3–5. Without a forge (a local origin), say the branch is ready to merge.

## Several jobs at once

When the person asks for parallel work, or several jobs are ready and independent:

1. `mcp__gmod__status` and pick ready jobs whose `files` don't overlap. Never two jobs that touch the same files.
2. Spawn one subagent per job **with `isolation: "worktree"`**, in one message so they run together. Tell each: which job, that it works in its own worktree and passes that folder as `dir` to every `mcp__gmod__` tool, and to follow "One job" above up to the commit.
3. Each subagent claims its own job in its own worktree; the mod holds each to its own job's files and its own red-then-green.
4. When they report back, check each branch exists with a `<job>:` commit, then open the pull requests (or report the branches).

## The plan itself

Don't write `.gmod/plan.json`. Changes go through a proposal (`mcp__gmod__propose_job`, `edit_job`, `drop_job`) that the person approves with `/gmod approve`. Use the plan skill (`/gmod:plan`) for real planning.
