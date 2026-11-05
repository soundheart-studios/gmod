# Agents, on your machine and in CI

| | On your machine | In CI (GitHub) |
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

After each landing, gmod counts the jobs that are ready, and the claims agents already hold, and starts one run per job up to `agents`. Each run does one job, start to finish, exactly as an agent at a keyboard does: claim, a failing test, a passing one, `mcp__gmod__commit`. Its pull request is gated, reviewed and landed like any other, and that landing starts the agents for the jobs it made ready.

An agent that can't finish lets the job go and opens a **gmod stuck** issue saying why. No agent takes that job again while the issue is open: close it to let one try again. Agents commit as `gmod agent`, and their pull requests come from the forge's own CI identity, not yours.

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
