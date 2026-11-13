import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * apiClient.ts calls loadConfig() at module load (top-level) to snapshot
 * {apiKey, apiUrl}. We mock ../config.js BEFORE importing so the real env
 * vars don't affect the test and loadConfig doesn't call process.exit.
 *
 * isBelow + CURRENT_MCP_VERSION are NOT mocked — we want the real semver
 * comparison and the real "0.1.0" string so the version-skew test is
 * exercising actual production logic.
 */
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>(
    '../config.js'
  );
  return {
    ...actual,
    loadConfig: () => ({
      apiKey: 'splera_live_test',
      apiUrl: 'https://api.test',
    }),
  };
});

import { apiFetch } from '../apiClient.js';
import { SpleraError } from '../errors.js';
import { CURRENT_MCP_VERSION } from '../config.js';

/**
 * Build a fake Response. Default body = '{}' so .json() parses to {}; callers
 * can override with a stringified JSON body when testing error paths.
 */
function makeResponse(opts: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  ok?: boolean;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  const ok = opts.ok ?? (opts.status >= 200 && opts.status < 300);
  return {
    ok,
    status: opts.status,
    statusText: `Status ${opts.status}`,
    headers,
    json: async () => JSON.parse(opts.body ?? '{}'),
    text: async () => opts.body ?? '',
  } as unknown as Response;
}

describe('apiFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('happy path', () => {
    it('returns the parsed JSON body on 2xx', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 200,
          body: JSON.stringify({ hello: 'world', n: 42 }),
        })
      );
      vi.stubGlobal('fetch', mock);

      const result = await apiFetch<{ hello: string; n: number }>('/api/me');
      expect(result).toEqual({ hello: 'world', n: 42 });
    });

    it('sets Authorization, Content-Type, and X-Splera-MCP-Version headers', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({ status: 200, body: '{}' })
      );
      vi.stubGlobal('fetch', mock);

      await apiFetch('/api/me');

      expect(mock).toHaveBeenCalledOnce();
      const [url, init] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test/api/me');

      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer splera_live_test');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Splera-MCP-Version']).toBe(CURRENT_MCP_VERSION);
    });

    it('merges caller-supplied headers with defaults', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({ status: 200, body: '{}' })
      );
      vi.stubGlobal('fetch', mock);

      await apiFetch('/api/me', {
        headers: { 'X-Custom-Header': 'custom-value' },
      });

      const [, init] = mock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Custom-Header']).toBe('custom-value');
      // Defaults still present.
      expect(headers.Authorization).toBe('Bearer splera_live_test');
    });

    it('forwards method + body init options', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({ status: 200, body: '{}' })
      );
      vi.stubGlobal('fetch', mock);

      await apiFetch('/api/experiments/create', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      });

      const [, init] = mock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{"name":"test"}');
    });
  });

  describe('version-skew guard (X-Splera-MCP-Min-Version)', () => {
    it('throws SPLERA_MCP_VERSION_TOO_OLD when min-version header is above current', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 200,
          headers: { 'X-Splera-MCP-Min-Version': '9.9.9' },
          body: '{}',
        })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/me')).rejects.toMatchObject({
        name: 'SpleraError',
        code: 'SPLERA_MCP_VERSION_TOO_OLD',
        httpStatus: 426,
      });
    });

    it('includes the upgrade hint in the thrown error', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 200,
          headers: { 'X-Splera-MCP-Min-Version': '9.9.9' },
          body: '{}',
        })
      );
      vi.stubGlobal('fetch', mock);

      try {
        await apiFetch('/api/me');
        expect.fail('expected apiFetch to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SpleraError);
        const sp = err as SpleraError;
        expect(sp.hint).toMatch(/npm update -g splera-mcp/);
        expect(sp.message).toContain(CURRENT_MCP_VERSION);
        expect(sp.message).toContain('9.9.9');
      }
    });

    it('fires BEFORE the non-2xx check — so a 4xx with min-version header still surfaces the version error', async () => {
      // The version-skew path runs first in apiClient; this documents that
      // behavior and protects the ordering (version error is more actionable
      // than a confusing schema mismatch from an old client against a new API).
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 404,
          headers: { 'X-Splera-MCP-Min-Version': '9.9.9' },
          body: JSON.stringify({ error: 'not found' }),
        })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/me')).rejects.toMatchObject({
        code: 'SPLERA_MCP_VERSION_TOO_OLD',
      });
    });

    it('does NOT throw when min-version equals current version', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 200,
          headers: { 'X-Splera-MCP-Min-Version': CURRENT_MCP_VERSION },
          body: JSON.stringify({ ok: true }),
        })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/me')).resolves.toEqual({ ok: true });
    });

    it('does NOT throw when min-version is below current version', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 200,
          headers: { 'X-Splera-MCP-Min-Version': '0.0.1' },
          body: JSON.stringify({ ok: true }),
        })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/me')).resolves.toEqual({ ok: true });
    });

    it('does NOT throw when min-version header is missing (normal flow)', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({ status: 200, body: JSON.stringify({ ok: true }) })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/me')).resolves.toEqual({ ok: true });
    });
  });

  describe('error → SpleraError conversion', () => {
    it('converts 401 → SPLERA_INVALID_API_KEY', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 401,
          body: JSON.stringify({ error: 'Invalid API key' }),
        })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/me')).rejects.toMatchObject({
        name: 'SpleraError',
        code: 'SPLERA_INVALID_API_KEY',
        message: 'Invalid API key',
        httpStatus: 401,
      });
    });

    it('converts 402 → SPLERA_PLAN_LIMIT_EXCEEDED', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 402,
          body: JSON.stringify({ error: 'cap reached' }),
        })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/experiments/create')).rejects.toMatchObject({
        code: 'SPLERA_PLAN_LIMIT_EXCEEDED',
        httpStatus: 402,
      });
    });

    it('trusts a server-returned SPLERA_* code over the HTTP-status mapping', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 500,
          body: JSON.stringify({
            error: 'JWT session required',
            code: 'SPLERA_JWT_REQUIRED',
          }),
        })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/me')).rejects.toMatchObject({
        code: 'SPLERA_JWT_REQUIRED',
        httpStatus: 500,
      });
    });

    it('uses server-returned hint when present (overrides default)', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 422,
          body: JSON.stringify({
            error: 'variants must be length 2',
            hint: 'Server-specific guidance: pass exactly 2 variants',
          }),
        })
      );
      vi.stubGlobal('fetch', mock);

      try {
        await apiFetch('/api/experiments/create');
        expect.fail('expected apiFetch to throw');
      } catch (err) {
        const sp = err as SpleraError;
        expect(sp.code).toBe('SPLERA_VALIDATION_ERROR');
        expect(sp.hint).toBe(
          'Server-specific guidance: pass exactly 2 variants'
        );
      }
    });

    it('falls back to res.statusText as message when body has no error field', async () => {
      const mock = vi.fn().mockResolvedValue(
        makeResponse({ status: 500, body: '{}' })
      );
      vi.stubGlobal('fetch', mock);

      try {
        await apiFetch('/api/me');
        expect.fail('expected throw');
      } catch (err) {
        const sp = err as SpleraError;
        expect(sp.message).toBe('Status 500');
        expect(sp.code).toBe('SPLERA_HTTP_ERROR');
      }
    });

    it('handles non-JSON error bodies gracefully (body.json() rejects)', async () => {
      // The apiClient does .json().catch(() => ({})) so a parse failure
      // shouldn't escape — it should fall back to status-based mapping with
      // empty body fields.
      const response = {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers(),
        json: async () => {
          throw new Error('Unexpected token < in JSON');
        },
        text: async () => '<html>gateway timeout</html>',
      } as unknown as Response;

      const mock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', mock);

      try {
        await apiFetch('/api/me');
        expect.fail('expected throw');
      } catch (err) {
        const sp = err as SpleraError;
        expect(sp.code).toBe('SPLERA_HTTP_ERROR');
        expect(sp.message).toBe('Service Unavailable');
      }
    });

    it('converts 426 upgrade-required HTTP response → SPLERA_MCP_VERSION_TOO_OLD', async () => {
      // This is the "no X-Splera-MCP-Min-Version header but status is 426"
      // path. Still maps to the right code via the status switch.
      const mock = vi.fn().mockResolvedValue(
        makeResponse({
          status: 426,
          body: JSON.stringify({ error: 'upgrade required' }),
        })
      );
      vi.stubGlobal('fetch', mock);

      await expect(apiFetch('/api/me')).rejects.toMatchObject({
        code: 'SPLERA_MCP_VERSION_TOO_OLD',
        httpStatus: 426,
      });
    });
  });
});
