// gmod capabilities: which gmod this is, the protocol it speaks and what it
// enforces, for faces (Skiff) to ask before reading anything else. The shape
// is record v1, as Skiff's fixture and reader define it:
//   { v, engine, version, protocol, enforcers, presets?, inventory? }
// `enforcers` are kind names (DESIGN 11.3: engine, mod, gate, forge, check,
// review, person). What each kind holds here, and where, rides along as
// `enforces`, and the commands a face may call as `commands`: extra fields a
// 1.x reader ignores. No presets or inventory: gmod has none yet.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CAPABILITIES_VERSION = 1;
export const PROTOCOL = '1.0';

// The read-only JSON a face may ask for.
export const COMMANDS = ['capabilities', 'state', 'signals', 'stamp'];

// Only what this gmod really enforces, each with the code that holds it.
export const ENFORCES = [
  { kind: 'mod', what: "an edit outside the claimed job's files is refused", where: 'hooks/register.tsx: Edit, Write and NotebookEdit guard (gmod guard-path)' },
  { kind: 'mod', what: 'git commit runs on its own and only past the commit gate', where: 'hooks/register.tsx: Bash hook (commitsAlone, gmod gate-commit)' },
  { kind: 'mod', what: "claims move only through claim and release; pull requests aren't merged by hand; the plan and gmod's records aren't written from the shell", where: 'hooks/register.tsx: Bash hook (hooks/shell.ts)' },
  { kind: 'mod', what: "a subagent's prompt carries gmod's routine", where: 'hooks/register.tsx: Agent hook' },
  { kind: 'check', what: "a job's done-when holds when its check command exits 0", where: 'gmod check (lib/core.mjs)' },
  { kind: 'engine', what: "a job's commit needs its checks red first, then green on exactly the files committed", where: 'gmod commit and gmod gate-commit (lib/core.mjs)' },
  { kind: 'gate', what: 'every pull request is proven again: its job is planned and claimed by its committer, it stays in its files, and its tests fail without the change and pass with it', where: 'CI: gmod verify (ci/action.mjs, lib/core.mjs)' },
  { kind: 'gate', what: 'plan, decision record and CI changes travel alone', where: 'CI: gmod verify (lib/core.mjs)' },
  { kind: 'gate', what: "main's protection matches what .gmod/protect.json declares", where: 'CI: gmod verify (lib/ci.mjs)' },
  { kind: 'review', what: 'an AI reviewer judges the change against its job and the accepted ADRs it falls under', where: 'CI: ci/review.mjs' },
  { kind: 'forge', what: 'main takes no direct pushes; the gate is required and branches must be up to date', where: 'gmod ci protect / gmod setup (lib/ci.mjs)' },
  { kind: 'forge', what: "a claim is never moved, and let go only by its holder or an admin (Gitea's pre-receive hook)", where: 'gmod receive (lib/receive.mjs)' },
  { kind: 'person', what: 'a plan change or a decision record takes effect only on a person\'s yes', where: 'gmod approve, gmod adr accept; the mod lets only a person at the prompt give it' },
];

// Which gmod this is: the package version, as `gmod version` reads it.
export function packageVersion() {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
}

export function capabilities({ version = packageVersion() } = {}) {
  return {
    v: CAPABILITIES_VERSION,
    engine: 'gmod',
    version,
    protocol: PROTOCOL,
    enforcers: [...new Set(ENFORCES.map(e => e.kind))],
    enforces: ENFORCES.map(e => ({ ...e })),
    commands: [...COMMANDS],
  };
}

// The record in words, for a person at a terminal.
export function describe(c) {
  return [
    `gmod ${c.version}, protocol ${c.protocol}`,
    `speaks: ${c.commands.join(', ')} (--json)`,
    'enforces:',
    ...c.enforces.map(e => `  ${e.kind.padEnd(7)} ${e.what}\n          ${e.where}`),
  ].join('\n');
}
