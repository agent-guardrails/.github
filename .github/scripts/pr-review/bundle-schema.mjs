import { fail } from './errors.mjs';
import { canonicalJson, parseJson, sha256 } from './json.mjs';
import { GIT_SHA, SHA256, safeMember, safeRepositoryPath } from './validate.mjs';
import { MAX_ARTIFACT_BYTES } from './bundle-constants.mjs';

export function manifestDigest(manifest) {
  const copy = { ...manifest };
  delete copy.manifestCanonicalSha256;
  return sha256(canonicalJson(copy));
}

export function validateManifestShape(manifest) {
  const required = ['schemaVersion', 'collectorVersion', 'repository', 'pullRequest', 'baseSha', 'headSha', 'collectedAt', 'localWorktree', 'selectedCi', 'artifacts', 'incompleteOrUnavailableEvidence', 'fileHashesSha256', 'manifestCanonicalSha256'];
  if (!manifest || Object.keys(manifest).sort().join() !== required.sort().join()) fail('bundle-invalid', 'Manifest fields are invalid');
  if (manifest.schemaVersion !== 1 || !GIT_SHA.test(manifest.baseSha) || !GIT_SHA.test(manifest.headSha)) fail('bundle-invalid', 'Manifest identity is invalid');
  if (!SHA256.test(manifest.fileHashesSha256) || !SHA256.test(manifest.manifestCanonicalSha256)) fail('bundle-invalid', 'Manifest hashes are invalid');
  if (typeof manifest.collectorVersion !== 'string' || manifest.collectorVersion.length < 1 || manifest.collectorVersion.length > 128 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.collectedAt) || Number.isNaN(Date.parse(manifest.collectedAt))) fail('bundle-invalid', 'Manifest provenance is invalid');
  const repository = manifest.repository;
  if (!repository || Object.keys(repository).sort().join() !== 'name,owner,url' || repository.owner !== 'agent-guardrails' || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name) || repository.url !== `https://github.com/${repository.owner}/${repository.name}`) fail('bundle-invalid', 'Manifest repository is invalid');
  const pull = manifest.pullRequest;
  if (!pull || Object.keys(pull).sort().join() !== 'number,url' || !Number.isInteger(pull.number) || pull.number < 1 || pull.url !== `${repository.url}/pull/${pull.number}`) fail('bundle-invalid', 'Manifest pull request is invalid');
  if (!manifest.localWorktree || Object.keys(manifest.localWorktree).sort().join() !== 'path,verifiedHeadSha' || !validWorktreePath(manifest.localWorktree.path) || manifest.localWorktree.verifiedHeadSha !== manifest.headSha) fail('bundle-invalid', 'Manifest worktree is invalid');
  if (!Array.isArray(manifest.selectedCi) || !manifest.selectedCi.every(validSelectedCi)) fail('bundle-invalid', 'Manifest CI selection is invalid');
  if (!Array.isArray(manifest.incompleteOrUnavailableEvidence) || !manifest.incompleteOrUnavailableEvidence.every(validUnavailable)) fail('bundle-invalid', 'Manifest unavailable evidence is invalid');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || !manifest.artifacts.every(validArtifact)) fail('bundle-invalid', 'Manifest artifacts are invalid');
  if (manifestDigest(manifest) !== manifest.manifestCanonicalSha256) fail('hash-mismatch', 'Manifest canonical digest mismatch');
}

function validArtifact(item) {
  return item && Object.keys(item).sort().join() === 'bytes,path,sha256' && safeMember(item.path) && Number.isInteger(item.bytes) && item.bytes >= 0 && item.bytes <= MAX_ARTIFACT_BYTES && SHA256.test(item.sha256);
}

function validWorktreePath(value) {
  return typeof value === 'string'
    && value.length <= 4096
    && value.startsWith('/')
    && !/\p{Cc}/u.test(value);
}

function validSelectedCi(item) {
  const required = ['runId', 'url', 'state', 'evidenceState'];
  const optional = ['jobId', 'logUrl', 'conclusion'];
  if (!item || !required.every((key) => Object.hasOwn(item, key)) || !Object.keys(item).every((key) => [...required, ...optional].includes(key))) return false;
  const identity = /^[A-Za-z0-9_.:-]{1,256}$/;
  const states = ['queued', 'in_progress', 'completed', 'unknown'];
  const evidence = ['available', 'unavailable', 'missing', 'failed', 'pending', 'cancelled', 'skipped', 'inaccessible'];
  const conclusions = ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale', 'unknown'];
  return identity.test(item.runId) && (!Object.hasOwn(item, 'jobId') || identity.test(item.jobId)) && absoluteUri(item.url) && (!Object.hasOwn(item, 'logUrl') || absoluteUri(item.logUrl)) && (!Object.hasOwn(item, 'conclusion') || conclusions.includes(item.conclusion)) && states.includes(item.state) && evidence.includes(item.evidenceState);
}

function validUnavailable(item) {
  const kinds = ['check', 'ci-run', 'ci-job', 'ci-log', 'remote-evidence'];
  return item && Object.keys(item).sort().join() === 'identity,kind,reason' && kinds.includes(item.kind) && typeof item.identity === 'string' && item.identity.length > 0 && item.identity.length <= 1024 && typeof item.reason === 'string' && item.reason.length > 0 && item.reason.length <= 4096;
}

function absoluteUri(value) {
  try { return Boolean(new URL(value).protocol); }
  catch { return false; }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
}

function validChangedFile(item) {
  const required = ['filename', 'status'];
  const optional = ['previous_filename'];
  const statuses = ['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'];
  if (!item || !required.every((key) => Object.hasOwn(item, key)) || !Object.keys(item).every((key) => [...required, ...optional].includes(key)) || !safeRepositoryPath(item.filename) || !statuses.includes(item.status)) return false;
  return item.status === 'renamed' || item.status === 'copied'
    ? Object.hasOwn(item, 'previous_filename') && safeRepositoryPath(item.previous_filename)
    : !Object.hasOwn(item, 'previous_filename');
}

function ciEvidenceState(status, conclusion) {
  if (status !== 'completed') return 'pending';
  if (conclusion === 'success' || conclusion === 'neutral') return 'available';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'skipped') return 'skipped';
  return 'failed';
}

function selectedMatchesRun(item, run) {
  const state = ['queued', 'in_progress', 'completed'].includes(run.status) ? run.status : 'unknown';
  if (item.state !== state) return false;
  const hasConclusion = Object.hasOwn(item, 'conclusion');
  return run.conclusion ? hasConclusion && item.conclusion === run.conclusion : !hasConclusion;
}

export function validatePayloadRelationships(snapshot, manifest, logFiles, repoFull) {
  for (const name of ['changed-files.json', 'reviews.json', 'review-comments.json', 'issue-comments.json']) {
    const payload = parseJson(snapshot.get(name), 'bundle-invalid', name);
    if (!Array.isArray(payload)) fail('bundle-invalid', `${name} must contain an array`);
    if (name === 'changed-files.json' && !payload.every(validChangedFile)) fail('bundle-invalid', 'Changed-file evidence is invalid');
  }
  const checks = parseJson(snapshot.get('checks.json'), 'bundle-invalid', 'Checks');
  if (!exactKeys(checks, ['headSha', 'checkRuns', 'checkSuites']) || checks.headSha !== manifest.headSha || !Array.isArray(checks.checkRuns) || !Array.isArray(checks.checkSuites)) fail('bundle-invalid', 'Check evidence identity is invalid');
  const ci = parseJson(snapshot.get('ci-runs.json'), 'bundle-invalid', 'CI runs');
  if (!exactKeys(ci, ['headSha', 'runs']) || ci.headSha !== manifest.headSha || !Array.isArray(ci.runs)) fail('bundle-invalid', 'CI run evidence identity is invalid');
  const selected = new Map();
  for (const item of manifest.selectedCi) {
    const key = `${item.runId}/${item.jobId ?? ''}`;
    if (selected.has(key)) fail('bundle-invalid', 'Selected CI identity is duplicated');
    selected.set(key, item);
  }
  const expectedLogs = new Set();
  const consumed = new Set();
  const runIds = new Set();
  const jobIds = new Set();
  const incompleteLogs = new Map();
  for (const item of manifest.incompleteOrUnavailableEvidence.filter((entry) => entry.kind === 'ci-log')) {
    if (incompleteLogs.has(item.identity)) fail('bundle-invalid', 'CI log unavailability is duplicated');
    incompleteLogs.set(item.identity, item);
  }
  for (const run of ci.runs) {
    if (!exactKeys(run, ['id', 'name', 'status', 'conclusion', 'html_url', 'jobs']) || !Array.isArray(run.jobs) || runIds.has(String(run.id))) fail('bundle-invalid', 'CI run record is invalid');
    runIds.add(String(run.id));
    if (run.jobs.length === 0) {
      const key = `${run.id}/`;
      const item = selected.get(key);
      if (!item || !selectedMatchesRun(item, run) || item.evidenceState !== 'missing' || item.url !== run.html_url || Object.hasOwn(item, 'logUrl')) fail('bundle-invalid', 'Jobless CI run selection is inconsistent');
      consumed.add(key);
    }
    for (const job of run.jobs) {
      if (!exactKeys(job, ['id', 'name', 'status', 'conclusion', 'html_url', 'logEvidenceState']) || jobIds.has(String(job.id))) fail('bundle-invalid', 'CI job record is invalid');
      jobIds.add(String(job.id));
      const key = `${run.id}/${job.id}`;
      const item = selected.get(key);
      const logName = `ci-logs/${run.id}-${job.id}.txt`;
      const hasLog = logFiles.includes(logName);
      const validLogState = job.status === 'completed' ? ['available', 'missing', 'inaccessible'].includes(job.logEvidenceState) : job.logEvidenceState === 'pending';
      if (!validLogState) fail('bundle-invalid', 'CI job log state is invalid');
      if ((job.logEvidenceState === 'available') !== hasLog) fail('bundle-invalid', 'CI log state differs from bundle inventory');
      if (hasLog) expectedLogs.add(logName);
      let expectedState = ciEvidenceState(job.status, job.conclusion);
      if (expectedState === 'available' && job.logEvidenceState !== 'available') expectedState = job.logEvidenceState;
      const expectedLogUrl = `https://api.github.com/repos/${repoFull}/actions/jobs/${job.id}/logs`;
      if (!item || !selectedMatchesRun(item, run) || item.evidenceState !== expectedState || item.url !== job.html_url || Object.hasOwn(item, 'logUrl') !== hasLog || (hasLog && item.logUrl !== expectedLogUrl)) fail('bundle-invalid', 'Selected CI job is inconsistent');
      if (hasLog === incompleteLogs.has(String(job.id))) fail('bundle-invalid', 'CI log availability record is inconsistent');
      incompleteLogs.delete(String(job.id));
      consumed.add(key);
    }
  }
  if (consumed.size !== selected.size || expectedLogs.size !== logFiles.length || [...expectedLogs].some((name) => !logFiles.includes(name)) || incompleteLogs.size > 0) fail('bundle-invalid', 'CI selection or log inventory contains orphaned evidence');
}
