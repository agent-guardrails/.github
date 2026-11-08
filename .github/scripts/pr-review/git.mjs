import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';
import { parseJson } from './json.mjs';
import { textCommand } from './runner.mjs';
import { validateCallerPath } from './validate.mjs';

export const cachePath = (worktree) => `${worktree}.git-cache`;
export const sidecarPath = (worktree) => `${worktree}.pr-review.json`;

async function git(run, cwd, args, options = {}) {
  return textCommand(run, 'git', args, { cwd, errorCode: options.errorCode ?? 'worktree-conflict', allowFailure: options.allowFailure });
}

export async function initCache(run, worktree) {
  const cache = cachePath(worktree);
  await mkdir(cache, { mode: 0o700 });
  await git(run, path.dirname(worktree), ['init', '--bare', cache]);
  await git(run, path.dirname(worktree), ['--git-dir', cache, 'config', 'core.sharedRepository', 'false']);
  return cache;
}

export async function fetchRevisions(run, worktree, identity, repo, pr) {
  const cache = cachePath(worktree);
  const baseUrl = `https://github.com/${repo.full}.git`;
  const headUrl = `https://github.com/${identity.headRepo}.git`;
  await git(run, path.dirname(worktree), ['--git-dir', cache, 'fetch', '--no-tags', baseUrl, `+${identity.baseSha}:refs/pr-review/base`]);
  await git(run, path.dirname(worktree), ['--git-dir', cache, 'fetch', '--no-tags', headUrl, `+${identity.headSha}:refs/pr-review/head`]);
  for (const [name, expected] of [['base', identity.baseSha], ['head', identity.headSha]]) {
    const fetched = (await git(run, path.dirname(worktree), ['--git-dir', cache, 'rev-parse', `refs/pr-review/${name}^{commit}`])).trim();
    if (fetched !== expected) fail('head-mismatch', `Fetched ${name} object does not equal resolved PR revision`);
  }
}

export async function readSidecar(worktree) {
  try {
    const sidecar = await validateCallerPath(sidecarPath(worktree), { mustExist: true, kind: 'file' });
    return parseJson(await readFile(sidecar), 'worktree-conflict', 'Worktree sidecar');
  }
  catch (error) {
    if (error.code === 'ENOENT') fail('worktree-conflict', 'Managed worktree sidecar is missing');
    throw error;
  }
}

export async function verifyManagedWorktree(run, worktree, repo, pr, expected = {}) {
  const cache = cachePath(worktree);
  await validateCallerPath(cache, { mustExist: true, kind: 'directory' });
  const sidecar = await readSidecar(worktree);
  if (sidecar.contractVersion !== 1 || sidecar.repository !== repo.full || sidecar.prNumber !== pr) fail('worktree-conflict', 'Worktree sidecar identity mismatch');
  const listing = await git(run, path.dirname(worktree), ['--git-dir', cache, 'worktree', 'list', '--porcelain']);
  const registered = listing.split(/\n\n+/).some((block) => block.split('\n').includes(`worktree ${worktree}`));
  if (!registered) fail('worktree-conflict', 'Path is not registered in the private cache');
  const status = await git(run, worktree, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], { errorCode: 'worktree-conflict' });
  if (status !== '') fail('worktree-dirty', 'Managed worktree has modified or untracked files');
  const head = (await git(run, worktree, ['rev-parse', 'HEAD'])).trim();
  const branch = (await git(run, worktree, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true })).trim();
  if (branch) fail('worktree-conflict', 'Managed worktree must have detached HEAD');
  if (expected.headSha && head !== expected.headSha) fail('head-mismatch', 'Managed worktree is at another head');
  for (const sha of [expected.baseSha, expected.headSha].filter(Boolean)) {
    await git(run, worktree, ['cat-file', '-e', `${sha}^{commit}`], { errorCode: 'head-mismatch' });
  }
  return { sidecar, head, cache };
}

export async function localDiff(run, worktree, baseSha, headSha) {
  return git(run, worktree, ['diff', '--no-ext-diff', '--no-textconv', '--binary', `${baseSha}..${headSha}`]);
}

export async function addOrUpdateWorktree(run, worktree, exists, headSha) {
  const cache = cachePath(worktree);
  if (exists) await git(run, worktree, ['checkout', '--detach', headSha]);
  else await git(run, path.dirname(worktree), ['--git-dir', cache, 'worktree', 'add', '--detach', worktree, headSha]);
  const actual = (await git(run, worktree, ['rev-parse', 'HEAD'])).trim();
  if (actual !== headSha) fail('head-mismatch', 'Resulting worktree HEAD is incorrect');
}
