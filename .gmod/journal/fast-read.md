# fast-read: Reading gmod stays fast with many worktrees

- 2026-11-08T18:33:23.968Z check: red (with 10 worktrees of landed jobs, gmod state --json --no-sync runs at most 25 git commands; state and signals print the same as before for a repository with landed, claimed and stuck worktrees; the existing test suite passes)
- 2026-11-08T18:39:34.078Z check: red (the existing test suite passes)
- 2026-11-08T18:42:13.130Z check: green
- 2026-11-08T18:42:22.055Z dev@soundheart.io: Leftover worktrees of landed jobs now skip the commit log, push check and movedFor (which returned null for them anyway); main and the done set are computed once per board and passed to movedFor; each worktree's git dir is looked up once per board (cache lives only during board()). Test world: 89 git calls before, under 25 after. Verified on the real ~/skiff and ~/gmod: state, signals and status --json --no-sync print byte-identical output before and after. Timings old→new: gmod state --no-sync 3.1s→0.8s, signals 3.6s→1.1s, state with sync 6.3s→2.9s; skiff state --no-sync 1.9s→0.4s. One suite run failed in commit-files.test.mjs on a local gpg signing error (Cannot allocate memory, from the global commit.gpgsign); the rerun passed, unrelated to this change.
- 2026-11-08T18:45:45.553Z check: green
