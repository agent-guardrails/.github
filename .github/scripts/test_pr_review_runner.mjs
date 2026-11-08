import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createRunner } from './pr-review/runner.mjs';
import { redact } from './pr-review/errors.mjs';
import { temporary } from './pr-review/test-helpers.mjs';

const execFile = promisify(execFileCallback);
const STDOUT_LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 4 * 1024 * 1024;

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killCount = 0;
  child.kill = () => {
    child.killCount += 1;
    return true;
  };
  return child;
}

function createFakeClock() {
  let timer;
  return {
    setTimeout(callback, delay) {
      timer = { callback, delay, cleared: false };
      return timer;
    },
    clearTimeout(handle) {
      handle.cleared = true;
    },
    get timer() {
      return timer;
    },
    tick() {
      if (!timer.cleared) timer.callback();
    },
  };
}

test('runner uses fixed executable, argv array, explicit cwd, controlled env, and shell false', async () => {
  let observed;
  const spawn = (executable, args, options) => {
    observed = { executable, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => { child.stdout.end('ok'); child.stderr.end(); child.emit('close', 0); });
    return child;
  };
  const run = createRunner(spawn, { PATH: '/bin', GH_TOKEN: 'secret-value', UNRELATED: 'drop' });
  const output = await run('gh', ['api', '/repos/x'], { cwd: '/tmp' });
  assert.equal(output.stdout.toString(), 'ok');
  assert.deepEqual(observed.args, ['api', '/repos/x']);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.cwd, '/tmp');
  assert.equal(observed.options.env.UNRELATED, undefined);
  assert.equal(observed.options.env.GH_TOKEN, 'secret-value');
  assert.equal(observed.args.some((arg) => arg.includes('secret-value')), false);
  assert.throws(() => run('sh', ['-c', 'evil']), { code: 'invalid-input' });
});

test('runner isolates git from inherited hooks, attributes, and configuration', async () => {
  let observed;
  const spawn = (executable, args, options) => {
    observed = { executable, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); });
    return child;
  };
  const run = createRunner(spawn, {
    PATH: '/bin', HOME: '/hostile-home', GIT_CONFIG_GLOBAL: '/hostile/config',
  });
  await run('git', ['status'], { cwd: '/tmp' });
  assert.deepEqual(observed.args.slice(0, 8), [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
    '-c', 'credential.helper=',
    '-c', 'credential.helper=!gh auth git-credential',
  ]);
  assert.deepEqual(observed.args.slice(8), ['status']);
  assert.equal(observed.options.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(observed.options.env.GIT_CONFIG_SYSTEM, '/dev/null');
  assert.equal(observed.options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(observed.options.env.GIT_ATTR_NOSYSTEM, '1');
  assert.equal(observed.options.env.GIT_TERMINAL_PROMPT, '0');
});

test('runner clears a hostile local credential helper before trusted authentication', async () => {
  const root = await temporary();
  const cache = path.join(root, 'cache.git');
  const marker = path.join(root, 'hostile-helper-ran');
  await execFile('git', ['init', '--bare', cache]);
  await execFile('git', ['--git-dir', cache, 'config', 'credential.helper', `!touch "${marker}"`]);
  const run = createRunner(undefined, { PATH: process.env.PATH, GH_TOKEN: 'test-token' });
  const result = await run('git', ['--git-dir', cache, 'credential', 'fill'], {
    cwd: root,
    stdin: 'protocol=https\nhost=github.com\n\n',
    allowFailure: true,
  });
  assert.equal(result.code, 0);
  await assert.rejects(access(marker));
});

test('diagnostics redact token forms and configured credentials', () => {
  const text = redact('Authorization: token github_pat_abcdefghijklmnopqrstuvwxyz\nBearer abc\nghr_abcdefghijklmnopqrstuvwxyz\nGHSECRET', { GH_TOKEN: 'GHSECRET' });
  assert.equal(text.includes('github_pat_'), false);
  assert.equal(text.includes('Bearer abc'), false);
  assert.equal(text.includes('ghr_'), false);
  assert.equal(text.includes('GHSECRET'), false);
  assert.equal(text.includes('$1'), false);
  assert.ok(text.includes('Authorization: [REDACTED]'));
  assert.ok(text.includes('Bearer [REDACTED]'));
  assert.ok(text.includes('[REDACTED]'));
});

test('Given a running child when the sixty-second timeout expires then the runner kills and rejects it once', async () => {
  const clock = createFakeClock();
  let child;
  const run = createRunner(() => {
    child = createFakeChild();
    return child;
  }, {}, clock);

  const result = run('gh', ['api', '/repos/x']);
  assert.equal(clock.timer.delay, 60_000);
  clock.tick();
  child.emit('close', 0);
  child.stdout.write('late output');

  await assert.rejects(result, { code: 'subprocess-budget-exceeded' });
  assert.equal(child.killCount, 1);
  assert.equal(clock.timer.cleared, true);
});

for (const { stream, limit } of [
  { stream: 'stdout', limit: STDOUT_LIMIT },
  { stream: 'stderr', limit: STDERR_LIMIT },
]) {
  test(`Given ${stream} at its budget when the child exits successfully then the runner accepts it`, async () => {
    const clock = createFakeClock();
    let child;
    const run = createRunner(() => {
      child = createFakeChild();
      return child;
    }, {}, clock);

    const result = run('gh', ['api', '/repos/x']);
    child[stream].write(Buffer.alloc(limit));
    child.emit('close', 0);

    const output = await result;
    assert.equal(output[stream].byteLength, limit);
    assert.equal(clock.timer.cleared, true);
    clock.tick();
    assert.equal(child.killCount, 0);
  });

  test(`Given ${stream} beyond its budget when data arrives then the runner kills and rejects the child`, async () => {
    let child;
    const run = createRunner(() => {
      child = createFakeChild();
      return child;
    });

    const result = run('gh', ['api', '/repos/x']);
    child[stream].write(Buffer.alloc(limit));
    child[stream].write(Buffer.alloc(1));
    child.emit('close', 0);

    await assert.rejects(result, { code: 'subprocess-budget-exceeded' });
    assert.equal(child.killCount, 1);
  });
}
