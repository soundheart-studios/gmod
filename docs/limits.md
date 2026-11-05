# Limits, honestly

- **Agents act as someone.** On your machine, as you. In CI they commit as `gmod agent`, but their pull requests come from GitHub's CI identity, or from a person's token on GitLab and Gitea. A bot account or GitHub App would give them their own ([notes](notes/ci-token-ghost-runs.md)).
- **Agents in CI start after landings and hourly.** They don't yet pick up failed checks or `@gmod` mentions.
- **A pull request runs its own copy of the workflow.** Changing it is a governance pull request, and the review checks it weakens nothing. Owners can also be required through CODEOWNERS.
- **Reviews are as good as the model.** Smaller models fail good work more often; that's what `gmod-override` is for.
- **No merge queue yet.** GitHub's needs an organization, GitLab's merge trains need Premium. gmod brings branches up to date itself instead. On GitLab, two merge requests can still land in the same second; gmod then runs every finished job's checks on `main` as merged, and opens a breach issue if they fail.
- **Agents in CI cost model time,** whether or not they succeed. They're capped: at most `agents` at once, one try per job until a person closes its stuck issue.
- **An agent stops when it's refused.** It never looks for another way round; the job waits as stuck, for a person or another agent.
- **One repository per plan.**
