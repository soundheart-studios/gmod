# Agents, on your machine and in CI

| | On your machine | In CI (GitHub, GitLab, Gitea) |
|---|---|---|
| **Who starts it** | You: `/gmod:work` in Claude Code | CI: after each landing, and hourly, one agent per ready job; when an agent's pull request fails its checks; when a maintainer writes `@gmod` on it |
| **What you see** | The gmod pane: progress, **Needs you**, every job's dots; proposal cards to approve | The forge: pull requests, their checks and reviews, and an issue if a job gets stuck |
| **What runs** | Claude Code with the gmod plugin | The gmod action runs Claude Code headless, with the same plugin |
| **Its guardrails** | Live, while it works: it can't edit outside the job's files or commit without red then green | The same rules, held by the plugin in the runner and then by CI's gate |
| **Good for** | Planning with you, tricky jobs, watching it work | Working the plan while you're away |

Either way the work ends the same: a pull request, the gate, the review, and a merge on green. Jobs are claimed through git, so an agent on your laptop and one in CI never take the same job.

## Agents in CI

Turn them on with `gmod setup --agents 1` and a key, kept as the `GMOD_AGENT_KEY` secret: an Anthropic API key, or a Claude Code sign-in token from `claude setup-token`. The workflow gains two lines:

```yaml
          agent-key: ${{ secrets.GMOD_AGENT_KEY }}
          agents: 1
```

After each landing, and hourly, gmod counts the jobs that are ready and the ones agents already hold, and starts agents up to `agents`: on GitHub one run per job, on GitLab and Gitea one job in the run that follows the landing. Each run does one job, start to finish, exactly as an agent at a keyboard does: claim, a failing test, a passing one, `mcp__gmod__commit`. Its pull request is gated, reviewed and landed like any other, and that landing starts the agents for the jobs it made ready.

## When an agent's pull request fails, or you ask for a change

If the gate or the review fails an agent's pull request, an agent picks the job up on its branch, reads the reports, fixes it within the job's files, and pushes again. Its failing-first run comes from the proof: the job's tests, with its code put back, fail. At most two tries (`GMOD_FIX_TRIES`); then the job is reported stuck for a person.

Don't push commits to an agent's branch yourself: the gate holds a job's branch to commits by whoever claimed it, so the pull request can never land, and gmod reports the job stuck at once. Ask with `@gmod` instead, or close the pull request and delete its branch to have an agent start over.

Agents' pull requests land as soon as they pass. To ask for a change first, put the `gmod-hold` label on it: it's still checked, but lands only once the label comes off.

On GitHub and Gitea, a comment starting `@gmod` on an agent's pull request, from someone who can write to the repository, does the same with the comment as the brief: `@gmod also handle an empty list`. On GitLab, comments don't start pipelines, so there it's failed checks only.

An agent that can't finish lets the job go and opens a **gmod stuck** issue saying why. No agent takes that job again while the issue is open: close it to let one try again. An agent's hold on a job is let go once it has had no open pull request for an hour (its pull request was closed, or its run died). gmod never reopens work whose pull request a person closed.

Agents commit as `gmod agent`. Their pull requests come from a GitHub App, if you gave gmod one ([setup](setup.md#a-github-app)), else from GitHub's CI identity on GitHub, and from the person's token on GitLab and Gitea (a pull request opened with those forges' CI token starts no checks). On GitHub the repository must let Actions open pull requests; `gmod setup --agents` turns that on, and `gmod doctor` checks it.

## The pane

On your machine, the gmod pane (`/gmod`) shows progress, what **needs you**, and each job as a row of dots, one per step:

```
                  claim  test  commit  push  merge
▾ Post basics     2 of 3 · 1 in progress
  ✓ slugify         ●     ●      ●      ●      ●
  ◐ slug-unique     ●     ●      ○      ○      ○    agent 1
  ○ reading-time    ○     ○      ○      ○      ○
▸ Tags            after post-basics
```

The test dot turns **red** while failing and **green** once it passes after failing. It turns **amber** if a job passes without ever failing, or stops passing on today's `main`.
