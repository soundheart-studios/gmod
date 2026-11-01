---
name: ci
description: Put gmod's gate and AI reviewer into a repository's CI (GitHub Actions or Gitea Actions), protect main so nothing merges unproven, and prove it with a real pull request. Use when the person wants gmod in CI, to set up or check the pipeline, or to change the reviewer.
---

# gmod in CI

Three commands do the mechanical parts; you do the conversation and the proof.

- `node <gmod>/bin/gmod.mjs ci init …` writes the workflow (and CODEOWNERS) for the repository's forge.
- `… ci protect` makes main require the gate on up-to-date branches, with no direct pushes.
- `… ci check` says what's in place and what's missing: workflow, protection, runner, reviewer.

`<gmod>` is the gmod folder this skill came from.

## 1. Find out, don't ask

Read `git remote get-url origin`: github.com is GitHub; anything else is treated as Gitea. For a Gitea reached over ssh, its web address isn't in the URL: ask for it once (e.g. `http://ai.local:3000`) and pass `--url`.

The repository needs a `.gmod/plan.json` first; if it has none, plan with `/gmod:plan`.

## 2. Ask only these

1. **The reviewer:**
   - Claude: needs an `ANTHROPIC_API_KEY` secret in the repository.
   - A local model: its OpenAI-compatible `/v1` address, as the runner sees it, e.g. `http://127.0.0.1:8080/v1`.
   - None: the gate alone.
2. **Advice or a blocker?** Start with advice (comment only) unless they say otherwise; `--blocking` makes a "fail" fail the job. A maintainer overrides with the `gmod-override` label.
3. **Where jobs run:**
   - GitHub's hosted runners (the default), with gmod checked out from a pinned repository (`--gmod-repo owner/gmod@v0.2.0`).
   - A self-hosted runner, by its label (`--runs-on <label>`). If gmod is installed on that machine, `--gmod-home <path>`.
4. **Plan owners,** for CODEOWNERS on `.gmod/` (`--owners @alice,@team`). Teams want this; solo repositories can skip it.

## 3. Set it up

```sh
node <gmod>/bin/gmod.mjs ci init --reviewer local --review-url http://127.0.0.1:8080/v1 --runs-on ai-local --gmod-home /home/me/gmod
```

Commit what it wrote **before** protecting main: once protected, the workflow itself can only change through a pull request. Push it, then:

```sh
node <gmod>/bin/gmod.mjs ci protect                       # GitHub: through gh
node <gmod>/bin/gmod.mjs ci protect --token-file <file>    # Gitea: a token of a repository admin
node <gmod>/bin/gmod.mjs ci check   --token-file <file>
```

Never print a token or put one in a command line; read it from a file the person names.

If `check` reports no runner, give the person the command to register one (`gitea-runner register --labels <label>:host`, or the repository's GitHub settings). Installing a runner downloads and runs software on their machine: that is theirs to run.

## 4. Prove it

A pipeline isn't set up until it has run. Take a small ready job (or ask the person for one), do it through `/gmod:work`, push it and open its pull request. Then watch:

- the gate's comment: every line ✅, ending "the criteria fail with the code put back";
- the review's comment;
- the pull request mergeable only once the gate is green.

Report what ran, how long it took, and anything that didn't.

## Afterwards

- Changing the workflow later goes through a pull request like any other change. Plan a job that owns `.github/**` or `.gitea/**` for it.
- For teams: a pull request runs its own copy of the workflow, so it could weaken the gate it's checked by. Put the workflow folder under CODEOWNERS and require their review.
