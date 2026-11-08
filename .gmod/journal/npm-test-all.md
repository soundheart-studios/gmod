# npm-test-all: npm test runs every test file

- 2026-11-08T07:23:34.220Z check: red (npm test's script covers every test/*.test.mjs)
- 2026-11-08T07:38:23.627Z check: red (npm test's script covers every test/*.test.mjs)
- 2026-11-08T07:45:38.449Z check: green
- 2026-11-08T07:45:43.935Z dev@soundheart.io: npm test now runs `node --test test/*.test.mjs` (sh expands the glob, so it works on Node 20 too). review-live is included; it skips itself without a key. test/suite.test.mjs fails if any test/*.test.mjs isn't covered by the script's words. Full suite: 116 tests, 115 pass, 1 skipped (review-live), ~2 min. The first recorded red was only the missing test file (Write was blocked by auto mode); a genuine red was recorded after the file existed.
- 2026-11-08T08:06:35.156Z check: green
- 2026-11-08T08:06:40.591Z dev@soundheart.io: Gate refused the first commit: in the action ANTHROPIC_API_KEY (the reviewer's key) is in the environment, so review-live ran against a real model inside the "suite" check and failed (0 skipped there, 1 failed). npm test now clears ANTHROPIC_API_KEY and GMOD_REVIEW_URL, so live tests run only when invoked directly (as review-live's header says); suite.test.mjs asserts it. Verified with ANTHROPIC_API_KEY=x npm test: 116 pass, review-live skipped.
- 2026-11-08T08:42:59.169Z check: green
- 2026-11-08T08:43:04.778Z dev@soundheart.io: Second gate run: still 1 failure in "the whole suite passes", review-live skipped this time, so it wasn't the cause. Locally (fresh worktree, no node_modules, empty HOME, GitHub env vars) the whole suite passes; "next, claim and the race for a claim" failed once under full parallel load and then passed — a flake candidate, not confirmed as the CI failure. The gate only shows the tail of the output and TAP ends with counts, so npm test now uses --test-reporter=spec, whose tail lists the failing tests and their errors.
- 2026-11-08T15:01:09.994Z dev@soundheart.io: Third gate run (with the spec reporter) showed the real failure: 'a plan can start from nothing' in test/cli.test.mjs sets user.email but no user.name, and the gate's runner has no global git identity ("empty ident name (for <o@x.io>) not allowed"). Gave it user.name too, as the brief asked.
- 2026-11-08T15:02:59.412Z check: red (the whole suite passes)
- 2026-11-08T15:06:53.551Z check: green
