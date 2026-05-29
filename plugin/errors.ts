// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Classify an error message as retryable (provider-side transient failure) or
 * terminal (auth, content policy, invalid request, model not found, etc.).
 */
export function classifyError(errorMsg: string): 'retryable' | 'terminal' {
  const lower = errorMsg.toLowerCase();
  const retryablePatterns = [
    '429', '500', '502', '503', '504',
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

  const classification = retryablePatterns.some((pattern) => lower.includes(pattern))
    ? 'retryable'
    : 'terminal';

  return classification;
}
