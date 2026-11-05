# gmod

**You say yes twice. Agents ship the rest.**

Plan your work with Claude. Agents build it, prove it works, and land it on `main`, working beside you or on their own in CI.

![gmod in four steps: you approve the plan and its rules; agents build each job, its test failing first and then passing; CI proves it again and an AI reviewer checks the tests are real; green work lands on main by itself](docs/assets/gmod-overview.png)

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

Claude drafts the plan and you approve it. Then connect your CI:

```
/gmod:ci
```

That's it. Every job lands by itself once it's proven. Do the work with Claude (`/gmod:work`), or let agents in CI take each job as the one before it lands.

## Two ways to run it in CI

| | **Checks only** (the default) | **Checks and agents** |
|---|---|---|
| CI | gates, reviews and lands every pull request | the same, and agents build the ready jobs |
| You need | a reviewer: Claude, any OpenAI-compatible model (DeepSeek, one you host), or none | also an Anthropic API key, as the `GMOD_AGENT_KEY` secret |
| Set up with | `gmod setup` | `gmod setup --agents 1` |

Claude sign-in tokens are never used in CI. How to set up each, and how agents are kept in check: [setting up a repository](docs/setup.md#two-ways-to-run-gmod-in-ci).

## Why gmod

- **Proof, not promises.** Every job's test fails before the change and passes after. CI proves it again, and an AI reviews it.
- **Nothing waits on you.** Work lands on green. You only approve the plan and the rules.
- **Works with what you have.** GitHub, GitLab or Gitea. Claude, DeepSeek, or a model you host.

## Learn more

- [How it works](docs/how-it-works.md)
- [Agents, on your machine and in CI](docs/agents.md)
- [Setting up a repository](docs/setup.md)
- [Day to day](docs/day-to-day.md)
- [Commands](docs/commands.md)
- [Limits, honestly](docs/limits.md)
- [Reference: how it works inside](docs/reference.md)
- [Notes for later](docs/notes/)

## License

MIT, © 2026 Soundheart Studios. See [LICENSE](LICENSE).
