import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBundle } from './bundle.mjs';
import { deriveFindingId } from './findings.mjs';

export const BASE = 'a'.repeat(40);
export const HEAD = 'b'.repeat(40);
export const REPO = { full: 'agent-guardrails/.github', owner: 'agent-guardrails', name: '.github' };

export async function temporary(prefix = 'pr-review-') {
  return mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
}

export async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/pr-review/${name}`, import.meta.url), 'utf8'));
}

export function bundleData(root, overrides = {}) {
  return {
    identity: { repository: REPO.full, prNumber: 25, baseSha: BASE, headSha: HEAD, ...overrides.identity },
    manifest: {
      schemaVersion: 1, collectorVersion: 'test',
      repository: { owner: REPO.owner, name: REPO.name, url: `https://github.com/${REPO.full}` },
      pullRequest: { number: 25, url: `https://github.com/${REPO.full}/pull/25` },
      baseSha: BASE, headSha: HEAD, collectedAt: '2026-11-08T00:00:00.000Z',
      localWorktree: { path: overrides.worktree ?? path.join(root, 'worktree'), verifiedHeadSha: HEAD },
      selectedCi: [], incompleteOrUnavailableEvidence: [],
      ...overrides.manifest,
    },
    payloads: {
      'pr.json': {
        number: 25,
        url: `https://github.com/${REPO.full}/pull/25`,
        base: { sha: BASE, repository: REPO.full },
        head: { sha: HEAD, repository: 'contributor/fork' },
      },
      'changed-files.json': [{ filename: 'src/review.mjs', status: 'modified' }],
      'diff.patch': 'diff --git a/src/review.mjs b/src/review.mjs\n--- a/src/review.mjs\n+++ b/src/review.mjs\n@@ -10,3 +10,3 @@\n context\n-old\n+new\n context\n',
      'reviews.json': [], 'review-comments.json': [], 'issue-comments.json': [],
      'checks.json': { headSha: HEAD, checkRuns: [], checkSuites: [] },
      'ci-runs.json': { headSha: HEAD, runs: [] },
      ...overrides.payloads,
    },
    logs: overrides.logs ?? {},
  };
}

export async function makeBundle(root, overrides = {}) {
  const output = overrides.output ?? path.join(root, 'bundle');
  return createBundle(output, bundleData(root, overrides));
}

export async function makeFindings(root, bundle, mutate = (value) => value) {
  const template = await fixture('findings.json');
  template.findings[0].evidenceReferences = [{
    path: 'diff.patch', sha256: bundle.artifactHashes.get('diff.patch'),
  }];
  template.findings[0].findingId = deriveFindingId(template, template.findings[0]);
  const document = mutate(template) ?? template;
  const file = path.join(root, 'findings.json');
  await writeFile(file, `${JSON.stringify(document)}\n`);
  return file;
}

export async function managedLayout(root) {
  const worktree = path.join(root, 'worktree');
  await mkdir(worktree);
  await mkdir(`${worktree}.git-cache`);
  await writeFile(`${worktree}.pr-review.json`, JSON.stringify({ contractVersion: 1, repository: REPO.full, prNumber: 25, baseSha: BASE, headSha: HEAD }));
  return worktree;
}
