---
id: 0002
title: What gmod shares and what stays local
status: accepted
scope: lib/**, bin/**, hooks/**, ci/**
date: 2026-11-08
---

## Context

Up to 1.6.2 the plan proposal and ADR drafts live in <git-common-dir>/gmod and check results in each worktree's git dir. None of them moves a git ref, so background surfaces (Skiff) miss new proposals, drafts and jobs turning red, and no other machine, teammate or Linear can ever see them. Claims already solved this: they are refs under refs/gmod/claims, pushed to the remote, where the push is the lock. Considered: keeping everything local and adding a sync service (another moving part, and a second source of truth); committing drafts to a branch (pollutes history, needs merges); publishing everything including full run evidence (a push per check, and evidence is bound to one worktree's files). ADR 0001 lists "decide" among managed features; that meant face-only decision flows, not the person's existing approve, reject and accept, which every surface needs.

## Decision

What a person decides on, and what tells them a job is red, is published as refs under refs/gmod/ on the remote, the way claims are: the plan proposal at refs/gmod/proposal, each ADR draft at refs/gmod/adr-drafts/<slug>, and each job's latest check verdict at refs/gmod/runs/<job>. Full run evidence, the worktree's claim binding and caches stay local. A change stamp in the common git dir moves on every gmod write and, with the tips of main and refs/gmod/*, gives surfaces one value to watch. gmod decide <signal-id> <action> is the one action command for proposals and ADR drafts; it records who decided and through which surface, and refuses under an agent. The stamp, shared state, decide and stable signal ids are core contract, used by every surface including the CLI and pane, not managed features; anything only Skiff needs stays behind managed mode (ADR 0001). The protocol stays v1 with additive fields.

## Rules
- must: The plan proposal, ADR drafts and each job's latest check verdict are stored as refs under refs/gmod/ and pushed to origin when there is one; a repository without a remote keeps working locally as before
- must: The gate and the reviewer never read refs/gmod/runs/* or treat a shared verdict as proof; every pull request is proven again in CI
- must: Full run evidence, the worktree's claim binding (claim.json) and caches (moved, told) stay in the worktree's git dir and are never pushed
- must: Every gmod write that a signal or state depends on (proposal, ADR drafts, check runs, claims, its own ref syncs) moves the change stamp
- must: A signal's id is a hash of its cause only, never of the clone, worktree, machine or time it was computed; the same cause gives the same id everywhere
- must: Approving, rejecting or asking changes on a proposal, and accepting or rejecting an ADR, from any surface other than the pane go through gmod decide, which refuses under gmod's agent identity or an agent's environment, and every decision commit carries Decided-By and Decided-Via trailers
- must: Protocol v1 changes are additive: no field or command is removed or changes meaning without protocol v2
- should: Publishing a shared ref is best effort for check verdicts (a failed push never fails a check) and compare-and-swap for the proposal (a lost race re-reads and retries the edit, never overwrites)
- should: A feature only Skiff or another single surface needs goes behind managed mode (ADR 0001), not into this contract
