import test from 'node:test';
import assert from 'node:assert/strict';
import { ghJson, ghRaw, normalizeChangedFiles, paginate, paginateNamed } from './pr-review/github.mjs';
import { MAX_ARTIFACT_BYTES } from './pr-review/bundle.mjs';
import { REPO } from './pr-review/test-helpers.mjs';

const response = (value) => ({ code: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });

test('GitHub escape-sequence opt-in is scoped to explicitly requested raw responses', async () => {
  const calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    return response({ ok: true });
  };
  await ghJson(run, REPO, '/pulls/25');
  await ghRaw(run, REPO, '/actions/jobs/1/logs');
  await ghRaw(run, REPO, '/actions/jobs/2/logs', { allowEscapeSequences: true });
  assert.deepEqual(calls.map((call) => call.args), [
    ['api', '/repos/agent-guardrails/.github/pulls/25'],
    ['api', '/repos/agent-guardrails/.github/actions/jobs/1/logs'],
    ['api', '--allow-escape-sequences', '/repos/agent-guardrails/.github/actions/jobs/2/logs'],
  ]);
});

test('pagination flattens complete list and named-object pages deterministically', async () => {
  const list = await paginate(async () => response([{ id: 1 }, { id: 2 }]), REPO, '/pulls/1/files', '/tmp');
  const named = await paginateNamed(async () => response({ total_count: 2, jobs: [{ id: 3 }, { id: 4 }] }), REPO, '/actions/runs/1/jobs', 'jobs', '/tmp');
  assert.deepEqual(list.map((item) => item.id), [1, 2]);
  assert.deepEqual(named.map((item) => item.id), [3, 4]);
});

test('pagination rejects malformed or partial page shapes', async () => {
  await assert.rejects(paginate(async () => response({ truncated: true }), REPO, '/pulls/1/files', '/tmp'), { code: 'pagination-failure' });
  await assert.rejects(paginateNamed(async () => response({ total_count: 2, jobs: [{ id: 1 }] }), REPO, '/actions/runs/1/jobs', 'jobs', '/tmp'), { code: 'pagination-failure' });
  await assert.rejects(paginate(async () => response([{ id: 1 }]), REPO, '/pulls/1/files', '/tmp', 2), { code: 'pagination-failure' });
});

test('pagination rejects a repeated full page', async () => {
  const repeated = Array.from({ length: 100 }, (_, id) => ({ id }));
  await assert.rejects(paginate(async () => response(repeated), REPO, '/pulls/1/comments', '/tmp'), { code: 'pagination-failure' });
  await assert.rejects(paginateNamed(async () => response({ total_count: 200, jobs: repeated }), REPO, '/actions/runs/1/jobs', 'jobs', '/tmp'), { code: 'pagination-failure' });
});

test('pagination rejects serialized evidence that exceeds the artifact budget before append', async (t) => {
  for (const [name, load] of [
    ['list', (value) => paginate(async () => response([value]), REPO, '/pulls/1/files', '/tmp')],
    ['named list', (value) => paginateNamed(async () => response({ total_count: 1, jobs: [value] }), REPO, '/actions/runs/1/jobs', 'jobs', '/tmp')],
  ]) {
    await t.test(`${name} accepts the exact limit`, async () => {
      const value = 'x'.repeat(MAX_ARTIFACT_BYTES - 4);
      assert.deepEqual(await load(value), [value]);
    });
    await t.test(`${name} rejects one byte over the limit`, async () => {
      await assert.rejects(load('x'.repeat(MAX_ARTIFACT_BYTES - 3)), { code: 'pagination-failure' });
    });
  }
});

test('changed-file normalization retains safe previous filenames for renamed and copied files', () => {
  assert.deepEqual(normalizeChangedFiles([
    { filename: 'src/renamed.mjs', status: 'renamed', previous_filename: 'src/original.mjs' },
    { filename: 'src/copied.mjs', status: 'copied', previous_filename: 'src/original.mjs' },
  ]), [
    { filename: 'src/renamed.mjs', status: 'renamed', previous_filename: 'src/original.mjs' },
    { filename: 'src/copied.mjs', status: 'copied', previous_filename: 'src/original.mjs' },
  ]);
  assert.throws(() => normalizeChangedFiles([
    { filename: 'src/copied.mjs', status: 'copied', previous_filename: '../original.mjs' },
  ]), { code: 'remote-failure' });
});
