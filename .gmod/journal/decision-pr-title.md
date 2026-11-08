# decision-pr-title: A decision's pull request is titled by its own commit

- 2026-11-08T22:21:44.252Z check: red (a plan change committed on top of an unlanded ADR commit opens its pull request titled with the plan commit's subject)
- 2026-11-08T22:21:50.996Z check: green
- 2026-11-08T22:22:06.398Z dev@soundheart.io: git log lists newest first, so subjects.at(-1) was the oldest commit past origin/main; a decision's branch can carry an earlier unlanded decision beneath it. Decisions now take subjects[0], the tip. Jobs keep their rule (their own "<job>:" commits). test/ci.test.mjs still passes.
