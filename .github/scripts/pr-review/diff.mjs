import { safeRepositoryPath } from './validate.mjs';

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const ESCAPED_BYTES = Object.freeze({
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
});
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function decodePath(value) {
  if (!value.startsWith('"')) return value;
  if (value.length < 2 || !value.endsWith('"')) return undefined;
  const bytes = [];
  for (let index = 1; index < value.length - 1;) {
    if (value[index] !== '\\') {
      const codePoint = value.codePointAt(index);
      bytes.push(...UTF8_ENCODER.encode(String.fromCodePoint(codePoint)));
      index += codePoint > 0xffff ? 2 : 1;
      continue;
    }
    const escaped = value[index + 1];
    if (Object.hasOwn(ESCAPED_BYTES, escaped)) {
      bytes.push(ESCAPED_BYTES[escaped]);
      index += 2;
      continue;
    }
    const octal = value.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/.test(octal)) return undefined;
    bytes.push(Number.parseInt(octal, 8));
    index += 4;
  }
  try {
    return UTF8_DECODER.decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

function repositoryPath(value, prefix) {
  const decoded = decodePath(value);
  if (decoded === undefined) return null;
  if (decoded === '/dev/null') return undefined;
  const file = decoded.startsWith(`${prefix}/`) ? decoded.slice(2) : decoded;
  return safeRepositoryPath(file) ? file : null;
}

function parseHunkHeader(line) {
  const match = HUNK_HEADER.exec(line);
  if (!match) return undefined;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  const values = [oldStart, oldCount, newStart, newCount];
  if (!values.every(Number.isSafeInteger) || oldCount < 0 || newCount < 0) return undefined;
  if ((oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) return undefined;
  if ((oldCount > 0 && !Number.isSafeInteger(oldStart + oldCount - 1))
    || (newCount > 0 && !Number.isSafeInteger(newStart + newCount - 1))) return undefined;
  return { oldStart, oldCount, newStart, newCount };
}

function addLine(ranges, line) {
  const last = ranges.at(-1);
  if (last && last[1] + 1 === line) last[1] = line;
  else ranges.push([line, line]);
}

function mergeRanges(target, source) {
  for (const [start, end] of source) {
    const last = target.at(-1);
    if (last && last[1] + 1 >= start) last[1] = Math.max(last[1], end);
    else target.push([start, end]);
  }
}

function commitHunkSide(locations, file, side, ranges) {
  if (file === undefined || ranges.length === 0) return;
  const entry = locations.get(file) ?? { LEFT: [], RIGHT: [] };
  mergeRanges(entry[side], ranges);
  locations.set(file, entry);
}

function commitHunk(locations, oldFile, newFile, hunk) {
  commitHunkSide(locations, oldFile, 'LEFT', hunk.LEFT);
  commitHunkSide(locations, newFile, 'RIGHT', hunk.RIGHT);
}

export function diffLocations(text) {
  const locations = new Map();
  let state = 'headers';
  let file;
  let oldFile;
  let hasOldHeader = false;
  let hunk;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      state = 'headers';
      file = undefined;
      oldFile = undefined;
      hasOldHeader = false;
      hunk = undefined;
      continue;
    }
    if (state === 'binary' || state === 'invalid') continue;
    if (state === 'hunk') {
      const marker = line[0];
      if (marker === ' ' && hunk.oldRemaining > 0 && hunk.newRemaining > 0) {
        addLine(hunk.LEFT, hunk.oldLine);
        addLine(hunk.RIGHT, hunk.newLine);
        hunk.oldLine += 1;
        hunk.newLine += 1;
        hunk.oldRemaining -= 1;
        hunk.newRemaining -= 1;
      } else if (marker === '-' && hunk.oldRemaining > 0) {
        addLine(hunk.LEFT, hunk.oldLine);
        hunk.oldLine += 1;
        hunk.oldRemaining -= 1;
      } else if (marker === '+' && hunk.newRemaining > 0) {
        addLine(hunk.RIGHT, hunk.newLine);
        hunk.newLine += 1;
        hunk.newRemaining -= 1;
      } else if (line !== '\\ No newline at end of file') {
        state = 'invalid';
        hunk = undefined;
        continue;
      }
      if (hunk && hunk.oldRemaining === 0 && hunk.newRemaining === 0) {
          commitHunk(locations, oldFile, file, hunk);
        state = 'headers';
        hunk = undefined;
      }
      continue;
    }
    if (line === 'GIT binary patch' || /^Binary files .+ differ$/.test(line)) {
      state = 'binary';
      continue;
    }
    if (line.startsWith('--- ')) {
      oldFile = repositoryPath(line.slice(4), 'a');
      if (oldFile === null) state = 'invalid';
      else {
        file = undefined;
        hasOldHeader = true;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newFile = repositoryPath(line.slice(4), 'b');
      if (!hasOldHeader || newFile === null || (oldFile === undefined && newFile === undefined)) {
        state = 'invalid';
      } else {
        file = newFile;
        hasOldHeader = false;
      }
      continue;
    }
    if (line.startsWith('@@ ')) {
      const header = parseHunkHeader(line);
      if ((oldFile === undefined && file === undefined) || !header) {
        state = 'invalid';
        continue;
      }
      if (header.oldCount === 0 && header.newCount === 0) continue;
      hunk = {
        oldLine: header.oldStart,
        newLine: header.newStart,
        oldRemaining: header.oldCount,
        newRemaining: header.newCount,
        LEFT: [],
        RIGHT: [],
      };
      state = 'hunk';
    }
  }
  return locations;
}

export function hasDiffLocation(locations, file, side, line) {
  return locations.get(file)?.[side]?.some(([start, end]) => line >= start && line <= end) ?? false;
}
