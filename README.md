# gmod

**You set the plan and the rules. Agents do the rest.**

> **Beta.** gmod is new, and we're excited to share it early. The core works and is proven on GitHub, GitLab and Gitea; some paths are still young. Read [the limits](docs/limits.md), and [tell us what breaks](https://github.com/soundheart-studios/gmod/issues).

Plan your work with Claude. Agents build it, prove it works, and land it on `main`, working beside you or on their own in CI.

![Why gmod. AI writes code fast; gmod makes sure it's right. With AI agents on their own, you're the safety net: you read every change or merge and hope, tests pass whether the code works or not, two agents' work collides and main breaks, and nothing moves unless you're there to merge. With gmod, the system is the safety net: you approve the plan once and agents do the jobs, every test must fail first and then pass, CI proves it all again so main stays green, and work lands while you're away; you hear when it's stuck](docs/assets/gmod-why.png)

- **Proof, not promises.** Every job's test fails before the change and passes after. CI proves it again, and an AI reviews it.
- **Nothing waits on you.** Work lands on green. You only approve the plan and the rules.
- **Works with what you have.** GitHub, GitLab or Gitea. Claude, DeepSeek, or a model you host.

## How it works

![gmod in four steps: you set the plan and the rules; agents build each job, its test failing first and then passing; CI proves it again and an AI reviewer checks the tests are real; green work lands on main by itself](docs/assets/gmod-overview.png)

## The plan and the rules matter most

![You set the plan and the rules; everything after enforces them. The plan: small jobs, the files each may touch, done-when criteria each proven by a command, and the order. The rules: a data format, a boundary, a library or a security rule, with must and should. From then on, agents get only their job, its files and the rules that cover them, the gate proves the criteria, the review answers each rule, and agents can't change the plan or the rules](docs/assets/gmod-plan.png)

Everything after enforces the plan and the rules you set, nothing more. The gate proves exactly the criteria in the plan, so a vague criterion gets you vaguely proven work, and a rule you never wrote is never enforced. Take the planning session seriously, and settle the rules that shape everything (data formats, boundaries, libraries, security) before agents start. How: [planning and rules](docs/planning.md).

## Install

In Claude Code:

```
/plugin marketplace add soundheart-studios/gmod
/plugin install gmod@gmod
```

Once per machine. From then on gmod is there in every project you open, and quiet in projects without a plan.

## Ship your first job

Open Claude Code in your project and say what you want:

```
/gmod:plan  a blog with tags and reading time
```

Claude interviews you and drafts the plan; you read its assumptions and approve it ([how to plan well](docs/planning.md)). Then connect your CI:

```
/gmod:ci
```

That's it. Every job lands by itself once it's proven. Do the work with Claude (`/gmod:work`), or let agents in CI take each job as the one before it lands.

## What CI does

![What CI does: 1. the gate, always on and with no AI, proves every pull request again; 2. the review, optional, has Claude or any OpenAI-compatible model judge the change; then it lands on main by itself. 3. Agents, optional, are Claude Code on an Anthropic API key: they build ready jobs, fix their own failed checks and answer @gmod, and their pull requests pass the same gate and review](docs/assets/gmod-ci.png)

1. **Gate**, always on, no AI: the job's test fails without the change and passes with it, only the job's files changed, and `main` stays protected.
2. **Review**, optional: Claude, or any OpenAI-compatible model (DeepSeek, one you host), judges the change. It never writes code.
3. **Agents**, optional: Claude Code works the plan in CI, on an Anthropic API key. Its pull requests pass the same gate and review as yours.

| You want | Run |
|---|---|
| Gate and review; you build on your machine | `gmod setup` (Claude reviews), or `gmod setup --reviewer-url <url> --reviewer-model <model>` |
| Gate only | `gmod setup --reviewer none` |
| All of it, agents included | `gmod setup --agents 1`, with an Anthropic API key as the `GMOD_AGENT_KEY` secret |

Agents in CI always use an API key, never a person's Claude sign-in. More: [setting up a repository](docs/setup.md#what-ci-does).

## Learn more

- [How it works](docs/how-it-works.md)
- [Planning and rules: where your judgment goes](docs/planning.md)
- [Agents, on your machine and in CI](docs/agents.md)
- [Setting up a repository](docs/setup.md)
- [Day to day](docs/day-to-day.md)
- [Commands](docs/commands.md)
- [Limits, honestly](docs/limits.md)
- [Reference: how it works inside](docs/reference.md)
- [Notes for later](docs/notes/)

## License

MIT, © 2026 Soundheart Studios. See [LICENSE](LICENSE). To report a security problem: [SECURITY.md](SECURITY.md).
