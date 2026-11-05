# Agents, on your machine and in CI

| | On your machine | In CI (GitHub, GitLab, Gitea) |
|---|---|---|
| **Who starts it** | You: `/gmod:work` in Claude Code | CI: after each landing, and hourly, one agent per ready job |
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

An agent that can't finish lets the job go and opens a **gmod stuck** issue saying why. No agent takes that job again while the issue is open: close it to let one try again. An agent's hold on a job is let go once it has had no open pull request for an hour (its pull request was closed, or its run died). gmod never reopens work whose pull request a person closed.

Agents commit as `gmod agent`. Their pull requests come from GitHub's CI identity on GitHub, and from the person's token on GitLab and Gitea (a pull request opened with those forges' CI token starts no checks). On GitHub the repository must let Actions open pull requests; `gmod setup --agents` turns that on, and `gmod doctor` checks it.

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
