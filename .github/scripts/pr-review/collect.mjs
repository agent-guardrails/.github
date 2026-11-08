import path from 'node:path';
import { createBundle } from './bundle.mjs';
import { collectRemoteEvidence } from './evidence.mjs';
import { cachePath, localDiff, sidecarPath, verifyManagedWorktree } from './git.mjs';
import { readPr } from './github.mjs';
import { fail, sanitizeEvidence } from './errors.mjs';
import { parseRepository, parsePr, pathIsWithin, validateCallerPath } from './validate.mjs';

function prPayload(raw) {
  return {
    number: raw.number, url: raw.html_url, title: raw.title, body: raw.body,
    state: raw.state, author: raw.user, labels: raw.labels,
    base: { ref: raw.base.ref, sha: raw.base.sha, repository: raw.base.repo.full_name },
    head: { ref: raw.head.ref, sha: raw.head.sha, repository: raw.head.repo.full_name },
  };
}

export async function collectReview(args, dependencies) {
  const repo = parseRepository(args.repo);
  const pr = parsePr(args.pr);
  const worktree = await validateCallerPath(args.worktree, { mustExist: true, kind: 'directory' });
  const output = await validateCallerPath(args.out);
  const protectedPaths = await Promise.all([
    worktree,
    validateCallerPath(cachePath(worktree), { mustExist: true, kind: 'directory' }),
    validateCallerPath(sidecarPath(worktree), { mustExist: true, kind: 'file' }),
  ]);
  if (protectedPaths.some((protectedPath) => pathIsWithin(output, protectedPath) || pathIsWithin(protectedPath, output))) fail('unsafe-path', 'Collection output overlaps managed worktree state');
  const before = await readPr(dependencies.run, repo, pr, worktree);
  const managed = await verifyManagedWorktree(dependencies.run, worktree, repo, pr, before);
  if (managed.sidecar.baseSha !== before.baseSha || managed.sidecar.headSha !== before.headSha) fail('stale-head', 'Worktree sidecar does not match current PR identity');
  const diff = await localDiff(dependencies.run, worktree, before.baseSha, before.headSha);
  const evidence = await collectRemoteEvidence(dependencies.run, repo, pr, before.headSha, before.changedFiles, worktree);
  const after = await readPr(dependencies.run, repo, pr, worktree);
  if (after.baseSha !== before.baseSha || after.headSha !== before.headSha) fail('stale-head', 'PR identity changed during collection');
  const identity = { repository: repo.full, prNumber: pr, baseSha: before.baseSha, headSha: before.headSha };
  const manifest = {
    schemaVersion: 1,
    collectorVersion: '1.0.0',
    repository: { owner: repo.owner, name: repo.name, url: `https://github.com/${repo.full}` },
    pullRequest: { number: pr, url: before.raw.html_url },
    baseSha: before.baseSha,
    headSha: before.headSha,
    collectedAt: dependencies.now().toISOString(),
    localWorktree: { path: worktree, verifiedHeadSha: managed.head },
    selectedCi: evidence.selectedCi,
    incompleteOrUnavailableEvidence: evidence.incomplete,
  };
  const bundle = await createBundle(output, {
    identity, manifest, logs: evidence.logs,
    payloads: sanitizeEvidence({
      'pr.json': prPayload(before.raw),
      'changed-files.json': evidence.changedFiles,
      'diff.patch': diff,
      'reviews.json': evidence.reviews,
      'review-comments.json': evidence.reviewComments,
      'issue-comments.json': evidence.issueComments,
      'checks.json': { headSha: before.headSha, ...evidence.checks },
      'ci-runs.json': { headSha: before.headSha, runs: evidence.ciRuns },
    }),
  });
  return {
    contractVersion: 1, ok: true, repository: repo.full, prNumber: pr,
    baseSha: before.baseSha, headSha: before.headSha, out: bundle.root,
  };
}
