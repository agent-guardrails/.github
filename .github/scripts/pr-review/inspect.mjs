import { verifyBundle } from './bundle-verify.mjs';
import { fail, sanitizeEvidence } from './errors.mjs';
import { parseJson } from './json.mjs';
import { diffView } from './inspect-diff.mjs';
import { ciView, discussionView, filesView, manifestView, prView } from './inspect-views.mjs';

const MAX_OUTPUT_BYTES = 1_048_576;
const VIEWS = Object.freeze({
  pr: { flags: ['bodyOffset', 'bodyLimit'] },
  files: { flags: ['offset', 'limit'] },
  diff: { flags: ['path', 'offset', 'limit'] },
  ci: { flags: ['offset', 'limit'] },
  discussion: { flags: ['offset', 'limit'] },
  manifest: { flags: [] },
});

export const INSPECT_ARGUMENTS = Object.freeze({
  '--bundle': { name: 'bundle', required: true },
  '--view': { name: 'view', required: true },
  '--path': { name: 'path', allowLeadingDashes: true },
  '--offset': { name: 'offset' },
  '--limit': { name: 'limit' },
  '--body-offset': { name: 'bodyOffset' },
  '--body-limit': { name: 'bodyLimit' },
});

function integer(value, name, defaultValue, maximum, allowZero) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) fail('invalid-input', `${name} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum || (!allowZero && parsed === 0)) fail('invalid-input', `${name} is outside its allowed range`);
  return parsed;
}

function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid-input', 'Arguments are invalid');
  if (typeof args.bundle !== 'string' || typeof args.view !== 'string') fail('invalid-input', 'Missing --bundle or --view');
  const definition = VIEWS[args.view];
  if (!definition) fail('invalid-input', 'Unknown inspection view');
  const allowed = new Set(['bundle', 'view', ...definition.flags]);
  if (Object.keys(args).some((key) => !allowed.has(key))) fail('invalid-input', 'Flag is not valid for this view');
  if (args.view === 'diff' && typeof args.path !== 'string') fail('invalid-input', 'Diff view requires --path');
  return {
    offset: integer(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER, true),
    limit: integer(args.limit, 'limit', args.view === 'diff' ? 200 : 20, args.view === 'diff' ? 1_000 : 100, false),
    bodyOffset: integer(args.bodyOffset, 'body-offset', 0, Number.MAX_SAFE_INTEGER, true),
    bodyLimit: integer(args.bodyLimit, 'body-limit', 16_384, 65_536, false),
  };
}

function payload(bundle, name) {
  const bytes = bundle.artifactBytes.get(name);
  if (!bytes) fail('bundle-invalid', `Verified artifact is missing: ${name}`);
  return parseJson(bytes, 'bundle-invalid', name);
}

function common(bundle, view) {
  return sanitizeEvidence({
    contractVersion: 1,
    ok: true,
    repository: `${bundle.manifest.repository.owner}/${bundle.manifest.repository.name}`,
    prNumber: bundle.manifest.pullRequest.number,
    baseSha: bundle.manifest.baseSha,
    headSha: bundle.manifest.headSha,
    bundlePath: bundle.root,
    view,
  });
}

function enforceOutputLimit(result) {
  if (Buffer.byteLength(`${JSON.stringify(result)}\n`) > MAX_OUTPUT_BYTES) fail('output-too-large', 'Inspection output exceeds the byte limit');
  return result;
}

export async function inspectReview(args, dependencies = {}) {
  const options = validateArgs(args);
  const bundle = await (dependencies.verifyBundle ?? verifyBundle)(args.bundle);
  let projection;
  switch (args.view) {
    case 'pr':
      projection = prView(payload(bundle, 'pr.json'), options.bodyOffset, options.bodyLimit);
      break;
    case 'files':
      projection = filesView(payload(bundle, 'changed-files.json'), options.offset, options.limit);
      break;
    case 'diff': {
      const patchBytes = bundle.artifactBytes.get('diff.patch');
      if (!patchBytes) fail('bundle-invalid', 'Verified artifact is missing: diff.patch');
      projection = diffView(payload(bundle, 'changed-files.json'), patchBytes.toString('utf8'), args.path, options.offset, options.limit);
      break;
    }
    case 'ci':
      projection = ciView(payload(bundle, 'checks.json'), payload(bundle, 'ci-runs.json'), bundle.manifest, options.offset, options.limit);
      break;
    case 'discussion':
      projection = discussionView(payload(bundle, 'reviews.json'), payload(bundle, 'review-comments.json'), payload(bundle, 'issue-comments.json'), options.offset, options.limit);
      break;
    case 'manifest':
      projection = manifestView(bundle.manifest);
      break;
    default:
      fail('invalid-input', 'Unknown inspection view');
  }
  return enforceOutputLimit({ ...common(bundle, args.view), ...projection });
}
