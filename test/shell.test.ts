import { expect, test } from 'claude-code/testing'

import { commitDirs, commitsAlone, decidesPlan, decision, mergesPr, movesClaims, writesPlan, writesRecords } from '../hooks/shell'

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
  ]) expect([cmd, writesPlan(cmd)]).toEqual([cmd, false])
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
  ]) expect([cmd, writesPlan(cmd)]).toEqual([cmd, true])
})

test("gmod's records: reads pass, writes are caught", () => {
  expect(writesRecords('cat .git/gmod/claim.json')).toBe(false)
  expect(writesRecords('ls .git/gmod/evidence/')).toBe(false)
  expect(writesRecords('echo [] > .git/gmod/evidence/add-sum.json')).toBe(true)
  expect(writesRecords('rm .git/gmod/proposal.json')).toBe(true)
  expect(writesRecords('cp x .git/worktrees/a/gmod/claim.json')).toBe(true)
})

test('claims and decisions', () => {
  expect(movesClaims('git push origin :refs/gmod/claims/x')).toBe(true)
  expect(movesClaims('git ls-remote origin refs/gmod/claims/*')).toBe(false)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs approve')).toBe(true)
  expect(decidesPlan("node '/x/gmod.mjs' reject 'no'")).toBe(true)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs proposal')).toBe(false)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs adr accept cents-only')).toBe(true)
  expect(decidesPlan('gmod adr reject cents-only "not now"')).toBe(true)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs adr propose {}')).toBe(false)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs adr list')).toBe(false)
})

test('moving claims is a git command on refs/gmod/, not text that mentions them', () => {
  // Still caught: git itself moving the shared refs, however it is reached.
  expect(movesClaims('git push origin refs/gmod/claims/x')).toBe(true)
  expect(movesClaims('git push -q --force-with-lease origin :refs/gmod/claims/x')).toBe(true)
  expect(movesClaims('git update-ref -d refs/gmod/claims/x')).toBe(true)
  expect(movesClaims('git -C ../wt update-ref refs/gmod/proposal abc123')).toBe(true)
  expect(movesClaims('git branch -D refs/gmod/claims/x')).toBe(true)
  expect(movesClaims('git tag refs/gmod/claims/x HEAD')).toBe(true)
  expect(movesClaims('git replace refs/gmod/proposal abc')).toBe(true)
  expect(movesClaims("cd ../wt && git push origin ':refs/gmod/claims/x'")).toBe(true)
  expect(movesClaims("sh -c 'git push origin :refs/gmod/claims/x'")).toBe(true)
  expect(movesClaims('eval git update-ref -d refs/gmod/runs/x')).toBe(true)
  expect(movesClaims("echo 'git push origin :refs/gmod/claims/x' | sh")).toBe(true)
  expect(movesClaims("bash <<'EOF'\ngit update-ref -d refs/gmod/claims/x\nEOF")).toBe(true)
  expect(movesClaims('git push origin HEAD:refs/gmod/claims/x $(git rev-parse HEAD)')).toBe(true)
  expect(movesClaims('echo $(git update-ref -d refs/gmod/claims/x)')).toBe(true)
  // Text: an edit, a heredoc, a comment, a read of the refs.
  expect(movesClaims("sed -i 's/old/tag it, then push refs\\/gmod\\/proposal/' notes.md")).toBe(false)
  expect(movesClaims("sed -i 's/old/tag it: refs/gmod/proposal moves on push/' notes.md")).toBe(false)
  expect(movesClaims("git ls-remote origin 'refs/gmod/*' # then push")).toBe(false)
  expect(movesClaims("python3 - <<'EOF'\n# the poller lists refs/gmod/* and never does a push\nrun(['git', 'ls-remote', 'origin', 'refs/gmod/*'])\nEOF")).toBe(false)
  expect(movesClaims("node --experimental-strip-types -e \"import('./hooks/shell.ts').then(m => m.movesClaims('git push refs/gmod/x'))\"")).toBe(false)
  expect(movesClaims('git push origin gmod/hook-words')).toBe(false)
  expect(movesClaims('git fetch origin +refs/gmod/claims/*:refs/gmod-origin/claims/* && git tag v1.7.1')).toBe(false)
})

test("a quoted heredoc's body is text: backticks and $(…) in it run nothing", () => {
  expect(decision("cat > a.md <<'EOF'\nRun `gmod decide abc approve` to approve.\nEOF")).toBe(null)
  expect(decision('cat > a.md << "EOF"\nor $(gmod approve) from the pane\nEOF')).toBe(null)
  expect(decision("mkdir -p d && cat > d/a.swift <<'SWIFT'\nlet c = \"$(gmod decide abc approve)\"\nSWIFT\necho done")).toBe(null)
  expect(decision("cat <<-'EOF' > a.md\n\t`gmod adr accept x`\n\tEOF")).toBe(null)
  // Unquoted, the shell runs them; a shell reading the heredoc runs it all.
  expect(decision('cat > a.md <<EOF\nRun `gmod decide abc approve`\nEOF')).toBe('plan')
  expect(decision('cat > a.md <<EOF\n$(gmod approve)\nEOF')).toBe('plan')
  expect(decision("sh <<'EOF'\ngmod approve\nEOF")).toBe('plan')
  expect(decision('bash -s <<EOF\ngmod decide abc approve\nEOF')).toBe('plan')
})

test("gmod decide is a person's decision, from an agent's shell as much as approve", () => {
  expect(decision('gmod decide 6ca7ca5f approve --via skiff')).toBe('plan')
  expect(decision('node ~/gmod/bin/gmod.mjs decide e980855e accept')).toBe('plan')
  expect(decision("sh -c 'gmod decide 6ca7ca5f reject'")).toBe('plan')
  expect(decision('gmod --json decide 6ca7ca5f ask-changes --note "why?"')).toBe('plan')
  expect(decision("grep -n 'gmod decide' docs/surfaces.md")).toBe(null)
  expect(decision('git commit -m "gmod decide refuses agents"')).toBe(null)
  expect(decision('gmod decided')).toBe(null)
})

test('switching managed mode is a decision; reading it is not', () => {
  expect(decidesPlan('gmod manage on')).toBe(true)
  expect(decidesPlan('gmod manage off')).toBe(true)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs manage on')).toBe(true)
  expect(decidesPlan("node '/x/gmod.mjs' manage off")).toBe(true)
  expect(decidesPlan('node "/x y/gmod.mjs" manage "on"')).toBe(true)
  expect(decidesPlan('gmod --json manage off')).toBe(true)
  expect(decidesPlan('gmod manage --json on')).toBe(true)
  expect(decidesPlan('cd ~/proj && gmod manage on')).toBe(true)
  expect(decidesPlan('FOO=1 env gmod manage off')).toBe(true)
  expect(decidesPlan('npx gmod manage on')).toBe(true)
  expect(decidesPlan('sh -c "gmod manage on"')).toBe(true)
  expect(decidesPlan("bash -lc 'node bin/gmod.mjs manage off'")).toBe(true)
  expect(decidesPlan('eval "gmod manage on"')).toBe(true)
  expect(decidesPlan('gmod manage')).toBe(false)
  expect(decidesPlan('gmod manage status')).toBe(false)
  expect(decidesPlan('gmod manage --json')).toBe(false)
  expect(decidesPlan('node ~/gmod/bin/gmod.mjs manage status --json')).toBe(false)
  expect(decidesPlan('grep -n "gmod manage on" README.md')).toBe(false)
  expect(decidesPlan("echo 'run gmod manage off yourself'")).toBe(false)
  expect(decidesPlan('git commit -m "gmod manage on is refused"')).toBe(false)
  expect(decidesPlan('gmod managed on')).toBe(false)
  expect(decidesPlan('gmod status manage on')).toBe(false)
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
  ]) expect([cmd, decision(cmd), decidesPlan(cmd)]).toEqual([cmd, null, false])
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
  ]) expect([cmd, decision(cmd), decidesPlan(cmd)]).toEqual([cmd, 'plan', true])
  expect(decision('gmod manage on')).toBe('managed')
  expect(decision("sh -c 'gmod manage off'")).toBe('managed')
  expect(decision('gmod manage status')).toBe(null)
})

test('merging a pull request by hand is caught; gmod pr --auto is not', () => {
  expect(mergesPr('gh pr merge 3 --merge')).toBe(true)
  expect(mergesPr('tea pr merge 3')).toBe(true)
  expect(mergesPr('curl -X POST -H "authorization: token $(cat ~/.config/gmod/gitea-token)" http://git.example.lan:3000/api/v1/repos/acme/shop/pulls/3/merge -d \'{"Do":"merge"}\'')).toBe(true)
  expect(mergesPr('node ~/gmod/bin/gmod.mjs pr --auto')).toBe(false)
  expect(mergesPr('git merge origin/main')).toBe(false)
  expect(mergesPr('curl http://git.example.lan:3000/api/v1/repos/acme/shop/pulls/3')).toBe(false)
  expect(mergesPr("git commit -m 'pr --auto: like gh pr merge --auto, the forge merges on green (a POST to /pulls/4/merge)'")).toBe(false)
  expect(mergesPr('cd x && gh pr merge 3')).toBe(true)
})

test('a git commit is found with the directory it runs in; a mention of commit is not', () => {
  expect(commitDirs('git commit -m x')).toEqual(['.'])
  expect(commitDirs('git add -A && git commit -m "add-sum: x"')).toEqual(['.'])
  expect(commitDirs('git -C ../wt commit -m x')).toEqual(['../wt'])
  expect(commitDirs('git -c user.name=a --no-pager commit -m x')).toEqual(['.'])
  expect(commitDirs('cd ../wt && git add -A && git commit -m x')).toEqual(['../wt'])
  expect(commitDirs('cd /a/b; git -C c commit')).toEqual(['/a/b/c'])
  expect(commitDirs('cd a && git -C /abs commit')).toEqual(['/abs'])
  expect(commitDirs('FOO=1 /usr/bin/git commit --amend')).toEqual(['.'])
  expect(commitDirs('git status\ngit commit')).toEqual(['.'])
  for (const cmd of [
    'grep -n commit hooks/register.tsx',
    'git log --oneline -S "bcommit"',
    "echo 'git commit -m x'",
    'git show --stat ec03333 # not a commit',
    'git log --format="%H commit" ; ls',
    'gh pr list --search "git commit && git push"',
    'git -C commit status',
  ]) expect(commitDirs(cmd)).toEqual([])
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
  ]) expect(commitsAlone(cmd)).toBe(true)
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
  ]) expect(commitsAlone(cmd)).toBe(false)
})
