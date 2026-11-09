// Architecture decision records: the decisions agents most often break
// without knowing. Drafted by the agent, accepted by a person, numbered and
// committed alone; each names its scope, the files it governs, and its rules.
//
//   docs/adr/0003-migrations-only-move-forward.md
//   ---
//   id: 0003
//   title: Migrations only move forward
//   status: accepted                  (proposed | accepted | superseded)
//   scope: db/migrations/**, src/db/**   (empty: the whole repository)
//   supersedes: 0001
//   date: 2026-11-01
//   ---
//   ## Context … ## Decision … ## Rules
//   - must: never edit a migration that has landed; add a new one
//   - should: name migrations by date
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GmodError, decideOnMain, decidedBy, git, globRe, onJobBranch, planFromDisk, syncClaims, who } from './core.mjs';
import * as shared from './shared.mjs';
import { bump } from './stamp.mjs';

export const adrDir = plan => (plan?.adr_dir ?? 'docs/adr').replace(/\/$/, '');

const slugOf = title => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'decision';

// Frontmatter values are written so any YAML parser reads them back as the
// same string: plain when safe, double-quoted (JSON is valid YAML) otherwise.
const plainSafe = v =>
  v !== '' &&
  !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(v) &&
  !/:(\s|$)|\s#|\s$/.test(v) &&
  !/^(true|false|yes|no|on|off|null|~|[-+.]?\d[\d_.eE+-]*)$/i.test(v);
const yamlScalar = v => (plainSafe(v) ? v : JSON.stringify(v));
const unquote = v => {
  if (/^".*"$/.test(v)) try { return JSON.parse(v); } catch { /* fall through: keep as written */ }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
};

export function parseAdr(text, file = '') {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const head = Object.fromEntries(
    m[1].split('\n').map(l => l.match(/^([a-z_]+):\s*(.*)$/)).filter(Boolean).map(([, k, v]) => [k, unquote(v.trim())]),
  );
  const rules = [...m[2].matchAll(/^- (must|should):\s*(.+)$/gm)].map(([, level, text]) => ({ level, text: text.trim() }));
  return {
    id: head.id ?? file.match(/^(\d{4})/)?.[1] ?? '',
    title: head.title ?? '',
    status: head.status ?? 'proposed',
    scope: (head.scope ?? '').split(',').map(s => s.trim()).filter(Boolean),
    supersedes: head.supersedes || null,
    superseded_by: head.superseded_by || null,
    file,
    rules,
    body: m[2],
  };
}

// The ADRs in the working tree, or at a commit (CI reads the base's).
export function listAdrs(root, { plan = planFromDisk(root), ref } = {}) {
  const dir = adrDir(plan);
  const files = ref
    ? git(['ls-tree', '-r', '--name-only', ref, '--', dir], { cwd: root, allow: true }).out.split('\n').filter(f => f.endsWith('.md'))
    : existsSync(join(root, dir))
      ? readdirSync(join(root, dir)).filter(f => f.endsWith('.md')).map(f => `${dir}/${f}`)
      : [];
  return files
    .map(f => parseAdr(ref ? git(['show', `${ref}:${f}`], { cwd: root }) : readFileSync(join(root, f), 'utf8'), f.split('/').pop()))
    .filter(a => a?.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

const prefix = glob => glob.split(/[*?[{]/)[0];

// Accepted ADRs that govern any of these files (or globs: a job's files).
export function applicable(adrs, paths) {
  return adrs.filter(a => a.status === 'accepted').filter(a =>
    !a.scope.length ||
    paths.some(p => a.scope.some(s => globRe(s).test(p) || (/[*?]/.test(p) && (prefix(p).startsWith(prefix(s)) || prefix(s).startsWith(prefix(p)))))),
  );
}

// ---------- drafts: the agent proposes, a person accepts ----------

//
// Each draft lives at refs/gmod/adr-drafts/<slug>, pushed to origin (ADR
// 0002), so every clone and surface sees it. One ref per draft: drafts never
// contend with each other.

export const DRAFTS = 'refs/gmod/adr-drafts/';
const DRAFT_FILE = 'draft.json';
const draftRef = slug => DRAFTS + slug;

// Where 1.6 kept the drafts: carried over to refs on first read.
const legacyDrafts = root => join(resolve(root, git(['rev-parse', '--git-common-dir'], { cwd: root }), 'gmod'), 'adr-drafts.json');

export function carryOverDrafts(root) {
  const f = legacyDrafts(root);
  if (!existsSync(f)) return;
  let list = [];
  try { list = JSON.parse(readFileSync(f, 'utf8')); } catch { /* unreadable: nothing to carry */ }
  for (const d of Array.isArray(list) ? list : []) {
    if (d?.draft && !shared.tip(root, draftRef(d.draft))) shared.writeJson(root, draftRef(d.draft), DRAFT_FILE, d);
  }
  rmSync(f, { force: true });
  bump(root);
}

export function drafts(root) {
  carryOverDrafts(root);
  return Object.keys(shared.refsUnder(root, DRAFTS))
    .map(ref => shared.readJson(root, ref, DRAFT_FILE))
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Write a draft (replacing one of the same slug) and push it. Origin moved
// under it (the same title drafted elsewhere at once): read again, write again.
function saveDraft(root, d) {
  for (let i = 0; i < 5; i++) {
    syncClaims(root);
    if (shared.writeJson(root, draftRef(d.draft), DRAFT_FILE, d) && shared.publish(root, draftRef(d.draft)) !== 'race') {
      bump(root);
      return d;
    }
  }
  throw new GmodError(`the draft "${d.draft}" kept changing under this edit: try again`);
}

// Take a draft down here and on origin. Refused when it changed since it was
// read: the person looks again rather than decide on a version they didn't see.
function dropDraft(root, slug) {
  if (!shared.unpublish(root, draftRef(slug))) throw new GmodError(`the draft "${slug}" changed a moment ago: look at it again`);
  bump(root);
}

export function proposeAdr(root, d) {
  if (!d?.title) throw new GmodError('an ADR needs a "title"');
  if (!d.decision) throw new GmodError('an ADR needs a "decision": what was decided, in a few sentences');
  if (!Array.isArray(d.rules) || !d.rules.length) throw new GmodError('an ADR needs at least one rule: {level: must|should, text}');
  for (const r of d.rules) if (!['must', 'should'].includes(r.level) || !r.text) throw new GmodError('every rule is {level: "must" or "should", text}');
  if (d.supersedes && !listAdrs(root).some(a => a.id === d.supersedes)) throw new GmodError(`there's no ADR ${d.supersedes} to supersede`);
  const draft = {
    draft: slugOf(d.title),
    title: d.title,
    scope: d.scope ?? [],
    context: d.context ?? '',
    decision: d.decision,
    rules: d.rules,
    supersedes: d.supersedes ?? null,
    by: who(root),
    at: new Date().toISOString(),
  };
  return saveDraft(root, draft);
}

// The file an accepted draft becomes. Frontmatter stays valid YAML whatever the title says.
export function renderAdr(d, id, date) {
  return [
    '---',
    `id: ${id}`,
    `title: ${yamlScalar(d.title)}`,
    'status: accepted',
    `scope: ${yamlScalar((d.scope ?? []).join(', '))}`,
    ...(d.supersedes ? [`supersedes: ${d.supersedes}`] : []),
    `date: ${date}`,
    '---',
    '',
    '## Context',
    '',
    d.context || '(none given)',
    '',
    '## Decision',
    '',
    d.decision,
    '',
    '## Rules',
    ...d.rules.map(r => `- ${r.level}: ${r.text}`),
    '',
  ].join('\n');
}

// A person's decision: numbered, written, and committed on its own; from a
// job's branch, on main's tip without touching the job.
export function acceptAdr(root, slug, { via = 'cli' } = {}) {
  syncClaims(root);
  if (!drafts(root).some(x => x.draft === slug)) throw new GmodError(`no ADR draft "${slug}" (gmod adr drafts)`);
  if (onJobBranch(root)) return decideOnMain(root, dir => commitAdr(dir, slug, via), r => `gmod/adr-${r.id}`);
  return commitAdr(root, slug, via);
}

function commitAdr(root, slug, via = 'cli') {
  const d = drafts(root).find(x => x.draft === slug);
  const plan = planFromDisk(root);
  const dir = adrDir(plan);
  const all = listAdrs(root, { plan });
  const id = String(Math.max(0, ...all.map(a => Number(a.id))) + 1).padStart(4, '0');
  const file = `${dir}/${id}-${d.draft}.md`;
  const text = renderAdr(d, id, new Date().toISOString().slice(0, 10));
  dropDraft(root, slug);
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, file), text);
  const paths = [file];
  if (d.supersedes) {
    const old = all.find(a => a.id === d.supersedes);
    const oldPath = `${dir}/${old.file}`;
    const oldText = readFileSync(join(root, oldPath), 'utf8').replace(/^status: .*$/m, `status: superseded\nsuperseded_by: ${id}`);
    writeFileSync(join(root, oldPath), oldText);
    paths.push(oldPath);
  }
  git(['add', '--', ...paths], { cwd: root });
  git(['commit', '-q', '-m', `adr: ${id} ${d.title}\n${decidedBy(root, via)}`, '--', ...paths], { cwd: root });
  return { id, title: d.title, file, supersedes: d.supersedes, sha: git(['rev-parse', 'HEAD'], { cwd: root }) };
}

export function rejectAdr(root, slug, reason = '') {
  syncClaims(root);
  if (!drafts(root).some(x => x.draft === slug)) throw new GmodError(`no ADR draft "${slug}"`);
  dropDraft(root, slug);
  return { draft: slug, reason };
}

export const isAdrFile = (plan, f) => f.startsWith(`${adrDir(plan)}/`);
