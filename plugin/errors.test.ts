import { describe, it, expect } from 'vitest';
import { extractErrorMessage } from './errors.js';

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
});
