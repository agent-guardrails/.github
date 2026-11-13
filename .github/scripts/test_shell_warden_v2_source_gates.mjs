// Deterministic tests for the Shell Warden v2 source-gate tool.
//
// Every subprocess interaction is simulated by a controlled fake command
// runner and every repository is a temporary fixture tree, so no product code
// (shell-warden, hook, docs validators, cargo, npm) is ever executed here.
// Run: node --test .github/scripts/test_shell_warden_v2_source_gates.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EXPECTED_COUNTS,
  GATES,
  REPOSITORIES,
  SourceGateError,
  canonicalOutputPath,
  expectedRemote,
  main,
  normalizeRemote,
  parseArguments,
  runSourceGates,
} from './shell-warden-v2-source-gates.mjs';

const FIXED_NOW = '2026-11-13T00:00:00.000Z';
const HEAD_SHA = 'a'.repeat(40);
const NOW = () => FIXED_NOW;

async function temporary(prefix = 'sw-v2-gates-') {
  return mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
}

function out(text, status = 0) {
  return { status, signal: null, stdout: text, stderr: '', error: null };
}

function fixtureEntry(index, phase, roles) {
  return {
    path: `${phase}/fixture-${index}.json`,
    schemaVersion: 'v2',
    roles,
    expectedInvocationId: `fixture:fixture-${index}`,
    positionalIndexes: [0],
    phase,
    expectedError: null,
  };
}

function manifestDocument({ total = 42 } = {}) {
  const fixtures = [];
  let index = 0;
  for (; index < Math.min(26, total); index += 1) {
    fixtures.push(fixtureEntry(index, 'valid', ['checker-producer', 'checker-serialization', 'hook-consumer']));
  }
  for (; index < Math.min(28, total); index += 1) {
    fixtures.push(fixtureEntry(index, 'schema', ['checker-serialization', 'hook-consumer']));
  }
  for (; index < total; index += 1) {
    fixtures.push(fixtureEntry(index, 'semantic', ['hook-consumer']));
  }
  return { fixtures };
}

async function writeRepo(root, key, document, mutateFixture) {
  const repository = path.join(root, key);
  const fixturesDir = path.join(repository, REPOSITORIES[key].fixtures);
  for (const fixture of document.fixtures) {
    const file = path.join(fixturesDir, fixture.path);
    await mkdir(path.dirname(file), { recursive: true });
    const body = mutateFixture?.(fixture.path) ?? JSON.stringify({ fixture: fixture.path });
    await writeFile(file, body, 'utf8');
  }
  await writeFile(path.join(fixturesDir, 'manifest.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return repository;
}

async function makeRepositories(root, overrides = {}) {
  return {
    docs: await writeRepo(root, 'docs', overrides.manifest ?? manifestDocument()),
    checker: await writeRepo(root, 'checker', overrides.manifest ?? manifestDocument()),
    hook: await writeRepo(root, 'hook', overrides.manifest ?? manifestDocument(), overrides.mutateHookFixture),
  };
}

function fakeRunner(overrides = {}) {
  const calls = [];
  const remotes = {
    docs: 'https://github.com/agent-guardrails/docs.git',
    checker: 'git@github.com:agent-guardrails/shell-warden.git',
    hook: 'ssh://git@github.com/agent-guardrails/opencode-shell-warden-hook.git',
    ...overrides.remotes,
  };
  const statusOutput = overrides.statusOutput ?? '';
  const failures = overrides.failures ?? [];
  const run = (request) => {
    calls.push(request);
    const { command, args = [], cwd = '' } = request;
    const failing = failures.some(
      (failure) =>
        failure.command === command &&
        (failure.args === undefined || JSON.stringify(failure.args) === JSON.stringify(args)),
    );
    if (failing) {
      return { status: 1, signal: null, stdout: '', stderr: 'simulated failure', error: null };
    }
    if (command === 'git') {
      if (args[0] === 'remote') return out(`${remotes[path.basename(cwd)] ?? ''}\n`);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return out(`${HEAD_SHA}\n`);
      if (args[0] === 'rev-parse') return out('main\n');
      if (args[0] === 'status') return out(statusOutput);
      if (args[0] === '--version') return out('git version 2.39.0\n');
    }
    if (command === 'npm') {
      if (args[0] === '--version') return out('10.9.0\n');
      return out('npm ok\n');
    }
    if (command === 'cargo') {
      if (args[0] === '--version') return out('cargo 1.99.1\n');
      return out('cargo ok\n');
    }
    if (command === 'node') return out('validated 42 manifest-pinned shell-warden verdict fixtures\n');
    return out('');
  };
  return { run, calls };
}

function readEvidence(evidence, relative) {
  return readFile(path.join(evidence, relative), 'utf8');
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

test('rejects relative, non-canonical, and missing repository paths', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root);
  const deps = { run: fakeRunner().run, now: NOW };
  const output = path.join(root, 'evidence');

  await assert.rejects(
    runSourceGates({ docs: 'relative/docs', checker: repos.checker, hook: repos.hook, out: output }, deps),
    (error) => error instanceof SourceGateError && error.code === 'invalid-input',
  );
  await assert.rejects(
    runSourceGates(
      { docs: `${root}/docs/../docs`, checker: repos.checker, hook: repos.hook, out: output },
      deps,
    ),
    (error) => error.code === 'invalid-input',
  );
  await assert.rejects(
    runSourceGates({ docs: `${repos.docs}/`, checker: repos.checker, hook: repos.hook, out: output }, deps),
    (error) => error.code === 'invalid-input',
  );
  await assert.rejects(
    runSourceGates({ docs: path.join(root, 'missing-repo'), checker: repos.checker, hook: repos.hook, out: output }, deps),
    (error) => error.code === 'invalid-input' && /does not exist/.test(error.message),
  );
  await assert.rejects(
    runSourceGates({ docs: repos.docs, checker: repos.checker, hook: repos.hook, out: 'relative/evidence' }, deps),
    (error) => error.code === 'invalid-input' && /--out/.test(error.message),
  );
});

test('rejects symlinked path components for inputs and output parents', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root);
  const link = path.join(root, 'docs-link');
  await symlink(repos.docs, link);
  const linkRoot = path.join(root, 'root-link');
  await symlink(root, linkRoot);
  const deps = { run: fakeRunner().run, now: NOW };

  await assert.rejects(
    runSourceGates({ docs: link, checker: repos.checker, hook: repos.hook, out: path.join(root, 'evidence') }, deps),
    (error) => error.code === 'symlink-component' && /--docs/.test(error.message),
  );
  assert.throws(
    () => canonicalOutputPath(path.join(linkRoot, 'evidence'), '--out'),
    (error) => error.code === 'symlink-component',
  );
  assert.throws(
    () => canonicalOutputPath(path.join(root, 'missing-parent', 'evidence'), '--out'),
    (error) => error.code === 'invalid-input',
  );
});

test('refuses to overwrite an existing evidence directory', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root);
  const output = path.join(root, 'evidence');
  await mkdir(output);
  await writeFile(path.join(output, 'keep.txt'), 'untouched', 'utf8');

  await assert.rejects(
    runSourceGates(
      { docs: repos.docs, checker: repos.checker, hook: repos.hook, out: output },
      { run: fakeRunner().run, now: NOW },
    ),
    (error) => error.code === 'output-exists',
  );
  assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(output).sort(), ['keep.txt']);
});

test('parseArguments requires exactly the four fixed flags', () => {
  assert.deepEqual(
    parseArguments(['--docs', 'd', '--checker', 'c', '--hook', 'h', '--out', 'o']),
    { docs: 'd', checker: 'c', hook: 'h', out: 'o' },
  );
  assert.throws(() => parseArguments(['--docs', 'd']), /missing required argument --checker/);
  assert.throws(() => parseArguments(['--docs', 'd', '--docs', 'd2']), /duplicate argument/);
  assert.throws(() => parseArguments(['--docs', 'd', '--extra']), /unexpected argument/);
  assert.throws(() => parseArguments(['--docs']), /missing value/);
});

test('main returns the usage exit code for missing arguments', async () => {
  assert.equal(await main([]), 2);
});

// ---------------------------------------------------------------------------
// Git identity and cleanliness
// ---------------------------------------------------------------------------

test('normalizes remote URLs to the expected repository identity', () => {
  assert.equal(normalizeRemote('https://github.com/agent-guardrails/docs.git'), expectedRemote(REPOSITORIES.docs.slug));
  assert.equal(
    normalizeRemote('git@github.com:agent-guardrails/shell-warden.git'),
    expectedRemote(REPOSITORIES.checker.slug),
  );
  assert.equal(
    normalizeRemote('ssh://git@github.com/agent-guardrails/opencode-shell-warden-hook.git'),
    expectedRemote(REPOSITORIES.hook.slug),
  );
  assert.notEqual(
    normalizeRemote('https://github.com/evil-org/opencode-shell-warden-hook.git'),
    expectedRemote(REPOSITORIES.hook.slug),
  );
});

test('rejects unexpected repository identity and skips later gates', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root);
  const gate = fakeRunner({
    remotes: { hook: 'https://github.com/evil-org/opencode-shell-warden-hook.git' },
  });

  const outcome = await runSourceGates(
    { docs: repos.docs, checker: repos.checker, hook: repos.hook, out: path.join(root, 'evidence') },
    { run: gate.run, now: NOW },
  );

  assert.equal(outcome.status, 'FAIL');
  assert.equal(outcome.summary.gates[0].name, 'repo-identity');
  assert.equal(outcome.summary.gates[0].status, 'fail');
  assert.ok(outcome.summary.gates.slice(1).every((entry) => entry.status === 'skipped'));
  assert.equal(outcome.summary.repositories.hook.identity, 'github.com/evil-org/opencode-shell-warden-hook');
  assert.match(await readEvidence(outcome.evidence, 'logs/00-repo-identity.log'), /IDENTITY MISMATCH/);
  // No command gate ran after the identity failure: only git and version probes.
  assert.ok(gate.calls.every((call) => call.command === 'git' || call.args[0] === '--version'));
});

test('rejects dirty worktrees and records head state', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root);
  const gate = fakeRunner({ statusOutput: '?? untracked.txt\n' });

  const outcome = await runSourceGates(
    { docs: repos.docs, checker: repos.checker, hook: repos.hook, out: path.join(root, 'evidence') },
    { run: gate.run, now: NOW },
  );

  assert.equal(outcome.status, 'FAIL');
  assert.equal(outcome.summary.gates[1].name, 'repo-clean');
  assert.equal(outcome.summary.gates[1].status, 'fail');
  assert.ok(outcome.summary.gates.slice(2).every((entry) => entry.status === 'skipped'));
  assert.equal(outcome.summary.repositories.docs.headSha, HEAD_SHA);
  assert.equal(outcome.summary.repositories.docs.branch, 'main');
  assert.equal(outcome.summary.repositories.docs.detached, false);
  assert.match(await readEvidence(outcome.evidence, 'logs/01-repo-clean.log'), /DIRTY/);
});

// ---------------------------------------------------------------------------
// Manifest counts and fixture identity
// ---------------------------------------------------------------------------

test('fails on manifest count mismatch and records observed counts', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root, { manifest: manifestDocument({ total: 41 }) });
  const gate = fakeRunner();

  const outcome = await runSourceGates(
    { docs: repos.docs, checker: repos.checker, hook: repos.hook, out: path.join(root, 'evidence') },
    { run: gate.run, now: NOW },
  );

  assert.equal(outcome.status, 'FAIL');
  assert.equal(outcome.summary.gates[2].name, 'manifest-counts');
  assert.equal(outcome.summary.gates[2].status, 'fail');
  assert.ok(outcome.summary.gates.slice(3).every((entry) => entry.status === 'skipped'));
  assert.equal(outcome.summary.manifestCounts.observed.total, 41);
  assert.deepEqual(outcome.summary.manifestCounts.expected, EXPECTED_COUNTS);
  assert.match(await readEvidence(outcome.evidence, 'logs/02-manifest-counts.log'), /COUNT MISMATCH/);
});

test('fails when fixture copies are not byte-identical', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root, {
    mutateHookFixture: (fixturePath) => (fixturePath === 'semantic/fixture-41.json' ? '{"mutated":true}' : undefined),
  });
  const gate = fakeRunner();

  const outcome = await runSourceGates(
    { docs: repos.docs, checker: repos.checker, hook: repos.hook, out: path.join(root, 'evidence') },
    { run: gate.run, now: NOW },
  );

  assert.equal(outcome.status, 'FAIL');
  assert.equal(outcome.summary.gates[3].name, 'fixture-identity');
  assert.equal(outcome.summary.gates[3].status, 'fail');
  assert.equal(outcome.summary.fixtureIdentity.byteIdentical, false);
  assert.ok(outcome.summary.gates.slice(4).every((entry) => entry.status === 'skipped'));
  const log = await readEvidence(outcome.evidence, 'logs/03-fixture-identity.log');
  assert.match(log, /semantic\/fixture-41\.json: docs=[0-9a-f]{64} hook=[0-9a-f]{64}/);
});

// ---------------------------------------------------------------------------
// Command failures
// ---------------------------------------------------------------------------

test('propagates child-command failure, skips later gates, preserves evidence', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root);
  const gate = fakeRunner({ failures: [{ command: 'cargo', args: ['test'] }] });

  const outcome = await runSourceGates(
    { docs: repos.docs, checker: repos.checker, hook: repos.hook, out: path.join(root, 'evidence') },
    { run: gate.run, now: NOW },
  );

  assert.equal(outcome.status, 'FAIL');
  const names = outcome.summary.gates.map((entry) => entry.name);
  assert.deepEqual(names, GATES.map((gate) => gate.name));
  const failing = outcome.summary.gates.find((entry) => entry.name === 'checker-test');
  assert.equal(failing.status, 'fail');
  assert.equal(failing.exitCode, 1);
  const position = names.indexOf('checker-test');
  assert.ok(outcome.summary.gates.slice(position + 1).every((entry) => entry.status === 'skipped'));

  // Stop-on-first-failure: no clippy or npm gate command was invoked.
  assert.ok(!gate.calls.some((call) => call.command === 'cargo' && call.args[0] === 'clippy'));
  assert.ok(!gate.calls.some((call) => call.command === 'npm' && call.args[0] === 'test'));

  const log = await readEvidence(outcome.evidence, `logs/${failing.log.replace('logs/', '')}`);
  assert.match(log, /# exit-code: 1/);
  assert.match(log, /simulated failure/);
  assert.ok(fs.existsSync(path.join(outcome.evidence, 'summary.json')));
});

// ---------------------------------------------------------------------------
// Success and determinism
// ---------------------------------------------------------------------------

test('passes all gates and produces a deterministic summary and logs', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root);
  const gate = fakeRunner();
  const first = path.join(root, 'evidence-one');
  const second = path.join(root, 'evidence-two');
  const deps = { run: gate.run, now: NOW };

  const firstOutcome = await runSourceGates(
    { docs: repos.docs, checker: repos.checker, hook: repos.hook, out: first }, deps,
  );
  const secondOutcome = await runSourceGates(
    { docs: repos.docs, checker: repos.checker, hook: repos.hook, out: second }, deps,
  );

  assert.equal(firstOutcome.status, 'PASS');
  assert.equal(secondOutcome.status, 'PASS');
  assert.ok(firstOutcome.summary.gates.every((entry) => entry.status === 'pass'));
  assert.equal(firstOutcome.summary.gates.length, GATES.length);
  assert.equal(firstOutcome.summary.manifestCounts.observed.total, 42);
  assert.deepEqual(firstOutcome.summary.manifestCounts.observed.roles, {
    'checker-producer': 26,
    'checker-serialization': 28,
    'hook-consumer': 42,
  });
  assert.equal(firstOutcome.summary.fixtureIdentity.byteIdentical, true);

  // Deterministic output: identical bytes for summary, every log, and hashes.
  assert.equal(await readEvidence(first, 'summary.json'), await readEvidence(second, 'summary.json'));
  const logs = (await readdir(path.join(first, 'logs'))).sort();
  assert.deepEqual(logs, (await readdir(path.join(second, 'logs'))).sort());
  for (const name of logs) {
    assert.equal(await readEvidence(first, path.join('logs', name)), await readEvidence(second, path.join('logs', name)));
  }
  assert.equal(await readEvidence(first, 'file-hashes.json'), await readEvidence(second, 'file-hashes.json'));

  // Evidence hashes cover every artifact, and the summary is hash-protected.
  const hashes = JSON.parse(await readEvidence(first, 'file-hashes.json'));
  const { createHash } = await import('node:crypto');
  for (const [relative, digest] of Object.entries(hashes)) {
    assert.equal(
      createHash('sha256').update(await readFile(path.join(first, relative))).digest('hex'),
      digest,
      relative,
    );
  }
  assert.ok(hashes['summary.json']);
  assert.equal(hashes['file-hashes.json'], undefined);
});

test('main exits 2 on validation errors and 1 on gate failure through the CLI', async () => {
  const root = await temporary();
  const repos = await makeRepositories(root, { manifest: manifestDocument({ total: 41 }) });
  const code = await main(
    ['--docs', repos.docs, '--checker', repos.checker, '--hook', repos.hook, '--out', path.join(root, 'evidence')],
    { run: fakeRunner().run, now: NOW },
  );
  assert.equal(code, 1);
  assert.ok(fs.existsSync(path.join(root, 'evidence', 'summary.json')));
});
