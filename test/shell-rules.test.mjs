// The shell rules (lib/shell.mjs) under node's own test runner: the cases
// test/shell.test.ts holds for the mod, so npm test and CI run them too.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { commitDirs, commitsAlone, decidesPlan, decision, mergesPr, movesClaims, resolveDir, writesPlan, writesRecords } from '../lib/shell.mjs'

test('reading the plan is never a write', () => {
  for (const cmd of [
    'cat .gmod/plan.json 2>/dev/null',
    'cat .gmod/plan.json 2>/dev/null || echo none',
    'jq . .gmod/plan.json > /tmp/plan.pretty',
    'cp .gmod/plan.json /tmp/',
    'sed -n 1,20p .gmod/plan.json',
    'git show HEAD:.gmod/plan.json',
    'git diff .gmod/plan.json',
    'grep -n slug .gmod/plan.json',
    'node -e "console.log(require(\'./.gmod/plan.json\'))"',
    'ls .gmod && cat .gmod/plan.json | head',
  ]) assert.deepEqual([cmd, writesPlan(cmd)], [cmd, false])
})

test('the obvious writes to the plan are caught', () => {
  for (const cmd of [
    'echo {} > .gmod/plan.json',
    'cat new.json >> .gmod/plan.json',
    'jq ".jobs += []" p.json | tee .gmod/plan.json',
    "sed -i '' s/a/b/ .gmod/plan.json",
    'perl -pi -e s/a/b/ .gmod/plan.json',
    'cp /tmp/p.json .gmod/plan.json',
    'mv draft.json ./.gmod/plan.json',
    'rm .gmod/plan.json',
    'git checkout HEAD~1 -- .gmod/plan.json',
    'git restore .gmod/plan.json',
    'vim .gmod/plan.json',
  ]) assert.deepEqual([cmd, writesPlan(cmd)], [cmd, true])
})

test("gmod's records: reads pass, writes are caught", () => {
  assert.equal(writesRecords('cat .git/gmod/claim.json'), false)
  assert.equal(writesRecords('ls .git/gmod/evidence/'), false)
  assert.equal(writesRecords('echo [] > .git/gmod/evidence/add-sum.json'), true)
  assert.equal(writesRecords('rm .git/gmod/proposal.json'), true)
  assert.equal(writesRecords('cp x .git/worktrees/a/gmod/claim.json'), true)
})

test('claims and decisions', () => {
  assert.equal(movesClaims('git push origin :refs/gmod/claims/x'), true)
  assert.equal(movesClaims('git ls-remote origin refs/gmod/claims/*'), false)
  assert.equal(decidesPlan('node ~/gmod/bin/gmod.mjs approve'), true)
  assert.equal(decidesPlan("node '/x/gmod.mjs' reject 'no'"), true)
  assert.equal(decidesPlan('node ~/gmod/bin/gmod.mjs proposal'), false)
  assert.equal(decidesPlan('node ~/gmod/bin/gmod.mjs adr accept cents-only'), true)
  assert.equal(decidesPlan('gmod adr reject cents-only "not now"'), true)
  assert.equal(decidesPlan('node ~/gmod/bin/gmod.mjs adr propose {}'), false)
  assert.equal(decidesPlan('node ~/gmod/bin/gmod.mjs adr list'), false)
})

test('moving claims is a git command on refs/gmod/, not text that mentions them', () => {
  // Still caught: git itself moving the shared refs, however it is reached.
  for (const cmd of [
    'git push origin refs/gmod/claims/x',
    'git push -q --force-with-lease origin :refs/gmod/claims/x',
    'git update-ref -d refs/gmod/claims/x',
    'git -C ../wt update-ref refs/gmod/proposal abc123',
    'git branch -D refs/gmod/claims/x',
    'git tag refs/gmod/claims/x HEAD',
    'git replace refs/gmod/proposal abc',
    "cd ../wt && git push origin ':refs/gmod/claims/x'",
    "sh -c 'git push origin :refs/gmod/claims/x'",
    'eval git update-ref -d refs/gmod/runs/x',
    "echo 'git push origin :refs/gmod/claims/x' | sh",
    "bash <<'EOF'\ngit update-ref -d refs/gmod/claims/x\nEOF",
    'git push origin HEAD:refs/gmod/claims/x $(git rev-parse HEAD)',
    'echo $(git update-ref -d refs/gmod/claims/x)',
  ]) assert.deepEqual([cmd, movesClaims(cmd)], [cmd, true])
  // Text: an edit, a heredoc, a comment, a read of the refs.
  for (const cmd of [
    "sed -i 's/old/tag it, then push refs\\/gmod\\/proposal/' notes.md",
    "sed -i 's/old/tag it: refs/gmod/proposal moves on push/' notes.md",
    "git ls-remote origin 'refs/gmod/*' # then push",
    "python3 - <<'EOF'\n# the poller lists refs/gmod/* and never does a push\nrun(['git', 'ls-remote', 'origin', 'refs/gmod/*'])\nEOF",
    "node --experimental-strip-types -e \"import('./hooks/shell.ts').then(m => m.movesClaims('git push refs/gmod/x'))\"",
    'git push origin gmod/hook-words',
    'git fetch origin +refs/gmod/claims/*:refs/gmod-origin/claims/* && git tag v1.7.1',
  ]) assert.deepEqual([cmd, movesClaims(cmd)], [cmd, false])
})

test("a quoted heredoc's body is text: backticks and $(…) in it run nothing", () => {
  assert.equal(decision("cat > a.md <<'EOF'\nRun `gmod decide abc approve` to approve.\nEOF"), null)
  assert.equal(decision('cat > a.md << "EOF"\nor $(gmod approve) from the pane\nEOF'), null)
  assert.equal(decision("mkdir -p d && cat > d/a.swift <<'SWIFT'\nlet c = \"$(gmod decide abc approve)\"\nSWIFT\necho done"), null)
  assert.equal(decision("cat <<-'EOF' > a.md\n\t`gmod adr accept x`\n\tEOF"), null)
  // Unquoted, the shell runs them; a shell reading the heredoc runs it all.
  assert.equal(decision('cat > a.md <<EOF\nRun `gmod decide abc approve`\nEOF'), 'plan')
  assert.equal(decision('cat > a.md <<EOF\n$(gmod approve)\nEOF'), 'plan')
  assert.equal(decision("sh <<'EOF'\ngmod approve\nEOF"), 'plan')
  assert.equal(decision('bash -s <<EOF\ngmod decide abc approve\nEOF'), 'plan')
})

test("gmod decide is a person's decision, from an agent's shell as much as approve", () => {
  assert.equal(decision('gmod decide 6ca7ca5f approve --via skiff'), 'plan')
  assert.equal(decision('node ~/gmod/bin/gmod.mjs decide e980855e accept'), 'plan')
  assert.equal(decision("sh -c 'gmod decide 6ca7ca5f reject'"), 'plan')
  assert.equal(decision('gmod --json decide 6ca7ca5f ask-changes --note "why?"'), 'plan')
  assert.equal(decision("grep -n 'gmod decide' docs/surfaces.md"), null)
  assert.equal(decision('git commit -m "gmod decide refuses agents"'), null)
  assert.equal(decision('gmod decided'), null)
})

test('switching managed mode is a decision; reading it is not', () => {
  for (const cmd of [
    'gmod manage on',
    'gmod manage off',
    'node ~/gmod/bin/gmod.mjs manage on',
    "node '/x/gmod.mjs' manage off",
    'node "/x y/gmod.mjs" manage "on"',
    'gmod --json manage off',
    'gmod manage --json on',
    'cd ~/proj && gmod manage on',
    'FOO=1 env gmod manage off',
    'npx gmod manage on',
    'sh -c "gmod manage on"',
    "bash -lc 'node bin/gmod.mjs manage off'",
    'eval "gmod manage on"',
  ]) assert.deepEqual([cmd, decidesPlan(cmd)], [cmd, true])
  for (const cmd of [
    'gmod manage',
    'gmod manage status',
    'gmod manage --json',
    'node ~/gmod/bin/gmod.mjs manage status --json',
    'grep -n "gmod manage on" README.md',
    "echo 'run gmod manage off yourself'",
    'git commit -m "gmod manage on is refused"',
    'gmod managed on',
    'gmod status manage on',
  ]) assert.deepEqual([cmd, decidesPlan(cmd)], [cmd, false])
})

test('approving, rejecting and accepting are read word by word: a mention is text', () => {
  for (const cmd of [
    "grep 'gmod approve' test/mod.test.tsx",
    'grep -rn "gmod adr accept" docs',
    "echo 'run gmod reject yourself'",
    'git commit -m "refuse gmod approve from the shell"',
    'git commit -m "gmod adr accept stays the person\'s"',
    'rg "gmod(\\.mjs)? approve" hooks',
    'gmod proposal',
    'gmod adr list',
    'gmod adr propose {}',
    'gmod status approve',
    'gmod approved',
    'cat approve.txt',
  ]) assert.deepEqual([cmd, decision(cmd), decidesPlan(cmd)], [cmd, null, false])
  for (const cmd of [
    'gmod approve',
    'gmod reject',
    'gmod --json approve',
    'gmod adr accept 3',
    'gmod adr reject 3 "not now"',
    'node ~/gmod/bin/gmod.mjs approve',
    "node '/x/gmod.mjs' reject 'no'",
    'node "/x y/gmod.mjs" adr accept cents-only',
    'npx gmod approve',
    'cd x && gmod reject',
    'FOO=1 env gmod approve',
    "sh -c 'gmod adr accept 3'",
    'bash -lc "node bin/gmod.mjs approve"',
    'eval "gmod reject"',
    'echo hi; gmod approve',
    'echo "gmod approve" | sh',
    'echo $(gmod reject)',
    'ls | xargs gmod adr accept',
  ]) assert.deepEqual([cmd, decision(cmd), decidesPlan(cmd)], [cmd, 'plan', true])
  assert.equal(decision('gmod manage on'), 'managed')
  assert.equal(decision("sh -c 'gmod manage off'"), 'managed')
  assert.equal(decision('gmod manage status'), null)
  // Setup that turns managed mode on is the same switch.
  assert.equal(decision('gmod setup --json --managed --yes'), 'managed')
  assert.equal(decision("sh -c 'gmod setup --managed'"), 'managed')
  assert.equal(decision('gmod setup --json --runs-on gpu-box'), null)
  assert.equal(decision("grep -- '--managed' docs/setup.md"), null)
})

test('merging a pull request by hand is caught; gmod pr --auto is not', () => {
  assert.equal(mergesPr('gh pr merge 3 --merge'), true)
  assert.equal(mergesPr('tea pr merge 3'), true)
  assert.equal(mergesPr('curl -X POST -H "authorization: token $(cat ~/.config/gmod/gitea-token)" http://git.example.lan:3000/api/v1/repos/acme/shop/pulls/3/merge -d \'{"Do":"merge"}\''), true)
  assert.equal(mergesPr('node ~/gmod/bin/gmod.mjs pr --auto'), false)
  assert.equal(mergesPr('git merge origin/main'), false)
  assert.equal(mergesPr('curl http://git.example.lan:3000/api/v1/repos/acme/shop/pulls/3'), false)
  assert.equal(mergesPr("git commit -m 'pr --auto: like gh pr merge --auto, the forge merges on green (a POST to /pulls/4/merge)'"), false)
  assert.equal(mergesPr('cd x && gh pr merge 3'), true)
})

test('a git commit is found with the directory it runs in; a mention of commit is not', () => {
  assert.deepEqual(commitDirs('git commit -m x'), ['.'])
  assert.deepEqual(commitDirs('git add -A && git commit -m "add-sum: x"'), ['.'])
  assert.deepEqual(commitDirs('git -C ../wt commit -m x'), ['../wt'])
  assert.deepEqual(commitDirs('git -c user.name=a --no-pager commit -m x'), ['.'])
  assert.deepEqual(commitDirs('cd ../wt && git add -A && git commit -m x'), ['../wt'])
  assert.deepEqual(commitDirs('cd /a/b; git -C c commit'), ['/a/b/c'])
  assert.deepEqual(commitDirs('cd a && git -C /abs commit'), ['/abs'])
  assert.deepEqual(commitDirs('FOO=1 /usr/bin/git commit --amend'), ['.'])
  assert.deepEqual(commitDirs('git status\ngit commit'), ['.'])
  for (const cmd of [
    'grep -n commit hooks/register.tsx',
    'git log --oneline -S "bcommit"',
    "echo 'git commit -m x'",
    'git show --stat ec03333 # not a commit',
    'git log --format="%H commit" ; ls',
    'gh pr list --search "git commit && git push"',
    'git -C commit status',
  ]) assert.deepEqual([cmd, commitDirs(cmd)], [cmd, []])
})

test('a commit travels on its own: beside it only cd and git that changes no file', () => {
  for (const cmd of [
    'ls',
    'grep -n commit hooks/register.tsx | head',
    'git commit -m x',
    'git add -A && git commit -m "add-sum: x"',
    'cd ../wt && git add src && git commit -m x && git status --short',
    'git -C ../wt add -A && git -C ../wt commit -m x && git log --oneline -1',
    "git commit -m \"$(cat <<'EOF'\nadd-sum: x (and y)\n\nCo-Authored-By: a <a@x.io>\nEOF\n)\"",
    'git commit -q -m x 2>&1',
    'git commit -m x > /dev/null',
  ]) assert.deepEqual([cmd, commitsAlone(cmd)], [cmd, true])
  for (const cmd of [
    'echo x >> src/a.mjs && git commit -am x',
    'git commit -m x; rm -rf src',
    'npm run fmt && git add -A && git commit -m x',
    'git apply p.diff && git commit -am x',
    'git checkout -- src && git commit -am x',
    'git stash pop && git commit -am x',
    'git status > src/a.mjs && git commit -am x',
    'git commit -m "$(echo x > src/a.mjs)"',
    'f() { git commit -m x; }; f',
    'eval "git commit -m x"',
    "sh -c 'git commit -m x'",
    "bash -lc 'cd ../wt && git commit -m x'",
  ]) assert.deepEqual([cmd, commitsAlone(cmd)], [cmd, false])
})

test('a commit directory is resolved from the session cwd', () => {
  assert.equal(resolveDir('/repo', '.'), '/repo')
  assert.equal(resolveDir('/repo', '../wt'), '/wt')
  assert.equal(resolveDir('/repo', '/abs/x'), '/abs/x')
  assert.equal(resolveDir('/repo', '~/x', '/home/me'), '/home/me/x')
  assert.equal(resolveDir('/repo', '~', '/home/me'), '/home/me')
  assert.equal(resolveDir('/repo/a', 'b/../c'), '/repo/a/c')
})
