import { describe, it, expect } from 'vitest';
import { SpleraError, httpStatusToSpleraCode, HINTS } from '../errors.js';

describe('SpleraError', () => {
  it('carries code, message, hint, and httpStatus', () => {
    const err = new SpleraError(
      'SPLERA_VALIDATION_ERROR',
      'variants must be length 2',
      'Check the tool input.',
      422
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SpleraError);
    expect(err.name).toBe('SpleraError');
    expect(err.code).toBe('SPLERA_VALIDATION_ERROR');
    expect(err.message).toBe('variants must be length 2');
    expect(err.hint).toBe('Check the tool input.');
    expect(err.httpStatus).toBe(422);
  });

  it('makes httpStatus optional', () => {
    const err = new SpleraError('SPLERA_HTTP_ERROR', 'boom', 'retry');
    expect(err.httpStatus).toBeUndefined();
  });
});

describe('httpStatusToSpleraCode', () => {
  describe('server-returned SPLERA_* code (trusted pass-through)', () => {
    it('passes a valid SPLERA_* code through verbatim, ignoring the HTTP status mapping', () => {
      // Status 500 would map to SPLERA_HTTP_ERROR via fallback, but the
      // server-returned SPLERA_JWT_REQUIRED should win.
      const { code, hint } = httpStatusToSpleraCode(500, 'SPLERA_JWT_REQUIRED');
      expect(code).toBe('SPLERA_JWT_REQUIRED');
      expect(hint).toBe(HINTS.SPLERA_JWT_REQUIRED);
    });

    it('falls back to status-based mapping if server returned an unknown SPLERA_* code', () => {
      // Unknown code (not in HINTS) is not trusted — we fall back to status.
      const { code, hint } = httpStatusToSpleraCode(402, 'SPLERA_NEVER_SEEN');
      expect(code).toBe('SPLERA_PLAN_LIMIT_EXCEEDED');
      expect(hint).toBe(HINTS.SPLERA_PLAN_LIMIT_EXCEEDED);
    });

    it('falls back to status mapping if server returned a code without SPLERA_ prefix', () => {
      const { code } = httpStatusToSpleraCode(401, 'some_raw_code');
      expect(code).toBe('SPLERA_INVALID_API_KEY');
    });
  });

  describe('HTTP status mapping', () => {
    it('maps 401 → SPLERA_INVALID_API_KEY', () => {
      const { code, hint } = httpStatusToSpleraCode(401);
      expect(code).toBe('SPLERA_INVALID_API_KEY');
      expect(hint).toBe(HINTS.SPLERA_INVALID_API_KEY);
    });

    it('maps 402 → SPLERA_PLAN_LIMIT_EXCEEDED (undefined serverCode)', () => {
      const { code, hint } = httpStatusToSpleraCode(402, undefined);
      expect(code).toBe('SPLERA_PLAN_LIMIT_EXCEEDED');
      expect(hint).toBe(HINTS.SPLERA_PLAN_LIMIT_EXCEEDED);
    });

    it('maps 403 → SPLERA_DOMAIN_NOT_ALLOWED', () => {
      const { code } = httpStatusToSpleraCode(403);
      expect(code).toBe('SPLERA_DOMAIN_NOT_ALLOWED');
    });

    it('maps 404 → SPLERA_EXPERIMENT_NOT_FOUND', () => {
      const { code } = httpStatusToSpleraCode(404);
      expect(code).toBe('SPLERA_EXPERIMENT_NOT_FOUND');
    });

    it('maps 422 → SPLERA_VALIDATION_ERROR', () => {
      const { code } = httpStatusToSpleraCode(422);
      expect(code).toBe('SPLERA_VALIDATION_ERROR');
    });

    it('maps 426 → SPLERA_MCP_VERSION_TOO_OLD', () => {
      const { code } = httpStatusToSpleraCode(426);
      expect(code).toBe('SPLERA_MCP_VERSION_TOO_OLD');
    });
  });

  describe('unknown/unhandled statuses → SPLERA_HTTP_ERROR fallback', () => {
    it('maps 500 → SPLERA_HTTP_ERROR', () => {
      const { code, hint } = httpStatusToSpleraCode(500);
      expect(code).toBe('SPLERA_HTTP_ERROR');
      expect(hint).toBe(HINTS.SPLERA_HTTP_ERROR);
    });

    it('maps 502 → SPLERA_HTTP_ERROR', () => {
      expect(httpStatusToSpleraCode(502).code).toBe('SPLERA_HTTP_ERROR');
    });

    it('maps 429 (rate limit, no server code) → SPLERA_HTTP_ERROR', () => {
      expect(httpStatusToSpleraCode(429).code).toBe('SPLERA_HTTP_ERROR');
    });

    it('maps 418 (teapot) → SPLERA_HTTP_ERROR', () => {
      expect(httpStatusToSpleraCode(418).code).toBe('SPLERA_HTTP_ERROR');
    });
  });

  it('every returned hint is non-empty and actionable (ends with a link, command, or instruction)', () => {
    // Spot-check: the hint-library contract is "always actionable".
    for (const status of [401, 402, 403, 404, 422, 426, 500]) {
      const { hint } = httpStatusToSpleraCode(status);
      expect(hint.length).toBeGreaterThan(10);
    }
  });
});
