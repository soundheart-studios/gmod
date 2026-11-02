#!/usr/bin/env node
// gmod: plan, claim, check and prove work; the same command for people,
// the Claude Code mod and CI.
import * as core from '../lib/core.mjs';
import * as ci from '../lib/ci.mjs';
import * as adr from '../lib/adr.mjs';
import * as rcv from '../lib/receive.mjs';
import { readFileSync as readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HELP = `gmod: planned work with proof, on plain git

  gmod init                       write a starter .gmod/plan.json
  gmod plan                       every job and its state
  gmod next                       the first job ready to take
  gmod claim <job>                take a job (a git ref on origin; first push wins)
  gmod release [job]              let a job go
  gmod check [job]                run the job's criteria; record red or green
  gmod gate-commit                may this worktree commit now?
  gmod note <text> [--job <job>]  add to the job's journal (.gmod/journal/<job>.md)
  gmod guard-path <path> [--allow-plan]
                                  may this file be written now? (the repository it is in decides)

  gmod proposal                   the drafted plan change, against the plan
  gmod propose-job '<job json>' [--checks '<json>']
                                  add or replace a job in the draft
  gmod edit-job <job> '<changes json>' [--checks '<json>']
                                  change fields of a job in the draft
  gmod drop-job <job> [--reason <why>]
                                  take a job out of the draft
  gmod propose-phase '<phase json>'
                                  add or replace a phase in the draft: {id, title, outcome, after}
  gmod edit-phase <phase> '<changes json>'
  gmod drop-phase <phase> [--reason <why>]
  gmod describe-proposal [--summary <one sentence>] [--assumptions '<json list>']
                                  say what the draft is for, and what it assumes
  gmod approve                    a person's yes: commit the draft as the plan
  gmod reject [reason]            a person's no: drop the draft
  gmod prove <job> --base <ref> [--head <ref>]
                                  the tests fail without the change
  gmod verify --base <ref> [--head <ref>] [--branch <name>] [--title <text>] [--report <file>]
                                  the CI gate for one pull request
  gmod moved [--run] [--no-fetch] did main move under each worktree's job? --run checks
                                  the work merged onto today's main
  gmod notice <path>              what the agent working at <path> should hear, once
  gmod sweep                      let go of claims on jobs done on main

  gmod adr propose '<draft json>'  draft a decision: {title, scope, context, decision, rules: [{level, text}], supersedes}
  gmod adr drafts                 the drafts waiting for a person
  gmod adr accept <draft>         a person's yes: numbered, written to docs/adr, committed alone
  gmod adr reject <draft> [why]   a person's no
  gmod adr list                   every ADR and its status
  gmod adr for <path>...          the accepted ADRs that govern these files

  gmod ci init [--runs-on <label>] (--gmod-home <path> | --gmod-repo <owner/repo>[@ref] [--gmod-token-secret <name>])
               [--reviewer claude|local|none] [--review-url <url>] [--review-model <m>] [--blocking]
               [--owners @a,@b] [--url <gitea web address>] [--force]
                                  write the CI workflow (and CODEOWNERS) for this repository's forge
  gmod pr [--auto] [--job <id>] [--branch <b>] [--token-file <f>] [--url <u>]
                                  open the job's pull request (its branch pushed first);
                                  asked again, answers with the one already open. --auto: the
                                  forge merges it once its checks pass (jobs only, never a plan,
                                  ADR or CI change)
  gmod ci protect [--token-file <f>] [--url <u>] [--code-owners] [--require-review]
                                  require the gate and up-to-date branches on main; no direct pushes
  gmod ci guard-claims --repo-path <bare repo> [--admins a,b]
                                  on the forge's machine: refuse moving claims, and letting go of
                                  someone else's (Gitea's pre-receive.d)
  gmod receive                    the hook itself: reads pushed refs on stdin
  gmod ci check [--token-file <f>] [--url <u>]
                                  is the workflow, protection, runner and reviewer in place?
  gmod status                     everything above, as JSON

  Gitea: the token is --token-file, GITEA_TOKEN, or ~/.config/gmod/gitea-token; the web
  address over ssh is --url, or once per host: git config --global gmod.<host>.url <url>
  --json prints JSON. Exit status 0 means yes / done, 1 means refused.`;

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) rest.push(a);
    else if (['--json', '--allow-plan', '--no-branch', '--no-sync', '--shell', '--run', '--no-fetch', '--blocking', '--force', '--code-owners', '--auto', '--require-review'].includes(a)) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i];
  }
  return { cmd: rest[0], args: rest.slice(1), flags };
}

function json(text, what) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    throw new core.GmodError(`${what} must be JSON`);
  }
}

function out(flags, value, text) {
  process.stdout.write(flags.json ? JSON.stringify(value) + '\n' : `${text}\n`);
}

async function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  if (!cmd || cmd === 'help' || flags.help) return void console.log(HELP);
  // Server side: neither needs a work tree.
  if (cmd === 'receive') {
    const r = rcv.receive(readSync(0, 'utf8'));
    for (const why of r.refused) console.error(`gmod: ${why}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'ci' && args[0] === 'guard-claims') {
    if (!flags['repo-path']) throw new core.GmodError('gmod ci guard-claims --repo-path <bare repository> [--admins a,b]');
    const r = rcv.guardClaims({ repoPath: flags['repo-path'], admins: (flags.admins ?? '').split(',').map(x => x.trim()).filter(Boolean), gmod: flags.gmod ?? fileURLToPath(import.meta.url) });
    return out(flags, r, `guarding claims in ${r.repo}${r.admins.length ? ` (admins: ${r.admins.join(', ')})` : ''}`);
  }
  if (cmd === 'notice') {
    process.stdout.write(core.notice(args[0] ?? '.'));
    return 0;
  }
  if (cmd === 'guard-path') {
    if (!args[0]) throw new core.GmodError('gmod guard-path <path>');
    const r = core.guardFile(args[0], { allowPlan: !!flags['allow-plan'] });
    out(flags, r, r.ok ? 'ok' : r.reason);
    return r.ok ? 0 : 1;
  }
  const root = core.repoRoot();
  if (cmd === 'ci') return runCi(root, args[0], flags);
  if (cmd === 'pr') {
    const plan = core.planFromDisk(root);
    const id = flags.job ?? core.current(root)?.job;
    const j = id && plan?.jobs.find(x => x.id === id);
    const r = await ci.openPr(root, { url: flags.url, token: ci.giteaToken({ file: flags['token-file'] }), main: plan?.main ?? 'main', job: id, goal: j?.goal, brief: j?.brief, branch: flags.branch, auto: !!flags.auto });
    return out(flags, r, `${r.existed ? 'already open' : 'opened'}: ${r.url}\n${r.title}${r.auto ? '\nmerges by itself once its checks pass' : ''}`);
  }
  if (cmd === 'adr') return runAdr(root, args[0], args.slice(1), flags);
  switch (cmd) {
    case 'init': {
      const r = core.init(root);
      return out(flags, r, `wrote ${r.file}: describe your jobs and checks, then commit it`);
    }
    case 'plan': {
      const plan = core.planFromDisk(root);
      if (!plan) throw new core.GmodError(`no ${core.PLAN} here (gmod init)`);
      const s = core.states(root, plan, { sync: !flags['no-sync'] });
      const st = core.status(root);
      const p = st.proposal;
      const row = j => `${j.state.padEnd(8)} ${j.id}${j.by ? ` (${j.by})` : ''}${j.waiting.length ? ` waits for ${j.waiting.join(', ')}` : ''}\n         ${j.goal}`;
      const body = st.phases?.length
        ? st.phases.map(ph => `${ph.title} · ${ph.done} of ${ph.total} done${ph.waiting.length ? ` · after ${ph.waiting.join(', ')}` : ''}\n  ${ph.outcome}\n${s.filter(j => ph.jobs.includes(j.id)).map(j => `  ${row(j).replace(/\n/g, '\n  ')}`).join('\n')}`).join('\n\n')
        : s.map(row).join('\n');
      return out(flags, { jobs: s, phases: st.phases, proposal: p }, body + (p ? `\n\nproposal by ${p.by}: ${p.summary} (gmod proposal)` : ''));
    }
    case 'next': {
      const plan = core.planFromDisk(root);
      if (!plan) throw new core.GmodError(`no ${core.PLAN} here (gmod init)`);
      const n = core.next(root, plan);
      out(flags, n, n ? `${n.id}: ${n.goal}\n  take it: gmod claim ${n.id}` : 'nothing is ready: everything is done, claimed or waiting');
      return n ? 0 : 1;
    }
    case 'claim': {
      if (!args[0]) throw new core.GmodError('which job? gmod claim <job>');
      const r = core.claim(root, args[0], { branch: !flags['no-branch'] });
      return out(flags, r, r.again ? `you already hold ${r.job}` : `claimed ${r.job} as ${r.by}${r.note ? `; ${r.note}` : ''}`);
    }
    case 'release': {
      const r = core.release(root, args[0]);
      return out(flags, r, `released ${r.job}`);
    }
    case 'check': {
      const r = core.check(root, args[0]);
      const lines = r.results.map(x => `  ${x.pass ? 'pass' : 'FAIL'}  ${x.criterion}${x.pass ? '' : `\n${x.tail.replace(/^/gm, '        ')}`}`);
      const hint = r.result === 'red' ? 'recorded red: now make it pass' : r.sawRed ? 'recorded green after red: you may commit these files' : 'green, but no red was seen first: a commit will be refused';
      out(flags, r, `${r.job}: ${r.result}\n${lines.join('\n')}\n${hint}`);
      return r.result === 'green' ? 0 : 1;
    }
    case 'note': {
      const r = core.note(root, args.join(' '), flags.job);
      return out(flags, r, `noted in ${r.file}`);
    }
    case 'gate-commit': {
      const r = core.gateCommit(root);
      // --shell: run in front of a commit, inside the agent's own shell.
      if (flags.shell) {
        if (!r.ok) console.error(`gmod refused the commit: ${r.reason}`);
        return r.ok ? 0 : 1;
      }
      out(flags, r, r.reason);
      return r.ok ? 0 : 1;
    }
    case 'proposal': {
      const p = core.status(root).proposal;
      if (!p) return out(flags, null, 'no proposal');
      const d = p.diff;
      const rows = [
        ...(p.headline ? [p.headline, ''] : []),
        ...d.phases.added.map(x => `  + phase ${x.id}: ${x.outcome}${x.after.length ? ` (after ${x.after.join(', ')})` : ''}`),
        ...d.phases.changed.map(x => `  ~ phase ${x.id}\n${x.changes.map(c => `      ${c.field}: ${c.before} → ${c.after}`).join('\n')}`),
        ...d.phases.dropped.map(x => `  - phase ${x.id}${x.reason ? ` (${x.reason})` : ''}`),
        ...d.added.map(j => `  + ${j.id}: ${j.goal}${j.after.length ? ` (after ${j.after.join(', ')})` : ''}\n${j.criteria.map(c => `      done when: ${c}`).join('\n')}`),
        ...d.changed.map(j => `  ~ ${j.id}\n${j.changes.map(c => `      ${c.field}: ${c.before} → ${c.after}`).join('\n')}`),
        ...d.dropped.map(j => `  - ${j.id}: ${j.goal}${j.reason ? ` (${j.reason})` : ''}`),
        ...(d.checks.length ? [`  checks: ${d.checks.join(', ')}`] : []),
        ...(p.assumptions.length ? ['', `  assumes: ${p.assumptions.join(' · ')}`] : []),
        ...p.warnings.map(w => `  ! ${w}`),
      ];
      return out(flags, p, `proposal by ${p.by}: ${p.summary}\n${rows.join('\n')}\n  approve: /gmod approve (a person)`);
    }
    case 'propose-job': {
      const r = core.proposeJob(root, json(args[0], 'the job'), flags.checks ? json(flags.checks, '--checks') : {});
      return out(flags, r, `drafted: ${core.describeDiff(r.diff)}`);
    }
    case 'edit-job': {
      const r = core.editJob(root, args[0], json(args[1], 'the changes'), flags.checks ? json(flags.checks, '--checks') : {});
      return out(flags, r, `drafted: ${core.describeDiff(r.diff)}`);
    }
    case 'propose-phase': {
      const r = core.proposePhase(root, json(args[0], 'the phase'));
      return out(flags, r, `drafted: ${core.describeDiff(r.diff)}`);
    }
    case 'edit-phase': {
      const r = core.editPhase(root, args[0], json(args[1], 'the changes'));
      return out(flags, r, `drafted: ${core.describeDiff(r.diff)}`);
    }
    case 'drop-phase': {
      const r = core.dropPhase(root, args[0], flags.reason ?? '');
      return out(flags, r, `drafted: ${core.describeDiff(r.diff)}`);
    }
    case 'describe-proposal': {
      const r = core.describeProposal(root, { summary: flags.summary, assumptions: flags.assumptions ? json(flags.assumptions, '--assumptions') : undefined });
      return out(flags, r, `drafted: ${r.summary ?? ''}`);
    }
    case 'drop-job': {
      const r = core.dropJob(root, args[0], flags.reason ?? '');
      return out(flags, r, `drafted: ${core.describeDiff(r.diff)}`);
    }
    case 'approve': {
      const r = core.approve(root);
      return out(flags, r, `approved: ${r.summary} (commit ${r.commit} on ${r.branch || 'a detached HEAD'})`);
    }
    case 'reject': {
      const r = core.reject(root, args.join(' '));
      return out(flags, r, `rejected: ${r.summary}${r.reason ? ` (${r.reason})` : ''}`);
    }
    case 'prove': {
      if (!args[0] || !flags.base) throw new core.GmodError('gmod prove <job> --base <ref>');
      const r = core.prove(root, args[0], flags.base, flags.head ?? 'HEAD');
      out(flags, r, r.steps.join('\n'));
      return r.ok ? 0 : 1;
    }
    case 'verify': {
      if (!flags.base) throw new core.GmodError('gmod verify --base <ref>');
      core.syncClaims(root);
      const r = core.verify(root, { base: flags.base, head: flags.head ?? 'HEAD', branch: flags.branch ?? '', title: flags.title ?? '' });
      const md = core.report(r);
      if (flags.report) (await import('node:fs')).writeFileSync(flags.report, md + '\n');
      out(flags, r, md);
      return r.ok ? 0 : 1;
    }
    case 'moved': {
      const plan = core.planFromDisk(root);
      if (!plan) throw new core.GmodError(`no ${core.PLAN} here`);
      const list = core.moved(root, plan, { run: !!flags.run, fetch: !flags['no-fetch'] });
      return out(flags, list, list.map(m => `${m.job}: ${m.level}${m.behind ? ` (${m.behind} behind)` : ''}${m.touched.length ? ` · touched ${m.touched.join(', ')}` : ''}${m.conflicts.length ? ` · conflicts ${m.conflicts.join(', ')}` : ''}${m.failing.length ? ` · fails: ${m.failing.join('; ')}` : ''}`).join('\n') || 'no claimed jobs here');
    }
    case 'sweep': {
      const r = core.sweep(root);
      return out(flags, r, r.length ? `released ${r.join(', ')}` : 'no claims on finished jobs');
    }
    case 'status':
      return out({ json: true }, core.status(root, { sync: !flags['no-sync'] }));
    default:
      throw new core.GmodError(`unknown command ${cmd}\n\n${HELP}`);
  }
}

function runAdr(root, sub, rest, flags) {
  if (sub === 'propose') {
    const d = adr.proposeAdr(root, json(rest[0], 'the draft'));
    return out(flags, d, `drafted ADR ${d.draft}: ${d.title}. A person accepts it: gmod adr accept ${d.draft}`);
  }
  if (sub === 'drafts') {
    const list = adr.drafts(root);
    return out(flags, list, list.map(d => `${d.draft}: ${d.title}${d.supersedes ? ` (supersedes ${d.supersedes})` : ''}\n${d.rules.map(r => `  ${r.level}: ${r.text}`).join('\n')}`).join('\n') || 'no ADR drafts');
  }
  if (sub === 'accept') {
    const r = adr.acceptAdr(root, rest[0]);
    return out(flags, r, `accepted ADR ${r.id}: ${r.title}${r.supersedes ? ` (supersedes ${r.supersedes})` : ''}`);
  }
  if (sub === 'reject') {
    const r = adr.rejectAdr(root, rest[0], rest.slice(1).join(' '));
    return out(flags, r, `rejected ${r.draft}${r.reason ? ` (${r.reason})` : ''}`);
  }
  if (sub === 'list') {
    const list = adr.listAdrs(root);
    return out(flags, list, list.map(a => `${a.id} ${a.status.padEnd(11)}${a.title}`).join('\n') || 'no ADRs');
  }
  if (sub === 'for') {
    const list = adr.applicable(adr.listAdrs(root), rest);
    return out(flags, list.map(a => ({ id: a.id, title: a.title, rules: a.rules })), list.map(a => `${a.id} ${a.title}\n${a.rules.map(r => `  ${r.level}: ${r.text}`).join('\n')}`).join('\n') || 'no ADR governs these files');
  }
  throw new core.GmodError('gmod adr propose | drafts | accept | reject | list | for');
}

async function runCi(root, sub, flags) {
  const token = ci.giteaToken({ file: flags['token-file'] });
  const main = flags.main ?? core.planFromDisk(root)?.main ?? 'main';
  if (sub === 'init') {
    const [repo, ref] = (flags['gmod-repo'] ?? '').split('@');
    if (!flags['gmod-home'] && !repo) throw new core.GmodError('where should CI get gmod? --gmod-home <path on the runner> or --gmod-repo <owner/repo>[@ref]');
    const kind = flags.reviewer ?? (flags['review-url'] ? 'local' : 'none');
    if (kind === 'local' && !flags['review-url']) throw new core.GmodError('a local reviewer needs --review-url (an OpenAI-compatible /v1 address)');
    const r = ci.ciInit(root, {
      url: flags.url,
      runsOn: flags['runs-on'],
      gmod: flags['gmod-home'] ? { path: flags['gmod-home'] } : { repo, ref, token: flags['gmod-token-secret'] },
      reviewer: kind === 'local' ? { kind, url: flags['review-url'], model: flags['review-model'] } : { kind },
      blocking: !!flags.blocking,
      owners: flags.owners ? flags.owners.split(',').map(x => x.trim()).filter(Boolean) : [],
      main,
      force: !!flags.force,
    });
    const next = 'commit it, then: gmod ci protect';
    return out(flags, r, `${r.files.map(f => `wrote ${f}`).join('\n')}\n${r.forge.kind} ${r.forge.owner}/${r.forge.repo}: ${next}`);
  }
  if (sub === 'protect') {
    const r = await ci.ciProtect(root, { url: flags.url, token, main, codeOwners: !!flags['code-owners'], requireReview: !!flags['require-review'] });
    return out(flags, r, `${main} on ${r.forge.owner}/${r.forge.repo}: the gate required, branches must be up to date, no direct pushes`);
  }
  if (sub === 'check') {
    const r = await ci.ciCheck(root, { url: flags.url, token, main });
    out(flags, r, r.findings.map(f => `${f.ok ? '✅' : '❌'} ${f.msg}`).join('\n'));
    return r.ok ? 0 : 1;
  }
  throw new core.GmodError('gmod ci init | protect | check');
}

try {
  process.exitCode = (await main()) ?? 0;
} catch (e) {
  if (!(e instanceof core.GmodError)) throw e;
  const flags = process.argv.includes('--json');
  process.stdout.write(flags ? JSON.stringify({ ok: false, error: e.message }) + '\n' : '');
  if (!flags) console.error(`gmod: ${e.message}`);
  process.exitCode = 1;
}
