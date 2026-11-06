# How gmod works

- **A plan** is a list of small **jobs**. Each says what it achieves, which files it may touch, and the check that proves it's done.
- **Rules** (architecture decision records, ADRs) bind every job they cover. The AI review holds each pull request to them.
- **Every job proves itself:** its check fails before the change and passes after. CI proves it again on its own, an AI reviewer reads it (if you have one), and then it merges on green.
- **You only approve.** Plans and rules are yours. Everything after is agents and CI.

## A job's life

![A job's life: ready in the plan you approved; an agent claims it, writes a failing test, makes it pass in the job's files only, and may only then commit; CI's gate proves it again and the review checks the tests are real; it lands on main by itself, and the jobs after it become ready](assets/gmod-job.png)

You and an agent go through the same steps and the same checks. A job that fails, stalls or is abandoned gets a **gmod stuck** issue for a person.

## One rulebook, three enforcers

![One rulebook, checked three times: while an agent works, the plugin stops edits outside the job's files, commits without red then green, and writing the plan or rules, approving or merging by hand; before it merges, CI and protection stop jobs not in the plan or not claimed, files outside the job, tests that pass without the change, rule or CI changes mixed with code, and anything that weakens what is checked; after it lands, CI opens a gmod breach or gmod stuck issue](assets/gmod-guards.png)

Every rule lives in the `gmod` command. The plugin calls it while agents work, you can call it from a terminal, and CI calls it on every pull request, so an agent hears exactly what CI will say later.

CI is the final word: nothing reaches `main` without passing it, whoever wrote the code. And `main`'s protection must stay at least as strong as `.gmod/protect.json` declares; loosen it by hand and nothing merges until it's put back.

## Everything is git

The plan, rules and journals are files. A claim is a tiny ref, `refs/gmod/claims/<job>`, and pushing it is the lock: the first push wins. A job is done when a commit starting `<job>:` is on `main`. Red and green runs stay on your machine; CI proves the work again anyway.

## Proof, not trust

CI takes the job's tests from the branch, puts the old code back, and checks they fail; then checks they pass on the new code. A test that never failed proves nothing.

What this can't prove is that the test is the *right* test: whoever writes the code also writes its test. That's what the AI review is for, and why plans name what each job must do in plain words.

## What's in your repository

```
.gmod/plan.json        the plan: phases, jobs, their files and checks
docs/adr/              the rules you accepted
.gmod/protect.json     what main requires: {"require": ["gate", "review"]}
.gmod/journal/         each job's notes, read by the reviewer
.github/workflows/gmod.yml   (or .gitlab-ci.yml, or .gitea/workflows/gmod.yml)
```
