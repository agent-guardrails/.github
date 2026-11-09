import { fail, sanitizeEvidence } from './errors.mjs';
import { safeRepositoryPath } from './validate.mjs';

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const ESCAPED_BYTES = Object.freeze({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });

function decodePath(value) {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) return undefined;
  const bytes = [];
  for (let index = 1; index < value.length - 1;) {
    if (value[index] !== '\\') {
      const point = value.codePointAt(index);
      bytes.push(...UTF8_ENCODER.encode(String.fromCodePoint(point)));
      index += point > 0xffff ? 2 : 1;
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
  try { return UTF8_DECODER.decode(Uint8Array.from(bytes)); }
  catch { return undefined; }
}

function quoteGitPath(value) {
  let body = '';
  for (const byte of UTF8_ENCODER.encode(value)) {
    if (byte === 34) body += '\\"';
    else if (byte === 92) body += '\\\\';
    else if (byte >= 32 && byte <= 126) body += String.fromCharCode(byte);
    else body += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `"${body}"`;
}

function headerPath(value, prefix) {
  const decoded = decodePath(value);
  if (decoded === '/dev/null') return null;
  const candidate = decoded?.startsWith(`${prefix}/`) ? decoded.slice(2) : decoded;
  if (!safeRepositoryPath(candidate)) fail('bundle-invalid', 'Diff contains an unsafe file path');
  return candidate;
}

function hunkIdentity(header, index) {
  const match = HUNK_HEADER.exec(header);
  if (!match) fail('bundle-invalid', 'Diff contains a malformed hunk header');
  const hunk = {
    index,
    header,
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
  if (!Object.values(hunk).slice(2).every(Number.isSafeInteger)) fail('bundle-invalid', 'Diff hunk is outside the safe integer range');
  return hunk;
}

function finishHunk(hunk) {
  if (hunk && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0)) fail('bundle-invalid', 'Diff hunk line counts are inconsistent');
}

function* patchLines(text) {
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    if (end === -1) {
      yield text.slice(start);
      return;
    }
    yield text.slice(start, end);
    start = end + 1;
  }
}

function newSection(header, expectedHeader, expectedQuotedHeader) {
  return {
    header,
    headerMatches: header === expectedHeader || header === expectedQuotedHeader,
    oldPath: undefined,
    newPath: undefined,
    binary: false,
    hunk: undefined,
    hunkIndex: 0,
    previousHunkKind: undefined,
    capture: false,
    total: 0,
    lines: [],
  };
}

function hunkRecord(hunk) {
  return {
    index: hunk.index,
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldCount: hunk.oldCount,
    newStart: hunk.newStart,
    newCount: hunk.newCount,
  };
}

function retainLine(section, offset, limit, kind, text, oldLine, newLine) {
  if (!section.capture) return;
  const index = section.total;
  section.total += 1;
  if (index < offset || section.lines.length >= limit) return;
  section.lines.push(sanitizeEvidence({ hunk: hunkRecord(section.hunk), kind, text, oldLine, newLine }));
}

function consumeHunkLine(section, line, offset, limit) {
  const hunk = section.hunk;
  if (line === '\\ No newline at end of file') {
    if (!section.previousHunkKind) fail('bundle-invalid', 'No-newline marker has no preceding hunk line');
    retainLine(section, offset, limit, 'no-newline', 'No newline at end of file', null, null);
    return;
  }
  if (line.startsWith(' ') && hunk.oldRemaining > 0 && hunk.newRemaining > 0) {
    retainLine(section, offset, limit, 'context', line.slice(1), hunk.oldLine, hunk.newLine);
    hunk.oldLine += 1;
    hunk.newLine += 1;
    hunk.oldRemaining -= 1;
    hunk.newRemaining -= 1;
    section.previousHunkKind = 'context';
    return;
  }
  if (line.startsWith('-') && hunk.oldRemaining > 0) {
    retainLine(section, offset, limit, 'deletion', line.slice(1), hunk.oldLine, null);
    hunk.oldLine += 1;
    hunk.oldRemaining -= 1;
    section.previousHunkKind = 'deletion';
    return;
  }
  if (line.startsWith('+') && hunk.newRemaining > 0) {
    retainLine(section, offset, limit, 'addition', line.slice(1), null, hunk.newLine);
    hunk.newLine += 1;
    hunk.newRemaining -= 1;
    section.previousHunkKind = 'addition';
    return;
  }
  fail('bundle-invalid', 'Diff hunk content is malformed');
}

export function projectPatch(text, file, offset, limit) {
  const headerOldPath = file.oldPath ?? file.newPath;
  const headerNewPath = file.newPath ?? file.oldPath;
  const expectedHeader = `diff --git a/${headerOldPath} b/${headerNewPath}`;
  const expectedQuotedHeader = `diff --git ${quoteGitPath(`a/${headerOldPath}`)} ${quoteGitPath(`b/${headerNewPath}`)}`;
  let section;
  let selected;
  let matchCount = 0;

  const finishSection = () => {
    if (!section) return;
    finishHunk(section.hunk);
    if ((section.oldPath === undefined) !== (section.newPath === undefined)) fail('bundle-invalid', 'Diff contains incomplete file headers');
    const textMatch = section.oldPath === file.oldPath && section.newPath === file.newPath;
    const metadataMatch = section.oldPath === undefined && section.newPath === undefined && section.headerMatches;
    if (!textMatch && !metadataMatch) return;
    matchCount += 1;
    selected = {
      textAvailable: section.oldPath !== undefined,
      binary: section.binary,
      lines: section.lines,
      returned: section.lines.length,
      total: section.total,
      nextOffset: offset + section.lines.length < section.total ? offset + section.lines.length : null,
    };
  };

  for (const line of patchLines(text)) {
    if (line.startsWith('diff --git ')) {
      finishSection();
      section = newSection(line, expectedHeader, expectedQuotedHeader);
      continue;
    }
    if (!section) continue;
    if (section.hunk && section.hunk.oldRemaining === 0 && section.hunk.newRemaining === 0 && line !== '\\ No newline at end of file') {
      finishHunk(section.hunk);
      section.hunk = undefined;
      section.previousHunkKind = undefined;
    }
    if (section.hunk) {
      consumeHunkLine(section, line, offset, limit);
      continue;
    }
    if (line.startsWith('--- ')) {
      section.oldPath = headerPath(line.slice(4), 'a');
      continue;
    }
    if (line.startsWith('+++ ')) {
      section.newPath = headerPath(line.slice(4), 'b');
      section.capture = section.oldPath === file.oldPath && section.newPath === file.newPath;
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (section.oldPath === undefined || section.newPath === undefined) fail('bundle-invalid', 'Diff hunk is missing file headers');
      const hunk = hunkIdentity(line, section.hunkIndex);
      section.hunkIndex += 1;
      section.hunk = {
        ...hunk,
        oldLine: hunk.oldStart,
        newLine: hunk.newStart,
        oldRemaining: hunk.oldCount,
        newRemaining: hunk.newCount,
      };
      section.previousHunkKind = undefined;
      continue;
    }
    if ((line.startsWith('Binary files ') && line.endsWith(' differ')) || line === 'GIT binary patch') {
      section.binary = true;
      continue;
    }
    if (!section.binary && /^[ +\\]/.test(line)) fail('bundle-invalid', 'Diff hunk content appears outside a hunk');
  }
  finishSection();
  if (matchCount !== 1) fail('bundle-invalid', 'Changed-file metadata does not identify exactly one patch');
  return selected;
}

function fileIdentity(file) {
  if (file.status === 'added') return { oldPath: null, newPath: file.filename, status: file.status };
  if (file.status === 'removed') return { oldPath: file.filename, newPath: null, status: file.status };
  if (file.status === 'renamed' || file.status === 'copied') return { oldPath: file.previous_filename, newPath: file.filename, status: file.status };
  return { oldPath: file.filename, newPath: file.filename, status: file.status };
}

export function diffView(files, patch, requestedPath, offset, limit) {
  if (!safeRepositoryPath(requestedPath)) fail('invalid-input', 'Diff path is not a safe repository path');
  const matches = files.filter((file) => file.filename === requestedPath || file.previous_filename === requestedPath);
  if (matches.length !== 1) fail('invalid-input', matches.length === 0 ? 'Diff path is not changed' : 'Diff path is ambiguous');
  const file = fileIdentity(matches[0]);
  const projection = projectPatch(patch, file, offset, limit);
  return {
    file: sanitizeEvidence(file),
    ...projection,
  };
}
