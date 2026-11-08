# commit-alone: A commit bundled with file changes is refused

- 2026-11-08T15:58:21.176Z check: red (a command that runs git commit and also anything but cd and quiet git (an edit, eval, sh -c, a function) is refused before it runs; a commit with git add, cd, a heredoc message or 2>&1 still runs exactly as written)
- 2026-11-08T15:58:31.475Z check: green
- 2026-11-08T15:58:36.050Z dev@soundheart.io: Carried over unchanged from gmod/bash-hook-no-rewrite (PR #23, refused: that job was already done on main when #17 landed early). Red with the tests alone (commitsAlone missing), green with hooks/shell.ts and hooks/register.tsx brought over.
