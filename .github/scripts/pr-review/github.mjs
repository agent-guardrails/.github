import { fail } from './errors.mjs';
import { canonicalJson, parseJson, sha256 } from './json.mjs';
import { classifyFailure } from './runner.mjs';
import { GIT_SHA, safeRepositoryPath } from './validate.mjs';
import { MAX_ARTIFACT_BYTES } from './bundle.mjs';

const FILE_STATUSES = new Set(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged']);

function endpoint(repo, suffix) {
  return `/repos/${repo.full}${suffix}`;
}

export async function ghJson(run, repo, suffix, options = {}) {
  const args = ['api'];
  if (options.method) args.push('--method', options.method);
  args.push(endpoint(repo, suffix));
  if (options.input) args.push('--input', '-');
  const result = await run('gh', args, { cwd: options.cwd, stdin: options.input ? JSON.stringify(options.input) : '' });
  return parseJson(result.stdout, 'remote-failure', 'GitHub response');
}

export async function ghRaw(run, repo, suffix, options = {}) {
  const result = await run('gh', ['api', endpoint(repo, suffix)], { cwd: options.cwd, allowFailure: true });
  if (result.code === 0) return result;
  const message = result.stderr.toString('utf8') || 'gh failed';
  const rateLimited = /\b(?:secondary )?rate limit\b|\babuse rate limit\b/i.test(message);
  const code = rateLimited ? 'remote-failure' : classifyFailure('gh', message);
  const recoverable = (options.recoverFailureCodes ?? ['not-found']).includes(code);
  if (recoverable) return { ...result, failureCode: code };
  fail(code, message);
}

export function normalizeChangedFiles(rawFiles) {
  return rawFiles.map((item) => {
    if (!item || typeof item !== 'object' || !FILE_STATUSES.has(item.status) || !safeRepositoryPath(item.filename)) fail('remote-failure', 'Changed-file metadata is malformed');
    if (item.status === 'renamed' || item.status === 'copied') {
      if (!safeRepositoryPath(item.previous_filename)) fail('remote-failure', 'Changed-file previous filename is malformed');
      return { filename: item.filename, status: item.status, previous_filename: item.previous_filename };
    }
    if (Object.hasOwn(item, 'previous_filename')) fail('remote-failure', 'Changed-file metadata is malformed');
    return { filename: item.filename, status: item.status };
  });
}

export function normalizePr(raw, repo, pr) {
  if (!raw || raw.number !== pr || raw.base?.repo?.full_name !== repo.full) fail('remote-failure', 'PR identity is malformed');
  const baseSha = raw.base?.sha;
  const headSha = raw.head?.sha;
  if (!GIT_SHA.test(baseSha ?? '') || !GIT_SHA.test(headSha ?? '')) fail('remote-failure', 'PR revision identity is malformed');
  const headRepo = raw.head?.repo?.full_name;
  const changedFiles = raw.changed_files;
  if (typeof headRepo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(headRepo)) fail('remote-failure', 'PR head repository is unavailable');
  if (!Number.isSafeInteger(changedFiles) || changedFiles < 0) fail('remote-failure', 'PR changed-file count is unavailable');
  return { raw, baseSha, headSha, headRepo, changedFiles };
}

export async function readPr(run, repo, pr, cwd) {
  return normalizePr(await ghJson(run, repo, `/pulls/${pr}`, { cwd }), repo, pr);
}

export async function paginate(run, repo, suffix, cwd, expectedCount) {
  const output = [];
  const seen = new Set();
  let serializedBytes = 2;
  for (let pageNumber = 1; pageNumber <= 10000; pageNumber += 1) {
    const page = await ghJson(run, repo, pageSuffix(suffix, pageNumber), { cwd });
    if (!Array.isArray(page)) fail('pagination-failure', 'Paginated list contains a malformed page');
    const signature = sha256(canonicalJson(page));
    if (page.length > 0 && seen.has(signature)) fail('pagination-failure', 'Paginated list repeated a page');
    seen.add(signature);
    serializedBytes = appendPage(output, page, serializedBytes);
    if (page.length < 100) break;
    if (pageNumber === 10000) fail('pagination-failure', 'Paginated list exceeded the page limit');
  }
  if (expectedCount !== undefined && output.length !== expectedCount) fail('pagination-failure', 'Paginated list count does not match remote identity');
  return output;
}

export async function paginateNamed(run, repo, suffix, name, cwd) {
  const output = [];
  const seen = new Set();
  let totalCount;
  let serializedBytes = 2;
  for (let pageNumber = 1; pageNumber <= 10000; pageNumber += 1) {
    const page = await ghJson(run, repo, pageSuffix(suffix, pageNumber), { cwd });
    if (!page || !Array.isArray(page[name]) || !Number.isSafeInteger(page.total_count) || page.total_count < 0) fail('pagination-failure', `Paginated ${name} response is malformed`);
    if (totalCount === undefined) totalCount = page.total_count;
    else if (page.total_count !== totalCount) fail('pagination-failure', `Paginated ${name} total changed between pages`);
    const signature = sha256(canonicalJson(page[name]));
    if (page[name].length > 0 && seen.has(signature)) fail('pagination-failure', `Paginated ${name} repeated a page`);
    seen.add(signature);
    serializedBytes = appendPage(output, page[name], serializedBytes);
    if (output.length === totalCount) break;
    if (page[name].length === 0 || page[name].length < 100 || output.length > totalCount || pageNumber === 10000) fail('pagination-failure', `Paginated ${name} count is incomplete`);
  }
  if ((totalCount ?? 0) !== output.length) fail('pagination-failure', `Paginated ${name} count is incomplete`);
  return output;
}

function pageSuffix(suffix, pageNumber) {
  return `${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${pageNumber}`;
}

function appendPage(output, page, serializedBytes) {
  const contentBytes = page.reduce((total, item) => total + Buffer.byteLength(canonicalJson(item)), 0);
  const separatorBytes = page.length === 0 ? 0 : output.length === 0 ? page.length - 1 : page.length;
  const nextBytes = serializedBytes + contentBytes + separatorBytes;
  if (nextBytes > MAX_ARTIFACT_BYTES) fail('pagination-failure', 'Paginated evidence exceeds byte limit');
  output.push(...page);
  return nextBytes;
}
