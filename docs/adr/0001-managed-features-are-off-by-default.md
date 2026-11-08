---
id: 0001
title: Managed features are off by default
status: accepted
scope: lib/**, bin/**, hooks/**, ci/**
date: 2026-11-08
---

## Context

Faces like Skiff need features (voyages, requests, decide, packs) most gmod users without a face would never use. Shipping them to everyone adds surface and risk for no gain.

## Decision

Face-driven features live behind a per-repository managed mode, recorded in .gmod/managed.json and switched only by a person. Core gmod (plan, claim, check, commit, gate, review, pane, and read-only JSON such as state and signals) stays the same whether or not a repository is managed.

## Rules
- must: A managed feature does nothing, adds no commands to the pane and changes no file format unless .gmod/managed.json says managed: true
- must: With managed mode off, behaviour is identical to before the feature existed; the existing test suite proves it
- must: Only a person turns managed mode on or off, as a decision commit
- should: Read-only views of what gmod already knows (state, signals) belong to core, not managed mode
