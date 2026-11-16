---
name: ci
description: Put gmod into a repository's CI (GitHub, GitLab or Gitea) - the gate, the AI reviewer, main's protection, landing on green, and optionally agents in CI - and prove it by landing the setup itself. Use when the person wants gmod in CI, to check or upgrade the pipeline, to change the reviewer, or to turn on agents in CI.
---

# gmod in CI

Run `gmod <command>` (the CLI on PATH):

- `setup` protects main, writes the CI file and `.gmod/protect.json`, lands them as one pull request, and waits for it: its landing is the proof.
- `doctor` says what's in place, each ✗ with the command that fixes it.
- `ci upgrade` opens a pull request moving the pinned gmod to its newest release.
- `runner up` (Gitea) starts a runner in Docker.

## 1. Find out, don't ask

- The forge comes from `origin`: github.com is GitHub, gitlab.com is GitLab, other hosts are Gitea (a self-hosted GitLab: `git config --global gmod.<host>.kind gitlab`).
- The forge's CLI must be signed in: `gh auth status`, `glab auth status`, or `tea logins list`. If not, the person signs in themselves.
- The repository needs a plan on main first; if it has none, plan with the plan skill.
- Run `doctor` first if gmod may already be set up.

## 2. Ask only these

1. **The reviewer:** Claude (an `ANTHROPIC_API_KEY` secret), any OpenAI-compatible API (`--reviewer-url`, `--reviewer-model`, its key as `GMOD_REVIEW_KEY`), a model on the runner itself (its URL, no key), or none.
2. **Blocking or advice?** Blocking (the default) stops the merge on a "fail"; a maintainer overrules with the `gmod-override` label. `--advice` only comments.
3. **Agents in CI?** `--agents <n>`: after each landing, agents take the jobs it made ready. Needs a `GMOD_AGENT_KEY` secret (an Anthropic API key, never a sign-in token).
4. **Gitea only, the runner:** an existing runner's label (`--runs-on <label>`), or start one with `runner up`. Starting a runner runs software on their machine: say so first.

Project dependencies the checks need go in `--setup '<commands>'` (e.g. `npm ci`).

## 3. Secrets are the person's

Never print a token, put one on a command line, or set a secret with a value you typed. Give the person the command, with the value piped in from their clipboard or a file:

```sh
pbpaste | tr -d ' \r\n' | gh secret set GMOD_REVIEW_KEY --repo owner/repo
```

## 4. Set it up, and prove it

```sh
gmod setup --reviewer-url https://api.deepseek.com/v1 --reviewer-model deepseek-flash
```

It's done when the last line says the governance pull request landed by itself. Then run `gmod doctor`: every line ✓. If it didn't land, read its checks (`gmod pr --status`, or the forge) and say what failed.

## Afterwards

Changing CI later is a pull request with only CI files in it. Run `gmod ci upgrade` now and then; `doctor` says when a newer gmod is out.
