import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeBundle, makeFindings, temporary } from './pr-review/test-helpers.mjs';
import { diffLocations, hasDiffLocation } from './pr-review/diff.mjs';
import { deriveFindingId, validateFindings } from './pr-review/findings.mjs';
import { safeRepositoryPath } from './pr-review/validate.mjs';

test('repository paths allow GitHub names, spaces, and Unicode', () => {
  for (const value of ['.github/workflows/pr review.yml', 'docs/résumé.txt', '日本語/設計.md']) {
    assert.equal(safeRepositoryPath(value), true);
  }
});

test('repository paths reject unsafe segments and characters', () => {
  for (const value of ['/absolute', 'a\0b', '../escape', 'folder/../escape', 'double//slash', 'line\nbreak', 'windows\\path']) {
    assert.equal(safeRepositoryPath(value), false);
  }
});

test('diff locations keep header-like source lines in the current file', () => {
  const locations = diffLocations([
    'diff --git a/src/original.mjs b/src/original.mjs',
    '--- a/src/original.mjs',
    '+++ b/src/original.mjs',
    '@@ -10,3 +20,3 @@',
    ' context',
    '--- old header',
    '+++ new header',
    ' context',
    '@@ -30 +40 @@',
    '-before',
    '+after',
    '',
  ].join('\n'));

  for (const [side, line] of [['LEFT', 10], ['LEFT', 11], ['LEFT', 12], ['LEFT', 30], ['RIGHT', 20], ['RIGHT', 21], ['RIGHT', 22], ['RIGHT', 40]]) {
    assert.equal(hasDiffLocation(locations, 'src/original.mjs', side, line), true);
  }
  assert.equal(hasDiffLocation(locations, 'src/original.mjs', 'RIGHT', 11), false);
  assert.equal(hasDiffLocation(locations, 'src/original.mjs', 'LEFT', 21), false);
  assert.equal(hasDiffLocation(locations, 'new header', 'RIGHT', 40), false);
});

test('diff locations keep each side on its create, delete, rename, or copy path', () => {
  const locations = diffLocations([
    'diff --git a/.github/workflows/pr review.yml b/.github/workflows/pr review.yml',
    '--- /dev/null',
    '+++ b/.github/workflows/pr review.yml',
    '@@ -0,0 +1 @@',
    '+name: review',
    'diff --git a/docs/résumé.txt b/docs/résumé.txt',
    '--- a/docs/résumé.txt',
    '+++ /dev/null',
    '@@ -2 +0,0 @@',
    '-obsolete',
    'diff --git a/old name.txt b/日本語/new name.txt',
    '--- a/old name.txt',
    '+++ b/日本語/new name.txt',
    '@@ -5 +8 @@',
    '-before',
    '+after',
    'diff --git a/src/copy source.mjs b/src/copy target.mjs',
    'similarity index 90%',
    'copy from src/copy source.mjs',
    'copy to src/copy target.mjs',
    '--- a/src/copy source.mjs',
    '+++ b/src/copy target.mjs',
    '@@ -3 +4 @@',
    '-before copy',
    '+after copy',
    '',
  ].join('\n'));

  assert.equal(hasDiffLocation(locations, '.github/workflows/pr review.yml', 'RIGHT', 1), true);
  assert.equal(hasDiffLocation(locations, '.github/workflows/pr review.yml', 'LEFT', 1), false);
  assert.equal(hasDiffLocation(locations, 'docs/résumé.txt', 'LEFT', 2), true);
  assert.equal(hasDiffLocation(locations, 'docs/résumé.txt', 'RIGHT', 1), false);
  assert.equal(hasDiffLocation(locations, 'old name.txt', 'LEFT', 5), true);
  assert.equal(hasDiffLocation(locations, '日本語/new name.txt', 'RIGHT', 8), true);
  assert.equal(hasDiffLocation(locations, '日本語/new name.txt', 'LEFT', 5), false);
  assert.equal(hasDiffLocation(locations, 'old name.txt', 'RIGHT', 8), false);
  assert.equal(hasDiffLocation(locations, 'src/copy source.mjs', 'LEFT', 3), true);
  assert.equal(hasDiffLocation(locations, 'src/copy target.mjs', 'RIGHT', 4), true);
  assert.equal(hasDiffLocation(locations, 'src/copy target.mjs', 'LEFT', 3), false);
  assert.equal(hasDiffLocation(locations, 'src/copy source.mjs', 'RIGHT', 4), false);
});

test('diff locations decode Git-quoted UTF-8 paths', () => {
  const locations = diffLocations([
    'diff --git quoted paths',
    String.raw`--- "a/docs/\346\227\245\346\234\254\350\252\236.md"`,
    String.raw`+++ "b/docs/\346\227\245\346\234\254\350\252\236.md"`,
    '@@ -1 +1 @@',
    '-before',
    '+after',
    '',
  ].join('\n'));

  assert.equal(hasDiffLocation(locations, 'docs/日本語.md', 'LEFT', 1), true);
  assert.equal(hasDiffLocation(locations, 'docs/日本語.md', 'RIGHT', 1), true);
});

test('diff locations handle zero-count hunks exactly', () => {
  const locations = diffLocations([
    'diff --git a/src/counts.mjs b/src/counts.mjs',
    '--- a/src/counts.mjs',
    '+++ b/src/counts.mjs',
    '@@ -5,0 +6,2 @@',
    '+one',
    '+two',
    '@@ -10,2 +12,0 @@',
    '-one',
    '-two',
    '',
  ].join('\n'));

  assert.equal(hasDiffLocation(locations, 'src/counts.mjs', 'LEFT', 5), false);
  assert.equal(hasDiffLocation(locations, 'src/counts.mjs', 'RIGHT', 6), true);
  assert.equal(hasDiffLocation(locations, 'src/counts.mjs', 'RIGHT', 7), true);
  assert.equal(hasDiffLocation(locations, 'src/counts.mjs', 'LEFT', 10), true);
  assert.equal(hasDiffLocation(locations, 'src/counts.mjs', 'LEFT', 11), true);
  assert.equal(hasDiffLocation(locations, 'src/counts.mjs', 'RIGHT', 12), false);
});

test('diff locations ignore binary payloads until the next file', () => {
  const locations = diffLocations([
    'diff --git a/assets/logo.bin b/assets/logo.bin',
    'GIT binary patch',
    'literal 12',
    '--- a/forged.mjs',
    '+++ b/forged.mjs',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/assets/other.bin b/assets/other.bin',
    'Binary files a/assets/other.bin and b/assets/other.bin differ',
    '--- a/also-forged.mjs',
    '+++ b/also-forged.mjs',
    '@@ -2 +2 @@',
    '-old',
    '+new',
    'diff --git a/src/real.mjs b/src/real.mjs',
    '--- a/src/real.mjs',
    '+++ b/src/real.mjs',
    '@@ -3 +4 @@',
    '-old',
    '+new',
    '',
  ].join('\n'));

  assert.equal(hasDiffLocation(locations, 'forged.mjs', 'RIGHT', 1), false);
  assert.equal(hasDiffLocation(locations, 'also-forged.mjs', 'RIGHT', 2), false);
  assert.equal(hasDiffLocation(locations, 'src/real.mjs', 'LEFT', 3), true);
  assert.equal(hasDiffLocation(locations, 'src/real.mjs', 'RIGHT', 4), true);
});

test('diff locations reject unsafe paths and incomplete hunks fail closed', () => {
  const locations = diffLocations([
    'diff --git unsafe path',
    '--- a/src/safe.mjs',
    '+++ b/../escape.mjs',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git malformed quote',
    String.raw`--- "a/docs/\q.md"`,
    String.raw`+++ "b/docs/\q.md"`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git incomplete hunk',
    '--- a/src/incomplete.mjs',
    '+++ b/src/incomplete.mjs',
    '@@ -1,2 +1,2 @@',
    ' context',
    'diff --git valid recovery',
    '--- a/src/recovered.mjs',
    '+++ b/src/recovered.mjs',
    '@@ -7 +9 @@',
    '-old',
    '+new',
    '',
  ].join('\n'));

  assert.equal(hasDiffLocation(locations, '../escape.mjs', 'RIGHT', 1), false);
  assert.equal(hasDiffLocation(locations, 'docs/q.md', 'RIGHT', 1), false);
  assert.equal(hasDiffLocation(locations, 'src/incomplete.mjs', 'LEFT', 1), false);
  assert.equal(hasDiffLocation(locations, 'src/recovered.mjs', 'LEFT', 7), true);
  assert.equal(hasDiffLocation(locations, 'src/recovered.mjs', 'RIGHT', 9), true);
});

test('fixture findings validate against bundle identity and evidence', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root, { payloads: {
    'diff.patch': 'diff --git a/src/review.mjs b/src/review.mjs\n--- a/src/review.mjs\n+++ b/src/review.mjs\n@@ -10,3 +10,3 @@\n context\n-old\n+new\n context\n',
  } });
  const file = await makeFindings(root, bundle);
  const result = await validateFindings(file, bundle);
  assert.match(result.document.findings[0].findingId, /^f-[0-9a-f]{64}$/);
});

test('findings use bytes verified before bundle files are replaced', async () => {
  const root = await temporary();
  const bundle = await makeBundle(root, { payloads: {
    'diff.patch': 'diff --git a/src/review.mjs b/src/review.mjs\n--- a/src/review.mjs\n+++ b/src/review.mjs\n@@ -10,3 +10,3 @@\n context\n-old\n+new\n context\n',
  } });
  const file = await makeFindings(root, bundle);
  await Promise.all([
    writeFile(path.join(bundle.root, 'changed-files.json'), '[]\n'),
    writeFile(path.join(bundle.root, 'diff.patch'), 'replaced after verification'),
  ]);

  await assert.doesNotReject(validateFindings(file, bundle));
});

test('findings require the changed-file path for the selected diff side', async (t) => {
  const patch = 'diff --git a/src/previous.mjs b/src/current.mjs\n--- a/src/previous.mjs\n+++ b/src/current.mjs\n@@ -1 +1 @@\n-old\n+new\n';
  for (const [name, changed, filePath, diffSide, valid] of [
    ['renamed LEFT previous', { filename: 'src/current.mjs', status: 'renamed', previous_filename: 'src/previous.mjs' }, 'src/previous.mjs', 'LEFT', true],
    ['renamed LEFT current', { filename: 'src/current.mjs', status: 'renamed', previous_filename: 'src/previous.mjs' }, 'src/current.mjs', 'LEFT', false],
    ['renamed RIGHT current', { filename: 'src/current.mjs', status: 'renamed', previous_filename: 'src/previous.mjs' }, 'src/current.mjs', 'RIGHT', true],
    ['renamed RIGHT previous', { filename: 'src/current.mjs', status: 'renamed', previous_filename: 'src/previous.mjs' }, 'src/previous.mjs', 'RIGHT', false],
    ['copied LEFT previous', { filename: 'src/current.mjs', status: 'copied', previous_filename: 'src/previous.mjs' }, 'src/previous.mjs', 'LEFT', true],
    ['copied LEFT current', { filename: 'src/current.mjs', status: 'copied', previous_filename: 'src/previous.mjs' }, 'src/current.mjs', 'LEFT', false],
    ['copied RIGHT current', { filename: 'src/current.mjs', status: 'copied', previous_filename: 'src/previous.mjs' }, 'src/current.mjs', 'RIGHT', true],
    ['copied RIGHT previous', { filename: 'src/current.mjs', status: 'copied', previous_filename: 'src/previous.mjs' }, 'src/previous.mjs', 'RIGHT', false],
    ['added RIGHT', { filename: 'src/current.mjs', status: 'added' }, 'src/current.mjs', 'RIGHT', true],
    ['added LEFT', { filename: 'src/current.mjs', status: 'added' }, 'src/current.mjs', 'LEFT', false],
    ['removed LEFT', { filename: 'src/previous.mjs', status: 'removed' }, 'src/previous.mjs', 'LEFT', true],
    ['removed RIGHT', { filename: 'src/previous.mjs', status: 'removed' }, 'src/previous.mjs', 'RIGHT', false],
  ]) {
    await t.test(name, async () => {
      const root = await temporary();
      const bundle = await makeBundle(root, { payloads: { 'changed-files.json': [changed], 'diff.patch': patch } });
      const file = await makeFindings(root, bundle, (document) => {
        Object.assign(document.findings[0], { filePath, diffSide, line: 1 });
        document.findings[0].findingId = deriveFindingId(document, document.findings[0]);
        return document;
      });
      const validation = validateFindings(file, bundle);
      if (valid) await assert.doesNotReject(validation);
      else await assert.rejects(validation, { code: 'findings-invalid' });
    });
  }
});

for (const [name, mutate] of [
  ['unknown field', (doc) => { doc.extra = true; }],
  ['wrong repository', (doc) => { doc.repository = 'agent-guardrails/docs'; }],
  ['wrong head', (doc) => { doc.reviewedHeadSha = 'c'.repeat(40); }],
  ['duplicate ID', (doc) => { doc.findings.push({ ...doc.findings[0] }); }],
  ['bad ID', (doc) => { doc.findings[0].findingId = 'Bad_ID'; }],
  ['partial location', (doc) => { delete doc.findings[0].line; }],
  ['line outside diff', (doc) => { doc.findings[0].line = 999; }],
  ['unknown changed file', (doc) => { doc.findings[0].filePath = 'src/other.mjs'; }],
  ['bad evidence hash', (doc) => { doc.findings[0].evidenceReferences[0].sha256 = '0'.repeat(64); }],
  ['path traversal evidence', (doc) => { doc.findings[0].evidenceReferences[0].path = '../diff.patch'; }],
  ['empty remediation', (doc) => { doc.findings[0].remediation = ''; }],
]) {
  test(`malformed findings reject ${name}`, async () => {
    const root = await temporary();
    const bundle = await makeBundle(root);
    const file = await makeFindings(root, bundle, (doc) => { mutate(doc); return doc; });
    await assert.rejects(validateFindings(file, bundle), { code: 'findings-invalid' });
  });
}
