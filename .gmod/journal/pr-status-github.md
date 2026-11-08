# pr-status-github: pr --status works on GitHub

- 2026-11-08T06:03:58.716Z check: red (pr --status on a GitHub repo reports the checks and both reports from recorded gh output)
- 2026-11-08T06:06:31.903Z check: green
- 2026-11-08T06:06:38.391Z dev@soundheart.io: GitHub path uses one `gh pr view <branch> --repo o/r --json number,url,state,statusCheckRollup,comments`; check runs named "<workflow> / <job>" (as protection names them), states mapped to Gitea's words so the CLI's icons work; latest run per check and latest report per marker win. Smoke-checked against the real PR #5 (all five checks and both reports shown). GitLab left with its message (now pointing at glab mr view).
