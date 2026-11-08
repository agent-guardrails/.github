import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(ordered(value));
}

export function jsonFile(value) {
  return `${canonicalJson(value)}\n`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function parseJson(buffer, code = 'remote-failure', label = 'JSON') {
  try { return JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer); }
  catch { fail(code, `${label} is malformed`); }
}
