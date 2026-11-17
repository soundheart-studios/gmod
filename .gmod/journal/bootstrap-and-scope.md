# bootstrap-and-scope: Guards don't block starting a repo or other repos

- 2026-11-17T06:31:06.922Z check: red (the commit gate allows the first commit of a repository with no commits yet, and still refuses an unclaimed commit after that; writing .gmod/plan.json is refused in a governed repository and allowed in one with no committed plan, judged by where the path resolves)
- 2026-11-17T06:35:44.157Z check: green
- 2026-11-17T06:36:03.009Z dev@soundheart.io: The governed test for the plan lives in core.guardPath (a plan is refused only when committed on HEAD, via new planCommitted), so the Write/Edit guard, gmod guard-path, the Claude Bash hook and the Codex hook all share it. register.tsx imports planTargets straight from lib/shell.mjs because hooks/shell.ts is outside this job's files. A plan target refused for a reason other than the plan rule (e.g. a not-yet-existing nested path inside a governed repo) is refused with guard-path's own reason.
