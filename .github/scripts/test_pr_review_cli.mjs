import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './pr-review/cli.mjs';
import { validateCallerPath } from './pr-review/validate.mjs';
import { temporary } from './pr-review/test-helpers.mjs';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

function launch(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file], { cwd: path.dirname(new URL(import.meta.url).pathname) }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

test('fixed CLI parser rejects missing, duplicate, and unknown flags', () => {
  const definition = { '--repo': { name: 'repo', required: true }, '--confirm': { name: 'confirm', boolean: true } };
  assert.deepEqual(parseArgs(['--repo', 'agent-guardrails/.github', '--confirm'], definition), { repo: 'agent-guardrails/.github', confirm: true });
  assert.throws(() => parseArgs([], definition), { code: 'invalid-input' });
  assert.throws(() => parseArgs(['--repo', 'x', '--repo', 'y'], definition), { code: 'invalid-input' });
  assert.throws(() => parseArgs(['--other'], definition), { code: 'invalid-input' });
});

test('OpenCode V2 permissions deny by default and allow only fixed non-publisher commands', async () => {
  const config = JSON.parse(await readFile(new URL('../../opencode.jsonc', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(config.permissions));
  const shellRules = config.permissions.filter((rule) => rule.action === 'shell');
  assert.deepEqual(shellRules[0], { action: 'shell', resource: '*', effect: 'ask' });
  assert.deepEqual(shellRules.filter((rule) => rule.effect === 'allow').map((rule) => rule.resource), [
    'node .github/scripts/pr-review-sync.mjs *',
    'node .github/scripts/pr-review-collect.mjs *',
    'node --check .github/scripts/pr-review-sync.mjs',
    'node --check .github/scripts/pr-review-collect.mjs',
  ]);
  assert.equal(shellRules.some((rule) => rule.effect === 'allow' && rule.resource.includes('pr-review-publish.mjs')), false);
  assert.equal(shellRules.some((rule) => rule.effect === 'allow' && ['*', 'git *', 'gh *'].includes(rule.resource)), false);
  const effectiveEffect = (command) => shellRules.reduce((effect, rule) => {
    const expression = new RegExp(`^${rule.resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`);
    return expression.test(command) ? rule.effect : effect;
  }, undefined);
  assert.equal(effectiveEffect('node .github/scripts/pr-review-sync.mjs --repo agent-guardrails/example'), 'allow');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-publish.mjs'), 'ask');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-publish.mjs --confirm'), 'ask');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-publish.mjs --unexpected value'), 'ask');
  assert.equal(effectiveEffect('node --test .github/scripts/test_pr_review_cli.mjs'), 'ask');
  assert.equal(effectiveEffect('node --test .github/scripts/test_pr_review_cli.mjs .github/scripts/pr-review/bundle-constants.mjs'), 'ask');
  assert.equal(effectiveEffect('gh auth status'), 'ask');
});

test('caller path rejects NUL and final-component symlink abuse', async () => {
  await assert.rejects(validateCallerPath('bad\0path'), { code: 'unsafe-path' });
  const root = await temporary();
  const link = path.join(root, 'link');
  await symlink('/tmp', link);
  await assert.rejects(validateCallerPath(link), { code: 'unsafe-path' });
});

test('caller path rejects relative input before resolving it', async () => {
  await assert.rejects(validateCallerPath('relative-path'), { code: 'unsafe-path' });
});

test('caller path rejects a nested symlink ancestor whether child exists or not', async () => {
  for (const childExists of [false, true]) {
    const root = await temporary();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    if (childExists) await mkdir(path.join(outside, 'child'));
    const link = path.join(root, 'link');
    await symlink(outside, link);
    await assert.rejects(validateCallerPath(path.join(link, 'child')), { code: 'unsafe-path' });
  }
});

test('caller path canonicalizes case aliases on case-insensitive filesystems', async (t) => {
  const root = await temporary();
  const actual = path.join(root, 'MixedCase');
  await mkdir(actual);
  const alias = path.join(root, 'mixedcase');
  let canonicalAlias;
  try {
    canonicalAlias = await validateCallerPath(alias, { mustExist: true, kind: 'directory' });
  } catch (error) {
    if (error.code === 'unsafe-path') return t.skip('filesystem is case-sensitive');
    throw error;
  }
  assert.equal(canonicalAlias, await validateCallerPath(actual, { mustExist: true, kind: 'directory' }));
});

test('all three launchers emit JSON failures and nonzero status without network access', async () => {
  for (const name of ['pr-review-sync.mjs', 'pr-review-collect.mjs', 'pr-review-publish.mjs']) {
    const result = await launch(path.join(path.dirname(new URL(import.meta.url).pathname), name));
    assert.equal(result.error.code, 1);
    const record = JSON.parse(result.stdout);
    assert.equal(record.ok, false);
    assert.equal(record.error.code, 'invalid-input');
    assert.ok(result.stderr.length > 0);
  }
});
