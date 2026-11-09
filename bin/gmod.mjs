#!/usr/bin/env node
// gmod: plan, claim, check and prove work; the same command for people,
// the Claude Code mod and CI.
import * as core from '../lib/core.mjs';
import * as ci from '../lib/ci.mjs';
import * as adr from '../lib/adr.mjs';
import * as rcv from '../lib/receive.mjs';
import * as setupLib from '../lib/setup.mjs';
import * as runnerLib from '../lib/runner.mjs';
import * as stateLib from '../lib/state.mjs';
import * as signalsLib from '../lib/signals.mjs';
import * as capsLib from '../lib/capabilities.mjs';
import * as managedLib from '../lib/managed.mjs';
import * as stampLib from '../lib/stamp.mjs';
import * as decideLib from '../lib/decide.mjs';
import * as requestsLib from '../lib/requests.mjs';
import { createInterface } from 'node:readline/promises';
import { readFileSync as readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const HELP = `gmod: planned work with proof, on plain git

  gmod init                       write a starter .gmod/plan.json
  gmod plan                       every job and its state
  gmod state [--no-sync]          the plan and its progress (--json: the record faces like Skiff read)
  gmod signals [--no-sync]        what needs a person (--json: the signals faces like Skiff read)
  gmod stamp                      the change stamp: read state and signals again when it differs
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
  gmod decide <signal-id> <action> [--rev r] [--note text] [--via surface]
                                  a person's decision on a signal, from any surface: approve,
                                  ask-changes or reject a proposal; accept or reject an ADR draft;
                                  answer (--note) or resolve an agent's request
  gmod ask <question> [--options '<json list>']
                                  ask the person about the job claimed here; the answer
                                  comes on a later tool round (gmod notice)
  gmod requests [--all] [--job <id>]
                                  open requests; --all also answered and resolved ones
  gmod manage [on | off | status] managed mode (.gmod/managed.json, off by default): a person's
                                  decision, committed alone; with no argument, whether it is on
  gmod prove <job> --base <ref> [--head <ref>]
                                  the tests fail without the change
  gmod verify --base <ref> [--head <ref>] [--branch <name>] [--title <text>] [--report <file>]
                                  the CI gate for one pull request
  gmod moved [--run] [--no-fetch] did main move under each worktree's job? --run checks
                                  the work merged onto today's main
  gmod notice <path>              what the agent working at <path> should hear, once
  gmod sweep                      let go of claims on jobs done on main
  gmod version                    which gmod this is (also --version)
  gmod capabilities               the protocol it speaks and what it enforces (--json: the record faces like Skiff read)

  gmod adr propose '<draft json>'  draft a decision: {title, scope, context, decision, rules: [{level, text}], supersedes}
  gmod adr drafts                 the drafts waiting for a person
  gmod adr accept <draft>         a person's yes: numbered, written to docs/adr, committed alone
  gmod adr reject <draft> [why]   a person's no
  gmod adr list                   every ADR and its status
  gmod adr for <path>...          the accepted ADRs that govern these files

  gmod ci init [--runs-on <label>] (--gmod-home <path> | --gmod-repo <owner/repo>[@ref] [--gmod-token-secret <name>])
               [--reviewer claude|local|none] [--review-url <url>] [--review-model <m>] [--blocking]
               [--owners @a,@b] [--url <gitea web address>] [--setup <commands, or a file of them>] [--force]
                                  write the CI workflow (and CODEOWNERS) for this repository's forge
  gmod commit [-m <text>] [--trailer <line>]... [--no-push] [--no-pr]
                                  commit the claimed job's work (what the last passing check ran
                                  on, as "<job>: …"), push it and open its pull request to land on
                                  green; refused until it failed, then passed, on exactly these files
  gmod pr --status [--branch <b>] how this branch's pull request is doing: its checks, and the
                                  gate's and the review's reports
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
  gmod setup [--reviewer-url <u> --reviewer-model <m> | --reviewer none] [--advice] [--setup '<cmd>'] [--ref <vX>] [--runs-on <label>] [--agents <n>] [--no-wait]
                                  set up CI on GitHub, GitLab or Gitea: gmod pinned, main's rules,
                                  .gmod/protect.json; proven by landing them
  gmod doctor                     is everything in place? each ✗ with its fix
  gmod app create [--name <n>] · gmod app finish <code>
                                  GitHub: create a GitHub App for gmod to work as (one click), then
                                  keep its key; gmod setup --app uses it
  gmod runner up [--labels <name:docker://image>,...] [--capacity <n>] [--instance <url>]
                                  Gitea: a runner for this repository in Docker (the local daemon,
                                  or DOCKER_HOST=ssh://user@host for another machine's)
  gmod ci upgrade [--to <vX>] [--candidates]   a pull request moving the gmod action to its newest release
  gmod ci secret <NAME> [--from-file <f>]  set a CI secret (the value piped in, or from a file)
  gmod ci forge-token [--token-file <f>] [--url <u>]
                                  keep your token as the repository's GMOD_FORGE_TOKEN secret: the
                                  gate reads main's protection with it, and job branches CI brings
                                  up to date after a merge are checked again
  gmod ci check [--token-file <f>] [--url <u>]
                                  is the workflow, protection, runner and reviewer in place?
  gmod status [--brief]           everything above, as JSON; --brief: the claim and open jobs only

  Gitea: the token is --token-file, GITEA_TOKEN, or ~/.config/gmod/gitea-token; the web
  address over ssh is --url, or once per host: git config --global gmod.<host>.url <url>
  --json prints JSON. Exit status 0 means yes / done, 1 means refused.`;

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) rest.push(a);
    else if (a === '--version') rest.unshift('version');
    else if (['--json', '--allow-plan', '--no-branch', '--no-sync', '--shell', '--run', '--no-fetch', '--blocking', '--force', '--code-owners', '--auto', '--require-review', '--status', '--no-push', '--no-pr', '--advice', '--no-wait', '--candidates', '--resume', '--app', '--all', '--managed', '--yes', '--brief'].includes(a)) flags[a.slice(2)] = true;
    else if (a === '--trailer') (flags.trailer ??= []).push(argv[++i]);
    else flags[a.slice(2)] = argv[++i];
  }
  return { cmd: rest[0], args: rest.slice(1), flags };
}

// The repository's name, as `gmod state` gives it: the folder of its main
// checkout, so every worktree of it reports the same project.
function projectName(root) {
  const common = core.git(['rev-parse', '--git-common-dir'], { cwd: root, allow: true });
  if (!common.ok) return basename(root);
  const dir = resolve(root, common.out);
  return basename(basename(dir) === '.git' ? dirname(dir) : dir.replace(/\.git$/, ''));
}

// The forge's web address, to pick the matching tea login; none when unknown.
function webOf(root, url) {
  try { return ci.detectForge(root, { url }).web ?? undefined; } catch { return undefined; }
}

// After a person's yes: push it on its own gmod/ branch and open the pull
// request that lands on green. With no forge (a local origin) or --no-pr, the
// commit stays where it is; a forge that refuses leaves the commit and says how
// to try again.
// A decision's commit (the one approve or adr accept just made, which is not
// HEAD when it was made from a job's branch) goes up as its own pull request.
async function publish(root, flags, branch, commit = 'HEAD') {
  if (flags['no-pr']) return [];
  let forge;
  try { forge = ci.detectForge(root, { url: flags.url }); } catch { return []; }
  try {
    const main = core.planFromDisk(root)?.main ?? 'main';
    const pr = await ci.publishDecision(root, { branch, commit, url: flags.url, main, forge, token: forge.kind === 'gitea' ? ci.giteaToken({ file: flags['token-file'], web: forge.web }) : undefined });
    return [`${pr.existed ? 'already open' : 'opened'}: ${pr.url}`, 'lands by itself once its checks pass'];
  } catch (e) {
    return [`couldn't open its pull request (${e.message.split('\n')[0]}): git push -u origin ${commit}:refs/heads/${branch}, then gmod pr --branch ${branch} --auto`];
  }
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
  // Which gmod this is: the package version, and the commit it was built
  // from when it runs from an image (GMOD_COMMIT).
  if (cmd === 'version') {
    const { version } = JSON.parse(readSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return out(flags, { version, commit: process.env.GMOD_COMMIT || null }, `gmod ${version}${process.env.GMOD_COMMIT ? ` (${process.env.GMOD_COMMIT})` : ''}`);
  }
  // What this gmod speaks and enforces: like version, no repository needed.
  if (cmd === 'capabilities') {
    const c = capsLib.capabilities();
    return out(flags, c, capsLib.describe(c));
  }
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
  if (cmd === 'setup') {
    // Turning managed mode on is the person's switch, as gmod manage on is.
    if (flags.managed) {
      const why = decideLib.agentReason(root);
      if (why) throw new core.GmodError(`only a person turns managed mode on, and this runs under ${why}: run gmod setup --managed at your own terminal`);
      if (!flags.yes && !(process.stdin.isTTY && process.stdout.isTTY)) throw new core.GmodError('setup --managed without a terminal needs --yes: the person running it says so');
    }
    const reviewer = flags.reviewer === 'none' ? { kind: 'none' } : flags['reviewer-url'] ? { kind: 'openai', url: flags['reviewer-url'], model: flags['reviewer-model'] } : { kind: 'claude' };
    const r = await setupLib.setup(root, { url: flags.url, reviewer, blocking: !flags.advice, setup: flags.setup ?? '', ref: flags.ref, runsOn: flags['runs-on'], agents: flags.agents ? Number(flags.agents) : 0, app: !!flags.app, managed: !!flags.managed, via: flags.via ?? 'cli', wait: !flags['no-wait'], log: s => !flags.json && console.log(`${s.ok ? '✓' : '✗'} ${s.msg}`) });
    if (flags.json) out(flags, r, '');
    else if (r.left.length) console.log(`left for you:\n${r.left.map(l => `  - ${l}`).join('\n')}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'app' && (args[0] === 'create' || args[0] === 'finish')) {
    const { appManifest } = await import('../lib/app.mjs');
    const { writeFileSync, mkdirSync, chmodSync } = await import('node:fs');
    const { homedir, tmpdir } = await import('node:os');
    const forge = ci.detectForge(root, { url: flags.url });
    if (forge.kind !== 'github') throw new core.GmodError('gmod app is for GitHub');
    if (args[0] === 'create') {
      // A form GitHub's own page takes: one click creates the App.
      const name = flags.name ?? `gmod-${forge.owner}`.slice(0, 34);
      const manifest = JSON.stringify(appManifest({ name, owner: forge.owner }));
      const file = join(tmpdir(), `gmod-app-${forge.owner}.html`);
      const esc = x => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>Create the gmod App</title><body style="font:16px system-ui;margin:3em"><form method="post" action="https://github.com/settings/apps/new?state=gmod"><input type="hidden" name="manifest" value="${esc(manifest)}"><p>Creates a private GitHub App, <b>${esc(name)}</b>, on your account, for gmod to work as.</p><button style="font-size:18px">Create ${esc(name)} on GitHub</button></form><p>GitHub then sends you to a page whose address ends <code>?code=…&amp;state=gmod</code>. Copy the code and run <code>gmod app finish &lt;code&gt;</code>.</p>`);
      return out(flags, { file, name }, `open ${file}: one click creates the App ${name}; then gmod app finish <the code from the address GitHub sends you to>`);
    }
    if (!args[1]) throw new core.GmodError('gmod app finish <code>: the code from the address GitHub sent you to');
    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(args[1])}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new core.GmodError(`GitHub wouldn't trade that code (${res.status}): codes last an hour and work once; gmod app create again`);
    const app = await res.json();
    const dir = join(homedir(), '.config', 'gmod');
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, `app-${app.slug}.pem`);
    writeFileSync(keyFile, app.pem, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const repo = `${forge.owner}/${forge.repo}`;
    return out(flags, { id: app.id, slug: app.slug, keyFile }, [
      `created ${app.slug} (App ID ${app.id}); its key is in ${keyFile}`,
      `1. install it on ${repo}: https://github.com/apps/${app.slug}/installations/new`,
      `2. gh secret set GMOD_APP_ID --repo ${repo} --body ${app.id}`,
      `3. gmod ci secret GMOD_APP_KEY --from-file ${keyFile}`,
      `4. gmod setup --app (with your other setup flags), or add app-id and app-key to the workflow`,
    ].join('\n'));
  }
  if (cmd === 'runner' && args[0] === 'up') {
    const r = await runnerLib.runnerUp(root, { url: flags.url, labels: flags.labels ? flags.labels.split(',') : undefined, capacity: flags.capacity ? Number(flags.capacity) : undefined, instance: flags.instance });
    return out(flags, r, r.already ? `${r.name} is already there (${r.already})` : `${r.name} is up and ${r.status}: takes ${r.labels.join(', ')} for ${r.forge.owner}/${r.forge.repo}`);
  }
  if (cmd === 'doctor') {
    const r = await setupLib.doctor(root, { url: flags.url });
    out(flags, r, r.findings.map(f => `${f.ok ? '✓' : '✗'} ${f.msg}${f.ok || !f.fix ? '' : `\n    fix: ${f.fix}`}`).join('\n'));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'ci' && args[0] === 'upgrade') {
    const r = await setupLib.upgrade(root, { url: flags.url, to: flags.to, candidates: !!flags.candidates });
    return out(flags, r, r.upToDate ? `already on gmod ${r.current}` : `gmod ${r.current} → ${r.to}: ${r.pr.url} (lands by itself once its checks pass)`);
  }
  if (cmd === 'ci') return runCi(root, args[0], flags, args.slice(1));
  if (cmd === 'commit') {
    const r = core.commitJob(root, { message: flags.message ?? args.filter(x => x !== '-m').join(' '), trailers: flags.trailer ?? [] });
    const lines = [`committed ${r.commit.slice(0, 10)} on ${r.branch}: ${r.subject}`];
    if (r.existing) lines[0] = `already committed ${r.commit.slice(0, 10)} on ${r.branch}: ${r.subject}`;
    if (flags['no-push']) return out(flags, r, lines.join('\n'));
    const up = core.catchUp(root, r.branch, core.planFromDisk(root)?.main ?? 'main');
    if (up.merged) lines.push(`took in ${up.count} merge${up.count === 1 ? '' : 's'} of main CI made on origin's ${r.branch}`);
    core.git(['push', '-q', '-u', 'origin', r.branch], { cwd: root });
    lines.push(`pushed ${r.branch}`);
    if (flags['no-pr']) return out(flags, r, lines.join('\n'));
    const plan = core.planFromDisk(root);
    const j = plan.jobs.find(x => x.id === r.job);
    const pr = await ci.openPr(root, { url: flags.url, token: ci.giteaToken({ file: flags['token-file'], web: webOf(root, flags.url) }), main: plan.main ?? 'main', job: r.job, goal: j?.goal, brief: j?.brief, branch: r.branch, auto: true });
    lines.push(`${pr.existed ? 'already open' : 'opened'}: ${pr.url}`, 'lands by itself once its checks pass (gmod pr --status says how they went)');
    return out(flags, { ...r, pr }, lines.join('\n'));
  }
  if (cmd === 'pr' && flags.status) {
    const r = await ci.prStatus(root, { url: flags.url, token: ci.giteaToken({ file: flags['token-file'], web: webOf(root, flags.url) }), branch: flags.branch });
    const lines = [`#${r.number} ${r.state}: ${r.url}`, ...r.checks.map(c => `${{ success: '✅', failure: '❌', error: '❌', pending: '⏳', skipped: '➖' }[c.state] ?? '·'} ${c.context}: ${c.state}`)];
    if (r.reports) lines.push('', ...r.reports);
    else lines.push(`(${r.note})`);
    return out(flags, r, lines.join('\n'));
  }
  if (cmd === 'pr') {
    const plan = core.planFromDisk(root);
    const id = flags.job ?? core.current(root)?.job;
    const j = id && plan?.jobs.find(x => x.id === id);
    const r = await ci.openPr(root, { url: flags.url, token: ci.giteaToken({ file: flags['token-file'], web: webOf(root, flags.url) }), main: plan?.main ?? 'main', job: id, goal: j?.goal, brief: j?.brief, branch: flags.branch, auto: !!flags.auto });
    return out(flags, r, `${r.existed ? 'already open' : 'opened'}: ${r.url}\n${r.title}${r.auto ? '\nmerges by itself once its checks pass' : ''}`);
  }
  if (cmd === 'adr') return runAdr(root, args[0], args.slice(1), flags);
  if (cmd === 'manage') {
    const how = args[0] ?? 'status';
    if (how === 'status') {
      const managed = managedLib.isManaged(root);
      return out(flags, { managed }, `managed mode is ${managed ? 'on' : 'off'} (${managedLib.MANAGED}${managed ? '' : ': missing or managed: false'})`);
    }
    if (how !== 'on' && how !== 'off') throw new core.GmodError('gmod manage [on | off | status]');
    const r = managedLib.setManaged(root, how === 'on', { via: flags.via ?? 'cli' });
    if (r.unchanged) return out(flags, r, `managed mode is already ${how}`);
    const lines = await publish(root, flags, `gmod/managed-${how}-${r.commit}`, r.sha);
    return out(flags, { ...r, published: lines }, [`managed mode ${how} (commit ${r.commit} on ${r.branch || 'a detached HEAD'})`, ...lines].join('\n'));
  }
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
    case 'state': {
      const s = stateLib.state(root, { sync: !flags['no-sync'] });
      return out(flags, s, stateLib.describe(s));
    }
    case 'stamp': {
      const s = stampLib.stamp(root);
      return out(flags, { v: 1, stamp: s }, s);
    }
    case 'signals': {
      const at = stampLib.stamp(root);
      const st = core.status(root, { sync: !flags['no-sync'] });
      if (!st.governed && !st.proposal) throw new core.GmodError(`no ${core.PLAN} here (gmod init)`);
      const list = signalsLib.signalsFrom(st, { project: projectName(root) });
      // Workers are a face's own: gmod runs none, so the list is empty.
      return out(flags, { v: signalsLib.SIGNALS_VERSION, stamp: at, signals: list, workers: [] }, signalsLib.describe(list));
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
      const r = core.claim(root, args[0], { branch: !flags['no-branch'], resume: !!flags.resume });
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
      const r = core.gateCommit(flags.dir ? core.repoRoot(flags.dir) : root);
      // --shell: run in front of a commit, inside the agent's own shell.
      if (flags.shell) {
        if (!r.ok) console.error(`gmod refused the commit: ${r.reason}`);
        return r.ok ? 0 : 1;
      }
      out(flags, r, r.reason);
      return r.ok ? 0 : 1;
    }
    case 'proposal': {
      if (!flags['no-sync']) core.syncClaims(root);
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
      const r = core.approve(root, { via: flags.via ?? 'cli' });
      const lines = await publish(root, flags, `gmod/plan-${r.commit}`, r.sha);
      return out(flags, { ...r, published: lines }, [`approved: ${r.summary} (commit ${r.commit} on ${r.branch || 'a detached HEAD'})`, ...lines].join('\n'));
    }
    case 'ask': {
      let options;
      if (flags.options !== undefined) {
        try { options = JSON.parse(flags.options); } catch { throw new core.GmodError('--options takes a JSON list, e.g. \'["cents","floats"]\''); }
      }
      const r = requestsLib.ask(root, args.join(' '), { options });
      return out(flags, r, `asked (request ${r.id}): the person's answer comes on a later tool round, or with gmod requests --all --job ${r.job}`);
    }
    case 'requests': {
      if (!flags['no-sync']) core.syncClaims(root);
      const list = requestsLib.requests(root, { all: !!flags.all, job: flags.job });
      const line = r => `${r.id} ${r.job}: ${r.question}${r.options ? ` [${r.options.join(' | ')}]` : ''}${r.answer != null ? `\n    answered by ${r.answeredBy}: ${r.answer}` : r.resolved ? `\n    resolved by ${r.answeredBy}${r.note ? `: ${r.note}` : ''}` : ''}`;
      return out(flags, { requests: list }, list.length ? list.map(line).join('\n') : (flags.all ? 'no requests' : 'no open requests'));
    }
    case 'decide': {
      const [id, action] = args;
      if (!id || !action) throw new core.GmodError('gmod decide <signal-id> <action> [--rev <rev>] [--note <text>] [--via <surface>] [--json]');
      const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
      const confirm = async s => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const typed = await rl.question(`${s.question}\n${action}? Type ${s.id} to confirm: `);
          return typed.trim() === s.id;
        } finally { rl.close(); }
      };
      const r = await decideLib.decide(root, id, action, { rev: flags.rev, note: flags.note, via: flags.via, tty, confirm });
      if (!r.decided) return out(flags, r, `not a decision: ${r.hint}`);
      const published = r.result?.sha && !flags['no-pr']
        ? await publish(root, flags, r.result.id ? `gmod/adr-${r.result.id}` : `gmod/plan-${r.result.commit}`, r.result.sha)
        : [];
      return out(flags, { ...r, published }, [`${action}: ${r.question} (by ${r.by}, via ${r.via})`, ...published].join('\n'));
    }
    case 'rebrief': {
      if (!args[0]) throw new core.GmodError('gmod rebrief <job> --note <new brief>');
      const r = core.rebrief(root, args[0], flags.note, { via: flags.via ?? 'cli' });
      const published = await publish(root, flags, `gmod/plan-${r.commit}`, r.sha);
      return out(flags, { ...r, published }, [`rebriefed ${r.job} (commit ${r.commit}); its claim is let go`, ...published].join('\n'));
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
      // main's live protection, held to what main declares (.gmod/protect.json
      // on the base): weakened by hand, the next pull request is refused.
      if (r.mode !== 'ungoverned' && r.mode !== 'empty') {
        const mb = core.git(['merge-base', flags.base, flags.head ?? 'HEAD'], { cwd: root });
        const spec = core.protectSpec(root, mb);
        const f = await ci.protectionMatches(root, { spec, url: flags.url, token: process.env.GMOD_TOKEN || ci.giteaToken({ file: flags['token-file'], web: webOf(root, flags.url) }), main: core.planAt(root, mb)?.main ?? 'main' }).catch(e => ({ ok: false, msg: `couldn't compare main's protection: ${e.message}` }));
        if (f) {
          r.findings.push(f);
          r.ok = r.ok && f.ok;
        }
      }
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
    case 'status': {
      const s = core.status(root, { sync: !flags['no-sync'] });
      return out({ json: true }, flags.brief ? core.statusBrief(s) : s);
    }
    default:
      throw new core.GmodError(`unknown command ${cmd}\n\n${HELP}`);
  }
}

async function runAdr(root, sub, rest, flags) {
  if (sub === 'propose') {
    const d = adr.proposeAdr(root, json(rest[0], 'the draft'));
    return out(flags, d, `drafted ADR ${d.draft}: ${d.title}. A person accepts it: gmod adr accept ${d.draft}`);
  }
  if (sub === 'drafts') {
    const list = adr.drafts(root);
    return out(flags, list, list.map(d => `${d.draft}: ${d.title}${d.supersedes ? ` (supersedes ${d.supersedes})` : ''}\n${d.rules.map(r => `  ${r.level}: ${r.text}`).join('\n')}`).join('\n') || 'no ADR drafts');
  }
  if (sub === 'accept') {
    const r = adr.acceptAdr(root, rest[0], { via: flags.via ?? 'cli' });
    const lines = await publish(root, flags, `gmod/adr-${r.id}`, r.sha);
    return out(flags, { ...r, published: lines }, [`accepted ADR ${r.id}: ${r.title}${r.supersedes ? ` (supersedes ${r.supersedes})` : ''}`, ...lines].join('\n'));
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

async function runCi(root, sub, flags, rest = []) {
  const token = ci.giteaToken({ file: flags['token-file'], web: webOf(root, flags.url) });
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
      // A file, or the commands themselves.
      setup: flags.setup ? ((await import('node:fs')).existsSync(flags.setup) ? (await import('node:fs')).readFileSync(flags.setup, 'utf8') : flags.setup) : '',
    });
    const next = 'commit it, then: gmod ci protect';
    return out(flags, r, `${r.files.map(f => `wrote ${f}`).join('\n')}\n${r.forge.kind} ${r.forge.owner}/${r.forge.repo}: ${next}`);
  }
  if (sub === 'protect') {
    const r = await ci.ciProtect(root, { url: flags.url, token, main, codeOwners: !!flags['code-owners'], requireReview: flags['require-review'] ? true : undefined });
    return out(flags, r, `${main} on ${r.forge.owner}/${r.forge.repo}: ${r.required.join(' and ')} required, branches must be up to date, no direct pushes`);
  }
  if (sub === 'check') {
    const r = await ci.ciCheck(root, { url: flags.url, token, main });
    out(flags, r, r.findings.map(f => `${f.ok ? '✅' : '❌'} ${f.msg}`).join('\n'));
    return r.ok ? 0 : 1;
  }
  if (sub === 'forge-token') {
    const r = await ci.ciForgeToken(root, { url: flags.url, token });
    return out(flags, r, `GMOD_FORGE_TOKEN set on ${r.forge.owner}/${r.forge.repo}: the gate reads main's protection with it, and job branches CI brings up to date are checked again${r.updated.length ? `\nbrought up to date, checked again: ${r.updated.map(n => `#${n}`).join(', ')}` : ''}`);
  }
  if (sub === 'secret') {
    // From a file, or piped in; never typed on the command line.
    const { readFileSync, fstatSync } = await import('node:fs');
    let value = '';
    if (flags['from-file']) value = readFileSync(flags['from-file'], 'utf8');
    else if (!process.stdin.isTTY && !fstatSync(0).isCharacterDevice()) value = readFileSync(0, 'utf8');
    const r = await ci.setSecret(root, { name: rest[0], value: value.replace(/\r?\n$/, ''), url: flags.url, token });
    return out(flags, { name: r.name, repo: `${r.forge.owner}/${r.forge.repo}` }, `${r.name} set on ${r.forge.owner}/${r.forge.repo}`);
  }
  throw new core.GmodError('gmod ci init | protect | check | forge-token | secret');
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
