const TOKEN_PATTERN = /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const AUTHORIZATION_PATTERN = /(Authorization\s*[:=]\s*)[^\r\n,;]+/gi;

export class ReviewError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
    this.details = details;
  }
}

export function redact(value, env = process.env) {
  let text = String(value ?? '');
  text = text.replace(AUTHORIZATION_PATTERN, (_match, prefix) => `${prefix}[REDACTED]`);
  text = text.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  text = text.replace(TOKEN_PATTERN, '[REDACTED]');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const secret = env[key];
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

export function sanitizeEvidence(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvidence(item)]));
  }
  return value;
}

export function fail(code, message, details) {
  throw new ReviewError(code, message, details);
}

export function errorRecord(error) {
  const known = error instanceof ReviewError;
  return {
    contractVersion: 1,
    ok: false,
    error: {
      code: known ? error.code : 'local-io-failure',
      message: redact(error?.message ?? error),
    },
  };
}
