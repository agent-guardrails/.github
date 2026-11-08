import { spawn } from 'node:child_process';
import { ReviewError, redact } from './errors.mjs';

const ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'NO_COLOR'];
const SAFE_GIT_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'credential.helper=',
  '-c', 'credential.helper=!gh auth git-credential',
];
const SUBPROCESS_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;

export function controlledEnv(source = process.env) {
  return Object.fromEntries(ENV_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

export function createRunner(spawnImpl = spawn, sourceEnv = process.env, clock = globalThis) {
  return function run(executable, args, options = {}) {
    if (!['git', 'gh'].includes(executable) || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new ReviewError('invalid-input', 'Subprocess request is not allowed');
    }
    const commandArgs = executable === 'git' ? [...SAFE_GIT_ARGS, ...args] : args;
    const env = controlledEnv(sourceEnv);
    if (executable === 'git') {
      Object.assign(env, {
        GIT_ATTR_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      });
    }
    return new Promise((resolve, reject) => {
      const child = spawnImpl(executable, commandArgs, {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timer;
      const settle = (handler, value) => {
        if (settled) return false;
        settled = true;
        clock.clearTimeout(timer);
        handler(value);
        return true;
      };
      const terminateForBudget = (budget, limit) => {
        if (settle(reject, new ReviewError('subprocess-budget-exceeded', `${budget} exceeded ${limit} bytes`))) child.kill('SIGKILL');
      };
      const collect = (output, budget, limit) => (chunk) => {
        if (settled) return;
        const data = Buffer.from(chunk);
        if (budget === 'stdout') stdoutBytes += data.byteLength;
        else stderrBytes += data.byteLength;
        const size = budget === 'stdout' ? stdoutBytes : stderrBytes;
        if (size > limit) terminateForBudget(budget, limit);
        else output.push(data);
      };
      timer = clock.setTimeout(() => {
        if (settle(reject, new ReviewError('subprocess-budget-exceeded', 'Subprocess exceeded 60 seconds'))) child.kill('SIGKILL');
      }, SUBPROCESS_TIMEOUT_MS);
      child.stdout.on('data', collect(stdout, 'stdout', MAX_STDOUT_BYTES));
      child.stderr.on('data', collect(stderr, 'stderr', MAX_STDERR_BYTES));
      child.on('error', (error) => settle(reject, new ReviewError('remote-failure', redact(error.message, sourceEnv))));
      child.on('close', (code) => {
        if (settled) return;
        const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
        if (code !== 0 && !options.allowFailure) {
          const message = redact(result.stderr.toString('utf8'), sourceEnv) || `${executable} failed`;
          settle(reject, new ReviewError(options.errorCode ?? classifyFailure(executable, message), message));
        } else settle(resolve, result);
      });
      child.stdin.end(options.stdin ?? '');
    });
  };
}

export function classifyFailure(executable, message) {
  if (executable !== 'gh') return 'remote-failure';
  if (/authentication|not logged|HTTP 401/i.test(message)) return 'auth-required';
  if (/HTTP 403|permission|forbidden/i.test(message)) return 'permission-denied';
  if (/HTTP 404|not found/i.test(message)) return 'not-found';
  return 'remote-failure';
}

export async function textCommand(run, executable, args, options) {
  return (await run(executable, args, options)).stdout.toString('utf8');
}
