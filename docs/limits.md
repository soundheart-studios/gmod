# Limits, honestly

## What the checks can't promise

- **A test proves the code does what the test says, not that the test asks the right thing.** Whoever writes the code, a person or an agent, also writes its test. The gate proves the test depends on the change; only the AI review, and you, judge whether it's the right test.
- **Reviews are as good as the model.** Smaller models fail good work more often, and may pass weak work. `gmod-override` is for the first; for the second, read what lands, and prefer a stronger reviewer for code that matters.
- **Agents in CI can be steered by what they read.** They read the repository, the plan, and `@gmod` comments from people who can write to it. They can't change the plan, the rules or CI, and everything they write passes the same gate and review, but treat a repository with untrusted content accordingly.

## Public repositories and forks

- **Pull requests from forks get no secrets.** A blocking review has no key, so it fails closed and the pull request waits for a maintainer (`gmod-override`) or a branch in the repository itself.
- **Agents in CI belong in repositories you control.** Keep `agents` off where outsiders can open issues or comment, or keep `@gmod` to people who can write (it already is).

## How it runs

- **Agents act as someone.** On your machine, as you. In CI they commit as `gmod agent`; their pull requests come from the gmod App on GitHub if you made one, else GitHub's CI identity, and from a person's token on GitLab and Gitea.
- **Agents in CI run on an Anthropic API key,** never a person's Claude sign-in; without one, CI only checks.
- **Agents in CI cost model time,** whether or not they succeed. They're capped: at most `agents` at once, two tries to fix a failed pull request, then a stuck issue; no agent takes that job again until a person closes it.
- **An agent stops when it's refused.** It never looks for another way round; the job waits as stuck, for a person or another agent.
- **`@gmod` works on agents' own pull requests,** on GitHub and Gitea. It doesn't plan: plan changes are always a person's yes. GitLab has no comment-started pipelines, so there agents only fix failed checks.
- **A pull request runs its own copy of the workflow.** Changing it is a governance pull request, and the review checks it weakens nothing. Owners can also be required through CODEOWNERS.
- **No merge queue yet.** GitHub's needs an organization, GitLab's merge trains need Premium. gmod brings branches up to date itself instead. On GitLab, two merge requests can still land in the same second; gmod then runs every finished job's checks on `main` as merged, and opens a breach issue if they fail.
- **One repository per plan.**

## Not yet proven live

Built and unit-tested, but not yet seen working end to end: agents fixing their own failed pull requests and answering `@gmod` on **Gitea**, and fixing them on **GitLab**; a self-hosted GitLab.
