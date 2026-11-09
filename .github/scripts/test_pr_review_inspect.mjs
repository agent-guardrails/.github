import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from './pr-review/cli.mjs';
import { INSPECT_ARGUMENTS, inspectReview } from './pr-review/inspect.mjs';
import { projectPatch } from './pr-review/inspect-diff.mjs';
import { BASE, HEAD, makeBundle, temporary } from './pr-review/test-helpers.mjs';

const SCRIPT_DIRECTORY = path.dirname(new URL(import.meta.url).pathname);

function fullPr(body = 'Fixture pull request') {
  return {
    number: 25,
    url: 'https://github.com/agent-guardrails/.github/pull/25',
    title: 'Auditable review workflow',
    body,
    state: 'open',
    author: { login: 'reviewer', id: 7 },
    labels: [{ name: 'feature' }, { name: 'security' }],
    base: { ref: 'main', sha: BASE, repository: 'agent-guardrails/.github' },
    head: { ref: 'feature', sha: HEAD, repository: 'contributor/fork' },
  };
}

function launch(args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(SCRIPT_DIRECTORY, 'pr-review-inspect.mjs'), ...args], { cwd: SCRIPT_DIRECTORY }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

test('pr view returns common identity and paginates body by Unicode code point', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root, { payloads: { 'pr.json': fullPr('A😀BC') } });

  const result = await inspectReview({ bundle: bundle.root, view: 'pr', bodyOffset: '1', bodyLimit: '2' });

  assert.deepEqual({
    contractVersion: result.contractVersion,
    ok: result.ok,
    repository: result.repository,
    prNumber: result.prNumber,
    baseSha: result.baseSha,
    headSha: result.headSha,
    bundlePath: result.bundlePath,
    view: result.view,
  }, {
    contractVersion: 1,
    ok: true,
    repository: 'agent-guardrails/.github',
    prNumber: 25,
    baseSha: BASE,
    headSha: HEAD,
    bundlePath: bundle.root,
    view: 'pr',
  });
  assert.equal(result.title, 'Auditable review workflow');
  assert.equal(result.author, 'reviewer');
  assert.deepEqual(result.labels, ['feature', 'security']);
  assert.deepEqual(result.base, { ref: 'main', sha: BASE });
  assert.deepEqual(result.head, { ref: 'feature', sha: HEAD });
  assert.equal(result.body, '😀B');
  assert.equal(result.bodyTotal, 4);
  assert.equal(result.nextBodyOffset, 3);
});

test('files view preserves verified metadata and reports pagination boundaries', async () => {
  const root = await temporary();
  const files = [
    { filename: 'src/one.mjs', status: 'added' },
    { filename: 'src/two.mjs', status: 'renamed', previous_filename: 'src/old.mjs' },
    { filename: 'src/three.mjs', status: 'removed' },
  ];
  const bundle = await makeBundle(root, { payloads: { 'changed-files.json': files } });

  const result = await inspectReview({ bundle: bundle.root, view: 'files', offset: '1', limit: '1' });

  assert.deepEqual(result.files, [{ path: 'src/two.mjs', status: 'renamed', previousPath: 'src/old.mjs' }]);
  assert.equal(result.returned, 1);
  assert.equal(result.total, 3);
  assert.equal(result.nextOffset, 2);
  const end = await inspectReview({ bundle: bundle.root, view: 'files', offset: '3', limit: '20' });
  assert.deepEqual(end.files, []);
  assert.equal(end.nextOffset, null);
});

test('files view redacts recognized credentials before pagination', async () => {
  const root = await temporary();
  const token = 'ghp_123456789012345678901234567890123456';
  const files = [{
    filename: `src/${token}.mjs`,
    status: 'renamed',
    previous_filename: 'Bearer secret-file-name',
  }];
  const bundle = await makeBundle(root, { payloads: { 'changed-files.json': files } });

  const result = await inspectReview({ bundle: bundle.root, view: 'files', offset: '0', limit: '1' });

  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes('secret-file-name'), false);
  assert.deepEqual(result.files, [{ path: 'src/[REDACTED].mjs', status: 'renamed', previousPath: 'Bearer [REDACTED]' }]);
});

test('diff view accepts rename sides and emits ordered structured hunk lines', async () => {
  const root = await temporary();
  const patch = [
    'diff --git a/src/old.mjs b/src/new.mjs',
    'similarity index 90%',
    'rename from src/old.mjs',
    'rename to src/new.mjs',
    '--- a/src/old.mjs',
    '+++ b/src/new.mjs',
    '@@ -10,2 +10,2 @@ function review()',
    ' context',
    '-old',
    '+new',
    '',
  ].join('\n');
  const bundle = await makeBundle(root, {
    payloads: {
      'changed-files.json': [{ filename: 'src/new.mjs', status: 'renamed', previous_filename: 'src/old.mjs' }],
      'diff.patch': patch,
    },
  });

  const result = await inspectReview({ bundle: bundle.root, view: 'diff', path: 'src/old.mjs', offset: '1', limit: '2' });

  assert.deepEqual(result.file, { oldPath: 'src/old.mjs', newPath: 'src/new.mjs', status: 'renamed' });
  assert.equal(result.total, 3);
  assert.equal(result.returned, 2);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.lines.map(({ kind, text, oldLine, newLine }) => ({ kind, text, oldLine, newLine })), [
    { kind: 'deletion', text: 'old', oldLine: 11, newLine: null },
    { kind: 'addition', text: 'new', oldLine: null, newLine: 11 },
  ]);
  assert.deepEqual(result.lines[0].hunk, {
    index: 0, header: '@@ -10,2 +10,2 @@ function review()', oldStart: 10, oldCount: 2, newStart: 10, newCount: 2,
  });
});

test('diff projection retains only the requested page while validating a large hunk', () => {
  const count = 10_000;
  const patch = [
    'diff --git a/src/large.txt b/src/large.txt',
    '--- a/src/large.txt',
    '+++ b/src/large.txt',
    `@@ -1,${count} +1,${count} @@`,
    ...Array.from({ length: count }, (_, index) => ` line-${index}`),
    '',
  ].join('\n');

  const result = projectPatch(
    patch,
    { oldPath: 'src/large.txt', newPath: 'src/large.txt', status: 'modified' },
    9_998,
    2,
  );

  assert.equal(result.total, count);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(result.lines.map((line) => line.text), ['line-9998', 'line-9999']);
});

test('diff view represents deleted files and rejects absent or ambiguous paths', async () => {
  const root = await temporary();
  const deleted = [
    'diff --git a/src/deleted.mjs b/src/deleted.mjs',
    'deleted file mode 100644',
    '--- a/src/deleted.mjs',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    '',
  ].join('\n');
  const bundle = await makeBundle(root, {
    payloads: {
      'changed-files.json': [{ filename: 'src/deleted.mjs', status: 'removed' }],
      'diff.patch': deleted,
    },
  });
  const result = await inspectReview({ bundle: bundle.root, view: 'diff', path: 'src/deleted.mjs' });
  assert.deepEqual(result.file, { oldPath: 'src/deleted.mjs', newPath: null, status: 'removed' });
  assert.deepEqual(result.lines.map((line) => [line.kind, line.oldLine, line.newLine]), [['deletion', 1, null]]);
  await assert.rejects(inspectReview({ bundle: bundle.root, view: 'diff', path: 'src/missing.mjs' }), { code: 'invalid-input' });

  const ambiguous = await makeBundle(root, {
    output: path.join(root, 'ambiguous'),
    payloads: {
      'changed-files.json': [
        { filename: 'src/one.mjs', status: 'copied', previous_filename: 'src/shared.mjs' },
        { filename: 'src/two.mjs', status: 'copied', previous_filename: 'src/shared.mjs' },
      ],
    },
  });
  await assert.rejects(inspectReview({ bundle: ambiguous.root, view: 'diff', path: 'src/shared.mjs' }), { code: 'invalid-input' });
});

test('diff view represents binary changes without exposing raw patch bytes', async () => {
  const root = await temporary();
  const patch = [
    'diff --git a/assets/logo.png b/assets/logo.png',
    'new file mode 100644',
    'index 0000000..1234567',
    'GIT binary patch',
    'literal 3',
    'KcmZQzU|?Vb0000',
    '',
  ].join('\n');
  const bundle = await makeBundle(root, {
    payloads: {
      'changed-files.json': [{ filename: 'assets/logo.png', status: 'added' }],
      'diff.patch': patch,
    },
  });

  const result = await inspectReview({ bundle: bundle.root, view: 'diff', path: 'assets/logo.png' });

  assert.deepEqual(result.file, { oldPath: null, newPath: 'assets/logo.png', status: 'added' });
  assert.equal(result.textAvailable, false);
  assert.equal(result.binary, true);
  assert.deepEqual(result.lines, []);
  assert.equal(result.total, 0);
});

test('diff view treats header-like hunk lines and no-newline markers as hunk content', async () => {
  const root = await temporary();
  const patch = [
    'diff --git a/src/markers.txt b/src/markers.txt',
    '--- a/src/markers.txt',
    '+++ b/src/markers.txt',
    '@@ -1 +1 @@',
    '--- old marker',
    '\\ No newline at end of file',
    '+++ new marker',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const bundle = await makeBundle(root, {
    payloads: {
      'changed-files.json': [{ filename: 'src/markers.txt', status: 'modified' }],
      'diff.patch': patch,
    },
  });

  const result = await inspectReview({ bundle: bundle.root, view: 'diff', path: 'src/markers.txt' });

  assert.deepEqual(result.lines.map((line) => [line.kind, line.text]), [
    ['deletion', '-- old marker'],
    ['no-newline', 'No newline at end of file'],
    ['addition', '++ new marker'],
    ['no-newline', 'No newline at end of file'],
  ]);
});

test('diff view matches metadata-only sections with Git-quoted paths', async () => {
  const root = await temporary();
  const patch = [
    String.raw`diff --git "a/\303\251.txt" "b/\303\251.txt"`,
    'old mode 100644',
    'new mode 100755',
    '',
  ].join('\n');
  const bundle = await makeBundle(root, {
    payloads: {
      'changed-files.json': [{ filename: 'é.txt', status: 'modified' }],
      'diff.patch': patch,
    },
  });

  const result = await inspectReview({ bundle: bundle.root, view: 'diff', path: 'é.txt' });

  assert.equal(result.textAvailable, false);
  assert.equal(result.binary, false);
  assert.deepEqual(result.lines, []);
});

test('ci view normalizes checks, runs, jobs, selection, and unavailable evidence without logs', async () => {
  const root = await temporary();
  const run = { id: 11, name: 'CI', status: 'completed', conclusion: 'failure', html_url: 'https://example.test/runs/11' };
  const job = { id: 101, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://example.test/jobs/101', logEvidenceState: 'available' };
  const selected = {
    runId: '11', jobId: '101', url: job.html_url, state: 'completed', conclusion: 'failure', evidenceState: 'failed',
    logUrl: 'https://api.github.com/repos/agent-guardrails/.github/actions/jobs/101/logs',
  };
  const bundle = await makeBundle(root, {
    manifest: {
      selectedCi: [selected],
      incompleteOrUnavailableEvidence: [{ kind: 'check', identity: '9', reason: 'cancelled' }],
    },
    payloads: {
      'checks.json': {
        headSha: HEAD,
        checkSuites: [{ id: 8, status: 'completed', conclusion: 'success', url: 'https://example.test/suites/8' }],
        checkRuns: [{ id: 9, name: 'lint', status: 'completed', conclusion: 'cancelled', html_url: 'https://example.test/checks/9' }],
      },
      'ci-runs.json': { headSha: HEAD, runs: [{ ...run, jobs: [job] }] },
    },
    logs: { '11-101.txt': 'SECRET RAW LOG' },
  });

  const result = await inspectReview({ bundle: bundle.root, view: 'ci', offset: '1', limit: '3' });

  assert.deepEqual(result.items.map((item) => item.source), ['check-run', 'ci-run', 'ci-job']);
  assert.equal(result.returned, 3);
  assert.equal(result.total, 4);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.selectedCi, [selected]);
  assert.equal(result.unavailableEvidence[0].reason, 'cancelled');
  assert.equal(JSON.stringify(result).includes('SECRET RAW LOG'), false);
});

test('discussion view keeps stable source order and bounds redacted Unicode text previews', async () => {
  const root = await temporary();
  const longBody = `${'x'.repeat(16_383)}😀tail`;
  const bundle = await makeBundle(root, {
    payloads: {
      'reviews.json': [{ id: 1, user: { login: 'alice' }, state: 'APPROVED', body: 'review', submitted_at: '2026-01-01T00:00:00Z', html_url: 'https://example.test/reviews/1' }],
      'review-comments.json': [{ id: 2, user: { login: 'bob' }, body: longBody, path: 'src/a.mjs', line: 7, side: 'RIGHT', created_at: '2026-01-02T00:00:00Z', html_url: 'https://example.test/comments/2' }],
      'issue-comments.json': [{ id: 3, user: { login: 'carol' }, body: 'Bearer secret-token-value', created_at: '2026-01-03T00:00:00Z', html_url: 'https://example.test/issues/3' }],
    },
  });

  const result = await inspectReview({ bundle: bundle.root, view: 'discussion' });

  assert.deepEqual(result.items.map((item) => item.source), ['review', 'review-comment', 'issue-comment']);
  assert.equal(result.items[1].body.length, 16_385);
  assert.equal([...result.items[1].body].length, 16_384);
  assert.equal(result.items[1].body.endsWith('😀'), true);
  assert.equal(result.items[1].bodyTotal, 16_388);
  assert.equal(result.items[1].bodyTruncated, true);
  assert.equal(result.items[1].nextBodyOffset, 16_384);
  assert.equal(result.items[2].body, 'Bearer [REDACTED]');
});

test('pr pagination redacts credentials before page boundaries are applied', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root, { payloads: { 'pr.json': fullPr('Bearer secret-token-value') } });

  const first = await inspectReview({ bundle: bundle.root, view: 'pr', bodyLimit: '8' });
  const second = await inspectReview({ bundle: bundle.root, view: 'pr', bodyOffset: '8', bodyLimit: '32' });

  assert.equal(`${first.body}${second.body}`, 'Bearer [REDACTED]');
  assert.equal(JSON.stringify(first).includes('secret-token-value'), false);
  assert.equal(JSON.stringify(second).includes('secret-token-value'), false);
});

test('diff view accepts a changed repository path beginning with dashes', async () => {
  const root = await temporary();
  const patch = [
    'diff --git a/--review.txt b/--review.txt',
    '--- a/--review.txt',
    '+++ b/--review.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
  const bundle = await makeBundle(root, {
    payloads: {
      'changed-files.json': [{ filename: '--review.txt', status: 'modified' }],
      'diff.patch': patch,
    },
  });
  const args = parseArgs(['--bundle', bundle.root, '--view', 'diff', '--path', '--review.txt'], INSPECT_ARGUMENTS);

  const result = await inspectReview(args);

  assert.equal(result.file.newPath, '--review.txt');
});

test('manifest view exposes verified provenance and hashes without payloads', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root);

  const result = await inspectReview({ bundle: bundle.root, view: 'manifest' });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.collectorVersion, 'test');
  assert.equal(result.collectedAt, '2026-11-08T00:00:00.000Z');
  assert.equal(result.artifacts.some((artifact) => artifact.path === 'diff.patch' && artifact.sha256.length === 64), true);
  assert.equal(result.fileHashesSha256.length, 64);
  assert.equal(result.manifestCanonicalSha256.length, 64);
  assert.equal(Object.hasOwn(result, 'payloads'), false);
});

test('inspect argument contract rejects unknown, duplicate, malformed, excessive, and wrong-view flags', async () => {
  assert.throws(() => parseArgs(['--bundle', '/tmp/a', '--view', 'pr', '--view', 'files'], INSPECT_ARGUMENTS), { code: 'invalid-input' });
  assert.throws(() => parseArgs(['--bundle', '/tmp/a', '--view', 'pr', '--artifact', 'pr.json'], INSPECT_ARGUMENTS), { code: 'invalid-input' });

  const root = await temporary();
  const bundle = await makeBundle(root);
  for (const args of [
    { bundle: bundle.root, view: 'unknown' },
    { bundle: bundle.root, view: 'pr', offset: '0' },
    { bundle: bundle.root, view: 'files', bodyLimit: '1' },
    { bundle: bundle.root, view: 'diff', path: 'src/review.mjs', bodyOffset: '0' },
    { bundle: bundle.root, view: 'ci', path: 'src/review.mjs' },
    { bundle: bundle.root, view: 'discussion', limit: '0' },
    { bundle: bundle.root, view: 'manifest', offset: '0' },
    { bundle: bundle.root, view: 'files', offset: '-1' },
    { bundle: bundle.root, view: 'files', offset: '1.5' },
    { bundle: bundle.root, view: 'files', offset: String(Number.MAX_SAFE_INTEGER + 1) },
    { bundle: bundle.root, view: 'files', limit: '101' },
    { bundle: bundle.root, view: 'diff', path: 'src/review.mjs', limit: '1001' },
    { bundle: bundle.root, view: 'pr', bodyLimit: '65537' },
    { bundle: bundle.root, view: 'diff' },
  ]) await assert.rejects(inspectReview(args), { code: 'invalid-input' });
});

test('verification rejects tampering before any evidence is returned', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root, { payloads: { 'pr.json': fullPr('sensitive evidence') } });
  await writeFile(path.join(bundle.root, 'pr.json'), JSON.stringify(fullPr('tampered sensitive evidence')));

  await assert.rejects(inspectReview({ bundle: bundle.root, view: 'pr' }), { code: 'hash-mismatch' });
});

test('complete stdout record over one MiB fails instead of shrinking or partially emitting', async () => {
  const root = await temporary();
  const checkRuns = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    name: `check-${index}-${'x'.repeat(12_000)}`,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://example.test/checks/${index}`,
  }));
  const bundle = await makeBundle(root, { payloads: { 'checks.json': { headSha: HEAD, checkRuns, checkSuites: [] } } });

  await assert.rejects(inspectReview({ bundle: bundle.root, view: 'ci', limit: '100' }), { code: 'output-too-large' });
});

test('launcher emits one JSON failure record and exits nonzero', async () => {
  const result = await launch();

  assert.equal(result.error.code, 1);
  const record = JSON.parse(result.stdout);
  assert.equal(record.ok, false);
  assert.equal(record.error.code, 'invalid-input');
  assert.ok(result.stderr.length > 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});
