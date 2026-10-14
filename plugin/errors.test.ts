import { describe, it, expect } from 'vitest';
import { classifyError, extractErrorMessage } from './errors.js';

describe('classifyError', () => {
  describe('retryable patterns', () => {
    it.each([
      ['429 status code',              '429 Too Many Requests'],
      ['500 status code',              'Internal Server Error 500'],
      ['502 status code',              'Bad Gateway 502'],
      ['503 status code',              '503 Service Unavailable'],
      ['504 status code',              'Gateway Timeout 504'],
      ['rate limit phrase',            'You have exceeded your rate limit'],
      ['rate_limit phrase',            'error: rate_limit exceeded'],
      ['overloaded',                   'Model is currently overloaded with requests'],
      ['server_error',                 'A server_error occurred on the provider'],
      ['timeout',                      'Request timeout after 30s'],
      ['timed out',                    'Connection timed out'],
      ['temporarily unavailable',      'Service is temporarily unavailable, try again'],
      ['capacity',                     'Insufficient capacity to process the request'],
      ['too many requests',            'Too many requests sent in a short time'],
      ['service unavailable',          'Service unavailable'],
      ['internal server error',        'We encountered an internal server error'],
      ['bad gateway',                  'Bad gateway response from upstream'],
      ['gateway timeout',              'Gateway timeout while waiting for response'],
      ['ECONNREFUSED',                 'ECONNREFUSED 127.0.0.1:443'],
      ['ECONNRESET',                   'socket hang up ECONNRESET'],
      ['ETIMEDOUT',                    'ETIMEDOUT connection timed out'],
      ['fetch failed',                 'fetch failed: network error'],
    ])('classifies "%s" as retryable', (_label, message) => {
      expect(classifyError(message)).toBe('retryable');
    });
  });

  describe('case insensitivity', () => {
    it('matches UPPERCASE pattern', () => {
      expect(classifyError('RATE LIMIT EXCEEDED')).toBe('retryable');
    });
    it('matches mixed case pattern', () => {
      expect(classifyError('Service Temporarily Unavailable')).toBe('retryable');
    });
    it('matches all-lowercase pattern', () => {
      expect(classifyError('internal server error')).toBe('retryable');
    });
  });

  describe('terminal errors', () => {
    it.each([
      'Invalid API key',
      'Authentication failed: 401 Unauthorized',
      '403 Forbidden',
      'Content policy violation detected',
      'The requested resource was not found (404)',
      'Model does not exist',
      'Invalid request body',
      'Unexpected error',
      '',
      '   ',
    ])('classifies "%s" as terminal', (message) => {
      expect(classifyError(message)).toBe('terminal');
    });
  });

  describe('edge cases', () => {
    it('returns terminal for empty string', () => {
      expect(classifyError('')).toBe('terminal');
    });

    it('matches 429 embedded mid-message', () => {
      expect(classifyError('provider responded with error code 429 — back off')).toBe('retryable');
    });

    it('does NOT match 42 (substring of 429)', () => {
      // "42" is not in the patterns list, so a message containing just "42" is terminal
      expect(classifyError('error code 42')).toBe('terminal');
    });

    it('matches multiple patterns — first match wins (retryable)', () => {
      expect(classifyError('429 rate limit hit, service unavailable')).toBe('retryable');
    });
  });

  describe('v2 error names and status codes', () => {
    it.each([
      'ProviderAuthError: invalid credentials',
      'ContextOverflowError: prompt is too long',
      'MessageAbortedError: aborted',
      'ApiError: content policy violation (HTTP 400)',
      'ApiError: Unauthorized (HTTP 401)',
      'ApiError: Forbidden (HTTP 403)',
      // Terminal wins over a retryable word in the same message.
      'ProviderAuthError: token refresh timed out',
      'ApiError: content policy check failed, rate limit not the cause',
    ])('classifies "%s" as terminal', (message) => {
      expect(classifyError(message)).toBe('terminal');
    });

    it.each([
      'ApiError: Too many requests (HTTP 429)',
      'ApiError: upstream failure (HTTP 500)',
      'ApiError: upstream failure (HTTP 520)',
      'ApiError: upstream failure (HTTP 599)',
      'UnknownError: request timeout',
      'ApiError: rate limit reached (HTTP 400)',
    ])('classifies "%s" as retryable', (message) => {
      expect(classifyError(message)).toBe('retryable');
    });

    it('does not treat 4xx statuses other than 429 as retryable', () => {
      expect(classifyError('ApiError: bad request (HTTP 400)')).toBe('terminal');
      expect(classifyError('ApiError: not found (HTTP 404)')).toBe('terminal');
    });
  });
});

describe('extractErrorMessage', () => {
  it('formats the v2 structured error { type, message, status }', () => {
    expect(extractErrorMessage({ type: 'ApiError', message: 'Too many requests', status: 429 })).toBe(
      'ApiError: Too many requests (HTTP 429)',
    );
  });

  it('formats the v1-style union { name, data: { message, statusCode } }', () => {
    expect(
      extractErrorMessage({ name: 'ApiError', data: { message: 'Bad gateway', statusCode: 502 } }),
    ).toBe('ApiError: Bad gateway (HTTP 502)');
    expect(extractErrorMessage({ name: 'ProviderAuthError', data: { message: 'bad key' } })).toBe(
      'ProviderAuthError: bad key',
    );
    expect(extractErrorMessage({ name: 'UnknownError', data: { message: 'boom' } })).toBe('UnknownError: boom');
    expect(extractErrorMessage({ name: 'MessageAbortedError', data: { message: 'aborted' } })).toBe(
      'MessageAbortedError: aborted',
    );
    expect(extractErrorMessage({ name: 'ContextOverflowError', data: { message: 'too long' } })).toBe(
      'ContextOverflowError: too long',
    );
  });

  it('handles partial shapes', () => {
    expect(extractErrorMessage({ message: 'only message' })).toBe('only message');
    expect(extractErrorMessage({ type: 'OnlyType' })).toBe('OnlyType');
    expect(extractErrorMessage({ type: 'ApiError', status: 503 })).toBe('ApiError (HTTP 503)');
    expect(extractErrorMessage({ _tag: 'UnknownError', message: 'x' })).toBe('UnknownError: x');
  });

  it('passes strings through and stringifies Error instances', () => {
    expect(extractErrorMessage('rate limit')).toBe('rate limit');
    expect(extractErrorMessage(new Error('fetch failed'))).toBe('fetch failed');
  });

  it('falls back to "unknown error" for empty / nullish input', () => {
    expect(extractErrorMessage(undefined)).toBe('unknown error');
    expect(extractErrorMessage(null)).toBe('unknown error');
    expect(extractErrorMessage('  ')).toBe('unknown error');
    expect(extractErrorMessage({})).toBe('unknown error');
  });

  it('produces strings classifyError maps to the right class', () => {
    const cls = (e: unknown) => classifyError(extractErrorMessage(e));
    expect(cls({ type: 'ApiError', message: 'Too many requests', status: 429 })).toBe('retryable');
    expect(cls({ type: 'ApiError', message: 'upstream', status: 503 })).toBe('retryable');
    expect(cls({ type: 'UnknownError', message: 'request timeout' })).toBe('retryable');
    expect(cls({ type: 'ApiError', message: 'Unauthorized', status: 401 })).toBe('terminal');
    expect(cls({ name: 'ProviderAuthError', data: { message: 'bad key' } })).toBe('terminal');
    expect(cls({ type: 'ContextOverflowError', message: 'too long' })).toBe('terminal');
    expect(cls({ type: 'MessageAbortedError', message: 'aborted' })).toBe('terminal');
    expect(cls({ type: 'ApiError', message: 'content policy violation', status: 400 })).toBe('terminal');
  });
});
