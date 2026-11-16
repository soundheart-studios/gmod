---
name: adr
description: Record an architecture decision for a gmod repository - draft it with the person, scope it to the files it governs, write its must and should rules, and leave the yes to them. Use when a decision is made or changed that later work must follow (a data format, a boundary, a library, a rule), or when the person asks for an ADR.
---

# Decisions with gmod

An ADR is a decision agents must follow from now on. Once the person accepts it:
- it binds every job whose files its **scope** covers;
- the agent working such a job is told its rules;
- CI lists it on the pull request, and the reviewer answers it. Breaking a **must** is a fail.

## Drafting

Ask, briefly:
1. **What was decided,** in a few sentences, and **why**: the context, what else was considered.
2. **What it governs:** file globs (`src/db/**`). Empty means the whole repository; prefer a real scope.
3. **The rules.** Each is a `must` (never broken; a violation fails review) or a `should` (departing needs a stated reason). Write them so a reviewer can check them against a diff.
4. **What it replaces,** if anything: an earlier ADR's id.

Then draft it with `mcp__gmod__adr_propose` (`title`, `scope`, `context`, `decision`, `rules`, `supersedes`). Show the person the decision card the tool returned (or `mcp__gmod__board`), and tell them they accept or reject it in a terminal of their own with `gmod watch` (a live board; coming in 1.9) or `gmod decide <signal-id> <action>` (the card prints the exact commands).

Never accept or reject one yourself, and never edit files under the ADR folder (`docs/adr` unless the plan says otherwise): they change only through drafts.

## When a job runs into one

If a job can't be done without breaking a `must`, stop and say so: the decision changes first, through a new ADR that supersedes it. Don't work around it in code.
