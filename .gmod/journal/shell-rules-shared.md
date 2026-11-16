# shell-rules-shared: Shell rules any host can run, tested in CI

- 2026-11-16T15:07:02.385Z check: red (lib/shell.mjs exports every shell rule and node's own test run proves each one on the cases the mod's tests use)
- 2026-11-16T15:08:07.033Z check: green
- 2026-11-16T15:11:12.948Z dev@soundheart.io: lib/shell.mjs is hooks/shell.ts with only its type annotations and non-null assertions removed; compared against node's stripTypeScriptTypes of the old file, the two differ only in whitespace. hooks/shell.ts now re-exports each rule with a cast to its old signature (the register.tsx / signals.mjs pattern) and keeps the Decision type, so register.tsx and test/shell.test.ts import unchanged. test/shell-rules.test.mjs ports every case of test/shell.test.ts and adds a few for resolveDir, which had none. test/shell.test.ts is unchanged.
