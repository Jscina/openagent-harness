// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Patterns that are always terminal, checked BEFORE the retryable list so a
 * message that mentions both (e.g. an auth failure that quotes a timeout) is
 * never retried. Covers the opencode error type names
 * (ProviderAuthError, ContextOverflowError, MessageAbortedError) plus
 * auth / content-policy wording.
 */
const TERMINAL_PATTERNS: Array<string | RegExp> = [
  'providerautherror',
  'contextoverflowerror',
  'messageabortederror',
  'content policy', 'content_policy', 'content filter',
  'invalid api key', 'invalid_api_key',
  /\bhttp 40[13]\b/,
];

const RETRYABLE_PATTERNS: Array<string | RegExp> = [
  '429', '500', '502', '503', '504',
  // Any other 5xx, in the `HTTP <status>` form emitted by extractErrorMessage.
  /\bhttp 5\d\d\b/,
  'rate limit', 'rate_limit',
  'overloaded',
  'server_error',
  'timeout', 'timed out',
  'temporarily unavailable',
  'capacity',
  'too many requests',
  'service unavailable',
  'internal server error',
  'bad gateway',
  'gateway timeout',
  'econnrefused',
  'econnreset',
  'etimedout',
  'fetch failed',
];

const matches = (lower: string, patterns: Array<string | RegExp>): boolean =>
  patterns.some((p) => (typeof p === 'string' ? lower.includes(p) : p.test(lower)));

/**
 * Classify an error message as retryable (provider-side transient failure) or
 * terminal (auth, content policy, invalid request, model not found, etc.).
 */
export function classifyError(errorMsg: string): 'retryable' | 'terminal' {
  const lower = errorMsg.toLowerCase();
  if (matches(lower, TERMINAL_PATTERNS)) return 'terminal';
  return matches(lower, RETRYABLE_PATTERNS) ? 'retryable' : 'terminal';
}

// ─── Error message extraction ─────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Turn a session error into a single readable string that `classifyError` can
 * classify, as `<name>: <message> (HTTP <status>)` with absent parts omitted.
 *
 * Accepts:
 *  - the v2 structured error `{ type, message, status?, response? }`
 *    (`session.execution.failed`);
 *  - the v1-style union `{ name, data: { message, statusCode? } }`
 *    (ProviderAuthError, UnknownError, MessageAbortedError,
 *    ContextOverflowError, ApiError);
 *  - `Error` instances and plain strings.
 */
export function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error.trim() === '' ? 'unknown error' : error;

  const rec = asRecord(error);
  if (!rec) return error == null ? 'unknown error' : String(error);

  const data = asRecord(rec.data);
  const rawName = asString(rec.type) ?? asString(rec.name) ?? asString(rec._tag);
  // A bare `Error` name (from Error instances) carries no information.
  const name = rawName === 'Error' ? undefined : rawName;
  const message = asString(rec.message) ?? asString(data?.message);
  const status =
    asNumber(rec.status) ??
    asNumber(rec.statusCode) ??
    asNumber(data?.statusCode) ??
    asNumber(data?.status);

  const parts: string[] = [];
  if (name && message) parts.push(`${name}: ${message}`);
  else if (name ?? message) parts.push((name ?? message) as string);
  if (status !== undefined) parts.push(`(HTTP ${status})`);

  return parts.length > 0 ? parts.join(' ') : 'unknown error';
}
