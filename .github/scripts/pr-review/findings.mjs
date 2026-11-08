import { readFile } from 'node:fs/promises';
import { fail, redact } from './errors.mjs';
import { canonicalJson, parseJson, sha256 } from './json.mjs';
import { assertExactKeys, GIT_SHA, safeRepositoryPath, SAFE_MEMBER, SHA256, validateCallerPath } from './validate.mjs';
import { diffLocations, hasDiffLocation } from './diff.mjs';

const VERDICTS = new Set(['approve', 'comment', 'request-changes', 'no-findings']);
const SEVERITIES = new Set(['blocker', 'major', 'minor', 'nit']);
const FINDING_ID = /^f-[0-9a-f]{64}$/;
const DEFECT_CLASS = /^[a-z][a-z0-9-]{0,95}$/;

function nonEmpty(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

function validateFindingShape(finding) {
  const required = ['findingId', 'defectClass', 'severity', 'title', 'explanation', 'evidenceReferences', 'remediation', 'blocking'];
  const optional = ['filePath', 'line', 'diffSide'];
  if (!assertExactKeys(finding, required, optional)) fail('findings-invalid', 'Finding fields are invalid');
  if (!FINDING_ID.test(finding.findingId) || !DEFECT_CLASS.test(finding.defectClass) || !SEVERITIES.has(finding.severity)) fail('findings-invalid', 'Finding identity or severity is invalid');
  if (!nonEmpty(finding.title, 160) || !nonEmpty(finding.explanation, 20000) || !nonEmpty(finding.remediation, 20000) || typeof finding.blocking !== 'boolean') fail('findings-invalid', 'Finding content is invalid');
  const located = Object.hasOwn(finding, 'filePath') || Object.hasOwn(finding, 'line') || Object.hasOwn(finding, 'diffSide');
  if (located && (!safeRepositoryPath(finding.filePath) || !Number.isInteger(finding.line) || finding.line < 1 || !['LEFT', 'RIGHT'].includes(finding.diffSide))) fail('findings-invalid', 'Inline location must be complete and valid');
  if (!Array.isArray(finding.evidenceReferences) || finding.evidenceReferences.length === 0) fail('findings-invalid', 'Evidence references are required');
}

export function deriveFindingId(document, finding) {
  const location = finding.filePath ? { filePath: finding.filePath, line: finding.line, diffSide: finding.diffSide } : null;
  return `f-${sha256(canonicalJson({
    repository: document.repository,
    prNumber: document.prNumber,
    reviewedHeadSha: document.reviewedHeadSha,
    defectClass: finding.defectClass,
    location,
  }))}`;
}

export async function validateFindings(findingsPath, bundle) {
  const file = await validateCallerPath(findingsPath, { mustExist: true, kind: 'file' });
  const document = parseJson(await readFile(file), 'findings-invalid', 'Findings');
  const required = ['schemaVersion', 'repository', 'prNumber', 'reviewedHeadSha', 'overallVerdict', 'findings'];
  if (!assertExactKeys(document, required) || document.schemaVersion !== 1 || !GIT_SHA.test(document.reviewedHeadSha ?? '') || !VERDICTS.has(document.overallVerdict) || !Array.isArray(document.findings)) fail('findings-invalid', 'Findings document is invalid');
  const repo = `${bundle.manifest.repository.owner}/${bundle.manifest.repository.name}`;
  if (document.repository !== repo || document.prNumber !== bundle.manifest.pullRequest.number || document.reviewedHeadSha !== bundle.manifest.headSha) fail('findings-invalid', 'Findings identity does not match bundle');
  const changed = parseJson(bundle.artifactBytes.get('changed-files.json'), 'bundle-invalid', 'Changed files');
  const changedPaths = { LEFT: new Set(), RIGHT: new Set() };
  for (const item of changed) {
    switch (item.status) {
      case 'added':
        changedPaths.RIGHT.add(item.filename);
        break;
      case 'removed':
        changedPaths.LEFT.add(item.filename);
        break;
      case 'renamed':
      case 'copied':
        changedPaths.LEFT.add(item.previous_filename);
        changedPaths.RIGHT.add(item.filename);
        break;
      default:
        changedPaths.LEFT.add(item.filename);
        changedPaths.RIGHT.add(item.filename);
    }
  }
  const locations = diffLocations(bundle.artifactBytes.get('diff.patch').toString('utf8'));
  const ids = new Set();
  for (const finding of document.findings) {
    validateFindingShape(finding);
    if (finding.findingId !== deriveFindingId(document, finding)) fail('findings-invalid', 'Finding ID is not derived from immutable identity fields');
    if (ids.has(finding.findingId)) fail('findings-invalid', 'Finding IDs must be unique');
    ids.add(finding.findingId);
    if (finding.filePath && !changedPaths[finding.diffSide].has(finding.filePath)) fail('findings-invalid', 'Finding path is not valid for the selected diff side');
    if (finding.filePath && !hasDiffLocation(locations, finding.filePath, finding.diffSide, finding.line)) fail('findings-invalid', 'Finding location is outside the reviewed diff');
    for (const value of [finding.title, finding.explanation, finding.remediation]) {
      if (redact(value) !== value) fail('findings-invalid', 'Finding text contains credential-like content');
    }
    for (const reference of finding.evidenceReferences) {
      if (!assertExactKeys(reference, ['path', 'sha256']) || !SAFE_MEMBER.test(reference.path ?? '') || !SHA256.test(reference.sha256 ?? '') || bundle.artifactHashes.get(reference.path) !== reference.sha256) fail('findings-invalid', 'Evidence reference is not a verified artifact');
    }
  }
  return { file, document };
}
