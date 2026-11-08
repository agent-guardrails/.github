import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publishReview } from './pr-review/publish.mjs';
import { fixture, HEAD, makeBundle, makeFindings, temporary } from './pr-review/test-helpers.mjs';

const response = (value) => ({ code: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });

async function publisherRunner(options = {}) {
  const pr = await fixture('pr.json');
  const calls = [];
  const run = async (executable, args, runOptions = {}) => {
    calls.push({ executable, args, options: runOptions });
    const endpoint = args.find((arg) => arg.startsWith('/repos/'));
    if (args.includes('--method')) return response({ id: 900 });
    if (endpoint.includes('/pulls/25/reviews?')) return response([...(options.reviews ?? [])]);
    if (endpoint.includes('/pulls/25/comments?')) return response([...(options.comments ?? [])]);
    if (endpoint.endsWith('/pulls/25')) {
      const current = structuredClone(pr);
      if (options.stale) current.head.sha = 'c'.repeat(40);
      return response(current);
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  return { run, calls };
}

test('preview emits exact COMMENT payload and never writes', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root);
  const findings = await makeFindings(root, bundle);
  const fake = await publisherRunner();
  const result = await publishReview({ bundle: bundle.root, findings, confirm: false }, fake);
  const findingId = JSON.parse(await readFile(findings)).findings[0].findingId;
  assert.equal(result.preview, true);
  assert.equal(result.published, false);
  assert.equal(result.review.event, 'COMMENT');
  assert.equal(result.review.comments.length, 1);
  assert.equal(result.review.comments[0].body.includes(`<!-- agent-guardrails-pr-review:${findingId} -->`), true);
  assert.equal(fake.calls.some((call) => call.args.includes('--method')), false);
});

test('omitted confirm remains preview-only and cannot reach a mutation endpoint', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root);
  const findings = await makeFindings(root, bundle);
  const fake = await publisherRunner();
  const result = await publishReview({ bundle: bundle.root, findings }, fake);
  assert.equal(result.preview, true);
  assert.equal(result.published, false);
  assert.equal(fake.calls.some((call) => call.args.includes('--method')), false);
});

test('exact markers in reviews and review comments suppress duplicate findings', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root);
  const findings = await makeFindings(root, bundle);
  const findingId = JSON.parse(await readFile(findings)).findings[0].findingId;
  for (const source of ['reviews', 'comments']) {
    const fake = await publisherRunner({ [source]: [{ body: `<!-- agent-guardrails-pr-review:${findingId} -->` }] });
    const result = await publishReview({ bundle: bundle.root, findings, confirm: true }, fake);
    assert.deepEqual(result.findingIds, []);
    assert.equal(result.published, false);
    assert.equal(fake.calls.some((call) => call.args.includes('--method')), false);
  }
});

test('confirm rereads head then performs exactly one COMMENT review POST', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root);
  const findings = await makeFindings(root, bundle);
  const fake = await publisherRunner();
  const result = await publishReview({ bundle: bundle.root, findings, confirm: true }, fake);
  assert.equal(result.published, true);
  const writes = fake.calls.filter((call) => call.args.includes('--method'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args.slice(0, 3), ['api', '--method', 'POST']);
  const payload = JSON.parse(writes[0].options.stdin);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.commit_id, HEAD);
  assert.equal(payload.comments.length, 1);
  assert.equal(fake.calls.at(-2).args.some((arg) => arg.endsWith('/pulls/25')), true);
  assert.equal(fake.calls.every((call) => call.args.every((arg) => !/issues|merge|resolve|comments\/\d+|APPROVE|REQUEST_CHANGES/.test(arg))), true);
});

test('stale head blocks the only publication endpoint', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root);
  const findings = await makeFindings(root, bundle);
  const fake = await publisherRunner({ stale: true });
  await assert.rejects(publishReview({ bundle: bundle.root, findings, confirm: true }, fake), { code: 'stale-head' });
  assert.equal(fake.calls.some((call) => call.args.includes('--method')), false);
});
