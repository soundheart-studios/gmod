# Security

## Reporting a problem

Please don't open a public issue. Write to **dev@soundheart.io** with what you found and how to reproduce it. You'll hear back within a week.

Especially welcome: a way to land code on `main` without passing the gate, to make an agent act outside its job, to get a secret out of CI, or to make the review pass a change it should fail.

## What gmod guards, and what it doesn't

gmod's guarantees and their limits are written down in [Limits, honestly](docs/limits.md). In short: CI's gate is the hard guarantee, the AI review is a judgement, and agents in CI belong in repositories you control.

## Keys

gmod never stores a key of its own. Reviewer and agent keys live in your forge's CI secrets, set with your forge's CLI (`gmod ci secret` pipes the value in; it never takes one on the command line). Agents in CI run only on an Anthropic API key, never on a person's Claude sign-in.
