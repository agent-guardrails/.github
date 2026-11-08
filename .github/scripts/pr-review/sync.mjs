import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicFile } from './files.mjs';
import { fail } from './errors.mjs';
import { addOrUpdateWorktree, cachePath, fetchRevisions, initCache, sidecarPath, verifyManagedWorktree } from './git.mjs';
import { jsonFile } from './json.mjs';
import { readPr } from './github.mjs';
import { parseRepository, parsePr, parseSha, validateCallerPath } from './validate.mjs';

async function pathExists(value) {
  try { await lstat(value); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function syncReview(args, dependencies) {
  const repo = parseRepository(args.repo);
  const pr = parsePr(args.pr);
  const worktree = await validateCallerPath(args.worktree);
  const cache = await validateCallerPath(cachePath(worktree));
  const sidecar = await validateCallerPath(sidecarPath(worktree));
  const states = await Promise.all([worktree, cache, sidecar].map(pathExists));
  const exists = states.every(Boolean);
  if (!exists && states.some(Boolean)) fail('worktree-conflict', 'Managed worktree paths are incomplete or collide with existing state');
  const expectedHead = args.head === undefined ? undefined : parseSha(args.head, 'expected head SHA');
  const identity = await readPr(dependencies.run, repo, pr, path.dirname(worktree));
  if (expectedHead && expectedHead !== identity.headSha) fail('head-mismatch', 'Resolved PR head does not equal --head');
  if (exists) {
    await validateCallerPath(worktree, { mustExist: true, kind: 'directory' });
    await verifyManagedWorktree(dependencies.run, worktree, repo, pr);
  } else {
    await mkdir(path.dirname(worktree), { recursive: true });
    await initCache(dependencies.run, worktree);
  }
  await fetchRevisions(dependencies.run, worktree, identity, repo, pr);
  await addOrUpdateWorktree(dependencies.run, worktree, exists, identity.headSha);
  await atomicFile(sidecar, jsonFile({
    contractVersion: 1,
    repository: repo.full,
    prNumber: pr,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
  }));
  await verifyManagedWorktree(dependencies.run, worktree, repo, pr, identity);
  return {
    contractVersion: 1, ok: true, repository: repo.full, prNumber: pr,
    baseSha: identity.baseSha, headSha: identity.headSha, worktree,
  };
}
