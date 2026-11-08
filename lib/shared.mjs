// Shared state (ADR 0002): what a person decides on lives in refs under
// refs/gmod/, pushed to origin the way claims are, so every clone, machine
// and surface sees the same thing. Each ref points at a commit (gmod's
// identity, the previous version as its parent) whose tree holds one JSON file.
//
// What origin had at the last sync is kept beside it, under refs/gmod-origin/:
// a local ref that differs from it holds edits not yet pushed (made offline),
// which the next sync pushes, unless origin moved meanwhile: then origin wins.
// Pushes are compare-and-swap against that copy (--force-with-lease), so a
// write never overwrites one it didn't see.
//
// No imports from core: core builds on this.
import { spawnSync } from 'node:child_process';

export const SHARED = 'refs/gmod/';
export const TRACK = 'refs/gmod-origin/';
const IDENT = { GIT_AUTHOR_NAME: 'gmod', GIT_AUTHOR_EMAIL: 'gmod@local', GIT_COMMITTER_NAME: 'gmod', GIT_COMMITTER_EMAIL: 'gmod@local' };

function run(root, args, { input, env } = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, env: env ? { ...process.env, ...env } : process.env });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

export const hasOrigin = root => run(root, ['remote', 'get-url', 'origin']).ok;
export const trackOf = ref => TRACK + ref.slice(SHARED.length);
export const tip = (root, ref) => run(root, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]).out || null;

// The JSON file a shared ref holds, or null.
export function readJson(root, ref, file) {
  if (!tip(root, ref)) return null;
  const r = run(root, ['show', `${ref}:${file}`]);
  if (!r.ok) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

// A new version of the ref's file, on top of the current one. Moves the local
// ref only if it is still where it was read (or still absent).
// `history: false` writes a commit with no parent: for a record only the
// latest of matters (a check verdict), so the ref never grows a chain.
export function writeJson(root, ref, file, data, { history = true } = {}) {
  const prev = tip(root, ref);
  const blob = run(root, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(data, null, 2) + '\n' }).out;
  const tree = run(root, ['mktree'], { input: `100644 blob ${blob}\t${file}\n` }).out;
  const commit = run(root, ['commit-tree', '--no-gpg-sign', tree, ...(prev && history ? ['-p', prev] : []), '-m', `gmod: ${ref.slice(SHARED.length)}`], { env: IDENT });
  if (!commit.ok) throw new Error(`couldn't write ${ref}: ${commit.err}`);
  if (!run(root, ['update-ref', ref, commit.out, prev ?? '']).ok) return null;
  return commit.out;
}

function setTrack(root, ref, sha) {
  if (sha) run(root, ['update-ref', trackOf(ref), sha]);
  else run(root, ['update-ref', '-d', trackOf(ref)]);
}

// Push the local ref (or its removal) to origin, if origin still has what we
// last saw there. 'pushed', 'race' (origin moved: read again), or 'offline'
// (kept locally; the next sync pushes it). No origin: 'local'.
export function publish(root, ref) {
  if (!hasOrigin(root)) return 'local';
  const mine = tip(root, ref);
  const seen = tip(root, trackOf(ref));
  if (mine === seen) return 'pushed';
  const spec = mine ? `${ref}:${ref}` : `:${ref}`;
  const r = run(root, ['push', '-q', '--no-verify', `--force-with-lease=${ref}:${seen ?? ''}`, 'origin', spec]);
  if (r.ok) {
    setTrack(root, ref, mine);
    return 'pushed';
  }
  return run(root, ['ls-remote', 'origin', ref]).ok ? 'race' : 'offline';
}

// Push the local ref (or its removal) over whatever origin has: for a record
// only its writer moves (a job's verdict, written by its claim's holder).
// Best effort: 'pushed', 'offline' (the next sync pushes it), or 'local'.
export function publishOver(root, ref) {
  if (!hasOrigin(root)) return 'local';
  const mine = tip(root, ref);
  const r = run(root, ['push', '-q', '--no-verify', 'origin', mine ? `+${ref}:${ref}` : `:${ref}`]);
  if (!r.ok) return 'offline';
  setTrack(root, ref, mine);
  return 'pushed';
}

// Let a record go here and on origin, whatever origin has.
export function dropOver(root, ref) {
  run(root, ['update-ref', '-d', ref]);
  return publishOver(root, ref);
}

// Remove the ref here and on origin. False when origin moved since we last
// looked (someone changed it: look again).
export function unpublish(root, ref) {
  const mine = tip(root, ref);
  if (!mine) return true;
  run(root, ['update-ref', '-d', ref, mine]);
  const r = publish(root, ref);
  if (r === 'race') {
    run(root, ['update-ref', ref, mine, '']);
    return false;
  }
  return true;
}

// The refspec that fetches every shared ref named `name…` into its tracking
// copy; with --prune, one origin no longer has is let go here too.
export const fetchSpec = name => `+${SHARED}${name}*:${TRACK}${name}*`;
// Every ref under a prefix (refs/gmod/adr-drafts/), ref → sha.
export function refsUnder(root, prefix) {
  const r = run(root, ['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
  return Object.fromEntries((r.ok ? r.out.split('\n') : []).filter(Boolean).map(l => l.split(' ')));
}

// What origin had, at the last sync, for every shared ref named `name…`,
// keyed by the local ref it tracks: taken before a fetch, for reconcileUnder.
export function seenUnder(root, name) {
  const out = {};
  for (const [ref, sha] of Object.entries(refsUnder(root, TRACK + name))) {
    if (ref.startsWith(TRACK + name)) out[SHARED + ref.slice(TRACK.length)] = sha;
  }
  return out;
}

// reconcile, for every shared ref named `name…` here, at origin, or before.
export function reconcileUnder(root, name, before) {
  const refs = new Set([
    ...Object.keys(refsUnder(root, SHARED + name)).filter(r => r.startsWith(SHARED + name)),
    ...Object.keys(seenUnder(root, name)),
    ...Object.keys(before),
  ]);
  for (const ref of refs) reconcile(root, ref, before[ref] ?? null);
}

// After a fetch: bring each local ref in line with origin. `before` is what
// the tracking copies held before the fetch.
export function reconcile(root, ref, before) {
  const mine = tip(root, ref);
  const theirs = tip(root, trackOf(ref));
  if (mine === theirs) return;
  if (mine === before) {
    // Nothing unpushed here: take origin's (or let it go with origin).
    if (theirs) run(root, ['update-ref', ref, theirs]);
    else run(root, ['update-ref', '-d', ref]);
    return;
  }
  if (theirs === before) {
    // Edits made here while origin stood still: push them now.
    publish(root, ref);
    return;
  }
  // Both moved: origin's is the one everyone else sees.
  if (theirs) run(root, ['update-ref', ref, theirs]);
  else run(root, ['update-ref', '-d', ref]);
}
