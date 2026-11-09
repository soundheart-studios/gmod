// Managed mode: where face-driven features (voyages, requests, decide, packs)
// will live, behind a per-repository switch that is off by default (ADR 0001).
// The switch is .gmod/managed.json, { v: 1, managed: true | false }; a missing
// or unreadable file is off. Only a person turns it on or off, and it lands
// as a decision commit of its own, the way approve and adr accept land: on
// the branch the person is on, or, from a job's branch, on main's tip without
// touching the job.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT } from './agent.mjs';
import { decideOnMain, decidedBy, git, GmodError, onJobBranch, planFromDisk, who } from './core.mjs';

export const MANAGED = '.gmod/managed.json';
export const MANAGED_VERSION = 1;

export function isManaged(root) {
  const file = join(root, MANAGED);
  if (!existsSync(file)) return false;
  try {
    return JSON.parse(readFileSync(file, 'utf8'))?.managed === true;
  } catch {
    return false;
  }
}

// Agents commit as gmod's agent identity (lib/agent.mjs): the same one CI's
// agents are given, and that their claims are known by.
export function isAgent(root) {
  const name = git(['config', 'user.name'], { cwd: root, allow: true }).out;
  return who(root).toLowerCase() === AGENT.email || name === AGENT.name;
}

// The switch as main has it (local main, else origin's), for a decision made
// from a job's branch.
function managedOnMain(root) {
  const main = planFromDisk(root)?.main ?? 'main';
  for (const ref of [`refs/heads/${main}`, `refs/remotes/origin/${main}`]) {
    if (!git(['rev-parse', '-q', '--verify', ref], { cwd: root, allow: true }).ok) continue;
    const r = git(['show', `${ref}:${MANAGED}`], { cwd: root, allow: true });
    try { return r.ok && JSON.parse(r.out)?.managed === true; } catch { return false; }
  }
  return false;
}

// A person's decision: on or off. Already so: nothing is committed.
export function setManaged(root, on, { via = 'cli' } = {}) {
  if (typeof on !== 'boolean') throw new GmodError('gmod manage on | off');
  if (isAgent(root)) throw new GmodError(`only a person turns managed mode ${on ? 'on' : 'off'}, not ${AGENT.name}`);
  if (onJobBranch(root)) {
    if (managedOnMain(root) === on) return { managed: on, unchanged: true, branch: '' };
    return decideOnMain(root, dir => commitSwitch(dir, on, via), (r, commit) => `gmod/managed-${on ? 'on' : 'off'}-${commit}`);
  }
  return commitSwitch(root, on, via);
}

function commitSwitch(root, on, via = 'cli') {
  const branch = git(['branch', '--show-current'], { cwd: root, allow: true }).out;
  if (isManaged(root) === on) return { managed: on, unchanged: true, branch };
  mkdirSync(join(root, '.gmod'), { recursive: true });
  writeFileSync(join(root, MANAGED), JSON.stringify({ v: MANAGED_VERSION, managed: on }, null, 2) + '\n');
  git(['add', '--', MANAGED], { cwd: root });
  git(['commit', '-q', '-m', `managed: ${on ? 'on' : 'off'}\n${decidedBy(root, via)}`, '--', MANAGED], { cwd: root });
  return { managed: on, commit: git(['rev-parse', '--short', 'HEAD'], { cwd: root }), sha: git(['rev-parse', 'HEAD'], { cwd: root }), branch };
}
