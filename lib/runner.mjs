// gmod runner up: a Gitea Actions runner for this repository, in Docker.
//
// The official runner image, registered to the repository with a token from
// its Gitea, its config (capacity, host network) kept in a named volume, and
// restarted with the Docker daemon. The daemon is the local one, or another
// machine's: DOCKER_HOST=ssh://user@host gmod runner up.
import { spawnSync } from 'node:child_process';
import { GmodError } from './core.mjs';
import { detectForge, giteaToken } from './ci.mjs';

// The official runner, pinned: gmod ci upgrade doesn't move it, gmod does.
export const RUNNER_IMAGE = 'gitea/runner:5.2.4';
export const DEFAULT_LABELS = ['ubuntu-latest:docker://node:22-bookworm'];

const docker = (args, env = {}) => {
  // GMOD_DOCKER: another docker, for tests.
  const r = spawnSync(process.env.GMOD_DOCKER || 'docker', args, { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.error) throw new GmodError('docker is needed for gmod runner up: https://docs.docker.com/get-docker/');
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

export const runnerName = forge => `gmod-${forge.owner}-${forge.repo}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');

// The docker commands, in order: config into the volume, then the runner.
// The registration token reaches docker through its environment, never argv.
export function runnerCommands({ name, instance, labels = DEFAULT_LABELS, capacity = 2, image = RUNNER_IMAGE }) {
  const volume = `${name}-data`;
  const set = (k, v) => `gitea-runner -c /data/config.yaml config set ${k} ${v}`;
  return [
    ['volume', 'create', volume],
    ['run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'sh', image, '-c',
      ['test -f /data/config.yaml || gitea-runner -c /data/config.yaml config init', set('runner.capacity', capacity), set('runner.file', '/data/.runner'), set('container.network', 'host')].join(' && ')],
    ['run', '-d', '--name', name, '--restart', 'unless-stopped', '--network', 'host',
      '-v', `${volume}:/data`, '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-e', 'CONFIG_FILE=/data/config.yaml', '-e', `GITEA_INSTANCE_URL=${instance}`, '-e', `GITEA_RUNNER_NAME=${name}`,
      '-e', `GITEA_RUNNER_LABELS=${labels.join(',')}`, '-e', 'GITEA_RUNNER_REGISTRATION_TOKEN', image],
  ];
}

async function registrationToken(forge, token) {
  const path = `${forge.api}/repos/${forge.owner}/${forge.repo}/actions/runners/registration-token`;
  for (const method of ['POST', 'GET']) {
    const res = await fetch(path, { method, headers: { authorization: `token ${token}`, accept: 'application/json' } });
    if (res.ok) return (await res.json()).token;
  }
  throw new GmodError(`${forge.web} wouldn't hand out a runner registration token for ${forge.owner}/${forge.repo}: the login needs to be its admin`);
}

export async function runnerUp(root, { url, labels = DEFAULT_LABELS, capacity = 2, instance, image = RUNNER_IMAGE, wait = true, sleep = ms => new Promise(ok => setTimeout(ok, ms)) } = {}) {
  const forge = detectForge(root, { url });
  if (forge.kind !== 'gitea') throw new GmodError(`gmod runner up is for Gitea; ${forge.kind} has hosted runners`);
  const token = giteaToken({ web: forge.web });
  if (!token) throw new GmodError(`no login for ${forge.web}: tea login add --url ${forge.web}`);
  const name = runnerName(forge);
  const existing = docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Status}}']);
  if (!existing.ok) throw new GmodError(`docker isn't reachable${process.env.DOCKER_HOST ? ` at ${process.env.DOCKER_HOST}` : ''}: ${existing.err}`);
  if (existing.out) return { forge, name, already: existing.out };

  const reg = await registrationToken(forge, token);
  const cmds = runnerCommands({ name, instance: instance ?? forge.web, labels, capacity, image });
  for (const args of cmds) {
    const r = docker(args, { GITEA_RUNNER_REGISTRATION_TOKEN: reg });
    if (!r.ok) throw new GmodError(`docker ${args.slice(0, 2).join(' ')} failed: ${r.err}`);
  }
  // Registered once Gitea lists it: the proof it can take jobs.
  const label = labels[0].split(':')[0];
  for (let i = 0; wait && i < 30; i++) {
    const res = await fetch(`${forge.api}/repos/${forge.owner}/${forge.repo}/actions/runners`, { headers: { authorization: `token ${token}` } }).catch(() => null);
    const runners = res?.ok ? (await res.json()).runners ?? [] : [];
    const mine = runners.find(x => x.name === name);
    if (mine && mine.status !== 'offline') return { forge, name, label, status: mine.status, labels: (mine.labels ?? []).map(l => l.name ?? l) };
    await sleep(2000);
  }
  const logs = docker(['logs', '--tail', '15', name]);
  throw new GmodError(`the runner ${name} started but ${forge.web} doesn't list it online yet:\n${logs.out}\n${logs.err}`);
}
