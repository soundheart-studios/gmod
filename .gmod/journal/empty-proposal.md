# empty-proposal: No empty plan proposals, and a clear word if one exists

- 2026-11-08T22:23:04.140Z check: red (describing with no proposal pending is refused and creates no proposal; approving a proposal that changes nothing is refused in plain words and commits nothing; an empty proposal is not ready, so its signal offers no approve)
- 2026-11-08T22:23:38.270Z check: green
- 2026-11-08T22:28:01.052Z dev@soundheart.io: Reproduced the person's error exactly ("git commit -q -m plan: no changes … nothing to commit"). "Changes nothing" compares the proposal's plan with the plan on disk, keys sorted, so a job proposed again unchanged counts as empty however its keys were ordered. describeProposal now reads the pending proposal instead of draft(), which started one. Full suite: 147/149 locally, the one failure a gpg "Cannot allocate memory" signing flake in ci-change-job, which passes on rerun.
