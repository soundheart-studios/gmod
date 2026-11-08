import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// The engine beneath the mod is stubbed: `gmod` answers as the CLI would.
type Answer = { exitCode: number; stdout: string; stderr?: string }

type Seen = { runs: { args: readonly string[]; cwd?: string }[]; calls: Record<string, unknown>[] }

function engine(on: On, answer: (args: readonly string[]) => Answer): Seen {
  const seen: Seen = { runs: [], calls: [] }
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(2)
    seen.runs.push({ args, cwd: e.init?.cwd })
    const a = answer(args)
    return { value: { exitCode: a.exitCode, stdout: a.stdout, stderr: a.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => {
    seen.calls.push(e as unknown as Record<string, unknown>)
    return { result: 'ran' }
  })
  return seen
}

const JOB = (over: Record<string, unknown>) => ({
  goal: 'A job', state: 'ready', stage: 0, stalled: false, tests: 'none', where: null, waiting: [], after: [],
  criteria: [{ text: 'it works', pass: null }], files: ['src/x.mjs'], ...over,
})

const STATUS = JSON.stringify({
  governed: true,
  claim: { job: 'add-sum', goal: 'Add two numbers', files: ['src/**', 'test/**'], done_when: ['sum adds'] },
  evidence: [{ result: 'red', at: '2026-10-31T10:00:00Z', failed: ['sum adds'] }],
  sawRed: true,
  gate: { ok: false, reason: 'add-sum: the last check failed' },
  jobs: [
    JOB({ id: 'slugify', goal: 'Turn a title into a slug', state: 'done', stage: 6, tests: 'green' }),
    JOB({ id: 'add-sum', goal: 'Add two numbers', state: 'claimed', stage: 2, stalled: true, tests: 'red', by: 'alice@x.io', where: 'agent-1', criteria: [{ text: 'sum adds', pass: false }] }),
    JOB({ id: 'add-mul', state: 'waiting', waiting: ['add-sum'], after: ['add-sum'] }),
  ],
  next: null,
  proposal: {
    by: 'alice@x.io',
    at: '2026-10-31T10:05:00Z',
    summary: 'add slug-trim; change add-mul',
    headline: 'Slugs stay short enough for a URL.',
    assumptions: ['40 characters at most'],
    stale: false,
    diff: {
      added: [{ id: 'slug-trim', goal: 'Keep slugs short', after: ['add-sum'], criteria: ['a long title fits in 40'], files: 1, tests: 1, paths: ['src/trim.mjs', 'test/trim.test.mjs'] }],
      changed: [{ id: 'add-mul', goal: 'Multiply', after: [], criteria: [], files: 1, tests: 1, paths: ['src/mul.mjs'], fields: ['goal'], changes: [{ field: 'goal', before: 'Multiply', after: 'Multiply two numbers' }] }],
      dropped: [],
      checks: ['trim'],
      phases: { added: [], changed: [], dropped: [] },
    },
    order: [{ id: 'slug-trim', after: ['add-sum'], waits: ['add-sum'], now: false }],
    warnings: ['slug-trim lists no test files'],
    ready: true,
  },
})

test('an edit outside the claimed job is refused with the reason', async ($, on) => {
  engine(on, args => (args[0] === 'guard-path' && args[1] === 'README' ? { exitCode: 1, stdout: 'README is outside add-sum' } : { exitCode: 0, stdout: 'ok' }))
  const out = await $.tool.call({ tool: 'Edit', file_path: 'README', old_string: 'a', new_string: 'b' })
  expect(out.deny).toContain('README is outside add-sum')
  const inside = await $.tool.call({ tool: 'Edit', file_path: 'src/sum.mjs', old_string: 'a', new_string: 'b' })
  expect(inside.deny).toBeUndefined()
})

test('a commit is gated by the hook, for the worktree it commits in, and runs as written', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  const cmd = 'cd ../wt && git add -A && git commit -m "add-sum: x"'
  const out = await $.tool.call({ tool: 'Bash', command: cmd })
  expect(out.deny).toBeUndefined()
  expect(seen.calls.at(-1)?.command).toBe(cmd)
  const gate = seen.runs.filter(r => r.args[0] === 'gate-commit')
  expect(gate.length).toBe(1)
  expect(gate[0]?.args).toEqual(['gate-commit', '--shell', '--dir', '/wt'])
})

test('a commit the gate refuses never reaches the shell', async ($, on) => {
  const seen = engine(on, args => (args[0] === 'gate-commit' ? { exitCode: 1, stdout: '', stderr: 'gmod refused the commit: add-sum: the last check failed' } : { exitCode: 0, stdout: STATUS }))
  const out = await $.tool.call({ tool: 'Bash', command: 'git -C /repo-wt commit -m x' })
  expect(out.deny).toContain('the last check failed')
  expect(seen.runs.find(r => r.args[0] === 'gate-commit')?.args).toEqual(['gate-commit', '--shell', '--dir', '/repo-wt'])
  expect(seen.calls.some(c => c.tool === 'Bash')).toBe(false)
})

test('a commit bundled with anything that could change files is refused before it runs', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  for (const cmd of ['echo x >> src/a.mjs && git commit -am x', 'eval "git commit -m x"', 'git apply p.diff && git commit -am x']) {
    const out = await $.tool.call({ tool: 'Bash', command: cmd })
    expect(out.deny).toContain('on its own')
  }
  expect(seen.calls.some(c => c.tool === 'Bash')).toBe(false)
})

test('a command that only mentions commit runs exactly as written, ungated', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  for (const cmd of ['grep -n commit hooks/register.tsx', 'git log --oneline -S "bcommit"', 'ls']) {
    await $.tool.call({ tool: 'Bash', command: cmd })
    expect(seen.calls.at(-1)?.command).toBe(cmd)
  }
  expect(seen.runs.some(r => r.args[0] === 'gate-commit')).toBe(false)
})

test('an edit is judged by the repository the file is in', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: 'ok' }))
  await $.tool.call({ tool: 'Write', file_path: '/repo-wt/src/a.mjs', content: 'x' })
  expect(seen.runs.find(r => r.args[0] === 'guard-path')?.args[1]).toBe('/repo-wt/src/a.mjs')
})

test('the agent drafts, never decides', async ($, on) => {
  const seen = engine(on, args => (args[0] === 'propose-job' ? { exitCode: 0, stdout: 'drafted: add slug-trim' } : { exitCode: 0, stdout: STATUS }))
  const job = { id: 'slug-trim', goal: 'Trim', files: ['src/**'], done_when: [{ text: 't', check: 'trim' }] }
  const out = await $.tool.call({ tool: 'mcp__gmod__propose_job', job, checks: { trim: 'node t.mjs' } } as never)
  expect(String(out.result)).toContain('/gmod approve')
  const run = seen.runs.find(r => r.args[0] === 'propose-job')!
  expect(JSON.parse(String(run.args[1])).id).toBe('slug-trim')
  expect(run.args.slice(2)).toEqual(['--checks', '{"trim":"node t.mjs"}'])
  expect((await $.tool.call({ tool: 'Bash', command: 'node ~/gmod/bin/gmod.mjs approve' })).deny).toContain("person's decision")
  expect((await $.command.run({ command: 'gmod', args: 'approve' } as never)).text).toContain('Only a person')
  expect((await $.command.run({ command: 'gmod', args: 'reject' } as never)).text).toContain('Only a person')
})

test("gmod's own records can't be written from the shell", async ($, on) => {
  engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  expect((await $.tool.call({ tool: 'Bash', command: 'echo [] > .git/gmod/evidence/add-sum.json' })).deny).toContain('own records')
})

test('a subagent in a worktree works with its own folder', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: 'claimed docs' }))
  await $.tool.call({ tool: 'mcp__gmod__claim', job: 'docs', dir: '/repo-wt' } as never)
  expect(seen.runs.find(r => r.args[0] === 'claim')?.cwd).toBe('/repo-wt')
})

async function governed($: Engine, on: On, status = STATUS): Promise<Seen> {
  const seen = engine(on, () => ({ exitCode: 0, stdout: status }))
  on('command.register', () => ({ value: { command: 'gmod' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__gmod__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return seen
}

const agents = (seen: Seen) => seen.calls.filter(c => c.tool === 'Agent')

test('a subagent prompt without the routine is refused with the routine to add, and nothing runs', async ($, on) => {
  const seen = await governed($, on)
  const out = await $.tool.call({ tool: 'Agent', description: 'work docs', prompt: 'Do the docs job.', subagent_type: 'general-purpose' })
  expect(out.deny).toContain('is governed by gmod')
  expect(out.deny).toContain('pass its path as "dir"')
  expect(agents(seen).length).toBe(0)
})

test('a prompt that carries the routine runs exactly as written, so auto mode reviews what runs', async ($, on) => {
  const seen = await governed($, on)
  const out = await $.tool.call({ tool: 'Agent', description: 'work docs', prompt: 'Do the docs job.', subagent_type: 'general-purpose' })
  const routine = String(out.deny).match(/(This repository's work is governed by gmod[\s\S]*)$/)?.[1] ?? ''
  expect(routine.length).toBeGreaterThan(0)
  const prompt = `Do the docs job.\n\n---\n${routine}`
  await $.tool.call({ tool: 'Agent', description: 'work docs', prompt, subagent_type: 'general-purpose' })
  expect(agents(seen).length).toBe(1)
  expect(agents(seen)[0]?.prompt).toBe(prompt)
})

test('in a repository gmod does not govern, a subagent runs exactly as written', async ($, on) => {
  const seen = await governed($, on, JSON.stringify({ governed: false }))
  await $.tool.call({ tool: 'Agent', description: 'work docs', prompt: 'Do the docs job.', subagent_type: 'general-purpose' })
  expect(agents(seen).length).toBe(1)
  expect(agents(seen)[0]?.prompt).toBe('Do the docs job.')
})

test('the agent cannot move claims or rewrite the plan through the shell', async ($, on) => {
  engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin :refs/gmod/claims/add-sum' })).deny).toContain('claims change only')
  expect((await $.tool.call({ tool: 'Bash', command: "sed -i '' s/a/b/ .gmod/plan.json" })).deny).toContain('allow-plan')
})

test('only a person at the prompt allows plan edits', async ($, on) => {
  engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  const fromPlugin = await $.command.run({ command: 'gmod', args: 'allow-plan' } as never)
  expect(fromPlugin.text).toContain('Only a person')
})

const PANE = {
  plugin: 'gmod',
  component: 'Pane',
  requestId: 'gmod',
  surface: 'terminal',
  props: { title: 'gmod', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Panes = { opened: Record<string, unknown>[]; closed: Record<string, unknown>[] }

async function started($: Engine, on: On, answer: (args: readonly string[]) => Answer, panes: Panes = { opened: [], closed: [] }) {
  const seen = engine(on, answer)
  on('command.register', () => ({ value: { command: 'gmod' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__gmod__${e.name}` } }))
  on('ui.open', (_, e) => (panes.opened.push(e as unknown as Record<string, unknown>), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (panes.closed.push(e as unknown as Record<string, unknown>), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return seen
}

test('the pane: progress, what needs you, every job on its stage track', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /1 of 3 done · 1 in progress · 1 waiting/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Needs you$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /add-sum is red in agent-1/ })).toBeDefined()
  // claim test commit push merge: a header, then a column of dots each.
  for (const step of ['claim', 'test', 'commit', 'push', 'merge']) expect(await ui.find({ type: 'Text', text: new RegExp(`^${step}$`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ slugify$/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^●$/ })).length).toBe(5 + 2)
  // The right side says only who has it, or what it waits for.
  expect(await ui.find({ type: 'Text', text: /^agent-1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^after\u00a0add-sum$/ })).toBeDefined()
  // The test dot carries the color.
  const colors = (await ui.findAll({ type: 'Text', text: /^●$/ })).map(d => d.props?.color)
  expect(colors).toContain('red')
  // A row opens to its goal, criteria and files.
  expect(await ui.find({ type: 'Text', text: /✗ sum adds/ })).toBeUndefined()
  await ui.press({ key: 'rowadd-sum' })
  expect(await ui.find({ type: 'Text', text: /✗ sum adds/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claimed by alice@x\.io/ })).toBeDefined()
  await ui.unmount()
})

test('the proposal card is short: why, one line per job, the decision', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  const has = async (t: RegExp) => Boolean(await ui.find({ type: 'Text', text: t }))
  expect(await has(/Plan change: 1 new job, 1 changed/)).toBe(true)
  expect(await has(/^Slugs stay short enough for a URL\.$/)).toBe(true)
  expect(await has(/^\+ slug-trim$/)).toBe(true)
  expect(await has(/^Keep slugs short  after add-sum$/)).toBe(true)
  expect(await has(/^changes goal$/)).toBe(true)
  expect(await has(/^1 assumption ▸$/)).toBe(true)
  expect(await has(/! slug-trim lists no test files/)).toBe(true)
  // Detail stays folded until asked for.
  expect(await has(/a long title fits in 40/)).toBe(false)
  expect(await has(/40 characters at most/)).toBe(false)
  expect(await has(/drafted by/)).toBe(false)
  await ui.press({ key: 'cardslug-trim' })
  expect(await has(/◦ a long title fits in 40/)).toBe(true)
  expect(await has(/may change src\/trim\.mjs, test\/trim\.test\.mjs/)).toBe(true)
  await ui.press({ key: 'cardadd-mul' })
  expect(await has(/^Multiply two numbers$/)).toBe(true)
  await ui.press({ key: 'assumptions' })
  expect(await has(/· 40 characters at most/)).toBe(true)
  expect(await ui.findAll({ type: 'Button', text: /^(Approve|Suggest a change…|Reject)$/ })).toHaveLength(3)
  await ui.unmount()
})

test('in a narrow pane the names give way, and a note never splits', async ($, on) => {
  const narrow = JSON.parse(STATUS)
  narrow.jobs[1].where = 'agent 2'
  narrow.jobs[1].id = 'a-rather-long-job-name'
  await started($, on, () => ({ exitCode: 0, stdout: JSON.stringify(narrow) }))
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 50 } })
  // 50 columns: 3 + name + 34 for the steps + 7 for "agent 2" leaves 8 for the name.
  expect(await ui.find({ type: 'Text', text: /^◐ a-rathe…$/ })).toBeDefined()
  const note = await ui.find({ type: 'Text', text: /^agent\u00a02$/ })
  expect(note?.props?.wrap).toBe('truncate-end')
  await ui.unmount()
})

test('an opened row names every step, and how the test stands', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'rowadd-sum' })
  expect(await ui.find({ type: 'Text', text: /^✓ claim  ✗ test  ○ commit  ○ push  ○ merge/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^test: failing$/ })).toBeDefined()
  await ui.unmount()
})

test('Approve and Reject in the card are the person deciding', async ($, on) => {
  const seen = await started($, on, args => (args[0] === 'approve' ? { exitCode: 0, stdout: 'approved: add slug-trim (commit abc on main)' } : { exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'approve' })
  expect(seen.runs.some(r => r.args[0] === 'approve')).toBe(true)
  await ui.press({ key: 'reject' })
  expect(seen.runs.some(r => r.args[0] === 'reject')).toBe(true)
  await ui.unmount()
})

test('Ask for changes sends the note to Claude', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'ask' })
  await ui.input({ key: 'ask-note', text: 'use -1 suffixes' })
  expect(sent).toEqual(['Please revise the plan proposal: use -1 suffixes'])
  await ui.unmount()
})

test('reading the plan from the shell is not refused', async ($, on) => {
  engine(on, () => ({ exitCode: 0, stdout: STATUS }))
  expect((await $.tool.call({ tool: 'Bash', command: 'cat .gmod/plan.json 2>/dev/null' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cat .git/gmod/claim.json' })).deny).toBeUndefined()
})

// The desktop app can run an older engine than the terminal: the pane must
// draw on every surface, with only props both accept.
for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`the pane draws on ${surface}`, async ($, on) => {
    engine(on, () => ({ exitCode: 0, stdout: STATUS }))
    on('command.register', () => ({ value: { command: 'gmod' } }))
    on('tool.register', (_, e) => ({ value: { tool: `mcp__gmod__${e.name}` } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.surfaces', () => ({ value: [surface] }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /1 of 3 done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Plan change/ })).toBeDefined()
    await ui.press({ key: 'rowadd-sum' })
    expect(await ui.find({ type: 'Text', text: /✗ sum adds/ })).toBeDefined()
    // The suggestion box opens on its own row, where the surface takes input.
    await ui.press({ key: 'ask' })
    if (surface !== 'mobile') {
      expect(await ui.find({ type: 'Text', text: /^What would you change\?/ })).toBeDefined()
      expect(await ui.find({ type: 'Input' })).toBeDefined()
    }
    await ui.unmount()
  })
}

// ---- phases ----

const PHASED = JSON.stringify({
  governed: true,
  claim: null,
  evidence: [],
  sawRed: false,
  gate: null,
  next: 'tag-index',
  phases: [
    { id: 'slugs', title: 'Slugs', outcome: 'Every post has its own URL', after: [], waiting: [], state: 'done', jobs: ['slugify'], done: 1, total: 1, moving: 0, stalled: false },
    { id: 'tags', title: 'Tags', outcome: 'Posts can be found by tag', after: ['slugs'], waiting: [], state: 'active', jobs: ['post-tags', 'tag-index'], done: 0, total: 2, moving: 1, stalled: false },
    { id: 'search', title: 'Search', outcome: 'Readers can search posts', after: ['tags'], waiting: ['tags'], state: 'waiting', jobs: ['search'], done: 0, total: 1, moving: 0, stalled: false },
  ],
  jobs: [
    JOB({ id: 'slugify', phase: 'slugs', state: 'done', stage: 6, tests: 'green' }),
    JOB({ id: 'post-tags', phase: 'tags', state: 'claimed', stage: 3, tests: 'green', where: 'agent 1' }),
    JOB({ id: 'tag-index', phase: 'tags', state: 'ready' }),
    JOB({ id: 'search', phase: 'search', state: 'waiting', waiting: ['post-tags', 'tag-index'] }),
  ],
  proposal: {
    by: 'alice@x.io', at: '2026-10-31T10:05:00Z', summary: 'add phase search; add search', headline: 'Readers can search.', assumptions: [], stale: false, ready: false,
    diff: {
      added: [{ id: 'search', goal: 'Search posts by word', phase: 'search', after: [], criteria: ['finds a word'], files: 1, tests: 1, paths: ['src/search.mjs'] }],
      changed: [], dropped: [], checks: [],
      phases: { added: [{ id: 'search', title: 'Search', outcome: 'Readers can search posts', after: ['tags'] }], changed: [], dropped: [] },
    },
    order: [], warnings: ['not ready to approve: job other isn\'t in a phase yet'],
  },
})

test('phases fold where the work isn\'t, and say where they stand', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: PHASED }))
  const ui = await $.ui.mount(PANE)
  const has = async (t: RegExp) => Boolean(await ui.find({ type: 'Text', text: t }))
  // Done: folded, with its count. Active: open, with its outcome and jobs.
  expect(await has(/^▸ Slugs$/)).toBe(true)
  expect(await has(/✓ 1 of 1/)).toBe(true)
  expect(await has(/^slugify/)).toBe(false)
  expect(await has(/^▾ Tags$/)).toBe(true)
  expect(await has(/0 of 2 · 1 in progress/)).toBe(true)
  expect(await has(/^Posts can be found by tag$/)).toBe(true)
  expect(await has(/^◐ post-tags$/)).toBe(true)
  // Search is in the proposal, so it opens though it waits.
  expect(await has(/^▾ Search$/)).toBe(true)
  expect(await has(/after tags/)).toBe(true)
  // Folding is the person's call.
  await ui.press({ key: 'phasetags' })
  expect(await has(/^◐ post-tags$/)).toBe(false)
  await ui.press({ key: 'phaseslugs' })
  expect(await has(/^✓ slugify$/)).toBe(true)
  await ui.unmount()
})

test('the card groups new jobs under their phase, and holds Approve until the draft is whole', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: PHASED }))
  const ui = await $.ui.mount(PANE)
  const has = async (t: RegExp) => Boolean(await ui.find({ type: 'Text', text: t }))
  expect(await has(/Plan change: 1 new phase, 1 new job/)).toBe(true)
  expect(await has(/^\+ Search$/)).toBe(true)
  expect(await has(/after Tags/)).toBe(true)
  expect(await has(/^\+ search$/)).toBe(true)
  expect(await has(/not ready to approve/)).toBe(true)
  expect(await ui.find({ type: 'Button', text: /^Approve$/ })).toBeUndefined()
  await ui.press({ key: 'cardphasesearch' })
  expect(await has(/^Readers can search posts$/)).toBe(true)
  await ui.unmount()
})

test('the agent drafts phases through its tools', async ($, on) => {
  const seen = engine(on, () => ({ exitCode: 0, stdout: 'drafted: add phase tags' }))
  const out = await $.tool.call({ tool: 'mcp__gmod__propose_phase', phase: { id: 'tags', outcome: 'Posts can be found by tag', after: ['slugs'] } } as never)
  expect(String(out.result)).toContain('add phase tags')
  expect(JSON.parse(String(seen.runs.find(r => r.args[0] === 'propose-phase')!.args[1])).after).toEqual(['slugs'])
  await $.tool.call({ tool: 'mcp__gmod__drop_phase', id: 'tags', reason: 'later' } as never)
  expect(seen.runs.find(r => r.args[0] === 'drop-phase')!.args).toEqual(['drop-phase', 'tags', '--reason', 'later'])
})

// ---- main moved under you ----

const MOVED = JSON.parse(STATUS)
MOVED.jobs[1].moved = { level: 'breaks', behind: 1, landed: ['rename-field'], changed: ['src/schema.mjs'], touched: ['src/schema.mjs'], conflicts: [], failing: ['sum adds'] }
MOVED.jobs[1].tests = 'green'
MOVED.jobs[1].stalled = false
const MOVED_STATUS = JSON.stringify(MOVED)

test('the pane flags a job that breaks on today\'s main, and asks for a rebase', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: MOVED_STATUS }))
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^✗ breaks on main · agent-1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /add-sum fails on today's main: rename-field changed src\/schema\.mjs \(agent-1\): rebase onto main/ })).toBeDefined()
  // The test dot: green here, amber because it no longer holds on main.
  const colors = (await ui.findAll({ type: 'Text', text: /^●$/ })).map(d => d.props?.color)
  expect(colors).toContain('yellow')
  await ui.unmount()
})

test('the agent hears it on its next step, from the folder it works in', async ($, on) => {
  const seen = await started($, on, args =>
    args[0] === 'notice' ? { exitCode: 0, stdout: 'gmod: rename-field landed on main and changed src/schema.mjs.' } : { exitCode: 0, stdout: args[0] === 'status' ? MOVED_STATUS : 'ok' },
  )
  const out = await $.tool.call({ tool: 'Write', file_path: '/repo-wt/src/b.mjs', content: 'x' })
  expect(out.context?.at(-1)).toBe('gmod: rename-field landed on main and changed src/schema.mjs.')
  expect(seen.runs.find(r => r.args[0] === 'notice')?.args[1]).toBe('/repo-wt/src/b.mjs')
})

test('nothing is asked while no job is affected', async ($, on) => {
  const seen = await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/b.mjs', content: 'x' })
  expect(seen.runs.some(r => r.args[0] === 'notice')).toBe(false)
})

test('a governed session checks main in the background', async ($, on) => {
  const every: number[] = []
  on('clock.every', (_, e) => {
    every.push((e as { ms: number }).ms)
    return { value: { cancel: () => undefined } } as never
  })
  await started($, on, () => ({ exitCode: 0, stdout: STATUS }))
  expect(every).toEqual([120_000])
})

// ---- gap 1: ADRs ----

const ADRS = JSON.parse(STATUS)
ADRS.proposal = null
ADRS.jobs[1].adrs = [{ id: '0001', title: 'Sums never round', rules: [{ level: 'must', text: 'never round inside sum' }] }]
ADRS.adrDrafts = [{ draft: 'cents-only', title: 'Money is integer cents', decision: 'Store and add money as integer cents.', scope: ['src/**'], rules: [{ level: 'must', text: 'no floats for money' }, { level: 'should', text: 'name amounts *Cents' }], supersedes: null, by: 'alice@x.io' }]
const ADR_STATUS = JSON.stringify(ADRS)

test('the agent drafts decisions and never accepts them', async ($, on) => {
  const seen = engine(on, args => (args[0] === 'adr' ? { exitCode: 0, stdout: 'drafted ADR cents-only: Money is integer cents.' } : { exitCode: 0, stdout: ADR_STATUS }))
  const out = await $.tool.call({ tool: 'mcp__gmod__adr_propose', title: 'Money is integer cents', decision: 'x', rules: [{ level: 'must', text: 'no floats' }] } as never)
  expect(String(out.result)).toContain("don't accept it yourself")
  const run = seen.runs.find(r => r.args[0] === 'adr')!
  expect(run.args[1]).toBe('propose')
  expect(JSON.parse(String(run.args[2])).title).toBe('Money is integer cents')
  expect((await $.tool.call({ tool: 'Bash', command: 'node ~/gmod/bin/gmod.mjs adr accept cents-only' })).deny).toContain("person's decision")
  expect((await $.command.run({ command: 'gmod', args: 'adr accept cents-only' } as never)).text).toContain('Only a person')
})

const ADR_PANE = { ...PANE, requestId: 'gmod-adr', props: { ...PANE.props, title: 'gmod · decision' } }

test('a decision draft is one line under Needs you; its card is in a pane of its own', async ($, on) => {
  const panes: Panes = { opened: [], closed: [] }
  const opened = panes.opened
  await started($, on, () => ({ exitCode: 0, stdout: ADR_STATUS }), panes)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^⚖ Decision waiting: Money is integer cents$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Decision: Money is integer cents$/ })).toBeUndefined()
  await ui.press({ key: 'adrreviewcents-only' })
  expect(opened.some(o => o.id === 'gmod-adr' && o.focus === true)).toBe(true)
  await ui.unmount()
})

test('the decision pane accepts, closes itself and hands back to the plan pane', async ($, on) => {
  const panes: Panes = { opened: [], closed: [] }
  const { opened, closed } = panes
  const seen = await started($, on, args => (args[0] === 'adr' ? { exitCode: 0, stdout: 'accepted ADR 0002: Money is integer cents' } : { exitCode: 0, stdout: ADR_STATUS }), panes)
  const ui = await $.ui.mount(ADR_PANE)
  expect(await ui.find({ type: 'Text', text: /^Decision: Money is integer cents$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^■ must no floats for money$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^governs src\/\*\*$/ })).toBeDefined()
  await ui.press({ key: 'adracceptcents-only' })
  expect(seen.runs.some(r => r.args[0] === 'adr' && r.args[1] === 'accept' && r.args[2] === 'cents-only')).toBe(true)
  expect(closed.some(c => c.id === 'gmod-adr')).toBe(true)
  expect(opened.at(-1)).toMatchObject({ id: 'gmod', focus: true })
  await ui.unmount()
})

test('a drafted decision opens its pane for the person', async ($, on) => {
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_, e) => (opened.push(e as unknown as Record<string, unknown>), { value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  engine(on, args => (args[0] === 'adr' ? { exitCode: 0, stdout: 'drafted ADR cents-only: Money is integer cents.' } : { exitCode: 0, stdout: ADR_STATUS }))
  await $.tool.call({ tool: 'mcp__gmod__adr_propose', title: 'Money is integer cents', decision: 'x', rules: [{ level: 'must', text: 'no floats' }] } as never)
  expect(opened.some(o => o.id === 'gmod-adr')).toBe(true)
})

test('an opened job shows the decisions that bind it', async ($, on) => {
  await started($, on, () => ({ exitCode: 0, stdout: ADR_STATUS }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'rowadd-sum' })
  expect(await ui.find({ type: 'Text', text: /^⚖ ADR 0001 Sums never round {2}must: never round inside sum$/ })).toBeDefined()
  await ui.unmount()
})

// ---- gap 4: the journal ----

test('the agent keeps a journal, and an opened job shows its last lines', async ($, on) => {
  const J = JSON.parse(STATUS)
  J.jobs[1].journal = [
    { at: '2026-11-01T10:00:00Z', by: 'alice@x.io', text: 'plain + is enough' },
    { at: '2026-11-01T10:05:00Z', by: 'check', text: 'red (sum adds)' },
  ]
  const seen = await started($, on, args => (args[0] === 'note' ? { exitCode: 0, stdout: 'noted in .gmod/journal/add-sum.md' } : { exitCode: 0, stdout: JSON.stringify(J) }))
  const out = await $.tool.call({ tool: 'mcp__gmod__note', text: 'trying a plain +', dir: '/repo-wt' } as never)
  expect(String(out.result)).toContain('noted')
  const run = seen.runs.find(r => r.args[0] === 'note')!
  expect([run.args[1], run.cwd]).toEqual(['trying a plain +', '/repo-wt'])
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'rowadd-sum' })
  expect(await ui.find({ type: 'Text', text: /^✎ 10:00 alice: plain \+ is enough$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✎ 10:05 red \(sum adds\)$/ })).toBeDefined()
  await ui.unmount()
})
