# gmod in Codex

gmod works in OpenAI's Codex as well as in Claude Code. The agent works the same way: it claims a job, stays in the job's files, makes the job's check fail and then pass, and commits. CI holds the work to the same gate. One thing changes: Codex has no pane, so you see the plan as text and make your decisions in a terminal of your own.

## Install

1. Put the `gmod` CLI on your `PATH`. The plugin runs `gmod mcp` and `gmod hook codex` from there. Clone gmod and run `npm link` in its folder, or install the released CLI.
2. Add gmod's marketplace, then the plugin:

   ```
   codex plugin marketplace add soundheart-studios/gmod
   codex plugin add gmod@gmod
   ```

   `marketplace add` also takes the path of a local gmod checkout. The marketplace is `.agents/plugins/marketplace.json`, and it points to the plugin in `./codex`.
3. Trust the hooks. Codex skips a plugin's hooks until you have looked at them and trusted them, so open `/hooks` in Codex, read gmod's hooks and trust them. For a single run you can pass `--dangerously-bypass-hook-trust` instead. After each gmod upgrade the hooks have to be trusted again.

You don't need to approve gmod's tools one by one. `codex/mcp.json` sets `"default_tools_approval_mode": "approve"` for the gmod server. The tools enforce their own rules, and none of them decides anything for you.

In a repository without `.gmod/plan.json`, gmod adds nothing to the session and refuses nothing.

## What the hooks do

| Event | What gmod does |
|---|---|
| `PreToolUse` on `Bash` | Applies the same shell rules as Claude Code: claims move only through claim and release, pull requests aren't merged by hand, the plan and gmod's records aren't written from the shell, a commit runs on its own, and `git commit` runs only past the commit gate |
| `PreToolUse` on `apply_patch` | Refuses a patch that adds, changes, deletes or moves a file outside the claimed job's files |
| `SessionStart` | Gives the agent gmod's routine, the job it holds (or the next ready one), and anything waiting for you |
| `SubagentStart` | Gives a subagent the routine for working in its own worktree |
| `PostToolUse` | Passes on what `gmod notice` has to say: main moved, you answered a request, or a shell command wrote files outside the job |

All of these run `gmod hook codex`. If the hook itself fails, for example because `gmod` isn't on `PATH`, the tool call is blocked, not let through.

## The same as in Claude Code

- **The tools.** `mcp__gmod__next`, `claim`, `check`, `commit`, `pr_status`, `release`, `status`, `note`, `ask`, the proposal tools and `adr_propose` are all there, served by `gmod mcp`. Codex also gets `mcp__gmod__board`.
- **The refusals.** The rules come from the same code (`lib/shell.mjs`, `lib/core.mjs`) and use the same words. A denied call is reported, and the agent stops there.
- **Red, then green.** The agent runs `mcp__gmod__check` while the check fails, then again once it passes. `mcp__gmod__commit` commits exactly what the passing check ran on, as `<job>: …`, pushes it and opens the pull request. If origin is a plain path and not a forge gmod knows, it commits and pushes, and says the branch is ready.
- **CI.** The gate, the review and landing on green don't depend on which agent did the work.

## What differs

- **No pane.** You see the plan as text. `gmod board` prints every phase and job with its steps, then any plan proposal or decision card waiting for you, each with the exact `gmod decide` commands. The agent's `mcp__gmod__board` tool shows the same. When the agent drafts a plan change (`mcp__gmod__propose_job` and the others) or a decision (`mcp__gmod__adr_propose`), the tool's result ends with that card so it can show it to you.
- **You decide in a terminal of your own.** Run `gmod watch` in a second terminal or a tmux split. It is a live view of the board and any waiting card: you move over jobs and signals, open one, and approve, ask for changes or reject from there. Or run what the card prints:

  ```
  gmod decide <id> approve --rev <rev>
  gmod decide <id> ask-changes --note "…"
  gmod decide <id> reject
  ```

  `--rev` is the revision you read, so a proposal that changed since then is refused. Agents can never decide: `gmod decide`, and `gmod watch` too, refuse under an agent's environment, and that includes Codex.
- **No `/gmod allow-plan`.** Codex has no slash commands, so a governed repository's `.gmod/plan.json` is always refused from the agent. Plans change only through a proposal that you approve.
- **A hook is a guardrail, not the hard line.** A `PreToolUse` hook catches mistakes while the agent works, but only if it is trusted and `gmod` is on `PATH`. CI's gate is the hard line: it proves every pull request again, whatever happened on the machine that made it.

## Running Codex headless

`codex exec` waits on stdin while stdin is open, so close it:

```
codex exec "Take the next ready gmod job and finish it with proof" < /dev/null
```

Hooks still need to be trusted, or the run needs `--dangerously-bypass-hook-trust`.

More on what this can and can't promise: [Limits, honestly](limits.md#codex).
