---
name: ci
description: Put gmod into a repository's CI (GitHub, GitLab or Gitea) - the gate, the AI reviewer, main's protection, landing on green, and optionally agents in CI - and prove it by landing the setup itself. Use when the person wants gmod in CI, to check or upgrade the pipeline, to change the reviewer, or to turn on agents in CI.
---

# gmod in CI

`<gmod>` is the gmod folder this skill came from; run `node <gmod>/bin/gmod.mjs <command>`.

- `setup` protects main, writes the CI file and `.gmod/protect.json`, lands them as one pull request, and waits for it: its landing is the proof.
- `doctor` says what's in place, each ✗ with the command that fixes it.
- `ci upgrade` opens a pull request moving the pinned gmod to its newest release.
- `runner up` (Gitea) starts a runner in Docker.

## 1. Find out, don't ask

- The forge comes from `origin`: github.com is GitHub, gitlab.com is GitLab, other hosts are Gitea (a self-hosted GitLab: `git config --global gmod.<host>.kind gitlab`). For a Gitea reached over ssh: `git config --global gmod.<host>.url http://host:port`.
- The forge's CLI must be signed in: `gh auth status`, `glab auth status`, or `tea logins list`. If not, the person runs `gh auth login` / `glab auth login` / `tea login add` themselves.
- The repository needs a plan on main first; if it has none, plan with `/gmod:plan`.
- Run `doctor` first if gmod may already be set up.

## 2. Ask only these

1. **The reviewer:** Claude (an `ANTHROPIC_API_KEY` secret), any OpenAI-compatible API such as DeepSeek (`--reviewer-url`, `--reviewer-model`, its key as `GMOD_REVIEW_KEY`), a model on the runner itself (its URL, e.g. `http://127.0.0.1:8080/v1`, no key), or none.
2. **Blocking or advice?** Blocking (the default): a "fail", or a reviewer that can't answer, stops the merge; a maintainer overrules with the `gmod-override` label. `--advice`: it only comments.
3. **Agents in CI?** (GitHub, GitLab, Gitea) `--agents <n>`: after each landing, agents take the jobs it made ready, at most `n` at once, fix their own failed pull requests, and act on `@gmod` comments (GitHub and Gitea). Needs a `GMOD_AGENT_KEY` secret: an Anthropic API key from console.anthropic.com. Never a Claude sign-in token (`claude setup-token`): gmod refuses one. Without agents, CI only checks, and the work happens on the person's machine.
4. **Gitea only, the runner:** an existing runner's label (`--runs-on <label>`), or start one with `runner up` (`DOCKER_HOST=ssh://user@host` for another machine). Starting a runner runs software on their machine: say so first.

Project dependencies the checks need go in `--setup '<commands>'` (e.g. `npm ci`).

## 3. Secrets are the person's

Never print a token, put one on a command line, or set a secret with a value you typed. Give the person the command, with the value piped in from their clipboard or a file:

```sh
pbpaste | tr -d ' \r\n' | gh secret set GMOD_REVIEW_KEY --repo owner/repo
pbpaste | tr -d ' \r\n' | glab variable set GMOD_REVIEW_KEY --masked -R group/project
```

On GitLab, gmod's jobs also need `GMOD_GITLAB_TOKEN`: a personal access token with `api` and `write_repository`. On Gitea, `setup` sets `GMOD_FORGE_TOKEN` from the tea login itself. `setup` stops before opening anything when one is missing and names it.

## 4. Set it up, and prove it

```sh
node <gmod>/bin/gmod.mjs setup --reviewer-url https://api.deepseek.com/v1 --reviewer-model deepseek-flash
```

It's done when the last line says the governance pull request landed by itself. Then run `doctor`: every line ✓. Report what ran and how long it took. If it didn't land, its checks say why: read them (`gmod pr --status`, or the forge) and say what failed.

## Afterwards

- Changing CI later is a pull request with only CI files in it; the gate passes it as a governance change and the review checks it weakens nothing. Mixed with code, it's refused.
- `ci upgrade` now and then; `doctor` says when a newer gmod is out.
