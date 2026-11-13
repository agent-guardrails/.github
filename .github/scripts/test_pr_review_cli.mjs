import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './pr-review/cli.mjs';
import { validateCallerPath } from './pr-review/validate.mjs';
import { temporary } from './pr-review/test-helpers.mjs';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

function launch(file, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { cwd: path.dirname(new URL(import.meta.url).pathname) }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

test('fixed CLI parser rejects missing, duplicate, and unknown flags', () => {
  const definition = { '--repo': { name: 'repo', required: true }, '--confirm': { name: 'confirm', boolean: true } };
  assert.deepEqual(parseArgs(['--repo', 'agent-guardrails/.github', '--confirm'], definition), { repo: 'agent-guardrails/.github', confirm: true });
  assert.throws(() => parseArgs([], definition), { code: 'invalid-input' });
  assert.throws(() => parseArgs(['--repo', 'x', '--repo', 'y'], definition), { code: 'invalid-input' });
  assert.throws(() => parseArgs(['--other'], definition), { code: 'invalid-input' });
});

test('OpenCode V2 permissions allow the fixed trusted-tooling commands and keep composition and confirmed publication guarded', async () => {
  const config = JSON.parse(await readFile(new URL('../../opencode.jsonc', import.meta.url), 'utf8'));
  assert.equal(Object.hasOwn(config, 'permissions'), false);
  assert.equal(typeof config.permission, 'object');
  assert.equal(typeof config.permission.bash, 'object');
  const shellRules = Object.entries(config.permission.bash);
  assert.deepEqual(shellRules[0], ['*', 'ask']);
  assert.deepEqual(shellRules.filter(([, effect]) => effect === 'allow').map(([pattern]) => pattern), [
    'node .github/scripts/pr-review-sync.mjs *',
    'node .github/scripts/pr-review-collect.mjs *',
    'node .github/scripts/pr-review-inspect.mjs *',
    'node .github/scripts/shell-warden-v2-source-gates.mjs *',
  ]);
  assert.equal(shellRules.some(([pattern, effect]) => effect === 'allow' && ['*', 'git *', 'gh *'].includes(pattern)), false);
  const effectiveEffect = (command) => shellRules.reduce((effect, [pattern, action]) => {
    const expression = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`);
    return expression.test(command) ? action : effect;
  }, undefined);
  assert.equal(effectiveEffect('node .github/scripts/pr-review-sync.mjs --repo agent-guardrails/example'), 'allow');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-collect.mjs --repo agent-guardrails/example'), 'allow');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-inspect.mjs --bundle /tmp/bundle --view pr'), 'allow');
  assert.equal(
    effectiveEffect(
      'node .github/scripts/shell-warden-v2-source-gates.mjs ' +
        '--docs /canonical/docs --docs-head 0123456789abcdef0123456789abcdef01234567 ' +
        '--checker /canonical/shell-warden --checker-head 0123456789abcdef0123456789abcdef01234567 ' +
        '--hook /canonical/opencode-shell-warden-hook --hook-head 0123456789abcdef0123456789abcdef01234567 ' +
        '--out /canonical/evidence',
    ),
    'allow',
  );
  for (const suffix of [
    '; uname -a',
    ' && uname -a',
    ' | uname -a',
    ' > /tmp/output',
    ' < /tmp/input',
    ' $(uname -a)',
    ' `uname -a`',
    '\nuname -a',
  ]) assert.equal(effectiveEffect(`node .github/scripts/pr-review-inspect.mjs --bundle /tmp/bundle --view pr${suffix}`), 'ask');
  assert.equal(effectiveEffect('node -e "console.log(1)"'), 'ask');
  assert.equal(effectiveEffect('python -c "print(1)"'), 'ask');
  assert.equal(effectiveEffect('jq . /tmp/bundle/pr.json'), 'ask');
  assert.equal(effectiveEffect('cat /tmp/bundle/pr.json'), 'ask');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-publish.mjs --bundle /tmp/bundle --findings /tmp/findings.json'), 'ask');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-publish.mjs --bundle /tmp/bundle --findings /tmp/findings.json --confirm'), 'ask');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-publish.mjs --confirm --bundle /tmp/bundle --findings /tmp/findings.json'), 'ask');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-publish.mjs --con""firm --bundle /tmp/bundle --findings /tmp/findings.json'), 'ask');
  assert.equal(effectiveEffect('node .github/scripts/pr-review-publish.mjs --unexpected value'), 'ask');
  assert.equal(effectiveEffect('node --test .github/scripts/test_pr_review_cli.mjs'), 'ask');
  assert.equal(effectiveEffect('node --test .github/scripts/test_pr_review_cli.mjs .github/scripts/pr-review/bundle-constants.mjs'), 'ask');
  assert.equal(effectiveEffect('git status'), 'ask');
  assert.equal(effectiveEffect('gh auth status'), 'ask');
  assert.equal(effectiveEffect('npm test'), 'ask');
  assert.equal(effectiveEffect('make build'), 'ask');
});

test('review policy requires fixed inspection views and forbids ad hoc review parsing', async () => {
  const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../workflows/pr-review-tests.yml', import.meta.url), 'utf8');
  for (const policy of [agents, readme]) {
    assert.match(policy, /shortest fixed (?:path|sequence)/i);
    assert.match(policy, /pr-review-sync/i);
    assert.match(policy, /pr-review-collect/i);
    assert.match(policy, /pr-review-inspect/i);
    assert.match(policy, /verified\s+(?:evidence\s+)?bundle/i);
    assert.match(policy, /(?:title and description|pull-request title and description)/i);
    assert.match(policy, /intent, constraints, verification/i);
    assert.match(policy, /missing or stale description|missing, vague, or stale PR description/i);
    assert.match(policy, /must not\s+invoke generic `review-work`|MUST NOT invoke generic `review-work`/i);
    assert.match(policy, /local tests,?\s+builds,?\s+package scripts/i);
    assert.match(policy, /CI results are\s+(?:remote\s+)?evidence/i);
    assert.match(policy, /inline Node or Python[\s\S]*heredocs[\s\S]*`jq`[\s\S]*`cat`, `grep`, `sed`, or `awk` parsing/i);
    assert.match(policy, /`pr`[\s\S]*`files`[\s\S]*path-scoped `diff`[\s\S]*`ci`[\s\S]*`discussion`[\s\S]*`manifest` views/i);
    assert.match(policy, /immediate explicit approval|explicit approval immediately/i);
  }
  assert.match(agents, /node \.github\/scripts\/pr-review-sync\.mjs[\s\S]*?--repo[\s\S]*?--pr[\s\S]*?--worktree[\s\S]*?--head/i);
  assert.match(agents, /node \.github\/scripts\/pr-review-collect\.mjs[\s\S]*--repo[\s\S]*--pr[\s\S]*--worktree[\s\S]*--out/i);
  assert.match(agents, /node \.github\/scripts\/pr-review-inspect\.mjs[\s\S]*--bundle[\s\S]*--view/i);
  assert.match(agents, /from a\s+trusted tooling checkout,?\s+never from the reviewed worktree/i);
  assert.match(agents, /caller paths (?:are|must be) canonical absolute\s+paths without symbolic-?link components/i);
  assert.match(agents, /fixture tests may run only in this repository's CI/i);
  assert.match(readme, /fixture tests run only in this\s+repository's CI/i);
  assert.match(readme, /Quit and restart\s+OpenCode/i);
  assert.match(workflow, /run: node --test \.github\/scripts\/test_pr_review_\*\.mjs/);
  assert.match(workflow, /repository: agent-guardrails\/docs/);
  assert.match(workflow, /PR_REVIEW_REQUIRE_SCHEMAS: ["']1["']/);
  assert.match(workflow, /PR_REVIEW_SCHEMA_DIR: \.review-docs\/schemas/);
  assert.doesNotMatch(workflow, /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install)\b/);
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

test('all four launchers emit JSON failures and nonzero status without network access', async () => {
  for (const name of ['pr-review-sync.mjs', 'pr-review-collect.mjs', 'pr-review-inspect.mjs', 'pr-review-publish.mjs']) {
    const result = await launch(path.join(path.dirname(new URL(import.meta.url).pathname), name));
    assert.equal(result.error.code, 1);
    const record = JSON.parse(result.stdout);
    assert.equal(record.ok, false);
    assert.equal(record.error.code, 'invalid-input');
    assert.ok(result.stderr.length > 0);
  }
});
