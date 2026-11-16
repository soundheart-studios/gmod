---
id: 0003
title: Hosts are adapters; the rules live in lib
status: accepted
scope: lib/**, bin/**, hooks/**, codex/**
date: 2026-11-16
---

## Context

gmod is moving from Claude Code alone to OpenAI Codex too. Codex has command hooks (PreToolUse can deny Bash and apply_patch calls; SessionStart, SubagentStart and PostToolUse can add context), MCP servers and skills, but no way for a plugin to draw a pane or register a slash command. Until now the shell rules lived in hooks/shell.ts, which only Claude Code's engine can load, and the agent's tools were registered only by the mod. Considered: a Codex fork of the mod (two copies of every rule, drifting apart); waiting for Codex to offer UI (blocks the work indefinitely); a host-neutral core with thin adapters per host (chosen).

## Decision

Every rule that decides what an agent may do (the file guard, the shell rules, the commit gate, who may decide) lives in lib/ as plain JavaScript and is reached through the gmod command. Each host is a thin adapter: Claude Code's mod (hooks/), and Codex's plugin (codex/: an MCP server from `gmod mcp`, command hooks running `gmod hook codex`, and its own skills). The agent's tools have the same names and inputs on every host, from one list. Where a host has no pane, a person sees the plan, phases and proposals as text (lib/render.mjs: `gmod board`, the card a tool returns, `gmod watch`) and decides in a terminal of their own through `gmod decide`; an agent never decides on any host.

## Rules
- must: A rule about what an agent may do is implemented once, in lib/, and a host adapter (hooks/, codex/) only calls it; an adapter never re-implements or loosens a rule
- must: The agent's tools have one list of names and input schemas (lib/mcp.mjs), and the Claude Code mod registers no tool missing from it or named differently
- must: On a host without a pane, approving, rejecting or accepting goes only through gmod decide (or gmod watch, which calls it), run by the person; no adapter adds a way for an agent to decide
- must: A host hook that fails on a tool call blocks that call rather than letting it through
- should: Text views of the plan come from lib/render.mjs, so the board, a proposal card and gmod watch look the same wherever they are shown
- should: Each host's real event payloads are recorded as fixtures under test/fixtures/<host>/ and its adapter is tested against them
