import { describe, it, expect } from 'vitest';
import { classifyError } from './errors.js';

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
});
