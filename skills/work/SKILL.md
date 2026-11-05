---
name: work
description: Do planned work in a repository governed by gmod (.gmod/plan.json) - take a job, stay in its files, prove it fails then passes, and finish it with mcp__gmod__commit, which lands it once CI passes; or fan several ready jobs out to subagents. Use whenever .gmod/plan.json exists and there is work to do.
---

# Working a gmod plan

The plan is `.gmod/plan.json`: jobs, each with a goal, the files it may change (`files`, `tests`), what "done" means (`done_when`, each criterion naming a `check` command), and the jobs it waits for (`after`). A job is done once a commit on main starts with `<job>:`.

## One job

1. **Take work.** `mcp__gmod__next`, then `mcp__gmod__claim` with that job. The claim is a git ref on origin: if someone else holds it, take another. Claiming switches to branch `gmod/<job>` when the worktree is clean.
2. **Read the job.** `mcp__gmod__status` gives the goal, the files you may change and the criteria. Edits outside them are refused; don't look for ways around that. If the job needs a file it doesn't list, stop and say so: draft the change with `mcp__gmod__edit_job` and let the person approve it.
3. **Red.** Write or change the tests for the criteria, then `mcp__gmod__check`. It must fail. A check that passes before the code changed proves nothing.
4. **Green.** Change the code until `mcp__gmod__check` passes.
5. **Finish it.** `mcp__gmod__commit` with a plain message of what changed (and your Co-Authored-By line as a trailer). It commits exactly what the last green ran on as `<job>: …`, pushes the branch, and opens the pull request, which lands by itself once CI passes: the gate re-runs the criteria, proves they fail with the code put back and your tests kept, and holds main's protection to `.gmod/protect.json`; the AI review reads the change against the job and its ADRs and can block. Don't run `git commit` or merge anything yourself.
6. **Follow it.** `mcp__gmod__pr_status` shows the checks and both reports. If something failed, fix it, check again (red is already recorded; green on the new files), and `mcp__gmod__commit` again: the open pull request takes the new commit. If main moves first, CI brings your branch up to date and the checks run again by themselves.

**If anything is denied** (by gmod, auto mode or a hook), don't look for another way to do the same thing: no other file, no other session, no asking another agent or the person to do it for you, no settings changes. Say exactly what was denied and stop.

The forge's CLI login (`gh`, `glab`, or `tea`) is what gmod uses; never ask the person to paste a token. Without a forge (a local origin), `mcp__gmod__commit` still commits and pushes; say the branch is ready.

## Several jobs at once

When the person asks for parallel work, or several jobs are ready and independent:

1. `mcp__gmod__status` and pick ready jobs whose `files` don't overlap. Never two jobs that touch the same files.
2. Spawn one subagent per job **with `isolation: "worktree"`**, in one message so they run together. Tell each: which job, that it works in its own worktree and passes that folder as `dir` to every `mcp__gmod__` tool, and to follow "One job" above to the end, its own `mcp__gmod__commit` included.
3. Each subagent claims its own job in its own worktree; the mod holds each to its own job's files and its own red-then-green.
4. When they report back, `mcp__gmod__pr_status` with each worktree as `dir` says where each pull request stands. Don't commit, push or open pull requests for them: a subagent that couldn't finish reports why, and that is the answer. Their pull requests land one after another as CI brings each up to date.

## The plan itself

Don't write `.gmod/plan.json`. Changes go through a proposal (`mcp__gmod__propose_job`, `edit_job`, `drop_job`) that the person approves with `/gmod approve`. Use the plan skill (`/gmod:plan`) for real planning.
