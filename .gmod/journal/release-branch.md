# release-branch: A released job's branch doesn't block the next claim

- 2026-11-09T04:46:30.309Z check: red (after release in a clean worktree, the job's branch is no longer checked out there, and is deleted when it has no commits; a branch with commits or uncommitted work stays; claiming a job whose branch is checked out in another worktree names that worktree and how to free it)
- 2026-11-09T04:47:00.897Z check: green
- 2026-11-09T04:50:23.143Z dev@soundheart.io: release (of this worktree's own claim) steps off gmod/<job> when the worktree is clean and the branch has no commits beyond main: switch to main, or detach at main's tip when main is checked out elsewhere, then delete the branch. Otherwise it leaves both and says why in the result's note (shown with --json; the CLI's text line is in bin/, outside this job). claim refuses before taking the lock when gmod/<job> is checked out in another worktree, naming it with the switch --detach and worktree remove fixes.
