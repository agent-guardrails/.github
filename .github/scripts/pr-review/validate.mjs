import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';

export const GIT_SHA = /^[0-9a-f]{7,128}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const SAFE_MEMBER = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function parseRepository(value) {
  if (typeof value !== 'string' || value.includes('\0')) fail('invalid-input', 'Invalid repository');
  const match = /^(agent-guardrails)\/([A-Za-z0-9_.-]{1,100})$/.exec(value);
  if (!match) {
    if (/^[^/]+\/[^/]+$/.test(value)) fail('unsupported-repository', 'Only agent-guardrails repositories are supported');
    fail('invalid-input', 'Repository must be OWNER/REPO');
  }
  return { full: value, owner: match[1], name: match[2] };
}

export function parsePr(value) {
  if (!/^[1-9][0-9]*$/.test(String(value))) fail('invalid-input', 'PR must be a positive integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail('invalid-input', 'PR is outside the safe integer range');
  return number;
}

export function parseSha(value, label = 'SHA') {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) fail('invalid-input', `${label} is invalid`);
  return value;
}

export function safeMember(value) {
  return typeof value === 'string' && value.length <= 1024 && SAFE_MEMBER.test(value);
}

export function safeRepositoryPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.startsWith('/')
    && !value.includes('\\')
    && !/\p{Cc}/u.test(value)
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function rejectSymlinkComponents(target) {
  const { root } = path.parse(target);
  const segments = target.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) fail('unsafe-path', 'Path contains a symbolic-link component');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code === 'ENOTDIR') fail('unsafe-path', 'Path traverses a non-directory component');
      throw error;
    }
  }
}

async function canonicalPath(target) {
  const missing = [];
  let current = target;
  while (true) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function validateCallerPath(value, options = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) fail('unsafe-path', 'Path must be absolute and contain no NUL');
  const resolved = path.resolve(value);
  await rejectSymlinkComponents(resolved);
  const canonical = await canonicalPath(resolved);
  try {
    const stat = await lstat(canonical);
    if (stat.isSymbolicLink()) fail('unsafe-path', 'Symbolic-link paths are not accepted');
    if (options.kind === 'directory' && !stat.isDirectory()) fail('unsafe-path', 'Expected a directory path');
    if (options.kind === 'file' && !stat.isFile()) fail('unsafe-path', 'Expected a file path');
    if (options.mustNotExist) fail('bundle-exists', 'Output path already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (options.mustExist) fail('unsafe-path', 'Required path does not exist');
  }
  return canonical;
}

export function pathIsWithin(candidate, boundary) {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function assertExactKeys(object, required, optional = []) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(object, key)) && Object.keys(object).every((key) => allowed.has(key));
}
