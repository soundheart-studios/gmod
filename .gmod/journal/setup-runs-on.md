# setup-runs-on: setup honours --runs-on on GitHub too

- 2026-11-08T05:54:50.627Z check: red (setup --runs-on <label> on a GitHub repo writes runs-on: <label>; doctor reports a self-hosted label that no runner carries)
- 2026-11-08T05:58:03.059Z check: green
- 2026-11-08T05:58:09.541Z dev@soundheart.io: setup passes runsOn to the GitHub workflow too. New ci.mjs helpers (runsOnLabels, githubHosted, githubRunner, githubRunnerFinding) list repo then org runners via gh api and match every runs-on label case-insensitively; doctor and ci check both use them, skipping GitHub-hosted ubuntu-/windows-/macos- labels. Test runs setup and doctor end to end with no network: origin git@github.com:o/r.git served by a fake GIT_SSH_COMMAND from a local bare repo, gh faked via GMOD_GH. Not done: comparing the workflow against the runner the person "chose", since doctor has no record of that choice. test/setup-runs-on.test.mjs is not in npm test's file list (package.json is outside this job).
