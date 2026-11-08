import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';
import { parseJson, sha256 } from './json.mjs';
import { validateCallerPath } from './validate.mjs';
import { MAX_ARTIFACT_BYTES, MAX_BUNDLE_BYTES, PAYLOADS } from './bundle-constants.mjs';
import { validateManifestShape, validatePayloadRelationships } from './bundle-schema.mjs';

async function listBundle(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('bundle-invalid', 'Bundle contains a symbolic link');
    if (entry.isFile()) files.push(entry.name);
    else if (entry.isDirectory() && entry.name === 'ci-logs') {
      for (const log of await readdir(path.join(root, entry.name), { withFileTypes: true })) {
        if (!log.isFile() || log.isSymbolicLink()) fail('bundle-invalid', 'CI logs must be regular files');
        files.push(`ci-logs/${log.name}`);
      }
    } else fail('bundle-invalid', 'Bundle contains an unlisted directory');
  }
  return files.sort();
}

function requireRegularFile(name, file, maxBytes) {
  if (!file.isFile() || file.isSymbolicLink()) fail('bundle-invalid', `Bundle member is not a regular file: ${name}`);
  if (file.size > maxBytes) fail('bundle-invalid', `Bundle member exceeds byte limit: ${name}`);
}

async function readSnapshotFile(root, name, maxBytes) {
  let handle;
  try { handle = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { fail('bundle-invalid', `Bundle member is not a regular file: ${name}`); }
  try {
    const file = await handle.stat();
    requireRegularFile(name, file, maxBytes);
    const bytes = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail('bundle-invalid', `Bundle member changed while reading: ${name}`);
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function readBundleSnapshot(root, files) {
  let totalBytes = 0;
  const snapshot = new Map();
  for (const name of files) {
    const maxBytes = name === 'manifest.json' ? MAX_BUNDLE_BYTES : MAX_ARTIFACT_BYTES;
    const bytes = await readSnapshotFile(root, name, maxBytes);
    totalBytes += bytes.length;
    if (totalBytes > MAX_BUNDLE_BYTES) fail('bundle-invalid', 'Bundle exceeds total byte limit');
    snapshot.set(name, bytes);
  }
  return snapshot;
}

function requireSnapshotFile(snapshot, name) {
  const bytes = snapshot.get(name);
  if (!bytes) fail('bundle-invalid', `Bundle member is missing: ${name}`);
  return bytes;
}

export async function verifyBundle(bundlePath, expected = {}) {
  const root = await validateCallerPath(bundlePath, { mustExist: true, kind: 'directory' });
  let logsStat;
  try { logsStat = await lstat(path.join(root, 'ci-logs')); }
  catch { fail('bundle-invalid', 'ci-logs directory is missing'); }
  if (!logsStat.isDirectory() || logsStat.isSymbolicLink()) fail('bundle-invalid', 'ci-logs is not a safe directory');
  const files = await listBundle(root);
  const payloadFiles = files.filter((item) => !['manifest.json', 'file-hashes.json'].includes(item));
  const rootFiles = files.filter((item) => !item.startsWith('ci-logs/')).sort();
  const expectedRootFiles = [...PAYLOADS, 'file-hashes.json', 'manifest.json'].sort();
  const logFiles = files.filter((item) => item.startsWith('ci-logs/'));
  if (rootFiles.join() !== expectedRootFiles.join() || !logFiles.every((item) => /^ci-logs\/[A-Za-z0-9_.:-]+\.txt$/.test(item))) fail('bundle-invalid', 'Fixed bundle inventory is invalid');
  const artifactBytes = await readBundleSnapshot(root, files);
  const manifest = parseJson(requireSnapshotFile(artifactBytes, 'manifest.json'), 'bundle-invalid', 'Manifest');
  validateManifestShape(manifest);
  const hashesBytes = requireSnapshotFile(artifactBytes, 'file-hashes.json');
  if (sha256(hashesBytes) !== manifest.fileHashesSha256) fail('hash-mismatch', 'file-hashes.json digest mismatch');
  const hashes = parseJson(hashesBytes, 'bundle-invalid', 'File hashes');
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || !Object.values(hashes).every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))) fail('bundle-invalid', 'File hash map is invalid');
  if (Object.keys(hashes).sort().join() !== payloadFiles.sort().join()) fail('bundle-invalid', 'File hash inventory differs from bundle files');
  const expectedArtifacts = [...payloadFiles, 'file-hashes.json'].sort();
  const artifactPaths = manifest.artifacts.map((item) => item.path);
  if (new Set(artifactPaths).size !== artifactPaths.length || artifactPaths.sort().join() !== expectedArtifacts.join()) fail('bundle-invalid', 'Artifact inventory differs from bundle files');
  const artifactHashes = new Map();
  for (const artifact of manifest.artifacts) {
    const bytes = requireSnapshotFile(artifactBytes, artifact.path);
    const digest = sha256(bytes);
    if (artifact.bytes !== bytes.length || artifact.sha256 !== digest) fail('hash-mismatch', `Artifact hash mismatch: ${artifact.path}`);
    if (artifact.path !== 'file-hashes.json' && hashes[artifact.path] !== digest) fail('hash-mismatch', `Payload hash mismatch: ${artifact.path}`);
    artifactHashes.set(artifact.path, digest);
  }
  const repoFull = `${manifest.repository.owner}/${manifest.repository.name}`;
  const pr = parseJson(requireSnapshotFile(artifactBytes, 'pr.json'), 'bundle-invalid', 'PR payload');
  if (pr?.number !== manifest.pullRequest.number || pr?.url !== manifest.pullRequest.url || pr?.base?.sha !== manifest.baseSha || pr?.base?.repository !== repoFull || pr?.head?.sha !== manifest.headSha) fail('bundle-invalid', 'PR payload identity differs from manifest');
  validatePayloadRelationships(artifactBytes, manifest, logFiles, repoFull);
  if ((expected.repository && expected.repository !== repoFull) || (expected.prNumber && expected.prNumber !== manifest.pullRequest.number) || (expected.headSha && expected.headSha !== manifest.headSha) || (expected.baseSha && expected.baseSha !== manifest.baseSha)) fail('bundle-exists', 'Existing bundle identity does not match');
  return { root, manifest, hashes, artifactHashes, artifactBytes };
}
