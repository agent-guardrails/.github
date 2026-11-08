import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBundle, MAX_ARTIFACT_BYTES, MAX_BUNDLE_BYTES, verifyBundle } from './pr-review/bundle.mjs';
import { canonicalJson, jsonFile, sha256 } from './pr-review/json.mjs';
import { bundleData, makeBundle, temporary } from './pr-review/test-helpers.mjs';

async function rewriteIntegrity(root) {
  const names = (await readdir(root)).filter((name) => !['manifest.json', 'file-hashes.json', 'ci-logs'].includes(name));
  const logs = (await readdir(path.join(root, 'ci-logs'))).map((name) => `ci-logs/${name}`);
  const payloads = [...names, ...logs].sort();
  const hashes = {};
  const artifacts = [];
  for (const name of payloads) {
    const bytes = await readFile(path.join(root, name));
    hashes[name] = sha256(bytes);
    artifacts.push({ path: name, bytes: bytes.length, sha256: hashes[name] });
  }
  const hashBytes = Buffer.from(jsonFile(hashes));
  await writeFile(path.join(root, 'file-hashes.json'), hashBytes);
  artifacts.push({ path: 'file-hashes.json', bytes: hashBytes.length, sha256: sha256(hashBytes) });
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json')));
  manifest.artifacts = artifacts;
  manifest.fileHashesSha256 = sha256(hashBytes);
  delete manifest.manifestCanonicalSha256;
  manifest.manifestCanonicalSha256 = sha256(canonicalJson(manifest));
  await writeFile(path.join(root, 'manifest.json'), jsonFile(manifest));
}

function ciBundleData(root) {
  const data = bundleData(root);
  const run = { id: 11, name: 'CI', status: 'completed', conclusion: 'failure', html_url: 'https://example.test/runs/11' };
  const job = { id: 101, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://example.test/jobs/101', logEvidenceState: 'available' };
  data.manifest.selectedCi = [{
    runId: '11', jobId: '101', url: job.html_url, state: 'completed', conclusion: 'failure', evidenceState: 'failed',
    logUrl: 'https://api.github.com/repos/agent-guardrails/.github/actions/jobs/101/logs',
  }];
  data.payloads['ci-runs.json'] = { headSha: 'b'.repeat(40), runs: [{ ...run, jobs: [job] }] };
  data.logs = { '11-101.txt': 'log' };
  return data;
}

test('bundle has fixed inventory, empty ci-logs, hashes, and canonical self-digest', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root);
  const entries = await readdir(bundle.root);
  assert.deepEqual(entries.sort(), ['changed-files.json', 'checks.json', 'ci-logs', 'ci-runs.json', 'diff.patch', 'file-hashes.json', 'issue-comments.json', 'manifest.json', 'pr.json', 'review-comments.json', 'reviews.json']);
  assert.deepEqual(await readdir(path.join(bundle.root, 'ci-logs')), []);
  assert.equal(bundle.hashes['manifest.json'], undefined);
  assert.equal(bundle.hashes['file-hashes.json'], undefined);
  const copy = { ...bundle.manifest };
  delete copy.manifestCanonicalSha256;
  assert.equal(bundle.manifest.manifestCanonicalSha256, sha256(canonicalJson(copy)));
});

test('bundle verification returns captured bytes for every bundle member', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root);
  const entries = await readdir(bundle.root);
  const artifactPaths = [...entries.filter((name) => name !== 'ci-logs'), ...(await readdir(path.join(bundle.root, 'ci-logs'))).map((name) => `ci-logs/${name}`)].sort();

  assert.deepEqual([...bundle.artifactBytes.keys()].sort(), artifactPaths);
  assert.deepEqual(bundle.artifactBytes.get('pr.json'), await readFile(path.join(bundle.root, 'pr.json')));
});

test('bundle verification detects payload, self-hash, extra-file, and path tampering', async (t) => {
  await t.test('payload', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    await writeFile(path.join(bundle.root, 'diff.patch'), 'tampered');
    await assert.rejects(verifyBundle(bundle.root), { code: 'hash-mismatch' });
  });
  await t.test('manifest', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    const manifest = JSON.parse(await readFile(path.join(bundle.root, 'manifest.json')));
    manifest.collectedAt = '2027-01-01T00:00:00.000Z';
    await writeFile(path.join(bundle.root, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyBundle(bundle.root), { code: 'hash-mismatch' });
  });
  await t.test('extra file', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    await writeFile(path.join(bundle.root, 'extra.txt'), 'x');
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });
  await t.test('self-consistent extra file', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    await writeFile(path.join(bundle.root, 'extra.txt'), 'x');
    await rewriteIntegrity(bundle.root);
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });
  await t.test('self-consistent PR identity mismatch', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    const pr = JSON.parse(await readFile(path.join(bundle.root, 'pr.json')));
    pr.number = 26;
    await writeFile(path.join(bundle.root, 'pr.json'), jsonFile(pr));
    await rewriteIntegrity(bundle.root);
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });
  await t.test('self-consistent orphan CI log', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    await writeFile(path.join(bundle.root, 'ci-logs', '1-2.txt'), 'orphan');
    await rewriteIntegrity(bundle.root);
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });
  await t.test('self-consistent CI head mismatch', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    const checks = JSON.parse(await readFile(path.join(bundle.root, 'checks.json')));
    checks.headSha = 'c'.repeat(40);
    await writeFile(path.join(bundle.root, 'checks.json'), jsonFile(checks));
    await rewriteIntegrity(bundle.root);
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });
  await t.test('symlink', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    await symlink('/etc/passwd', path.join(bundle.root, 'ci-logs', 'escape.txt'));
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });
  await t.test('missing ci-logs directory', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    await rm(path.join(bundle.root, 'ci-logs'), { recursive: true });
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });
});

test('same-head collision is reused and wrong-head collision is refused', async () => {
  const root = await temporary();
  const first = await makeBundle(root);
  const manifestPath = path.join(first.root, 'manifest.json');
  const beforeBytes = await readFile(manifestPath);
  const beforeStat = await stat(manifestPath, { bigint: true });
  const reused = await createBundle(first.root, bundleData(root));
  assert.equal(reused.manifest.headSha, 'b'.repeat(40));
  assert.deepEqual(await readFile(manifestPath), beforeBytes);
  assert.equal((await stat(manifestPath, { bigint: true })).mtimeNs, beforeStat.mtimeNs);
  await assert.rejects(createBundle(first.root, bundleData(root, { identity: { headSha: 'c'.repeat(40) } })), { code: 'bundle-exists' });
});

test('same-head collision refuses changed evidence instead of reusing stale evidence', async (t) => {
  await t.test('payload hash', async () => {
    const root = await temporary();
    const first = await makeBundle(root);
    const candidate = bundleData(root, { payloads: { 'reviews.json': [{ id: 1 }] } });
    await assert.rejects(createBundle(first.root, candidate), { code: 'bundle-exists' });
  });
  await t.test('log hash', async () => {
    const root = await temporary();
    const data = ciBundleData(root);
    const first = await createBundle(path.join(root, 'bundle'), data);
    const candidate = ciBundleData(root);
    candidate.logs = { '11-101.txt': 'changed log' };
    await assert.rejects(createBundle(first.root, candidate), { code: 'bundle-exists' });
  });
  await t.test('CI selection', async () => {
    const root = await temporary();
    const data = ciBundleData(root);
    const first = await createBundle(path.join(root, 'bundle'), data);
    const candidate = ciBundleData(root);
    candidate.manifest.selectedCi[0].evidenceState = 'missing';
    await assert.rejects(createBundle(first.root, candidate), { code: 'bundle-exists' });
  });
  await t.test('unavailable evidence', async () => {
    const root = await temporary();
    const first = await makeBundle(root);
    const candidate = bundleData(root, { manifest: { incompleteOrUnavailableEvidence: [{ kind: 'check', identity: '99', reason: 'Unavailable' }] } });
    await assert.rejects(createBundle(first.root, candidate), { code: 'bundle-exists' });
  });
  await t.test('worktree provenance', async () => {
    const root = await temporary();
    const first = await makeBundle(root, { worktree: path.join(root, 'worktree-one') });
    const candidate = bundleData(root, { worktree: path.join(root, 'worktree-two') });
    await assert.rejects(createBundle(first.root, candidate), { code: 'bundle-exists' });
  });
});

test('canonical manifest is deterministic except timestamp and its derived self-digest', async () => {
  const root = await temporary();
  const commonWorktree = path.join(root, 'worktree');
  const first = await makeBundle(root, { output: path.join(root, 'one'), worktree: commonWorktree, manifest: { collectedAt: '2026-01-01T00:00:00.000Z' } });
  const second = await makeBundle(root, { output: path.join(root, 'two'), worktree: commonWorktree, manifest: { collectedAt: '2026-02-01T00:00:00.000Z' } });
  const normalized = (manifest) => {
    const copy = structuredClone(manifest);
    delete copy.collectedAt;
    delete copy.manifestCanonicalSha256;
    return copy;
  };
  assert.deepEqual(normalized(first.manifest), normalized(second.manifest));
});

test('failed bundle creation cleans sibling staging directory', async () => {
  const root = await temporary();
  const output = path.join(root, 'bundle');
  await assert.rejects(createBundle(output, {
    identity: {}, manifest: {}, payloads: Object.fromEntries([
      'changed-files.json', 'checks.json', 'ci-runs.json', 'diff.patch', 'issue-comments.json', 'pr.json', 'review-comments.json', 'reviews.json',
    ].map((name) => [name, name === 'diff.patch' ? '' : {}])), logs: { '../escape.txt': 'x' },
  }), { code: 'bundle-invalid' });
  assert.deepEqual(await readdir(root), []);
});

test('staged cross-file validation fails before output publication', async () => {
  const root = await temporary();
  const output = path.join(root, 'bundle');
  const data = bundleData(root, { payloads: { 'pr.json': { number: 26 } } });
  await assert.rejects(createBundle(output, data), { code: 'bundle-invalid' });
  assert.deepEqual(await readdir(root), []);
});

test('production verifier enforces local worktree schema and length limits', async () => {
  const root = await temporary();
  for (const [name, manifest] of [
    ['worktree too long', { localWorktree: { path: `/${'x'.repeat(4096)}`, verifiedHeadSha: 'b'.repeat(40) } }],
    ['worktree relative', { localWorktree: { path: 'worktree', verifiedHeadSha: 'b'.repeat(40) } }],
    ['worktree control character', { localWorktree: { path: '/worktree\nnext', verifiedHeadSha: 'b'.repeat(40) } }],
    ['worktree trailing control character', { localWorktree: { path: '/worktree\n', verifiedHeadSha: 'b'.repeat(40) } }],
    ['worktree C1 control character', { localWorktree: { path: '/worktree\u0085next', verifiedHeadSha: 'b'.repeat(40) } }],
    ['worktree Windows drive', { localWorktree: { path: 'C:\\worktree', verifiedHeadSha: 'b'.repeat(40) } }],
    ['unavailable', { incompleteOrUnavailableEvidence: [{ kind: 'ci-log', identity: 'x', reason: 'x'.repeat(4097) }] }],
  ]) {
    await assert.rejects(createBundle(path.join(root, name), bundleData(root, { manifest })), { code: 'bundle-invalid' });
  }
});

test('bundle permits safe previous filenames only for renamed and copied files', async (t) => {
  for (const [name, changed, valid] of [
    ['renamed', { filename: 'src/current.mjs', status: 'renamed', previous_filename: 'src/previous.mjs' }, true],
    ['copied', { filename: 'src/current.mjs', status: 'copied', previous_filename: 'src/previous.mjs' }, true],
    ['renamed without source', { filename: 'src/current.mjs', status: 'renamed' }, false],
    ['copied without source', { filename: 'src/current.mjs', status: 'copied' }, false],
    ['copied unsafe source', { filename: 'src/current.mjs', status: 'copied', previous_filename: '../previous.mjs' }, false],
    ['renamed unsafe source', { filename: 'src/current.mjs', status: 'renamed', previous_filename: 'src/previous\n.mjs' }, false],
    ['added with source', { filename: 'src/current.mjs', status: 'added', previous_filename: 'src/previous.mjs' }, false],
    ['removed with source', { filename: 'src/current.mjs', status: 'removed', previous_filename: 'src/previous.mjs' }, false],
    ['modified with source', { filename: 'src/current.mjs', status: 'modified', previous_filename: 'src/previous.mjs' }, false],
  ]) {
    await t.test(name, async () => {
      const root = await temporary();
      const creation = createBundle(path.join(root, 'bundle'), bundleData(root, { payloads: { 'changed-files.json': [changed] } }));
      if (valid) await assert.doesNotReject(creation);
      else await assert.rejects(creation, { code: 'bundle-invalid' });
    });
  }
});

test('bundle byte budgets reject oversized candidates and on-disk bundles', async (t) => {
  await t.test('accepts an artifact at the per-artifact boundary', async () => {
    const root = await temporary();
    const bundle = await createBundle(path.join(root, 'bundle'), bundleData(root, { payloads: { 'diff.patch': Buffer.alloc(MAX_ARTIFACT_BYTES) } }));
    assert.equal((await stat(path.join(bundle.root, 'diff.patch'))).size, MAX_ARTIFACT_BYTES);
    await verifyBundle(bundle.root);
  });

  await t.test('rejects a candidate artifact above the per-artifact boundary before staging', async () => {
    const root = await temporary();
    await assert.rejects(
      createBundle(path.join(root, 'bundle'), bundleData(root, { payloads: { 'diff.patch': Buffer.alloc(MAX_ARTIFACT_BYTES + 1) } })),
      { code: 'bundle-invalid' },
    );
    assert.deepEqual(await readdir(root), []);
  });

  await t.test('rejects a manifest artifact above the per-artifact boundary', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    const manifest = JSON.parse(await readFile(path.join(bundle.root, 'manifest.json')));
    manifest.artifacts[0].bytes = MAX_ARTIFACT_BYTES + 1;
    await writeFile(path.join(bundle.root, 'manifest.json'), jsonFile(manifest));
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });

  await t.test('rejects an on-disk artifact above the per-artifact boundary before reads', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    await truncate(path.join(bundle.root, 'diff.patch'), MAX_ARTIFACT_BYTES + 1);
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });

  await t.test('accepts an actual bundle at the total boundary until integrity verification', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    const payloads = bundle.manifest.artifacts.map((artifact) => artifact.path).filter((name) => name !== 'file-hashes.json');
    const metadataBytes = (await stat(path.join(bundle.root, 'manifest.json'))).size + (await stat(path.join(bundle.root, 'file-hashes.json'))).size;
    let remainingBytes = MAX_BUNDLE_BYTES - metadataBytes;
    for (const name of payloads) {
      const bytes = Math.min(MAX_ARTIFACT_BYTES, remainingBytes);
      await truncate(path.join(bundle.root, name), bytes);
      remainingBytes -= bytes;
    }
    assert.equal(remainingBytes, 0);
    await assert.rejects(verifyBundle(bundle.root), { code: 'hash-mismatch' });
  });

  await t.test('rejects actual bundles above the total boundary before artifact reads', async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    for (const artifact of bundle.manifest.artifacts.filter((item) => item.path !== 'file-hashes.json')) {
      await truncate(path.join(bundle.root, artifact.path), MAX_ARTIFACT_BYTES);
    }
    await assert.rejects(verifyBundle(bundle.root), { code: 'bundle-invalid' });
  });

  await t.test('rejects a candidate completed bundle above the total boundary before staging', async () => {
    const root = await temporary();
    const artifact = Buffer.alloc(MAX_ARTIFACT_BYTES);
    const logs = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${index}.txt`, artifact]));
    await assert.rejects(createBundle(path.join(root, 'bundle'), bundleData(root, { logs })), { code: 'bundle-invalid' });
    assert.deepEqual(await readdir(root), []);
  });
});

test('bundle verification rejects self-consistent CI relationship tampering', async (t) => {
  for (const [name, mutate] of [
    ['run state', async (root) => { const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'))); manifest.selectedCi[0].state = 'queued'; await writeFile(path.join(root, 'manifest.json'), jsonFile(manifest)); }],
    ['run conclusion', async (root) => { const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'))); manifest.selectedCi[0].conclusion = 'success'; await writeFile(path.join(root, 'manifest.json'), jsonFile(manifest)); }],
    ['log URL', async (root) => { const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'))); manifest.selectedCi[0].logUrl = 'https://example.test/wrong'; await writeFile(path.join(root, 'manifest.json'), jsonFile(manifest)); }],
    ['log state', async (root) => { const ci = JSON.parse(await readFile(path.join(root, 'ci-runs.json'))); ci.runs[0].jobs[0].logEvidenceState = 'unknown'; await writeFile(path.join(root, 'ci-runs.json'), jsonFile(ci)); }],
  ]) {
    await t.test(name, async () => {
      const root = await temporary();
      const output = path.join(root, 'bundle');
      await createBundle(output, ciBundleData(root));
      await mutate(output);
      await rewriteIntegrity(output);
      await assert.rejects(verifyBundle(output), { code: 'bundle-invalid' });
    });
  }
});
