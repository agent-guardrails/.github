import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { syncReview } from './pr-review/sync.mjs';
import { BASE, fixture, HEAD, managedLayout, temporary } from './pr-review/test-helpers.mjs';

function result(stdout = '', code = 0, stderr = '') {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

async function syncRunner(worktree, options = {}) {
  const pr = await fixture('pr.json');
  pr.head.repo.clone_url = options.cloneUrl ?? pr.head.repo.clone_url;
  const calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    if (executable === 'gh') return result(JSON.stringify(pr));
    if (args[0] === 'init') return result();
    if (args.includes('add') && args.includes('--detach')) { await mkdir(worktree); return result(); }
    if (args.includes('list')) return result(`worktree ${worktree}\nHEAD ${HEAD}\ndetached\n`);
    if (args[0] === 'status') return result(options.dirty ? '?? untracked.txt\n' : options.ignored ? '!! ignored.txt\n' : '');
    if (args[0] === 'symbolic-ref') return result('', 1);
    if (args.includes('rev-parse')) return result(`${args.some((arg) => arg.startsWith('refs/pr-review/base')) ? BASE : HEAD}\n`);
    return result();
  };
  return { run, calls };
}

test('sync ignores malicious clone_url and constructs validated HTTPS fork fetch URL', async () => {
  const root = await temporary();
  const worktree = path.join(root, 'review');
  const fake = await syncRunner(worktree, { cloneUrl: '--upload-pack=malicious' });
  const output = await syncReview({ repo: 'agent-guardrails/.github', pr: '25', worktree }, fake);
  assert.equal(output.headSha, HEAD);
  const sidecar = JSON.parse(await readFile(`${worktree}.pr-review.json`));
  assert.deepEqual(sidecar, { contractVersion: 1, repository: 'agent-guardrails/.github', prNumber: 25, baseSha: BASE, headSha: HEAD });
  const fetches = fake.calls.filter((call) => call.executable === 'git' && call.args.includes('fetch'));
  assert.equal(fetches.length, 2);
  assert.ok(fetches[0].args.includes(`+${BASE}:refs/pr-review/base`));
  assert.ok(fetches[1].args.includes('https://github.com/contributor/fork.git'));
  assert.equal(fetches[1].args.includes('--upload-pack=malicious'), false);
  assert.equal(fake.calls.some((call) => call.args.includes('--upload-pack=malicious')), false);
  assert.ok(fetches[1].args.includes(`+${HEAD}:refs/pr-review/head`));
  assert.equal(fake.calls.some((call) => call.args.some((arg) => /test|npm|checkout\s/.test(arg))), false);
});

test('sync refuses expected-head mismatch before any git command', async () => {
  const root = await temporary();
  const worktree = path.join(root, 'review');
  const fake = await syncRunner(worktree);
  await assert.rejects(syncReview({ repo: 'agent-guardrails/.github', pr: '25', worktree, head: 'c'.repeat(40) }, fake), { code: 'head-mismatch' });
  assert.equal(fake.calls.filter((call) => call.executable === 'git').length, 0);
});

test('sync refuses dirty managed worktree before fetch or update', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const fake = await syncRunner(worktree, { dirty: true });
  await assert.rejects(syncReview({ repo: 'agent-guardrails/.github', pr: '25', worktree }, fake), { code: 'worktree-dirty' });
  assert.equal(fake.calls.some((call) => call.args.includes('fetch')), false);
  assert.equal(fake.calls.some((call) => call.args.includes('checkout')), false);
});

test('sync refuses ignored files in a managed worktree before fetch or update', async () => {
  const root = await temporary();
  const worktree = await managedLayout(root);
  const fake = await syncRunner(worktree, { ignored: true });
  await assert.rejects(syncReview({ repo: 'agent-guardrails/.github', pr: '25', worktree }, fake), { code: 'worktree-dirty' });
  assert.ok(fake.calls.some((call) => call.args.includes('--ignored')));
  assert.equal(fake.calls.some((call) => call.args.includes('fetch')), false);
  assert.equal(fake.calls.some((call) => call.args.includes('checkout')), false);
});

test('unsupported repository fails before subprocess access', async () => {
  let called = false;
  await assert.rejects(syncReview({ repo: 'other/repo', pr: '1', worktree: '/tmp/review' }, { run: async () => { called = true; } }), { code: 'unsupported-repository' });
  assert.equal(called, false);
});

test('sync refuses an orphaned sidecar before subprocess access', async () => {
  const root = await temporary();
  const worktree = path.join(root, 'review');
  await mkdir(`${worktree}.pr-review.json`);
  let called = false;
  await assert.rejects(syncReview(
    { repo: 'agent-guardrails/.github', pr: '25', worktree },
    { run: async () => { called = true; } },
  ), { code: 'worktree-conflict' });
  assert.equal(called, false);
});
