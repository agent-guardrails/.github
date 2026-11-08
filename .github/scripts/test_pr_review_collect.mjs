import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { collectReview } from './pr-review/collect.mjs';
import { collectRemoteEvidence } from './pr-review/evidence.mjs';
import { verifyBundle } from './pr-review/bundle.mjs';
import { MAX_ARTIFACT_BYTES } from './pr-review/bundle.mjs';
import { BASE, fixture, HEAD, managedLayout, REPO, temporary } from './pr-review/test-helpers.mjs';

const response = (value, code = 0, stderr = '') => ({ code, stdout: Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), stderr: Buffer.from(stderr) });

function remoteEvidenceRunner(logs) {
  const jobs = Object.keys(logs).map((id) => ({ id: Number(id), name: `job-${id}`, status: 'completed', conclusion: 'success', html_url: `https://example.test/jobs/${id}` }));
  return async (executable, args) => {
    assert.equal(executable, 'gh');
    const endpoint = args.find((arg) => arg.startsWith('/repos/'));
    assert.equal(args.includes('--allow-escape-sequences'), endpoint.includes('/actions/jobs/') && endpoint.endsWith('/logs'));
    if (endpoint.includes('/pulls/25/files') || endpoint.includes('/pulls/25/reviews') || endpoint.includes('/pulls/25/comments') || endpoint.includes('/issues/25/comments')) return response([]);
    if (endpoint.includes('/check-runs')) return response({ total_count: 0, check_runs: [] });
    if (endpoint.includes('/check-suites')) return response({ total_count: 0, check_suites: [] });
    if (endpoint.includes('/actions/runs?')) return response({ total_count: 1, workflow_runs: [{ id: 11, name: 'CI', status: 'completed', conclusion: 'success', html_url: 'https://example.test/runs/11' }] });
    if (endpoint.includes('/actions/runs/11/jobs')) return response({ total_count: jobs.length, jobs });
    const match = /\/actions\/jobs\/(\d+)\/logs/.exec(endpoint);
    if (match) return response(logs[match[1]]);
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
}

async function collectorRunner(worktree, options = {}) {
  const pr = await fixture('pr.json');
  pr.body = 'credential github_pat_abcdefghijklmnopqrstuvwxyz must not persist';
  let prReads = 0;
  const calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    if (executable === 'git') {
      if (args.includes('list')) return response(`worktree ${worktree}\nHEAD ${HEAD}\ndetached\n`);
    if (args[0] === 'status') return response(options.status ?? '');
      if (args[0] === 'rev-parse') return response(`${HEAD}\n`);
      if (args[0] === 'symbolic-ref') return response('', 1);
      if (args[0] === 'diff') return response('LOCAL PINNED DIFF\n');
      return response('');
    }
    const endpoint = args.find((arg) => arg.startsWith('/repos/'));
    assert.equal(args.includes('--allow-escape-sequences'), endpoint.includes('/actions/jobs/') && endpoint.endsWith('/logs'));
    if (endpoint.endsWith('/pulls/25')) {
      prReads += 1;
      const value = structuredClone(pr);
      if (options.stale && prReads === 2) value.head.sha = 'c'.repeat(40);
      return response(value);
    }
    if (endpoint.includes('/pulls/25/files')) return response(options.changedFiles ?? [
      { filename: 'src/a.mjs', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: '@@ -1 +1 @@' },
      { filename: 'src/b.mjs', status: 'renamed', previous_filename: 'src/old b.mjs', contents_url: 'https://example.test/contents/b' },
    ]);
    if (endpoint.includes('/pulls/25/reviews')) return response([{ id: 1 }, { id: 2 }]);
    if (endpoint.includes('/pulls/25/comments')) return response([{ id: 3 }, { id: 4 }]);
    if (endpoint.includes('/issues/25/comments')) return response([{ id: 5 }, { id: 6 }]);
    if (endpoint.includes('/check-runs')) return response(options.emptyChecks ? { total_count: 0, check_runs: [] } : { total_count: 2, check_runs: [{ id: 7, status: 'completed', conclusion: 'failure' }, { id: 8, status: 'in_progress', conclusion: null }] });
    if (endpoint.includes('/check-suites')) return response(options.emptyChecks ? { total_count: 0, check_suites: [] } : { total_count: 2, check_suites: [{ id: 9, status: 'completed', conclusion: 'success' }, { id: 10, status: 'completed', conclusion: 'cancelled' }] });
    if (endpoint.includes('/actions/runs?')) return response(options.noRuns ? { total_count: 0, workflow_runs: [] } : { total_count: options.noJobs ? 1 : 2, workflow_runs: [{ id: 11, name: 'CI', status: 'completed', conclusion: 'failure', html_url: 'https://example.test/runs/11' }, ...(options.noJobs ? [] : [{ id: 12, name: 'Lint', status: 'in_progress', conclusion: null, html_url: 'https://example.test/runs/12' }])] });
    if (endpoint.includes('/actions/runs/11/jobs')) return response(options.noJobs ? { total_count: 0, jobs: [] } : { total_count: 2, jobs: [{ id: 101, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://example.test/jobs/101' }, { id: 102, name: 'private', status: 'completed', conclusion: 'success', html_url: 'https://example.test/jobs/102' }] });
    if (endpoint.includes('/actions/runs/12/jobs')) return response({ total_count: 3, jobs: [
      { id: 103, name: 'lint', status: 'in_progress', conclusion: null, html_url: 'https://example.test/jobs/103' },
      { id: 104, name: 'cancelled', status: 'completed', conclusion: 'cancelled', html_url: 'https://example.test/jobs/104' },
      { id: 105, name: 'skipped', status: 'completed', conclusion: 'skipped', html_url: 'https://example.test/jobs/105' },
    ] });
    if (endpoint.includes('/actions/jobs/101/logs')) return response('plain log text');
    if (endpoint.includes('/actions/jobs/102/logs')) return response('', 1, 'HTTP 404: not found');
    if (endpoint.includes('/actions/jobs/104/logs')) return response('cancelled job log');
    if (endpoint.includes('/actions/jobs/105/logs')) return response('skipped job log');
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  return { run, calls };
}

test('collect verifies source, flattens every pagination surface, and records CI gaps', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const out = path.join(root, 'bundle');
  const fake = await collectorRunner(worktree);
  const result = await collectReview({ repo: 'agent-guardrails/.github', pr: '25', worktree, out }, { run: fake.run, now: () => new Date('2026-11-08T00:00:00Z') });
  assert.equal(result.out, out);
  const bundle = await verifyBundle(out);
  assert.equal(await readFile(path.join(out, 'diff.patch'), 'utf8'), 'LOCAL PINNED DIFF\n');
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'changed-files.json'))), [
    { filename: 'src/a.mjs', status: 'modified' },
    { filename: 'src/b.mjs', status: 'renamed', previous_filename: 'src/old b.mjs' },
  ]);
  assert.equal(JSON.parse(await readFile(path.join(out, 'reviews.json'))).length, 2);
  assert.equal(JSON.parse(await readFile(path.join(out, 'review-comments.json'))).length, 2);
  assert.equal(JSON.parse(await readFile(path.join(out, 'issue-comments.json'))).length, 2);
  assert.equal(JSON.parse(await readFile(path.join(out, 'checks.json'))).checkRuns.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(out, 'ci-runs.json'))).runs.length, 2);
  assert.equal((await readFile(path.join(out, 'pr.json'), 'utf8')).includes('github_pat_'), false);
  assert.equal((await readFile(path.join(out, 'pr.json'), 'utf8')).includes('[REDACTED]'), true);
  await access(path.join(out, 'ci-logs', '11-101.txt'));
  const states = new Set(bundle.manifest.selectedCi.map((item) => item.evidenceState));
  assert.ok(states.has('failed'));
  assert.ok(states.has('missing'));
  assert.ok(states.has('pending'));
  assert.ok(states.has('cancelled'));
  assert.ok(states.has('skipped'));
  assert.ok(bundle.manifest.incompleteOrUnavailableEvidence.some((item) => item.kind === 'ci-log' && item.identity === '102'));
  const paginated = fake.calls.filter((call) => call.executable === 'gh' && call.args.some((arg) => arg.includes('per_page=100&page=1')));
  assert.ok(paginated.length >= 7);
  assert.ok(fake.calls.some((call) => call.args.some((arg) => arg.includes('/check-runs?filter=all'))));
  assert.ok(fake.calls.some((call) => call.args.some((arg) => arg.includes('/actions/runs/11/jobs?filter=all'))));
  assert.equal(fake.calls.some((call) => call.args.some((arg) => arg.includes('test') || arg.includes('npm'))), false);
});

test('collect stores a sanitized log at the exact artifact limit', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const out = path.join(root, 'bundle');
  const fake = await collectorRunner(worktree);
  const original = fake.run;
  fake.run = async (executable, args) => {
    if (executable === 'gh' && args.some((arg) => arg.includes('/actions/jobs/101/logs'))) return response('x'.repeat(MAX_ARTIFACT_BYTES));
    return original(executable, args);
  };
  await collectReview({ repo: 'agent-guardrails/.github', pr: '25', worktree, out }, { run: fake.run, now: () => new Date() });
  assert.equal((await stat(path.join(out, 'ci-logs', '11-101.txt'))).size, MAX_ARTIFACT_BYTES);
});

test('collect strips terminal sequences and unsafe controls while preserving readable whitespace', async () => {
  const raw = Buffer.from('first\r\n\t\u001b[31mred\u001b[0m \u001b]8;;https://example.test\u0007link\u001b]8;;\u0007\u0001\u000b\u000c\u000e\u007f\u0085 last\n');
  const evidence = await collectRemoteEvidence(remoteEvidenceRunner({ 1: raw }), REPO, 25, HEAD, 0, '/tmp');
  assert.equal(evidence.logs['11-1.txt'], 'first\r\n\tred link last\n');
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(evidence.logs['11-1.txt']), false);
});

test('collect rejects NUL-bearing and invalid UTF-8 log payloads', async () => {
  for (const raw of [Buffer.from([0x61, 0x00, 0x62]), Buffer.from([0xc3, 0x28])]) {
    const evidence = await collectRemoteEvidence(remoteEvidenceRunner({ 1: raw }), REPO, 25, HEAD, 0, '/tmp');
    assert.deepEqual(evidence.logs, {});
    assert.ok(evidence.selectedCi.some((item) => item.jobId === '1' && item.evidenceState === 'unavailable'));
    assert.ok(evidence.ciRuns[0].jobs.some((job) => String(job.id) === '1' && job.logEvidenceState === 'unavailable'));
    assert.ok(evidence.incomplete.some((item) => item.kind === 'ci-log' && item.identity === '1' && item.reason === 'Log response was not valid text'));
  }
});

test('collect rejects sanitized logs one byte over the artifact limit before storage', async () => {
  await assert.rejects(collectRemoteEvidence(
    remoteEvidenceRunner({ 1: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) }), REPO, 25, HEAD, 0, '/tmp',
  ), { code: 'remote-failure' });
});

test('collect rejects cumulative sanitized logs one byte over the bundle limit before storage', async () => {
  const logs = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, 'x'.repeat(MAX_ARTIFACT_BYTES)]));
  logs[9] = 'x';
  await assert.rejects(collectRemoteEvidence(remoteEvidenceRunner(logs), REPO, 25, HEAD, 0, '/tmp'), { code: 'remote-failure' });
});

test('collect fails closed when CI log retrieval has a remote failure', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const out = path.join(root, 'bundle');
  const fake = await collectorRunner(worktree);
  const original = fake.run;
  fake.run = async (executable, args) => {
    if (executable === 'gh' && args.some((arg) => arg.includes('/actions/jobs/102/logs'))) {
      return response('', 1, 'HTTP 503: unavailable');
    }
    return original(executable, args);
  };
  await assert.rejects(collectReview(
    { repo: 'agent-guardrails/.github', pr: '25', worktree, out },
    { run: fake.run, now: () => new Date() },
  ), { code: 'remote-failure' });
  await assert.rejects(access(out));
});

test('collect records inaccessible job logs but fails closed on other GitHub failures', async (t) => {
  await t.test('permission denied', async () => {
    const root = await temporary();
    const worktree = await managedLayout(root);
    const out = path.join(root, 'bundle');
    const fake = await collectorRunner(worktree);
    const original = fake.run;
    fake.run = async (executable, args) => {
      if (executable === 'gh' && args.some((arg) => arg.includes('/actions/jobs/102/logs'))) return response('', 1, 'HTTP 403: forbidden');
      return original(executable, args);
    };
    await collectReview({ repo: 'agent-guardrails/.github', pr: '25', worktree, out }, { run: fake.run, now: () => new Date() });
    const bundle = await verifyBundle(out);
    assert.ok(bundle.manifest.selectedCi.some((item) => item.jobId === '102' && item.evidenceState === 'inaccessible'));
    assert.ok(bundle.manifest.incompleteOrUnavailableEvidence.some((item) => item.kind === 'ci-log' && item.identity === '102' && item.reason === 'Log access is denied'));
  });
  await t.test('not found', async () => {
    const root = await temporary();
    const worktree = await managedLayout(root);
    const out = path.join(root, 'bundle');
    const fake = await collectorRunner(worktree);
    await collectReview({ repo: 'agent-guardrails/.github', pr: '25', worktree, out }, { run: fake.run, now: () => new Date() });
    const bundle = await verifyBundle(out);
    assert.ok(bundle.manifest.selectedCi.some((item) => item.jobId === '102' && item.evidenceState === 'missing'));
    assert.ok(bundle.manifest.incompleteOrUnavailableEvidence.some((item) => item.kind === 'ci-log' && item.identity === '102' && item.reason === 'Log unavailable'));
  });
  for (const [name, message, code] of [
    ['authentication', 'HTTP 401: authentication required', 'auth-required'],
    ['rate limit', 'HTTP 429: rate limited', 'remote-failure'],
    ['rate limit reported as forbidden', 'HTTP 403: API rate limit exceeded', 'remote-failure'],
    ['server failure', 'HTTP 503: unavailable', 'remote-failure'],
  ]) {
    await t.test(name, async () => {
      const root = await temporary();
      const worktree = await managedLayout(root);
      const fake = await collectorRunner(worktree);
      const original = fake.run;
      fake.run = async (executable, args) => {
        if (executable === 'gh' && args.some((arg) => arg.includes('/actions/jobs/102/logs'))) return response('', 1, message);
        return original(executable, args);
      };
      await assert.rejects(collectReview(
        { repo: 'agent-guardrails/.github', pr: '25', worktree, out: path.join(root, 'bundle') },
        { run: fake.run, now: () => new Date() },
      ), { code });
    });
  }
});

test('collect rejects unsafe or malformed changed-file records before creating a bundle', async (t) => {
  for (const [name, changedFiles] of [
    ['unsafe filename', [{ filename: '../escape.mjs', status: 'modified' }, { filename: 'src/b.mjs', status: 'added' }]],
    ['malformed status', [{ filename: 'src/a.mjs', status: 'unknown' }, { filename: 'src/b.mjs', status: 'added' }]],
    ['unsafe rename source', [{ filename: 'src/a.mjs', status: 'renamed', previous_filename: '/escape.mjs' }, { filename: 'src/b.mjs', status: 'added' }]],
  ]) {
    await t.test(name, async () => {
      const root = await temporary();
      const worktree = await managedLayout(root);
      const out = path.join(root, 'bundle');
      const fake = await collectorRunner(worktree, { changedFiles });
      await assert.rejects(collectReview(
        { repo: 'agent-guardrails/.github', pr: '25', worktree, out },
        { run: fake.run, now: () => new Date() },
      ), { code: 'remote-failure' });
      await assert.rejects(access(out));
    });
  }
});

test('collect refuses a head change after evidence and leaves no output', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const out = path.join(root, 'bundle');
  const fake = await collectorRunner(worktree, { stale: true });
  await assert.rejects(collectReview({ repo: 'agent-guardrails/.github', pr: '25', worktree, out }, { run: fake.run, now: () => new Date() }), { code: 'stale-head' });
  await assert.rejects(access(out));
});

test('collect rejects ignored files in the managed worktree', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const out = path.join(root, 'bundle');
  const fake = await collectorRunner(worktree, { status: '!! ignored.log\n' });
  await assert.rejects(collectReview(
    { repo: 'agent-guardrails/.github', pr: '25', worktree, out },
    { run: fake.run, now: () => new Date() },
  ), { code: 'worktree-dirty' });
  assert.ok(fake.calls.some((call) => call.executable === 'git' && call.args.includes('--ignored')));
  assert.equal(fake.calls.some((call) => call.args.some((arg) => arg.includes('/pulls/25/files'))), false);
  await assert.rejects(access(out));
});

test('collect refuses output inside managed worktree, cache, or sidecar namespace before subprocess access', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  for (const out of [
    worktree,
    path.join(worktree, 'bundle'),
    `${worktree}.git-cache`,
    path.join(`${worktree}.git-cache`, 'bundle'),
    `${worktree}.pr-review.json`,
    path.join(`${worktree}.pr-review.json`, 'bundle'),
  ]) {
    let called = false;
    await assert.rejects(collectReview(
      { repo: 'agent-guardrails/.github', pr: '25', worktree, out },
      { run: async () => { called = true; }, now: () => new Date() },
    ), { code: 'unsafe-path' });
    assert.equal(called, false);
  }
});

test('collect records explicit missing check and workflow-run evidence', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const out = path.join(root, 'bundle');
  const fake = await collectorRunner(worktree, { emptyChecks: true, noRuns: true });
  await collectReview({ repo: 'agent-guardrails/.github', pr: '25', worktree, out }, { run: fake.run, now: () => new Date() });
  const bundle = await verifyBundle(out);
  assert.ok(bundle.manifest.incompleteOrUnavailableEvidence.some((item) => item.kind === 'check' && item.identity === HEAD));
  assert.ok(bundle.manifest.incompleteOrUnavailableEvidence.some((item) => item.kind === 'ci-run' && item.identity === HEAD));
  assert.deepEqual(bundle.manifest.selectedCi, []);
});

test('collect records a run-level selected CI item when a workflow run has no jobs', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const out = path.join(root, 'bundle');
  const fake = await collectorRunner(worktree, { noJobs: true });
  await collectReview({ repo: 'agent-guardrails/.github', pr: '25', worktree, out }, { run: fake.run, now: () => new Date() });
  const bundle = await verifyBundle(out);
  assert.deepEqual(bundle.manifest.selectedCi, [{
    runId: '11', url: 'https://example.test/runs/11', state: 'completed', conclusion: 'failure', evidenceState: 'missing',
  }]);
  assert.ok(bundle.manifest.incompleteOrUnavailableEvidence.some((item) => item.kind === 'ci-run' && item.identity === '11'));
});
