# commit-only-job-files: gmod commit stages only the job's own files

- 2026-11-08T05:56:00.688Z check: red (a nested git repository in the worktree is not committed; an untracked file outside the job is not committed; a file deleted or renamed inside the job is still committed)
- 2026-11-08T05:56:49.351Z check: red (a nested git repository in the worktree is not committed; an untracked file outside the job is not committed; a file deleted or renamed inside the job is still committed)
- 2026-11-08T05:57:44.289Z check: green
- 2026-11-08T06:01:15.994Z dev@soundheart.io: commitJob now stages only the job's paths (tracked changes vs HEAD with --no-renames, plus untracked files, filtered to the job's files/tests and its journal, directories/nested repos skipped) and commits them with --only, so other index content stays uncommitted. fingerprint drops gitlinks that HEAD doesn't track, so a nested agent worktree moving on doesn't invalidate a green check. npm test: 90/90 pass.
