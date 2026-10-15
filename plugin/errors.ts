const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Turn a session error into a single readable string:
 * `<name>: <message> (HTTP <status>)` with absent parts omitted.
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
