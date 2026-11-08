import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';
import { canonicalJson, jsonFile, sha256 } from './json.mjs';
import { freshStage, fsyncDirectory, writeExclusive } from './files.mjs';
import { safeMember, validateCallerPath } from './validate.mjs';
import { MAX_ARTIFACT_BYTES, MAX_BUNDLE_BYTES, PAYLOADS } from './bundle-constants.mjs';
import { manifestDigest } from './bundle-schema.mjs';
import { verifyBundle } from './bundle-verify.mjs';

export { MAX_ARTIFACT_BYTES, MAX_BUNDLE_BYTES, PAYLOADS, verifyBundle };

export async function createBundle(output, data) {
  const out = await validateCallerPath(output);
  const prepared = prepareBundle(data);
  try {
    await lstat(out);
    const existing = await verifyBundle(out, data.identity);
    if (!sameEvidence(existing, data, prepared.contents)) fail('bundle-exists', 'Existing bundle evidence does not match fresh collection');
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = await freshStage(out);
  try {
    await mkdir(path.join(stage, 'ci-logs'), { mode: 0o700 });
    for (const [name, bytes] of [...prepared.contents].sort()) await writeExclusive(path.join(stage, name), bytes);
    await writeExclusive(path.join(stage, 'file-hashes.json'), prepared.hashBytes);
    await writeExclusive(path.join(stage, 'manifest.json'), prepared.manifestBytes);
    await fsyncDirectory(path.join(stage, 'ci-logs'));
    await fsyncDirectory(stage);
    const verified = await verifyBundle(stage, data.identity);
    await rename(stage, out);
    await fsyncDirectory(path.dirname(out));
    return { ...verified, root: out };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function bundleContents(data) {
  const contents = new Map();
  for (const name of PAYLOADS) contents.set(name, name === 'diff.patch' ? toBytes(data.payloads[name]) : Buffer.from(jsonFile(data.payloads[name])));
  for (const [name, content] of Object.entries(data.logs)) {
    if (!/^[A-Za-z0-9_.:-]+\.txt$/.test(name)) fail('bundle-invalid', 'Unsafe CI log name');
    contents.set(`ci-logs/${name}`, toBytes(content));
  }
  return contents;
}

function toBytes(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function prepareBundle(data) {
  const contents = bundleContents(data);
  const hashes = {};
  for (const [name, bytes] of contents) {
    if (bytes.length > MAX_ARTIFACT_BYTES) fail('bundle-invalid', `Artifact exceeds byte limit: ${name}`);
    hashes[name] = sha256(bytes);
  }
  const hashBytes = Buffer.from(jsonFile(hashes));
  if (hashBytes.length > MAX_ARTIFACT_BYTES) fail('bundle-invalid', 'Artifact exceeds byte limit: file-hashes.json');
  const all = new Map(contents);
  all.set('file-hashes.json', hashBytes);
  const manifest = { ...data.manifest, artifacts: [...all].sort().map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) })), fileHashesSha256: sha256(hashBytes) };
  manifest.manifestCanonicalSha256 = manifestDigest(manifest);
  const manifestBytes = Buffer.from(jsonFile(manifest));
  let totalBytes = manifestBytes.length;
  for (const bytes of all.values()) totalBytes += bytes.length;
  if (totalBytes > MAX_BUNDLE_BYTES) fail('bundle-invalid', 'Bundle exceeds total byte limit');
  return { contents, hashBytes, manifestBytes };
}

function sameEvidence(existing, data, contents) {
  if (contents.size !== Object.keys(existing.hashes).length) return false;
  for (const [name, bytes] of contents) if (existing.hashes[name] !== sha256(bytes)) return false;
  return canonicalJson(existing.manifest.localWorktree) === canonicalJson(data.manifest.localWorktree)
    && canonicalJson(existing.manifest.selectedCi) === canonicalJson(data.manifest.selectedCi)
    && canonicalJson(existing.manifest.incompleteOrUnavailableEvidence) === canonicalJson(data.manifest.incompleteOrUnavailableEvidence);
}
