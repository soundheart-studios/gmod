// The change stamp (ADR 0002, docs/surfaces.md): one cheap value a surface
// watches or polls to know when to read state and signals again.
//
//   <git-common-dir>/gmod/stamp   a counter, rewritten (temp file, rename) on
//                                 every gmod write a signal or state depends
//                                 on: watch this file for this clone's writes
//   gmod stamp                    "<counter>-<hash>", the hash over the tips of
//                                 main (local and origin's) and refs/gmod/*,
//                                 so a plain git fetch moves it too
//
// The stamp is opaque: compare it for equality, never parse or order it.
// Reading never moves it. One clone, one stamp, shared by its worktrees.
//
// No imports from core: core calls bump() at its writes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const git = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

const dirOf = root => {
  const common = git(root, ['rev-parse', '--git-common-dir']);
  return common ? resolve(root, common, 'gmod') : null;
};

export const stampFile = root => {
  const dir = dirOf(root);
  return dir ? join(dir, 'stamp') : null;
};

function counter(file) {
  if (!file || !existsSync(file)) return 0;
  const n = Number.parseInt(readFileSync(file, 'utf8'), 10);
  return Number.isFinite(n) ? n : 0;
}

// Something a surface shows may have changed: move the counter.
export function bump(root) {
  const file = stampFile(root);
  if (!file) return;
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${counter(file) + 1}\n`);
  renameSync(tmp, file);
}

// main as the plan names it, without reading the rest of the plan.
function mainName(root) {
  try {
    return JSON.parse(readFileSync(join(root, '.gmod', 'plan.json'), 'utf8')).main ?? 'main';
  } catch {
    return 'main';
  }
}

// The tips of main and refs/gmod/*, in one for-each-ref.
export function refsHash(root, main = mainName(root)) {
  const refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${main}`, `refs/remotes/origin/${main}`, 'refs/gmod/']);
  return createHash('sha256').update(refs).digest('hex').slice(0, 8);
}

export function stamp(root) {
  return `${counter(stampFile(root))}-${refsHash(root)}`;
}

// Run something that may move refs (a fetch); move the counter when it did,
// so a watcher of the stamp file hears about it.
export function bumpIfRefsMove(root, run) {
  const before = refsHash(root);
  const out = run();
  if (refsHash(root) !== before) bump(root);
  return out;
}
