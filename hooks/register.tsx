import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { GmodJob, GmodPhase, GmodProposal, GmodStatus } from '../types'
import { decidesPlan, movesClaims, writesPlan, writesRecords } from './shell'

// The mod is thin: every rule lives in the gmod command (bin/gmod.mjs), the
// same one people run at a terminal and CI runs on pull requests.

const PANE = 'gmod'
const status = atom({ plugin: 'gmod', key: 'status' } as const, null, { shape: 'status-3' })
const allowPlan = atom({ plugin: 'gmod', key: 'allowPlan' } as const, false)
const open = atom({ plugin: 'gmod', key: 'open' } as const, null)
const asking = atom({ plugin: 'gmod', key: 'asking' } as const, false)
const cardOpen = atom({ plugin: 'gmod', key: 'cardOpen' } as const, null)
const showAssumptions = atom({ plugin: 'gmod', key: 'showAssumptions' } as const, false)
// Phases the person folded or unfolded; the rest follow where the work is.
const phaseOpen = atom({ plugin: 'gmod', key: 'phaseOpen' } as const, {})

const ROUTINE = `This repository plans its work in .gmod/plan.json, and the gmod mod enforces it:
- Take work with mcp__gmod__next and mcp__gmod__claim. Change only the claimed job's files; edits elsewhere are refused. Keep the job's journal with mcp__gmod__note: intent, decisions, dead ends.
- Write or change the tests first, run mcp__gmod__check and see it fail (red). Then make it pass and run mcp__gmod__check again (green).
- Commit only after green on exactly the files you commit, with the subject "<job>: …". The commit is refused otherwise.
- Plan changes are drafted with mcp__gmod__propose_phase / propose_job, edit_job and drop_job (bigger plans group jobs into phases, each with an outcome, ordered after other phases), then described with mcp__gmod__describe_proposal (one plain sentence of why, and your assumptions); the person approves them in the gmod pane or with /gmod approve. Never write .gmod/plan.json yourself.
- The pull request runs the same checks in CI and proves the tests fail without your change, then an AI reviewer reads it.`

// What a subagent is told, since its own prompt is the parent's call.
const FOR_SUBAGENTS = `

---
This repository's work is governed by gmod (.gmod/plan.json). If you work in a worktree of your own, pass its path as "dir" to every mcp__gmod__ tool, and claim your own job there before changing files. Edits outside the claimed job's files are refused; a commit needs a failing mcp__gmod__check first, then a passing one on exactly what you commit, with the subject "<job>: …".`

// The steps a job takes to main. Red then green is one step, "test": its
// dot is red while failing, green once it passes after failing.
const STEPS = ['claim', 'test', 'commit', 'push', 'merge'] as const
const TEST_WORDS = { none: 'no test run yet', red: 'failing', green: 'passing, after failing first', unproven: 'passing, but never failed: it proves nothing yet' } as const

type Run = { exitCode: number; stdout: string; stderr: string }

async function gmod($: EngineInterface, args: string[], dir?: string): Promise<Run> {
  const cwd = dir || (await $.session.cwd())
  return $.process.run(['node', `${$.plugin.root}/bin/gmod.mjs`, ...args], { cwd, timeoutMs: 10 * 60_000 })
}

async function refresh($: EngineInterface, sync = false): Promise<GmodStatus | null> {
  const r = await gmod($, ['status', ...(sync ? [] : ['--no-sync'])])
  let s: GmodStatus | null = null
  try {
    s = JSON.parse(r.stdout) as GmodStatus
  } catch {
    s = { governed: false, error: (r.stderr || r.stdout).trim() }
  }
  if (s && 'ok' in s && (s as { ok?: boolean }).ok === false) s = { governed: false }
  await update($, status, () => s)
  $.ui.status(line(s))
  return s
}

function line(s: GmodStatus | null): string | undefined {
  const draft = s?.proposal ? ` · plan change waiting for you` : ''
  if (!s?.governed) return draft ? `gmod${draft}` : undefined
  const jobs = s.jobs ?? []
  const done = jobs.filter(j => j.state === 'done').length
  const moving = jobs.filter(j => j.state === 'claimed').length
  return `gmod · ${done}/${jobs.length} done${moving ? ` · ${moving} in progress` : ''}${draft}`
}

function text(r: Run): string {
  return (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim()
}

function arg(e: unknown, key: string): string {
  const v = (e as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)
}

// Main moved under a job: the agent hears it on its next step, from the
// folder that step ran in, so a subagent in its own worktree hears about its
// own job. Only asked when some job is affected at all.
const MOVED_LEVELS = ['touched', 'conflicts', 'breaks']
async function withNotice<R extends ToolCallResult>($: EngineInterface, ran: R, path: string): Promise<R> {
  if (ran.deny !== undefined || !path) return ran
  const s = await read($, status)
  if (!(s?.jobs ?? []).some(j => j.moved && MOVED_LEVELS.includes(j.moved.level))) return ran
  const said = (await gmod($, ['notice', path])).stdout.trim()
  return said ? { ...ran, context: [...(ran.context ?? []), said] } : ran
}

async function guard($: EngineInterface, path: string): Promise<string | null> {
  const r = await gmod($, ['guard-path', path, ...((await read($, allowPlan)) ? ['--allow-plan'] : [])])
  return r.exitCode === 0 ? null : `gmod: ${text(r)}`
}

// The commit gate runs inside the agent's own shell, as `git commit` starts:
// wherever the shell is by then (a subagent's worktree, after a cd), that
// worktree's claim and runs decide.
function gated(cli: string, command: string): string {
  const q = `'${cli.replace(/'/g, `'\\''`)}'`
  return `git() { _gs=; _gk=0; for _ga in "$@"; do if [ "$_gk" = 1 ]; then _gk=0; continue; fi; case "$_ga" in -C|-c|--git-dir|--work-tree|--namespace) _gk=1;; -*) ;; *) _gs="$_ga"; break;; esac; done; if [ "$_gs" = commit ]; then node ${q} gate-commit --shell || return 1; fi; command git "$@"; }\n${command}`
}

// One dot per step, under the step's name: each column is the name's width
// plus a gap, the dot in its middle.
const ID_MIN = 8
const ID_MAX = 20
const NOTE_ROOM = 12
const MOVED_EVERY = 120_000
const GAP = 2
const STEPS_WIDTH = STEPS.reduce((n, name) => n + name.length + GAP, 0)

type Dot = { filled: boolean; color?: 'green' | 'red' | 'yellow' }

function dots(j: GmodJob): Dot[] {
  const done = j.state === 'done'
  // Passing here but failing on today's main: proven no longer.
  const test = done ? undefined : j.moved?.level === 'breaks' ? 'yellow' : ({ none: undefined, red: 'red', green: 'green', unproven: 'yellow' } as const)[j.tests]
  return [
    { filled: done || j.stage >= 1 },
    { filled: done || j.tests !== 'none', color: test },
    { filled: j.stage >= 4 },
    { filled: j.stage >= 5 },
    { filled: j.stage >= 6 },
  ]
}


function bar(done: number, total: number, width: number): string {
  const full = total ? Math.round((done / total) * width) : 0
  return '━'.repeat(full) + '┄'.repeat(width - full)
}

const DIR = { dir: { type: 'string', description: 'Your working directory, when you work in a worktree of your own; leave it out otherwise.' } }
const JOB = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'lowercase-with-dashes; commits and pull requests start with it' },
    goal: { type: 'string', description: 'What this job achieves, in about 8 plain words (it is one line of the proposal card); detail goes in brief' },
    brief: { type: 'string', description: 'A few sentences of context: where, what, what not' },
    files: { type: 'array', items: { type: 'string' }, description: 'Globs of the code it may change' },
    tests: { type: 'array', items: { type: 'string' }, description: 'Globs of its tests' },
    done_when: {
      type: 'array',
      items: { type: 'object', properties: { text: { type: 'string' }, check: { type: 'string', description: 'A name under checks' } }, required: ['text', 'check'] },
    },
    phase: { type: 'string', description: 'The phase it belongs to, when the plan has phases' },
    after: { type: 'array', items: { type: 'string' }, description: 'Jobs that must be done first (beyond what its phase already waits for)' },
  },
  required: ['id', 'goal', 'files', 'done_when'],
}
const PHASE = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'lowercase-with-dashes' },
    title: { type: 'string', description: 'A short name, two or three words' },
    outcome: { type: 'string', description: 'One plain sentence: what is true once every job in it is done' },
    after: { type: 'array', items: { type: 'string' }, description: 'Phases that must be done first: every job here waits for every job there' },
  },
  required: ['id', 'outcome'],
}
const CHECKS = { type: 'object', additionalProperties: { type: 'string' }, description: 'New or changed checks: name → shell command, exit 0 when the criterion holds' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gmod',
      description: 'Planned work: /gmod (the pane), next, claim <job>, check, release, proposal, approve, reject, allow-plan, lock-plan',
    })
    await $.tool.register({ name: 'next', description: 'The first job in .gmod/plan.json that is ready to take, with its goal.', inputSchema: { type: 'object', properties: DIR }, isDeferred: false })
    await $.tool.register({ name: 'claim', description: 'Claim a job before changing any of its files. Claims are shared through git; the first claim wins.', inputSchema: { type: 'object', properties: { job: { type: 'string' }, ...DIR }, required: ['job'] }, isDeferred: false })
    await $.tool.register({ name: 'check', description: "Run the claimed job's criteria and record the result: red while they fail, green once they pass. A commit needs red first, then green on exactly the files committed.", inputSchema: { type: 'object', properties: DIR }, isDeferred: false })
    await $.tool.register({ name: 'release', description: 'Let go of the claimed job, for example to hand it back unfinished.', inputSchema: { type: 'object', properties: DIR }, isDeferred: false })
    await $.tool.register({ name: 'status', description: 'The claimed job, its allowed files, its criteria, the recorded runs, every job\'s stage, and any drafted plan change.', inputSchema: { type: 'object', properties: DIR }, isDeferred: false })
    await $.tool.register({ name: 'propose_job', description: 'Draft a new job, or replace one, in the plan proposal. The person sees the draft in the gmod pane and approves it there or with /gmod approve. Keep jobs small: one reviewable pull request each.', inputSchema: { type: 'object', properties: { job: JOB, checks: CHECKS }, required: ['job'] }, isDeferred: false })
    await $.tool.register({ name: 'edit_job', description: 'Change fields of a job in the plan proposal (goal, brief, files, tests, done_when, after).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, changes: { type: 'object' }, checks: CHECKS }, required: ['id', 'changes'] }, isDeferred: false })
    await $.tool.register({ name: 'drop_job', description: 'Take a job out of the plan proposal, saying why. Done or claimed jobs stay.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] }, isDeferred: false })
    await $.tool.register({ name: 'propose_phase', description: 'Draft a phase, or replace one: a group of jobs with an outcome, ordered after other phases. Put jobs in it with their "phase" field. A plan with phases needs every job in one before the person can approve it.', inputSchema: { type: 'object', properties: { phase: PHASE }, required: ['phase'] }, isDeferred: false })
    await $.tool.register({ name: 'edit_phase', description: "Change a phase's title, outcome or after in the plan proposal.", inputSchema: { type: 'object', properties: { id: { type: 'string' }, changes: { type: 'object' } }, required: ['id', 'changes'] }, isDeferred: false })
    await $.tool.register({ name: 'drop_phase', description: 'Take an empty phase out of the plan proposal, saying why. Move or drop its jobs first.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] }, isDeferred: false })
    await $.tool.register({ name: 'note', description: "Add a line to the claimed job's journal (.gmod/journal/<job>.md), which goes into its pull request for the reviewer: what you're about to try and why, a decision you made, a dead end and what you learned. Checks add red/green there by themselves.", inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...DIR }, required: ['text'] }, isDeferred: false })
    await $.tool.register({ name: 'adr_propose', description: 'Draft an architecture decision record: a decision agents must follow from now on. Give it a short title, the scope (globs of the files it governs; empty for the whole repository), the context, the decision, and its rules, each {level: "must" | "should", text}. The person accepts it; then it binds every job whose files it covers, and CI holds pull requests to it.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, scope: { type: 'array', items: { type: 'string' } }, context: { type: 'string' }, decision: { type: 'string' }, rules: { type: 'array', items: { type: 'object', properties: { level: { type: 'string', enum: ['must', 'should'] }, text: { type: 'string' } }, required: ['level', 'text'] } }, supersedes: { type: 'string', description: 'The id of an ADR this one replaces, e.g. 0003' } }, required: ['title', 'decision', 'rules'] }, isDeferred: false })
    await $.tool.register({ name: 'describe_proposal', description: 'Say what the plan proposal is for, in one short plain sentence (under 25 words) a non-engineer understands, and list the assumptions the person is really approving (choices you made that they might not have). Shown at the top of the proposal card.', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } } } }, isDeferred: false })
    const s = await refresh($, true)
    if ((s?.governed || s?.proposal) && (await $.session.surfaces()).length) void $.ui.open({ id: PANE, title: 'gmod' })
    // Every two minutes: fetch main, and run the checks of any job a landing
    // touched, on its work merged onto the new main.
    if (s?.governed) $.clock.every(MOVED_EVERY, async () => {
      await gmod($, ['moved', '--run', '--json'])
      await refresh($)
    })
    return next(e)
  })

  // ---- the agent's tools: doing the work ----

  on('tool.call', { tool: 'mcp__gmod__next' }, async ($, e) => ({ result: text(await gmod($, ['next'], arg(e, 'dir'))) }))
  on('tool.call', { tool: 'mcp__gmod__claim' }, async ($, e) => {
    const r = await gmod($, ['claim', arg(e, 'job')], arg(e, 'dir'))
    await refresh($)
    return r.exitCode === 0 ? { result: text(r) } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__check' }, async ($, e) => {
    const r = await gmod($, ['check'], arg(e, 'dir'))
    await refresh($)
    return withNotice($, { result: text(r) } as ToolCallResult, arg(e, 'dir') || (await $.session.cwd()))
  })
  on('tool.call', { tool: 'mcp__gmod__release' }, async ($, e) => {
    const r = await gmod($, ['release'], arg(e, 'dir'))
    await refresh($)
    return { result: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__status' }, async ($, e) => {
    const r = await gmod($, ['status', '--no-sync'], arg(e, 'dir'))
    if (!arg(e, 'dir')) await refresh($)
    return { result: r.stdout.trim() }
  })

  // ---- the agent's tools: drafting the plan ----

  on('tool.call', { tool: 'mcp__gmod__propose_job' }, async ($, e) => {
    const checks = arg(e, 'checks')
    const r = await gmod($, ['propose-job', arg(e, 'job'), ...(checks ? ['--checks', checks] : [])])
    await refresh($)
    return r.exitCode === 0 ? { result: `${text(r)}. When the draft is complete, describe it with mcp__gmod__describe_proposal; the person approves it in the gmod pane or with /gmod approve.` } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__edit_job' }, async ($, e) => {
    const checks = arg(e, 'checks')
    const r = await gmod($, ['edit-job', arg(e, 'id'), arg(e, 'changes'), ...(checks ? ['--checks', checks] : [])])
    await refresh($)
    return r.exitCode === 0 ? { result: text(r) } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__drop_job' }, async ($, e) => {
    const reason = arg(e, 'reason')
    const r = await gmod($, ['drop-job', arg(e, 'id'), ...(reason ? ['--reason', reason] : [])])
    await refresh($)
    return r.exitCode === 0 ? { result: text(r) } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__propose_phase' }, async ($, e) => {
    const r = await gmod($, ['propose-phase', arg(e, 'phase')])
    await refresh($)
    return r.exitCode === 0 ? { result: text(r) } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__edit_phase' }, async ($, e) => {
    const r = await gmod($, ['edit-phase', arg(e, 'id'), arg(e, 'changes')])
    await refresh($)
    return r.exitCode === 0 ? { result: text(r) } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__drop_phase' }, async ($, e) => {
    const reason = arg(e, 'reason')
    const r = await gmod($, ['drop-phase', arg(e, 'id'), ...(reason ? ['--reason', reason] : [])])
    await refresh($)
    return r.exitCode === 0 ? { result: text(r) } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__note' }, async ($, e) => {
    const r = await gmod($, ['note', arg(e, 'text')], arg(e, 'dir'))
    await refresh($)
    return r.exitCode === 0 ? { result: text(r) } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__adr_propose' }, async ($, e) => {
    const draft = Object.fromEntries(['title', 'scope', 'context', 'decision', 'rules', 'supersedes'].map(k => [k, (e as unknown as Record<string, unknown>)[k]]).filter(([, v]) => v !== undefined))
    const r = await gmod($, ['adr', 'propose', JSON.stringify(draft)])
    await refresh($)
    return r.exitCode === 0 ? { result: `${text(r)} The person sees it in the gmod pane; don't accept it yourself.` } : { deny: text(r) }
  })
  on('tool.call', { tool: 'mcp__gmod__describe_proposal' }, async ($, e) => {
    const summary = arg(e, 'summary')
    const assumptions = arg(e, 'assumptions')
    const r = await gmod($, ['describe-proposal', ...(summary ? ['--summary', summary] : []), ...(assumptions ? ['--assumptions', assumptions] : [])])
    await refresh($)
    return r.exitCode === 0 ? { result: 'Described. The person sees it at the top of the proposal card, with Approve, Ask for changes and Reject.' } : { deny: text(r) }
  })

  // ---- guards ----

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const refused = await guard($, e.file_path)
    return refused ? { deny: refused } : withNotice($, await next(e), e.file_path)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'gmod: its file guard failed; nothing was changed' }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const refused = await guard($, e.file_path)
    return refused ? { deny: refused } : withNotice($, await next(e), e.file_path)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'gmod: its file guard failed; nothing was changed' }))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const refused = await guard($, e.notebook_path)
    return refused ? { deny: refused } : withNotice($, await next(e), e.notebook_path)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'gmod: its file guard failed; nothing was changed' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = e.command
    if (movesClaims(cmd)) return { deny: 'gmod: claims change only through mcp__gmod__claim and mcp__gmod__release' }
    if (decidesPlan(cmd)) return { deny: "gmod: approving or rejecting the plan is the person's decision: they do it in the gmod pane or with /gmod approve" }
    if (writesRecords(cmd)) return { deny: "gmod: gmod's own records change only through gmod" }
    if (writesPlan(cmd) && !(await read($, allowPlan))) {
      return { deny: 'gmod: .gmod/plan.json changes only through a proposal the person approves (mcp__gmod__propose_job), or after /gmod allow-plan' }
    }
    const command = /\bcommit\b/.test(cmd) ? gated(`${$.plugin.root}/bin/gmod.mjs`, cmd) : cmd
    const ran = await next(command === cmd ? e : { ...e, command })
    if (/\bgit\b|gmod/.test(cmd)) await refresh($)
    return withNotice($, ran, await $.session.cwd())
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'gmod: its command guard failed; nothing ran' }))

  // A subagent is told the routine in its own prompt.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const s = await read($, status)
    return s?.governed ? next({ ...e, prompt: e.prompt + FOR_SUBAGENTS }) : next(e)
  }).catch(($, e, next) => next(e))

  // ---- the person's command ----

  on('command.run', { command: 'gmod' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const isPerson = e.origin?.kind === 'composer'
    switch (sub) {
      case '':
      case 'status':
      case 'plan': {
        const s = await refresh($, true)
        if ((await $.session.surfaces()).length) await $.ui.open({ id: PANE, title: 'gmod' })
        if (s?.governed || s?.proposal) return { text: line(s) ?? 'gmod' }
        return { text: 'No plan here yet. Start one with /gmod:plan, or describe the work and ask Claude to plan it.' }
      }
      case 'approve': {
        if (!isPerson) return { text: 'Only a person at the prompt can approve the plan.' }
        const r = await gmod($, ['approve'])
        await refresh($)
        return { text: text(r), context: r.exitCode === 0 ? [`The person approved the plan proposal: ${text(r)}`] : undefined }
      }
      case 'reject': {
        if (!isPerson) return { text: 'Only a person at the prompt can reject the plan proposal.' }
        const r = await gmod($, ['reject', ...rest])
        await refresh($)
        return { text: text(r), context: r.exitCode === 0 ? [`The person rejected the plan proposal${rest.length ? `: "${rest.join(' ')}"` : ''}. Ask what they want instead before drafting again.`] : undefined }
      }
      case 'adr': {
        const [what = 'drafts', ...more] = rest
        if (['accept', 'reject'].includes(what) && !isPerson) return { text: `Only a person at the prompt can ${what} a decision.` }
        const r = await gmod($, ['adr', what, ...more])
        await refresh($)
        return {
          text: text(r),
          context: r.exitCode === 0 && ['accept', 'reject'].includes(what) ? [`The person ${what === 'accept' ? 'accepted' : 'rejected'} the decision draft: ${text(r)}`] : undefined,
        }
      }
      case 'allow-plan':
        if (!isPerson) return { text: 'Only a person at the prompt can allow plan changes.' }
        await update($, allowPlan, () => true)
        return { text: 'The agent may now edit .gmod/plan.json directly, until /gmod lock-plan. Proposals are the usual way; this is for bulk edits.' }
      case 'lock-plan':
        await update($, allowPlan, () => false)
        return { text: '.gmod/plan.json is locked again.' }
      case 'next':
      case 'claim':
      case 'release':
      case 'check':
      case 'proposal':
      case 'sweep': {
        const r = await gmod($, [sub, ...rest])
        await refresh($)
        return { text: text(r) }
      }
      default:
        return { text: 'Usage: /gmod [plan | next | claim <job> | check | release | proposal | approve | reject [why] | adr [drafts | list | accept <draft> | reject <draft> [why]] | allow-plan | lock-plan | sweep]' }
    }
  })

  // ---- what the agent is told ----

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const s = await read($, status)
    if (!s?.governed && !s?.proposal) return composed
    const decisions = (s.claim?.adrs ?? []).map(a => `- ADR ${a.id} (${a.title}):\n${a.rules.map(r => `  - ${r.level}: ${r.text}`).join('\n')}`).join('\n')
    const now = s.claim
      ? `\nYou hold ${s.claim.job}: ${s.claim.goal}\nIts files: ${s.claim.files.join(', ')}\nDone when:\n${s.claim.done_when.map(c => `- ${c}`).join('\n')}${decisions ? `\nDecisions that bind this job (a "must" is never broken; to change one, draft a new ADR with mcp__gmod__adr_propose):\n${decisions}` : ''}`
      : `\nNo job is claimed${s.next ? `; the next ready one is ${s.next}` : ''}.`
    const draft = s.proposal ? `\nA plan proposal is waiting for the person: ${s.proposal.summary}.` : ''
    return { sections: [...composed.sections, { id: 'gmod:routine', text: ROUTINE + now + draft, scope: 'session' as const }] }
  })

  // ---- the pane ----
  //
  //   Plan  ━━━━━━┄┄┄┄┄┄  1 of 3 done · 2 in progress
  //   ╭ Needs you ──────────────────────────────╮
  //   │ the proposal card, with its buttons      │
  //   ╰──────────────────────────────────────────╯
  //   ✓ slugify        ●━●━●━●━●━●  merged
  //   ◐ slug-unique    ●━●┄○┄○┄○┄○  red · agent-1
  //   (the dots: claim, red, green, commit, push, merge)
  //       (press a row to open it: goal, done-when ✓/✗, files)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Every surface but mobile takes typed input.
    const Input = 'Input' in els ? els.Input : undefined
    const s = await read($, status)
    const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

    if (!s?.governed && !s?.proposal) {
      return (
        <Box flexDirection="column">
          <Text bold>gmod</Text>
          <Text dimColor>{s?.error ? s.error : 'No plan here yet.'}</Text>
          <Text dimColor>Start one with /gmod:plan and say what you want built.</Text>
        </Box>
      )
    }

    const jobs = s.jobs ?? []
    const done = jobs.filter(j => j.state === 'done').length
    const moving = jobs.filter(j => j.state === 'claimed').length
    const waiting = jobs.filter(j => j.state === 'waiting').length
    const stalled = jobs.filter(j => j.stalled)
    const opened = await read($, open)
    const isAsking = await read($, asking)
    const openInCard = await read($, cardOpen)
    const assumptionsOpen = await read($, showAssumptions)
    const folds = (await read($, phaseOpen)) as Record<string, boolean>
    const phases = s.phases ?? []
    const p = s.proposal

    async function decide(choice: 'approve' | 'reject') {
      const r = await gmod($, [choice])
      await refresh($)
      $.ui.toast(cut(text(r), 120))
    }

    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

    // The proposal, short: why, one line per job, then the decision. A job
    // line opens to its criteria and files; assumptions open on demand.
    function card(p: GmodProposal) {
      const { added, changed, dropped } = p.diff
      const ph = p.diff.phases
      const title = [
        ph.added.length && plural(ph.added.length, 'new phase'),
        added.length && plural(added.length, 'new job'),
        changed.length + ph.changed.length && `${changed.length + ph.changed.length} changed`,
        dropped.length + ph.dropped.length && `${dropped.length + ph.dropped.length} dropped`,
      ]
        .filter(Boolean)
        .join(', ')
      const idWidth = Math.min(18, Math.max(...[...added, ...changed, ...dropped].map(j => j.id.length), 4) + 2)
      const startNow = p.order.filter(o => o.now).length
      const toggle = (id: string) => update($, cardOpen, v => (v === id ? null : id))
      const line = (key: string, mark: string, color: 'green' | 'yellow' | 'red', id: string, words: string, tag: string, struck = false, indent = 0) => (
        <Box key={`${key}-line`} flexDirection="row" paddingLeft={indent}>
          <Box width={idWidth + 2} flexShrink={0}>
            <Button key={key} plain onPress={() => toggle(id)}>
              <Text color={color} strikethrough={struck}>
                {openInCard === id ? '▾' : mark} {id}
              </Text>
            </Button>
          </Box>
          <Box flexShrink={1}>
            <Text wrap="wrap">
              {words}
              {tag ? <Text dimColor>  {tag}</Text> : null}
            </Text>
          </Box>
        </Box>
      )
      const jobLines = (list: typeof added, indent: number) =>
        list.map(j => (
          <Box key={`+${j.id}`} flexDirection="column">
            {line(`card${j.id}`, '+', 'green', j.id, j.goal, j.after.length ? `after ${j.after.join(', ')}` : '', false, indent)}
            {openInCard === j.id && (
              <Box flexDirection="column" paddingLeft={indent + idWidth + 2}>
                {j.criteria.map(c => (
                  <Text key={c} dimColor wrap="wrap">◦ {c}</Text>
                ))}
                <Text dimColor wrap="wrap">may change {j.paths.join(', ')}</Text>
              </Box>
            )}
          </Box>
        ))
      const changedLines = (list: typeof changed, indent: number) =>
        list.map(j => (
          <Box key={`~${j.id}`} flexDirection="column">
            {line(`card${j.id}`, '~', 'yellow', j.id, `changes ${j.fields.join(', ')}`, '', false, indent)}
            {openInCard === j.id &&
              j.changes.map(c => (
                <Box key={c.field} flexDirection="column" paddingLeft={indent + idWidth + 2}>
                  <Text dimColor>{c.field}</Text>
                  <Text color="red" strikethrough wrap="wrap">{c.before}</Text>
                  <Text color="green" wrap="wrap">{c.after}</Text>
                </Box>
              ))}
          </Box>
        ))
      // With phases, jobs sit under the phase they belong to: new phases
      // first, then existing phases that gain or change jobs.
      const phaseIds = [...ph.added.map(x => x.id), ...ph.changed.map(x => x.id), ...[...added, ...changed].map(j => j.phase).filter((x): x is string => !!x)]
      const grouped = [...new Set(phaseIds)]
      const known = new Map([...ph.added, ...ph.changed].map(x => [x.id, x]))
      const titleOf = (id: string) => known.get(id)?.title ?? phases.find(x => x.id === id)?.title ?? id
      const body = grouped.length ? (
        <Box flexDirection="column" marginTop={1}>
          {grouped.map(id => {
            const isNew = ph.added.some(x => x.id === id)
            const edit = ph.changed.find(x => x.id === id)
            const card = known.get(id)
            return (
              <Box key={`cph${id}`} flexDirection="column" marginBottom={1}>
                <Box flexDirection="row">
                  <Button key={`cardphase${id}`} plain onPress={() => toggle(`phase:${id}`)}>
                    <Text bold color={isNew ? 'green' : edit ? 'yellow' : undefined}>
                      {openInCard === `phase:${id}` ? '▾' : isNew ? '+' : edit ? '~' : '·'} {titleOf(id)}
                    </Text>
                  </Button>
                  <Text dimColor>
                    {card?.after.length ? `  after ${card.after.map(titleOf).join(', ')}` : ''}
                    {edit ? `  changes ${edit.fields.join(', ')}` : ''}
                  </Text>
                </Box>
                {openInCard === `phase:${id}` && card && (
                  <Box flexDirection="column" paddingLeft={2}>
                    <Text dimColor italic wrap="wrap">{card.outcome}</Text>
                    {edit?.changes.map(c => (
                      <Box key={c.field} flexDirection="column">
                        <Text dimColor>{c.field}</Text>
                        <Text color="red" strikethrough wrap="wrap">{c.before}</Text>
                        <Text color="green" wrap="wrap">{c.after}</Text>
                      </Box>
                    ))}
                  </Box>
                )}
                {jobLines(added.filter(j => j.phase === id), 2)}
                {changedLines(changed.filter(j => j.phase === id), 2)}
              </Box>
            )
          })}
          {jobLines(added.filter(j => !j.phase), 0)}
          {changedLines(changed.filter(j => !j.phase), 0)}
          {ph.dropped.map(x => line(`cardphase-${x.id}`, '−', 'red', x.title, x.reason ? `why: ${x.reason}` : x.outcome, '', true))}
          {dropped.map(j => line(`card${j.id}`, '−', 'red', j.id, j.reason ? `why: ${j.reason}` : j.goal, '', true))}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {jobLines(added, 0)}
          {changedLines(changed, 0)}
          {ph.dropped.map(x => line(`cardphase-${x.id}`, '−', 'red', x.title, x.reason ? `why: ${x.reason}` : x.outcome, '', true))}
          {dropped.map(j => line(`card${j.id}`, '−', 'red', j.id, j.reason ? `why: ${j.reason}` : j.goal, '', true))}
        </Box>
      )
      return (
        <Box key="proposal" flexDirection="column" borderStyle="round" borderColor={p.stale ? 'red' : 'cyan'} paddingX={1}>
          <Text bold>Plan change: {title || 'no changes'}</Text>
          {p.headline ? <Text wrap="wrap">{p.headline}</Text> : <Text dimColor italic>No summary yet: ask Claude to describe it.</Text>}
          {body}
          {p.warnings.map(w => (
            <Text key={w} color="yellow" wrap="wrap">! {w}</Text>
          ))}
          <Box flexDirection="row" marginTop={1} gap={3}>
            {p.assumptions.length > 0 && (
              <Button key="assumptions" plain onPress={() => update($, showAssumptions, v => !v)}>
                <Text dimColor>{plural(p.assumptions.length, 'assumption')} {assumptionsOpen ? '▾' : '▸'}</Text>
              </Button>
            )}
            {startNow > 1 && !p.warnings.some(w => /same files/.test(w)) && <Text dimColor>{startNow} can start now, side by side</Text>}
          </Box>
          {assumptionsOpen &&
            p.assumptions.map(a => (
              <Text key={a} dimColor wrap="wrap">· {a}</Text>
            ))}
          <Box flexDirection="row" gap={2} marginTop={1}>
            {p.ready && (
              <Button key="approve" variant="primary" onPress={() => decide('approve')}>
                Approve
              </Button>
            )}
            <Button key="ask" onPress={() => update($, asking, v => !v)}>
              Suggest a change…
            </Button>
            <Button key="reject" onPress={() => decide('reject')}>
              Reject
            </Button>
          </Box>
          {isAsking && Input && (
            // The question on its own line, the field on a full-width row of
            // its own: sharing a row, the terminal overflows the card and the
            // desktop squeezes the field to nothing.
            <Box key="ask-box" flexDirection="column" marginTop={1} width="100%">
              <Text dimColor wrap="wrap">What would you change? Claude revises the draft.</Text>
              <Box width="100%" flexGrow={1}>
                <Input
                  key="ask-note"
                  placeholder="e.g. keep tags as typed"
                  submitLabel="Send"
                  rows={2}
                  autoFocus
                  onSubmit={async (note: string) => {
                    await update($, asking, () => false)
                    if (note.trim()) await $.prompt.submit({ text: `Please revise the plan proposal: ${note.trim()}` })
                  }}
                />
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    // Only what the dots can't say: who has a job, or what it waits for.
    // Non-breaking spaces keep a label like "agent 2" on one line.
    const notes = new Map(
      jobs.map(j => {
        // A job whose whole phase waits says nothing: its heading does.
        const phaseWaits = (s.phases ?? []).some(ph => ph.id === j.phase && ph.state === 'waiting')
        const moved = j.moved?.level === 'breaks' ? '✗ breaks on main · ' : j.moved?.level === 'conflicts' ? '✗ conflicts · ' : j.moved?.level === 'touched' ? '⚠ main moved · ' : ''
        const who = j.state === 'waiting' ? (phaseWaits ? '' : `after ${j.waiting.join(', ')}`) : j.state === 'claimed' ? (j.where === 'here' ? 'you' : j.where && j.where !== 'elsewhere' ? j.where : (j.by ?? '')) : ''
        const raw = (moved + who).replace(/ · $/, '')
        return [j.id, raw.replace(/ /g, '\u00a0')] as const
      }),
    )
    // The name column takes what the dots and the longest note leave.
    const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? 80
    const longestNote = Math.max(0, ...[...notes.values()].map(n => n.length))
    const longestId = Math.max(4, ...jobs.map(j => j.id.length))
    // Under phase headings the names sit two in; the column makes room.
    const indent = (s.phases ?? []).length ? 2 : 0
    // Names come first: a note takes at most NOTE_ROOM from them and is cut
    // short past that.
    const idWidth = Math.max(ID_MIN, Math.min(ID_MAX + indent, longestId + indent, columns - 3 - STEPS_WIDTH - Math.min(longestNote, NOTE_ROOM)))

    // One job: its name, a dot per step, and only what the dots can't say.
    // `indent` shifts it under a phase heading; the dots stay in their columns.
    function jobRow(j: GmodJob, indent: number) {
      const isOpen = opened === j.id
      const icon = j.state === 'done' ? '✓' : j.state === 'claimed' ? '◐' : j.state === 'waiting' ? '…' : '○'
      const note = notes.get(j.id) ?? ''
      return (
        <Box key={j.id} flexDirection="column">
          <Box key={`line${j.id}`} flexDirection="row">
            <Box width={idWidth + 3} flexShrink={0} paddingLeft={indent}>
              <Button key={`row${j.id}`} plain onPress={() => update($, open, v => (v === j.id ? null : j.id))}>
                <Text dimColor={j.state === 'done'} wrap="truncate-end">
                  {isOpen ? '▾' : icon} {cut(j.id, idWidth - indent)}
                </Text>
              </Button>
            </Box>
            {dots(j).map((d, i) => (
              <Box key={`d${i}`} width={STEPS[i]!.length + GAP} flexShrink={0} paddingLeft={Math.floor((STEPS[i]!.length - 1) / 2)}>
                <Text color={d.color} dimColor={!d.filled} hover={{ scope: `gmod-step-${i}`, color: 'cyan', bold: true }}>
                  {d.filled ? '●' : '○'}
                </Text>
              </Box>
            ))}
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {note}
              </Text>
            </Box>
          </Box>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={indent + 2} marginBottom={1}>
              <Text>
                {dots(j).map((d, i) => (
                  <Text key={STEPS[i]} color={d.filled ? (d.color ?? 'green') : undefined} dimColor={!d.filled}>
                    {d.filled ? (d.color === 'red' ? '✗' : d.color === 'yellow' ? '!' : '✓') : '○'} {STEPS[i]}{'  '}
                  </Text>
                ))}
              </Text>
              {j.state === 'claimed' && <Text dimColor>test: {TEST_WORDS[j.tests]}</Text>}
              <Text wrap="wrap">{j.goal}</Text>
              {j.criteria.map(c => (
                <Text key={c.text} color={c.pass === true ? 'green' : c.pass === false ? 'red' : undefined} dimColor={c.pass === null} wrap="wrap">
                  {c.pass === true ? '✓' : c.pass === false ? '✗' : '◦'} {c.text}
                </Text>
              ))}
              <Text dimColor wrap="wrap">may change {j.files.join(', ')}</Text>
              {(j.adrs ?? []).map(a => (
                <Text key={`adr${a.id}`} color="cyan" wrap="wrap">
                  ⚖ ADR {a.id} {a.title}
                  <Text dimColor>{a.rules.some(r => r.level === 'must') ? `  must: ${a.rules.filter(r => r.level === 'must').map(r => r.text).join('; ')}` : ''}</Text>
                </Text>
              ))}
              {(j.journal ?? []).slice(-3).map(n => (
                <Text key={`j${n.at}`} dimColor wrap="wrap">
                  ✎ {n.at.slice(11, 16)} {n.by === 'check' ? '' : `${n.by.split('@')[0]}: `}
                  {n.text}
                </Text>
              ))}
              {j.by && <Text dimColor>claimed by {j.by}</Text>}
            </Box>
          )}
        </Box>
      )
    }

    // A phase: a heading that says where it stands, folding its jobs away.
    // Open by default where the work is: the active phase, one with a red
    // job or touched by the proposal, else the first that may start.
    const firstReady = phases.find(ph => ph.state === 'ready')?.id
    const anyActive = phases.some(ph => ph.state === 'active')
    const touched = new Set([...(p?.diff.added ?? []), ...(p?.diff.changed ?? [])].map(j => j.phase).filter((x): x is string => !!x))
    function isPhaseOpen(ph: GmodPhase): boolean {
      if (ph.id in folds) return folds[ph.id]!
      return ph.state === 'active' || ph.stalled || touched.has(ph.id) || (!anyActive && ph.id === firstReady)
    }
    function phaseGroup(ph: GmodPhase) {
      const isOpenP = isPhaseOpen(ph)
      const summary =
        ph.state === 'done' ? `✓ ${ph.done} of ${ph.total}` : ph.state === 'waiting' ? `after ${ph.waiting.join(', ')}` : `${ph.done} of ${ph.total}${ph.moving ? ` · ${ph.moving} in progress` : ''}`
      const members = jobs.filter(j => ph.jobs.includes(j.id))
      return (
        <Box key={`phase${ph.id}`} flexDirection="column">
          <Box key={`ph-line${ph.id}`} flexDirection="row">
            <Button key={`phase${ph.id}`} plain onPress={() => update($, phaseOpen, m => ({ ...m, [ph.id]: !isOpenP }))}>
              <Text bold={ph.state !== 'done'} dimColor={ph.state === 'done' || ph.state === 'waiting'} color={ph.stalled ? 'red' : undefined}>
                {isOpenP ? '▾' : '▸'} {ph.title}
              </Text>
            </Button>
            <Text dimColor>{'  '}{summary}</Text>
          </Box>
          {isOpenP && (
            <Box flexDirection="column">
              <Box paddingLeft={2}>
                <Text dimColor italic wrap="wrap">{ph.outcome}</Text>
              </Box>
              {members.map(j => jobRow(j, 2))}
            </Box>
          )}
        </Box>
      )
    }

    const broken = jobs.filter(j => j.moved && ['conflicts', 'breaks'].includes(j.moved.level))
    const adrDrafts = s.adrDrafts ?? []
    const needs = Boolean(p) || stalled.length > 0 || broken.length > 0 || adrDrafts.length > 0

    async function decideAdr(choice: 'accept' | 'reject', draft: string) {
      const r = await gmod($, ['adr', choice, draft])
      await refresh($)
      $.ui.toast(cut(text(r), 120))
    }

    // A decision draft: the title, what was decided, its rules, and the yes.
    function adrCard(d: (typeof adrDrafts)[number]) {
      return (
        <Box key={`adrcard${d.draft}`} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
          <Text bold>Decision: {d.title}</Text>
          <Text wrap="wrap">{d.decision}</Text>
          {d.rules.map(r => (
            <Text key={r.text} color={r.level === 'must' ? 'magenta' : undefined} dimColor={r.level === 'should'} wrap="wrap">
              {r.level === 'must' ? '■ must' : '□ should'} {r.text}
            </Text>
          ))}
          <Text dimColor wrap="wrap">
            governs {d.scope.length ? d.scope.join(', ') : 'the whole repository'}
            {d.supersedes ? ` · replaces ADR ${d.supersedes}` : ''}
          </Text>
          <Box flexDirection="row" gap={2} marginTop={1}>
            <Button key={`adraccept${d.draft}`} variant="primary" onPress={() => decideAdr('accept', d.draft)}>
              Accept
            </Button>
            <Button key={`adrreject${d.draft}`} onPress={() => decideAdr('reject', d.draft)}>
              Reject
            </Button>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Plan </Text>
          <Text color="green">{bar(done, jobs.length, 12)}</Text>
          <Text dimColor>
            {'  '}{done} of {jobs.length} done{moving ? ` · ${moving} in progress` : ''}{waiting ? ` · ${waiting} waiting` : ''}
          </Text>
        </Text>

        {needs && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">Needs you</Text>
            {p && card(p)}
            {adrDrafts.map(d => adrCard(d))}
            {stalled.map(j => (
              <Text key={`stall${j.id}`} color="red" wrap="wrap">! {j.id} is red{j.where && j.where !== 'here' ? ` in ${j.where}` : ''}: its criteria still fail</Text>
            ))}
            {broken.map(j => (
              <Text key={`moved${j.id}`} color="red" wrap="wrap">
                ! {j.id}
                {j.moved!.level === 'breaks'
                  ? ` fails on today's main: ${j.moved!.landed.join(', ') || 'main'} changed ${(j.moved!.touched.length ? j.moved!.touched : j.moved!.changed).slice(0, 3).join(', ')}`
                  : ` conflicts with main in ${j.moved!.conflicts.join(', ')}`}
                {j.where && j.where !== 'here' ? ` (${j.where})` : ''}: rebase onto main
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          {jobs.length === 0 && <Text dimColor>No jobs yet.</Text>}
          {jobs.length > 0 && (
            // The steps, each above its column of dots, laid out as boxes so
            // they line up in any font. Pointing at a name lights its column.
            <Box key="steps" flexDirection="row">
              <Box width={idWidth + 3} flexShrink={0} />
              {STEPS.map((name, i) => (
                <Box key={`h${i}`} width={name.length + GAP} flexShrink={0}>
                  <Text dimColor hover={{ scope: `gmod-step-${i}`, color: 'cyan', bold: true, dimColor: false }}>
                    {name}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
          {phases.length ? phases.map(ph => phaseGroup(ph)) : jobs.map(j => jobRow(j, 0))}
        </Box>

        {(await read($, allowPlan)) && <Text color="yellow">Direct plan edits allowed: /gmod lock-plan</Text>}
      </Box>
    )
  })
}
