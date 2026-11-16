---
name: work
description: Do planned work in a repository governed by gmod (.gmod/plan.json) - take a job, stay in its files, prove it fails then passes, and finish it with mcp__gmod__commit, which lands it once CI passes. Use whenever .gmod/plan.json exists and there is work to do.
---

# Working a gmod plan

The plan is `.gmod/plan.json`: jobs, each with a goal, the files it may change (`files`, `tests`), what "done" means (`done_when`, each criterion naming a `check` command), and the jobs it waits for (`after`). A job is done once a commit on main starts with `<job>:`.

## One job

1. **Take work.** `mcp__gmod__next`, then `mcp__gmod__claim` with that job. The claim is a git ref on origin: if someone else holds it, take another. Claiming switches to branch `gmod/<job>` when the worktree is clean.
2. **Read the job.** `mcp__gmod__status` gives the goal, the files you may change and the criteria. Edits outside them are refused; don't look for ways around that. If the job needs a file it doesn't list, stop and say so: draft the change with `mcp__gmod__edit_job` for the person to decide.
3. **Red.** Write or change the tests for the criteria, then `mcp__gmod__check`. It must fail. A check that passes before the code changed proves nothing.
4. **Green.** Change the code until `mcp__gmod__check` passes.
5. **Finish it.** `mcp__gmod__commit` with a plain message of what changed (and any Co-Authored-By line as a trailer). It commits exactly what the last green ran on as `<job>: …`, pushes the branch, and opens the pull request, which lands by itself once CI passes. Don't run `git commit` or merge anything yourself.
6. **Follow it.** `mcp__gmod__pr_status` shows the checks and the gate's and review's reports. If something failed, fix it, check again (red is already recorded), and `mcp__gmod__commit` again: the open pull request takes the new commit.

Use `mcp__gmod__note` for decisions and dead ends the reviewer should see, and `mcp__gmod__ask` when only the person can answer.

**If anything is denied** (by gmod, a hook or the sandbox), don't look for another way to do the same thing: no other file, no other session, no asking another agent or the person to do it for you, no settings changes. Say exactly what was denied and stop.

The forge's CLI login (`gh`, `glab`, or `tea`) is what gmod uses; never ask the person to paste a token.

## Several jobs at once

Use one Codex session per git worktree, one job each. Pick ready jobs whose `files` don't overlap, and in each session pass that worktree's folder as `dir` to every `mcp__gmod__` tool. Each session claims, checks and commits its own job; never commit or push for another.

## The plan itself

Don't write `.gmod/plan.json`. Changes go through a proposal (`mcp__gmod__propose_job`, `edit_job`, `drop_job`) that the person decides: show them the card the tool returned, and tell them they decide in a terminal of their own with `gmod watch` (a live board; coming in 1.9) or `gmod decide <signal-id> <action>` (the card prints the exact commands).
