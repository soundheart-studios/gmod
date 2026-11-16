// gmod mcp: the agent's tools as a stdio MCP server, for hosts other than
// Claude Code (whose mod, hooks/register.tsx, registers the same tools).
// JSON-RPC 2.0, one JSON message per line on stdin and stdout; stdout carries
// nothing but protocol messages, anything else goes to stderr. Every call runs
// the same gmod command the mod runs for it, in the `dir` argument when given,
// else the server's folder. No dependency beyond node.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { proposalCard, adrCard } from './render.mjs';
import { signalsFrom } from './signals.mjs';

const GMOD = fileURLToPath(new URL('../bin/gmod.mjs', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_PROTOCOL = '2025-06-18';

// The input schemas, as the mod registers them.
const DIR = { dir: { type: 'string', description: 'Your working directory, when you work in a worktree of your own; leave it out otherwise.' } };
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
};
const PHASE = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'lowercase-with-dashes' },
    title: { type: 'string', description: 'A short name, two or three words' },
    outcome: { type: 'string', description: 'One plain sentence: what is true once every job in it is done' },
    after: { type: 'array', items: { type: 'string' }, description: 'Phases that must be done first: every job here waits for every job there' },
  },
  required: ['id', 'outcome'],
};
const CHECKS = { type: 'object', additionalProperties: { type: 'string' }, description: 'New or changed checks: name → shell command, exit 0 when the criterion holds' };

// The one list of the agent's tools: names, descriptions, input schemas.
export const TOOLS = [
  { name: 'next', description: 'The first job in .gmod/plan.json that is ready to take, with its goal.', inputSchema: { type: 'object', properties: DIR } },
  { name: 'claim', description: 'Claim a job before changing any of its files. Claims are shared through git; the first claim wins.', inputSchema: { type: 'object', properties: { job: { type: 'string' }, ...DIR }, required: ['job'] } },
  { name: 'check', description: "Run the claimed job's criteria and record the result: red while they fail, green once they pass. A commit needs red first, then green on exactly the files committed.", inputSchema: { type: 'object', properties: DIR } },
  { name: 'commit', description: 'Finish the claimed job: commit exactly what the last passing check ran on, as "<job>: <message>", push its branch, and open its pull request, which lands by itself once CI passes. Refused until the check failed first and then passed on these very files.', inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'What the work does, in a few words; "<job>: " is added' }, trailers: { type: 'array', items: { type: 'string' }, description: 'Lines for the end of the message, e.g. Co-Authored-By' }, ...DIR }, required: ['message'] } },
  { name: 'pr_status', description: "How the claimed job's pull request is doing: its checks, and the gate's and the AI review's reports.", inputSchema: { type: 'object', properties: DIR } },
  { name: 'release', description: 'Let go of the claimed job, for example to hand it back unfinished.', inputSchema: { type: 'object', properties: DIR } },
  { name: 'status', description: "The claimed job, its allowed files, its criteria, the recorded runs, the open jobs' stages (done ones by id), and any drafted plan change.", inputSchema: { type: 'object', properties: DIR } },
  { name: 'propose_job', description: 'Draft a new job, or replace one, in the plan proposal. The result ends with the proposal card to show the person, who decides with gmod decide. Keep jobs small: one reviewable pull request each.', inputSchema: { type: 'object', properties: { job: JOB, checks: CHECKS }, required: ['job'] } },
  { name: 'edit_job', description: 'Change fields of a job in the plan proposal (goal, brief, files, tests, done_when, after).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, changes: { type: 'object' }, checks: CHECKS }, required: ['id', 'changes'] } },
  { name: 'drop_job', description: 'Take a job out of the plan proposal, saying why. Done or claimed jobs stay.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] } },
  { name: 'propose_phase', description: 'Draft a phase, or replace one: a group of jobs with an outcome, ordered after other phases. Put jobs in it with their "phase" field. A plan with phases needs every job in one before the person can approve it.', inputSchema: { type: 'object', properties: { phase: PHASE }, required: ['phase'] } },
  { name: 'edit_phase', description: "Change a phase's title, outcome or after in the plan proposal.", inputSchema: { type: 'object', properties: { id: { type: 'string' }, changes: { type: 'object' } }, required: ['id', 'changes'] } },
  { name: 'drop_phase', description: 'Take an empty phase out of the plan proposal, saying why. Move or drop its jobs first.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] } },
  { name: 'ask', description: "Ask the person a question about the claimed job, when you can't go on well without their answer (a choice only they can make, something missing from the brief). Their answer reaches you on a later step. Give options when the answer is one of a few.", inputSchema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'The answers to choose from, when there are a few' }, ...DIR }, required: ['question'] } },
  { name: 'note', description: "Add a line to the claimed job's journal (.gmod/journal/<job>.md), which goes into its pull request for the reviewer: what you're about to try and why, a decision you made, a dead end and what you learned. Checks add red/green there by themselves.", inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...DIR }, required: ['text'] } },
  { name: 'adr_propose', description: 'Draft an architecture decision record: a decision agents must follow from now on. Give it a short title, the scope (globs of the files it governs; empty for the whole repository), the context, the decision, and its rules, each {level: "must" | "should", text}. The person accepts it; then it binds every job whose files it covers, and CI holds pull requests to it.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, scope: { type: 'array', items: { type: 'string' } }, context: { type: 'string' }, decision: { type: 'string' }, rules: { type: 'array', items: { type: 'object', properties: { level: { type: 'string', enum: ['must', 'should'] }, text: { type: 'string' } }, required: ['level', 'text'] } }, supersedes: { type: 'string', description: 'The id of an ADR this one replaces, e.g. 0003' } }, required: ['title', 'decision', 'rules'] } },
  { name: 'describe_proposal', description: 'Say what the plan proposal is for, in one short plain sentence (under 25 words) a non-engineer understands, and list the assumptions the person is really approving (choices you made that they might not have). Shown at the top of the proposal card.', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } } } } },
  { name: 'board', description: 'The plan as plain text: every phase and job with its steps, then any proposal or decision card waiting for the person. Show it to the person when they ask how the plan stands.', inputSchema: { type: 'object', properties: DIR } },
];

// An argument as the mod passes it on: strings as they are, anything else as JSON.
function arg(a, key) {
  const v = a?.[key];
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
}

function run(args, cwd) {
  return new Promise(res => {
    const p = spawn(process.execPath, [GMOD, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', e => res({ code: 1, stdout, stderr: `${stderr}${e.message}` }));
    p.on('close', code => res({ code: code ?? 1, stdout, stderr }));
  });
}

const text = r => (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim();

// The card that goes with a plan or decision draft, as `gmod board` shows it.
async function card(cwd, kind, which) {
  const r = await run(['status', '--no-sync'], cwd);
  let s;
  try { s = JSON.parse(r.stdout); } catch { return ''; }
  if (kind === 'proposal') return proposalCard(s).join('\n');
  const drafts = s.adrDrafts ?? [];
  const d = drafts.find(x => x.draft === which) ?? drafts.at(-1);
  return d ? adrCard(d, signalsFrom(s).find(x => x.cause.adr === d.draft)).join('\n') : '';
}

// The gmod command each tool runs: what hooks/register.tsx runs for it.
const COMMANDS = {
  next: () => ['next'],
  claim: a => ['claim', arg(a, 'job')],
  check: () => ['check'],
  commit: a => ['commit', '--message', arg(a, 'message'), ...(Array.isArray(a.trailers) ? a.trailers.map(String) : []).flatMap(t => ['--trailer', t])],
  pr_status: () => ['pr', '--status'],
  release: () => ['release'],
  status: () => ['status', '--no-sync', '--brief'],
  propose_job: a => ['propose-job', arg(a, 'job'), ...(arg(a, 'checks') ? ['--checks', arg(a, 'checks')] : [])],
  edit_job: a => ['edit-job', arg(a, 'id'), arg(a, 'changes'), ...(arg(a, 'checks') ? ['--checks', arg(a, 'checks')] : [])],
  drop_job: a => ['drop-job', arg(a, 'id'), ...(arg(a, 'reason') ? ['--reason', arg(a, 'reason')] : [])],
  propose_phase: a => ['propose-phase', arg(a, 'phase')],
  edit_phase: a => ['edit-phase', arg(a, 'id'), arg(a, 'changes')],
  drop_phase: a => ['drop-phase', arg(a, 'id'), ...(arg(a, 'reason') ? ['--reason', arg(a, 'reason')] : [])],
  note: a => ['note', arg(a, 'text')],
  ask: a => ['ask', arg(a, 'question'), ...(Array.isArray(a.options) && a.options.length ? ['--options', JSON.stringify(a.options)] : []), '--json'],
  adr_propose: a => ['adr', 'propose', JSON.stringify(Object.fromEntries(['title', 'scope', 'context', 'decision', 'rules', 'supersedes'].map(k => [k, a[k]]).filter(([, v]) => v !== undefined)))],
  describe_proposal: a => ['describe-proposal', ...(arg(a, 'summary') ? ['--summary', arg(a, 'summary')] : []), ...(arg(a, 'assumptions') ? ['--assumptions', arg(a, 'assumptions')] : [])],
  board: () => ['board', '--no-sync'],
};

// One tool call: its text, and isError when gmod refused. A refusal is a
// non-zero exit with nothing on stdout (gmod's words go to stderr); a red
// check or "nothing is ready" exits 1 with its answer on stdout, and is an
// answer, as the mod treats it.
export async function callTool(name, a = {}, { cwd = process.cwd() } = {}) {
  const command = COMMANDS[name];
  if (!command) return null;
  const at = arg(a, 'dir') || cwd;
  const r = await run(command(a), at);
  const refused = r.code !== 0 && !r.stdout.trim();
  if (refused) return { content: [{ type: 'text', text: text(r) || `gmod ${name} failed` }], isError: true };
  let said = name === 'status' ? r.stdout.trim() : text(r);
  if (name === 'ask') {
    let id = '';
    try { id = JSON.parse(r.stdout).id; } catch {}
    said = `Asked the person (request ${id}). Their answer reaches you on a later step as a gmod notice; until then carry on with what doesn't depend on it, and don't guess the answer.`;
  }
  if (name === 'propose_job') said = `${said}. When the draft is complete, describe it with describe_proposal. Show the person the card below; they decide with gmod decide.\n\n${await card(at, 'proposal')}`;
  if (name === 'describe_proposal') said = `Described. Show the person the card below; they decide with gmod decide, not you.\n\n${await card(at, 'proposal')}`;
  if (name === 'adr_propose') said = `${said} Show the person the card below; they decide, don't accept it yourself.\n\n${await card(at, 'adr', r.stdout.match(/drafted ADR (\S+):/)?.[1])}`;
  return { content: [{ type: 'text', text: said.trimEnd() }] };
}

// The server: reads requests until stdin closes, answering each as it finishes.
export function serve({ input = process.stdin, output = process.stdout, cwd = process.cwd(), log = m => process.stderr.write(`gmod mcp: ${m}\n`) } = {}) {
  const send = m => output.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const pending = new Set();

  async function handle(msg) {
    const { id, method, params } = msg;
    const reply = id !== undefined && id !== null;
    const answer = result => reply && send({ id, result });
    const fail = (code, message) => reply && send({ id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return answer({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'gmod', version: VERSION } });
      }
      case 'ping':
        return answer({});
      case 'tools/list':
        return answer({ tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        if (!TOOLS.some(t => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
        try {
          return answer(await callTool(name, params?.arguments ?? {}, { cwd }));
        } catch (e) {
          return answer({ content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true });
        }
      }
      default:
        if (typeof method === 'string' && method.startsWith('notifications/')) return;
        return fail(-32601, `method not found: ${method}`);
    }
  }

  return new Promise(res => {
    const rl = createInterface({ input });
    rl.on('line', line => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return send({ id: null, error: { code: -32700, message: 'parse error' } });
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
        // A response to us (we send no requests) or nonsense.
        if (msg && msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) return;
        return send({ id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } });
      }
      const p = handle(msg).catch(e => log(e?.stack ?? String(e))).finally(() => pending.delete(p));
      pending.add(p);
    });
    rl.on('close', async () => {
      await Promise.all(pending);
      res(0);
    });
  });
}
