#!/usr/bin/env node
// Shell Warden v2 source gates — trusted source/release preflight.
//
// One fixed command validates three trusted, clean checkouts (docs, checker,
// hook) against the verdict-v2 rollout requirements and writes an immutable
// evidence directory:
//
//   node .github/scripts/shell-warden-v2-source-gates.mjs \
//     --docs /absolute/path/to/docs \
//     --checker /absolute/path/to/shell-warden \
//     --hook /absolute/path/to/opencode-shell-warden-hook \
//     --out /absolute/path/to/evidence-directory
//
// SECURITY BOUNDARY: this tool executes code from the supplied repositories
// (fixture validators, cargo, npm). It is a source/release preflight tool, not
// a local PR-review tool: run it only against trusted, reviewed, clean
// checkouts and never against untrusted or reviewed worktrees. It is not
// integrated into pr-review-sync, pr-review-collect, pr-review-inspect, or
// pr-review-publish, holds no GitHub capabilities (no write, merge, release,
// publication, or issue mutation), never touches the network, and does not
// replace code or security review.
//
// Failure semantics: the first failed gate stops the run (later gates are
// recorded as "skipped"); every gate runs to completion and all evidence
// produced before the failure is preserved. The evidence directory is built
// in a temporary sibling and moved into place atomically; an existing --out
// is refused, never overwritten.
//
// Exit codes: 0 all gates passed; 1 gate failure; 2 usage/validation error;
// 3 internal error.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_NAME = 'shell-warden-v2-source-gates';
export const TOOL_VERSION = '1.0.0';
export const SUMMARY_SCHEMA_VERSION = 1;

export const EXPECTED_COUNTS = Object.freeze({
  total: 42,
  'checker-producer': 26,
  'checker-serialization': 28,
  'hook-consumer': 42,
});

export const REPOSITORIES = Object.freeze({
  docs: Object.freeze({
    slug: 'agent-guardrails/docs',
    fixtures: 'schemas/fixtures/shell-warden.verdict.v2',
    manifest: 'schemas/fixtures/shell-warden.verdict.v2/manifest.json',
  }),
  checker: Object.freeze({
    slug: 'agent-guardrails/shell-warden',
    fixtures: 'tests/verdict_v2',
  }),
  hook: Object.freeze({
    slug: 'agent-guardrails/opencode-shell-warden-hook',
    fixtures: 'test/verdict-v2',
  }),
});

export const USAGE =
  'usage: node .github/scripts/shell-warden-v2-source-gates.mjs ' +
  '--docs <dir> --checker <dir> --hook <dir> --out <dir>';

const GATE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const PASSED_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME',
  'CARGO_HOME', 'RUSTUP_HOME',
];

export class SourceGateError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SourceGateError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export const GATES = Object.freeze([
  { name: 'repo-identity', kind: 'identity' },
  { name: 'repo-clean', kind: 'clean' },
  { name: 'manifest-counts', kind: 'manifest' },
  { name: 'fixture-identity', kind: 'fixtures' },
  {
    name: 'docs-verdict-v2-fixture-validator',
    kind: 'command',
    command: 'node',
    args: (context) => [
      path.join(context.repositories.docs, 'scripts/validate-shell-warden-verdict-v2-fixtures.mjs'),
    ],
    cwd: (context) => context.repositories.docs,
  },
  {
    name: 'checker-test-verdict-v2-conformance',
    kind: 'command',
    command: 'cargo',
    args: ['test', '--test', 'verdict_v2_conformance'],
    cwd: (context) => context.repositories.checker,
  },
  { name: 'checker-test', kind: 'command', command: 'cargo', args: ['test'], cwd: (context) => context.repositories.checker },
  { name: 'checker-fmt', kind: 'command', command: 'cargo', args: ['fmt', '--check'], cwd: (context) => context.repositories.checker },
  {
    name: 'checker-clippy',
    kind: 'command',
    command: 'cargo',
    args: ['clippy', '--all-targets', '--', '-D', 'warnings'],
    cwd: (context) => context.repositories.checker,
  },
  { name: 'hook-test', kind: 'command', command: 'npm', args: ['test'], cwd: (context) => context.repositories.hook },
  { name: 'hook-typecheck', kind: 'command', command: 'npm', args: ['run', 'typecheck'], cwd: (context) => context.repositories.hook },
]);

// ---------------------------------------------------------------------------
// Path canonicalization
// ---------------------------------------------------------------------------

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SourceGateError('invalid-input', `${label} must be a non-empty string`);
  }
  if (!path.isAbsolute(value)) {
    throw new SourceGateError('invalid-input', `${label} must be an absolute path: ${value}`);
  }
}

function assertCanonical(value, label) {
  const resolved = path.resolve(value);
  if (resolved !== value) {
    throw new SourceGateError(
      'invalid-input',
      `${label} must be a canonical path without '.', '..' or a trailing separator: ${value}`,
    );
  }
  return resolved;
}

function splitComponents(absolute) {
  return absolute.split(path.sep).filter((component) => component.length > 0);
}

function assertNoSymlinkComponents(resolved, label) {
  let checked = path.sep;
  for (const component of splitComponents(resolved)) {
    checked = path.join(checked, component);
    let stats;
    try {
      stats = fs.lstatSync(checked);
    } catch {
      throw new SourceGateError('invalid-input', `${label} does not exist: ${checked}`);
    }
    if (stats.isSymbolicLink()) {
      throw new SourceGateError('symlink-component', `${label} contains a symlinked path component: ${checked}`);
    }
  }
}

export function canonicalDirectory(value, label) {
  assertAbsolutePath(value, label);
  const resolved = assertCanonical(value, label);
  assertNoSymlinkComponents(resolved, label);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new SourceGateError('invalid-input', `${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

export function canonicalOutputPath(value, label) {
  assertAbsolutePath(value, label);
  const resolved = assertCanonical(value, label);
  const parent = path.dirname(resolved);
  // Every existing component must be a real directory; the first missing
  // component must be the final one (the parent of --out must exist).
  let checked = path.sep;
  for (const component of splitComponents(resolved)) {
    const current = path.join(checked, component);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      if (current !== resolved) {
        throw new SourceGateError('invalid-input', `${label} parent must exist; missing: ${current}`);
      }
      break;
    }
    if (stats.isSymbolicLink()) {
      throw new SourceGateError('symlink-component', `${label} contains a symlinked path component: ${current}`);
    }
    checked = current;
  }
  if (!fs.statSync(parent).isDirectory()) {
    throw new SourceGateError('invalid-input', `${label} parent is not a directory: ${parent}`);
  }
  if (fs.existsSync(resolved)) {
    throw new SourceGateError('output-exists', `${label} already exists: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const FLAGS = Object.freeze({
  '--docs': 'docs',
  '--checker': 'checker',
  '--hook': 'hook',
  '--out': 'out',
});

export function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = FLAGS[argv[index]];
    if (!key) {
      throw new SourceGateError('invalid-input', `unexpected argument: ${argv[index]}\n${USAGE}`);
    }
    if (parsed[key] !== undefined) {
      throw new SourceGateError('invalid-input', `duplicate argument: ${argv[index]}\n${USAGE}`);
    }
    if (index + 1 >= argv.length) {
      throw new SourceGateError('invalid-input', `missing value for ${argv[index]}\n${USAGE}`);
    }
    index += 1;
    parsed[key] = argv[index];
  }
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (parsed[key] === undefined) {
      throw new SourceGateError('invalid-input', `missing required argument ${flag}\n${USAGE}`);
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Git identity
// ---------------------------------------------------------------------------

export function normalizeRemote(value) {
  let text = String(value ?? '').trim().replace(/\/+$/, '');
  if (text.length === 0) return null;
  const scpLike = /^git@([^:/]+):(.+)$/.exec(text);
  if (scpLike) {
    return `${scpLike[1].toLowerCase()}/${scpLike[2].replace(/\.git$/, '').toLowerCase()}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return `${url.host.toLowerCase()}/${url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').toLowerCase()}`;
    } catch {
      return null;
    }
  }
  return text.replace(/\.git$/, '').toLowerCase();
}

export function expectedRemote(slug) {
  return `github.com/${slug}`;
}

// ---------------------------------------------------------------------------
// Manifest and fixture checks
// ---------------------------------------------------------------------------

export function manifestCounts(manifestPath) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new SourceGateError('manifest-unreadable', `cannot read manifest ${manifestPath}: ${error.message}`);
  }
  const fixtures = document?.fixtures;
  if (!Array.isArray(fixtures)) {
    throw new SourceGateError('manifest-shape', `manifest ${manifestPath} must contain a fixtures array`);
  }
  const roles = {};
  fixtures.forEach((fixture, index) => {
    if (!Array.isArray(fixture?.roles)) {
      throw new SourceGateError('manifest-shape', `manifest ${manifestPath}: fixture ${index} has no roles array`);
    }
    for (const role of fixture.roles) {
      if (typeof role !== 'string') {
        throw new SourceGateError('manifest-shape', `manifest ${manifestPath}: fixture ${index} has a non-string role`);
      }
      roles[role] = (roles[role] ?? 0) + 1;
    }
  });
  return { total: fixtures.length, roles };
}

export function countMismatches(observed) {
  return Object.entries(EXPECTED_COUNTS)
    .filter(([key, expected]) => {
      const actual = key === 'total' ? observed.total : observed.roles[key] ?? 0;
      return actual !== expected;
    })
    .map(([key, expected]) => {
      const actual = key === 'total' ? observed.total : observed.roles[key] ?? 0;
      return `${key}=${actual} (expected ${expected})`;
    });
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashTree(root) {
  const files = new Map();
  let totalBytes = 0;
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new SourceGateError('symlink-component', `fixture tree contains a symlink: ${full}`);
      }
      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new SourceGateError('invalid-input', `fixture tree contains a non-regular file: ${full}`);
      }
      const bytes = fs.readFileSync(full);
      files.set(relative, sha256Hex(bytes));
      totalBytes += bytes.length;
    }
  };
  walk(root, '');
  return { files, fileCount: files.size, totalBytes };
}

function compareTrees(left, right, leftLabel, rightLabel) {
  const differences = [];
  for (const [relative, hash] of left.files) {
    if (!right.files.has(relative)) differences.push(`${relative}: only in ${leftLabel}`);
    else if (right.files.get(relative) !== hash) {
      differences.push(`${relative}: ${leftLabel}=${hash} ${rightLabel}=${right.files.get(relative)}`);
    }
  }
  for (const relative of right.files.keys()) {
    if (!left.files.has(relative)) differences.push(`${relative}: only in ${rightLabel}`);
  }
  return differences;
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

export function controlledEnv(source = process.env) {
  return Object.fromEntries(
    PASSED_ENV_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

export function createProcessRunner() {
  return function run(request) {
    const { command, args = [], cwd } = request;
    const env = controlledEnv();
    if (command === 'git') {
      Object.assign(env, {
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
      });
    }
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: 'buffer',
      shell: false,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: GATE_TIMEOUT_MS,
    });
    return {
      status: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ? result.stdout.toString('utf8') : '',
      stderr: result.stderr ? result.stderr.toString('utf8') : '',
      error: result.error ? result.error.message : null,
    };
  };
}

// ---------------------------------------------------------------------------
// Evidence directory
// ---------------------------------------------------------------------------

function createStagingDirectory(out) {
  const staging = fs.mkdtempSync(path.join(path.dirname(out), `.${path.basename(out)}.staging-`));
  fs.mkdirSync(path.join(staging, 'logs'));
  return staging;
}

function publishStaging(staging, out) {
  if (fs.existsSync(out)) {
    throw new SourceGateError('output-exists', `refusing to overwrite existing evidence directory: ${out}`);
  }
  try {
    fs.renameSync(staging, out);
  } catch (error) {
    throw new SourceGateError(
      'output-exists',
      `refusing to overwrite existing evidence directory: ${out} (${error.message})`,
    );
  }
}

function gateLogPath(staging, index, name) {
  return path.join(staging, 'logs', `${String(index).padStart(2, '0')}-${name}.log`);
}

function listEvidenceFiles(root) {
  const files = [];
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relative);
        continue;
      }
      if (entry.isFile()) files.push(relative);
    }
  };
  walk(root, '');
  return files;
}

function writeEvidenceHashes(staging) {
  const hashes = {};
  for (const relative of listEvidenceFiles(staging)) {
    if (relative === 'file-hashes.json') continue;
    hashes[relative] = sha256Hex(fs.readFileSync(path.join(staging, relative)));
  }
  fs.writeFileSync(path.join(staging, 'file-hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Gate execution
// ---------------------------------------------------------------------------

function durationMs(startedAt, endedAt) {
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function writeCheckLog(logPath, gate, startedAt, lines, endedAt) {
  const body = [
    `# gate: ${gate.name}`,
    `# started: ${startedAt}`,
    ...lines,
    `# ended: ${endedAt}`,
    '',
  ].join('\n');
  fs.writeFileSync(logPath, body, 'utf8');
}

function checkIdentity(context, run, metadata) {
  const lines = [];
  let failed = false;
  for (const [key, spec] of Object.entries(REPOSITORIES)) {
    const result = run({ command: 'git', args: ['remote', 'get-url', 'origin'], cwd: context.repositories[key] });
    const raw = result.stdout.trim();
    const normalized = result.status === 0 ? normalizeRemote(raw) : null;
    const expected = expectedRemote(spec.slug);
    const ok = normalized === expected;
    metadata[key].remote = raw || null;
    metadata[key].identity = normalized;
    lines.push(
      `${key}: git remote get-url origin -> ${raw || '<no output>'} ` +
        `(normalized: ${normalized ?? '<unavailable>'}; expected: ${expected}) => ${ok ? 'OK' : 'IDENTITY MISMATCH'}`,
    );
    if (!ok) failed = true;
  }
  return { ok: !failed, lines };
}

function checkClean(context, run, metadata) {
  const lines = [];
  let failed = false;
  for (const [key, spec] of Object.entries(REPOSITORIES)) {
    const cwd = context.repositories[key];
    const head = run({ command: 'git', args: ['rev-parse', 'HEAD'], cwd });
    const branch = run({ command: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd });
    const status = run({ command: 'git', args: ['status', '--porcelain'], cwd });
    const headSha = head.status === 0 ? head.stdout.trim() : null;
    const branchName = branch.status === 0 ? branch.stdout.trim() : null;
    const detached = branchName === 'HEAD';
    metadata[key].headSha = headSha;
    metadata[key].branch = branchName;
    metadata[key].detached = detached;
    if (head.status !== 0 || branch.status !== 0) {
      failed = true;
      lines.push(`${key}: git state unavailable (rev-parse failed); refusing to continue`);
      continue;
    }
    const dirty = status.status === 0 ? status.stdout.trim() : null;
    const clean = status.status === 0 && dirty === '';
    lines.push(
      `${key}: HEAD ${headSha} branch ${branchName} detached=${detached} ` +
        `${spec.slug} => ${clean ? 'CLEAN' : 'DIRTY'}`,
    );
    if (!clean) {
      failed = true;
      lines.push(`${key}: git status --porcelain reported:\n${status.stdout.trim() || '<git status failed>'}`);
    }
  }
  return { ok: !failed, lines };
}

function checkManifest(context) {
  const manifestPath = path.join(context.repositories.docs, REPOSITORIES.docs.manifest);
  let observed;
  try {
    observed = manifestCounts(manifestPath);
  } catch (error) {
    return { ok: false, lines: [error.message], observed: null };
  }
  const mismatches = countMismatches(observed);
  context.manifestCounts = {
    manifest: REPOSITORIES.docs.manifest,
    expected: { ...EXPECTED_COUNTS },
    observed: { total: observed.total, roles: { ...observed.roles } },
  };
  const rendered = Object.entries(EXPECTED_COUNTS)
    .map(([key]) => `${key}=${key === 'total' ? observed.total : observed.roles[key] ?? 0}`)
    .join(' ');
  return {
    ok: mismatches.length === 0,
    lines: [
      `manifest ${REPOSITORIES.docs.manifest}: ${rendered}`,
      mismatches.length === 0 ? 'counts OK' : `COUNT MISMATCH: ${mismatches.join(', ')}`,
    ],
    observed: context.manifestCounts,
  };
}

function checkFixtures(context) {
  const trees = {};
  const lines = [];
  for (const [key, spec] of Object.entries(REPOSITORIES)) {
    try {
      trees[key] = hashTree(path.join(context.repositories[key], spec.fixtures));
      lines.push(`${key}: ${spec.fixtures} hashed ${trees[key].fileCount} files (${trees[key].totalBytes} bytes)`);
    } catch (error) {
      return { ok: false, lines: [...lines, error.message], identity: null };
    }
  }
  const differences = [
    ...compareTrees(trees.docs, trees.checker, 'docs', 'checker'),
    ...compareTrees(trees.docs, trees.hook, 'docs', 'hook'),
  ];
  const identity = {
    fileCount: trees.docs.fileCount,
    totalBytes: trees.docs.totalBytes,
    byteIdentical: differences.length === 0,
  };
  context.fixtureIdentity = identity;
  return {
    ok: differences.length === 0,
    lines: [...lines, ...(differences.length === 0 ? ['fixture copies byte-identical'] : differences)],
    identity,
  };
}

function runCommandGate(gate, context, deps, staging, index) {
  const args = typeof gate.args === 'function' ? gate.args(context) : gate.args;
  const cwd = typeof gate.cwd === 'function' ? gate.cwd(context) : gate.cwd;
  const startedAt = deps.now();
  const result = deps.run({ command: gate.command, args, cwd });
  const endedAt = deps.now();
  const ok = result.status === 0;
  const logPath = gateLogPath(staging, index, gate.name);
  const body = [
    `# gate: ${gate.name}`,
    `# command-json: ${JSON.stringify([gate.command, ...args])}`,
    `# cwd: ${cwd}`,
    `# started: ${startedAt}`,
    ...(result.error ? [`# spawn-error: ${result.error}`] : []),
    '## stdout',
    result.stdout.trimEnd(),
    '## stderr',
    result.stderr.trimEnd(),
    `# exit-code: ${result.status}`,
    `# signal: ${result.signal}`,
    `# ended: ${endedAt}`,
    `# result: ${ok ? 'pass' : 'fail'}`,
    '',
  ].join('\n');
  fs.writeFileSync(logPath, body, 'utf8');
  return {
    name: gate.name,
    kind: 'command',
    command: gate.command,
    args,
    cwd,
    startedAt,
    endedAt,
    durationMs: durationMs(startedAt, endedAt),
    exitCode: result.status,
    status: ok ? 'pass' : 'fail',
    log: `logs/${path.basename(logPath)}`,
  };
}

function executeGate(gate, index, context, deps, staging, metadata) {
  const startedAt = deps.now();
  let outcome;
  if (gate.kind === 'command') {
    return runCommandGate(gate, context, deps, staging, index);
  }
  if (gate.kind === 'identity') {
    outcome = checkIdentity(context, deps.run, metadata);
  } else if (gate.kind === 'clean') {
    outcome = checkClean(context, deps.run, metadata);
  } else if (gate.kind === 'manifest') {
    outcome = checkManifest(context);
  } else if (gate.kind === 'fixtures') {
    outcome = checkFixtures(context);
  } else {
    throw new SourceGateError('internal-error', `unknown gate kind: ${gate.kind}`);
  }
  const endedAt = deps.now();
  const logPath = gateLogPath(staging, index, gate.name);
  writeCheckLog(logPath, gate, startedAt, outcome.lines, endedAt);
  return {
    name: gate.name,
    kind: gate.kind,
    startedAt,
    endedAt,
    durationMs: durationMs(startedAt, endedAt),
    exitCode: outcome.ok ? 0 : 1,
    status: outcome.ok ? 'pass' : 'fail',
    log: `logs/${path.basename(logPath)}`,
  };
}

function collectToolVersions(run) {
  const versions = { node: process.version };
  for (const [key, command, args] of [
    ['npm', 'npm', ['--version']],
    ['cargo', 'cargo', ['--version']],
    ['git', 'git', ['--version']],
  ]) {
    const result = run({ command, args });
    versions[key] = result.status === 0 ? result.stdout.trim().split('\n')[0] || null : null;
  }
  return versions;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runSourceGates(options, deps = {}) {
  const run = deps.run ?? createProcessRunner();
  const now = deps.now ?? (() => new Date().toISOString());

  const repositories = {
    docs: canonicalDirectory(options.docs, '--docs'),
    checker: canonicalDirectory(options.checker, '--checker'),
    hook: canonicalDirectory(options.hook, '--hook'),
  };
  const out = canonicalOutputPath(options.out, '--out');

  const staging = createStagingDirectory(out);
  try {
    const context = { repositories };
    const startedAt = now();
    const toolVersions = collectToolVersions(run);

    const gateResults = [];
    const metadata = { docs: {}, checker: {}, hook: {} };
    let failed = false;
    for (const [index, gate] of GATES.entries()) {
      if (failed) {
        gateResults.push({ name: gate.name, status: 'skipped' });
        continue;
      }
      const result = executeGate(gate, index, context, { run, now }, staging, metadata);
      gateResults.push(result);
      if (result.status === 'fail') failed = true;
    }
    const endedAt = now();
    const status = failed ? 'FAIL' : 'PASS';

    const summary = {
      tool: TOOL_NAME,
      toolVersion: TOOL_VERSION,
      summarySchemaVersion: SUMMARY_SCHEMA_VERSION,
      status,
      startedAt,
      endedAt,
      nodeVersion: process.version,
      toolVersions,
      repositories: Object.fromEntries(
        Object.keys(REPOSITORIES).map((key) => [key, { path: repositories[key], ...metadata[key] }]),
      ),
      manifestCounts: context.manifestCounts ?? null,
      fixtureIdentity: context.fixtureIdentity ?? null,
      gates: gateResults,
    };
    fs.writeFileSync(path.join(staging, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    writeEvidenceHashes(staging);
    publishStaging(staging, out);
    return { status, evidence: out, summary };
  } catch (error) {
    // Preserve whatever evidence was already produced before the error.
    try {
      publishStaging(staging, out);
    } catch {
      // The output path is unavailable; keep the staging directory as-is.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), deps = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    const outcome = await runSourceGates(options, deps);
    process.stdout.write(`${outcome.status}: evidence ${outcome.evidence}\n`);
    return outcome.status === 'PASS' ? 0 : 1;
  } catch (error) {
    if (error instanceof SourceGateError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`internal-error: ${error?.stack ?? String(error)}\n`);
    return 3;
  }
}

const entryPoint = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entryPoint) {
  process.exitCode = await main();
}
