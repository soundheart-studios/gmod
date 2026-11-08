# npm-test-all: npm test runs every test file

- 2026-11-08T07:23:34.220Z check: red (npm test's script covers every test/*.test.mjs)
- 2026-11-08T07:38:23.627Z check: red (npm test's script covers every test/*.test.mjs)
- 2026-11-08T07:45:38.449Z check: green
- 2026-11-08T07:45:43.935Z dev@soundheart.io: npm test now runs `node --test test/*.test.mjs` (sh expands the glob, so it works on Node 20 too). review-live is included; it skips itself without a key. test/suite.test.mjs fails if any test/*.test.mjs isn't covered by the script's words. Full suite: 116 tests, 115 pass, 1 skipped (review-live), ~2 min. The first recorded red was only the missing test file (Write was blocked by auto mode); a genuine red was recorded after the file existed.
