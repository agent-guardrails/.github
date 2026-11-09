import { sanitizeEvidence } from './errors.mjs';

export const DISCUSSION_BODY_LIMIT = 16_384;

function optional(target, key, value) {
  if (value !== undefined && value !== null) target[key] = value;
  return target;
}

function actor(value) {
  if (typeof value === 'string') return value;
  return typeof value?.login === 'string' ? value.login : null;
}

function labels(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    return typeof item?.name === 'string' ? [item.name] : [];
  });
}

function textPage(value, offset, limit) {
  const points = [...(typeof value === 'string' ? value : '')];
  const body = points.slice(offset, offset + limit).join('');
  const next = offset + [...body].length;
  return {
    body,
    bodyTotal: points.length,
    bodyTruncated: next < points.length,
    nextBodyOffset: next < points.length ? next : null,
  };
}

export function prView(pr, bodyOffset, bodyLimit) {
  const safe = sanitizeEvidence(pr);
  const page = textPage(safe.body, bodyOffset, bodyLimit);
  return {
    url: safe.url,
    title: safe.title,
    author: actor(safe.author),
    state: safe.state,
    labels: labels(safe.labels),
    base: { ref: safe.base?.ref, sha: safe.base?.sha },
    head: { ref: safe.head?.ref, sha: safe.head?.sha },
    body: page.body,
    bodyTotal: page.bodyTotal,
    nextBodyOffset: page.nextBodyOffset,
  };
}

function fileRecord(item) {
  const result = { path: item.filename, status: item.status };
  optional(result, 'previousPath', item.previous_filename);
  return result;
}

export function filesView(files, offset, limit) {
  return pageResult('files', sanitizeEvidence(files.map(fileRecord)), offset, limit);
}

function checkRecord(item, source) {
  const result = {
    source,
    id: item.id,
    name: item.name ?? item.app?.name ?? null,
    state: item.status ?? null,
    conclusion: item.conclusion ?? null,
    url: item.html_url ?? item.details_url ?? item.url ?? null,
  };
  return sanitizeEvidence(result);
}

export function ciView(checks, ci, manifest, offset, limit) {
  const items = [
    ...checks.checkSuites.map((item) => checkRecord(item, 'check-suite')),
    ...checks.checkRuns.map((item) => checkRecord(item, 'check-run')),
  ];
  for (const run of ci.runs) {
    items.push(checkRecord(run, 'ci-run'));
    for (const job of run.jobs) {
      items.push(sanitizeEvidence({
        ...checkRecord(job, 'ci-job'),
        runId: run.id,
        runName: run.name ?? null,
        evidenceState: job.logEvidenceState ?? null,
        logAvailable: job.logEvidenceState === 'available',
      }));
    }
  }
  return {
    ...pageResult('items', items, offset, limit),
    selectedCi: sanitizeEvidence(manifest.selectedCi),
    unavailableEvidence: sanitizeEvidence(manifest.incompleteOrUnavailableEvidence),
  };
}

function discussionRecord(item, source) {
  const safe = sanitizeEvidence(item);
  const page = textPage(safe.body, 0, DISCUSSION_BODY_LIMIT);
  const result = {
    source,
    id: safe.id,
    author: actor(safe.user ?? safe.author),
    body: page.body,
    bodyTotal: page.bodyTotal,
    bodyTruncated: page.bodyTruncated,
    nextBodyOffset: page.nextBodyOffset,
  };
  optional(result, 'state', safe.state);
  optional(result, 'submittedAt', safe.submitted_at);
  optional(result, 'createdAt', safe.created_at);
  optional(result, 'updatedAt', safe.updated_at);
  optional(result, 'url', safe.html_url ?? safe.url);
  optional(result, 'path', safe.path);
  optional(result, 'line', safe.line);
  optional(result, 'originalLine', safe.original_line);
  optional(result, 'side', safe.side);
  optional(result, 'originalSide', safe.original_side);
  optional(result, 'commitId', safe.commit_id);
  optional(result, 'originalCommitId', safe.original_commit_id);
  optional(result, 'inReplyToId', safe.in_reply_to_id);
  return result;
}

export function discussionView(reviews, reviewComments, issueComments, offset, limit) {
  const items = [
    ...reviews.map((item) => discussionRecord(item, 'review')),
    ...reviewComments.map((item) => discussionRecord(item, 'review-comment')),
    ...issueComments.map((item) => discussionRecord(item, 'issue-comment')),
  ];
  return pageResult('items', items, offset, limit);
}

export function manifestView(manifest) {
  return sanitizeEvidence({
    schemaVersion: manifest.schemaVersion,
    collectorVersion: manifest.collectorVersion,
    repositoryProvenance: manifest.repository,
    pullRequestProvenance: manifest.pullRequest,
    collectedAt: manifest.collectedAt,
    localWorktree: manifest.localWorktree,
    selectedCi: manifest.selectedCi,
    incompleteOrUnavailableEvidence: manifest.incompleteOrUnavailableEvidence,
    artifacts: manifest.artifacts,
    fileHashesSha256: manifest.fileHashesSha256,
    manifestCanonicalSha256: manifest.manifestCanonicalSha256,
  });
}

export function pageResult(key, items, offset, limit) {
  const selected = items.slice(offset, offset + limit);
  const next = offset + selected.length;
  return {
    [key]: selected,
    returned: selected.length,
    total: items.length,
    nextOffset: next < items.length ? next : null,
  };
}
