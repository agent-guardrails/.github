import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createRunner } from './pr-review/runner.mjs';
import { syncReview } from './pr-review/sync.mjs';

const execFileAsync = promisify(execFile);
const REPOSITORY = 'agent-guardrails/.github';
const HEAD_REPOSITORY = 'contributor/fork';

async function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return realpath(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    }
  }
  throw new Error(`${name} is not available on PATH`);
}

async function git(gitExecutable, cwd, args) {
  const result = await execFileAsync(gitExecutable, args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pullRequest(baseSha, headSha) {
  return {
    number: 25,
    changed_files: 2,
    base: { sha: baseSha, repo: { full_name: REPOSITORY } },
    head: { sha: headSha, repo: { full_name: HEAD_REPOSITORY } },
  };
}

async function checkoutState(gitExecutable, checkout) {
  return {
    head: await git(gitExecutable, checkout, ['rev-parse', 'HEAD']),
    branch: await git(gitExecutable, checkout, ['rev-parse', '--abbrev-ref', 'HEAD']),
    status: await git(gitExecutable, checkout, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']),
    tracked: await readFile(path.join(checkout, 'reviewed.txt'), 'utf8'),
    untracked: await readFile(path.join(checkout, 'local-only.txt'), 'utf8'),
  };
}

test('sync creates and updates only its detached managed worktree with real Git', async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pr-review-sync-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const gitExecutable = await executableOnPath(process.platform === 'win32' ? 'git.exe' : 'git');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const main = path.join(root, 'main');
  const bin = path.join(root, 'bin');
  const worktree = path.join(root, 'review');
  const executionMarker = path.join(root, 'reviewed-code-executed');

  await mkdir(seed);
  await git(gitExecutable, root, ['init', '--bare', '--initial-branch=main', remote]);
  await git(gitExecutable, seed, ['init', '--initial-branch=main']);
  await writeFile(path.join(seed, 'reviewed.txt'), 'base\n');
  await writeFile(path.join(seed, 'reviewed-code.sh'), `#!/bin/sh\nprintf executed > ${quoteShell(executionMarker)}\n`);
  await chmod(path.join(seed, 'reviewed-code.sh'), 0o755);
  await git(gitExecutable, seed, ['add', '.']);
  await git(gitExecutable, seed, ['-c', 'user.name=Integration Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);
  const baseSha = await git(gitExecutable, seed, ['rev-parse', 'HEAD']);

  await git(gitExecutable, seed, ['checkout', '-b', 'review-head']);
  await writeFile(path.join(seed, 'reviewed.txt'), 'head one\n');
  await git(gitExecutable, seed, ['add', 'reviewed.txt']);
  await git(gitExecutable, seed, ['-c', 'user.name=Integration Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'head one']);
  const firstHeadSha = await git(gitExecutable, seed, ['rev-parse', 'HEAD']);

  await writeFile(path.join(seed, 'reviewed.txt'), 'head two\n');
  await git(gitExecutable, seed, ['add', 'reviewed.txt']);
  await git(gitExecutable, seed, ['-c', 'user.name=Integration Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'head two']);
  const secondHeadSha = await git(gitExecutable, seed, ['rev-parse', 'HEAD']);
  await git(gitExecutable, seed, ['remote', 'add', 'origin', remote]);
  await git(gitExecutable, seed, ['push', 'origin', 'main', 'review-head']);

  await git(gitExecutable, root, ['clone', remote, main]);
  await writeFile(path.join(main, 'reviewed.txt'), 'main checkout local content\n');
  await writeFile(path.join(main, 'local-only.txt'), 'main checkout untracked content\n');
  const mainBefore = await checkoutState(gitExecutable, main);
  assert.equal(mainBefore.head, baseSha);
  assert.equal(mainBefore.branch, 'main');
  assert.notEqual(mainBefore.status, '');

  await mkdir(bin);
  const remoteUrl = pathToFileURL(remote).href;
  const shim = path.join(bin, process.platform === 'win32' ? 'git.cmd' : 'git');
  assert.notEqual(process.platform, 'win32', 'integration test requires a POSIX Git shim');
  await writeFile(shim, [
    '#!/bin/sh',
    `exec ${quoteShell(gitExecutable)} -c ${quoteShell(`url.${remoteUrl}.insteadOf=https://github.com/${REPOSITORY}.git`)} -c ${quoteShell(`url.${remoteUrl}.insteadOf=https://github.com/${HEAD_REPOSITORY}.git`)} "$@"`,
    '',
  ].join('\n'));
  await chmod(shim, 0o755);

  const realRun = createRunner(undefined, {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  });
  let metadata = pullRequest(baseSha, firstHeadSha);
  const run = async (executable, args, options) => {
    if (executable === 'gh') {
      return { code: 0, stdout: Buffer.from(JSON.stringify(metadata)), stderr: Buffer.alloc(0) };
    }
    return realRun(executable, args, options);
  };

  const created = await syncReview({ repo: REPOSITORY, pr: '25', worktree }, { run });
  assert.equal(created.headSha, firstHeadSha);
  assert.equal(await git(gitExecutable, worktree, ['rev-parse', 'HEAD']), firstHeadSha);
  assert.equal(await git(gitExecutable, worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  assert.equal(await readFile(path.join(worktree, 'reviewed.txt'), 'utf8'), 'head one\n');

  metadata = pullRequest(baseSha, secondHeadSha);
  const updated = await syncReview({ repo: REPOSITORY, pr: '25', worktree }, { run });
  assert.equal(updated.headSha, secondHeadSha);
  assert.equal(await git(gitExecutable, worktree, ['rev-parse', 'HEAD']), secondHeadSha);
  assert.equal(await git(gitExecutable, worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  assert.equal(await readFile(path.join(worktree, 'reviewed.txt'), 'utf8'), 'head two\n');

  assert.deepEqual(await checkoutState(gitExecutable, main), mainBefore);
  assert.deepEqual((await readdir(root)).sort(), ['bin', 'main', 'remote.git', 'review', 'review.git-cache', 'review.pr-review.json', 'seed']);
  assert.deepEqual(JSON.parse(await readFile(`${worktree}.pr-review.json`, 'utf8')), {
    contractVersion: 1,
    repository: REPOSITORY,
    prNumber: 25,
    baseSha,
    headSha: secondHeadSha,
  });
  assert.equal((await stat(`${worktree}.git-cache`)).isDirectory(), true);
  await access(`${worktree}.git-cache`, constants.R_OK | constants.W_OK);
  await assert.rejects(access(executionMarker), { code: 'ENOENT' });
});
