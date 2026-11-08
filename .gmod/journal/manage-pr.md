# manage-pr: gmod manage on/off opens its own pull request

- 2026-11-08T20:16:41.318Z check: green
- 2026-11-08T20:17:04.168Z check: red (publishing a managed-mode switch opens a pull request titled by its commit)
- 2026-11-08T20:17:25.772Z check: green
- 2026-11-08T20:23:22.762Z dev@soundheart.io: Red reproduced the real refusal seen on skiff (`no commit on gmod/managed-on-… starts with "managed-on-…:"`). Fix: prKind returns 'managed' for a branch that changes MANAGED_SWITCH, so openPr names no job and uses the commit's title; prKind has no other caller, and the gate's own switch check is untouched. Full suite locally: 142 pass; 'a file deleted or renamed inside the job is still committed' failed once in the full run and passed alone (the same flaky global commit.gpgsign failure seen in fast-read).
