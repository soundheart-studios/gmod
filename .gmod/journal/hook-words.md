# hook-words: The hook refuses git and gmod commands, not text

- 2026-11-09T04:33:48.908Z check: red (text that mentions the shared refs with push, tag or replace (sed text, a heredoc, a comment, git ls-remote) runs; git push, update-ref, branch -D, tag or replace on them is still refused, also through sh -c; backticks or $(...) naming a gmod decision inside a quoted heredoc body run; inside an unquoted heredoc or sh <<EOF they are still refused)
- 2026-11-09T04:34:23.424Z check: green
- 2026-11-09T04:34:30.023Z dev@soundheart.io: movesClaims now reads word by word like decision(): git (with -C) update-ref/push/tag/replace/branch -D with a refs/gmod/ argument, also through sh -c, eval, xargs, $(…) and a shell's heredoc; a shell reading from a pipe keeps the old mention rule. A quoted heredoc is kept as `<<'DELIM…` by lists(), and decision()/movesClaims skip $(…)/backticks in it. commitsAlone is unchanged.
