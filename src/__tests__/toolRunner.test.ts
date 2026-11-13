import { describe, it, expect, beforeEach, vi } from 'vitest';
import { wrapToolHandler } from '../toolRunner.js';
import { SpleraError } from '../errors.js';
import type { Tool } from '../types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Helper — construct a minimal Tool with a handler we control per test.
 * The handler type says "unknown" in, CallToolResult out. We pass in
 * noop args via the wrapper.
 */
function makeTool(
  handler: (args: unknown) => Promise<CallToolResult>
): Tool {
  return {
    name: 'test_tool',
    description: 'Test tool for unit tests',
    inputSchema: { type: 'object', properties: {} },
    handler,
  };
}

// Narrowed content-block accessors. wrapToolHandler builds a fixed shape:
//   content[0] → { type: 'text', text: string }
//   content[1] → { type: 'resource', resource: { uri, mimeType, text } }
// We cast via unknown because the MCP SDK's content union is too loose to
// consume inline without discriminated-union gymnastics in every assertion.
function textBlock(result: CallToolResult): string {
  const block = result.content[0] as unknown as { type: string; text: string };
  expect(block.type).toBe('text');
  return block.text;
}

function resourceJSON(result: CallToolResult): {
  code: string;
  message: string;
  hint: string;
  status: number | null;
} {
  const block = result.content[1] as unknown as {
    type: string;
    resource: { uri: string; mimeType: string; text: string };
  };
  expect(block.type).toBe('resource');
  expect(block.resource.mimeType).toBe('application/json');
  return JSON.parse(block.resource.text);
}

describe('wrapToolHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path — handler returns a result', () => {
    it('returns the handler result unchanged when no error is thrown', async () => {
      const expected: CallToolResult = {
        content: [{ type: 'text', text: 'ok' }],
      };
      const tool = makeTool(async () => expected);

      const result = await wrapToolHandler(tool, {});
      expect(result).toBe(expected);
      expect(result.isError).toBeUndefined();
    });
  });

  describe('SpleraError → passed through verbatim', () => {
    it('preserves the code + message + hint + status from a thrown SpleraError', async () => {
      const tool = makeTool(async () => {
        throw new SpleraError(
          'SPLERA_PLAN_LIMIT_EXCEEDED',
          'Plan cap reached: 3/3 experiments',
          'Upgrade at https://splera.app/pricing',
          402
        );
      });

      const result = await wrapToolHandler(tool, {});

      expect(result.isError).toBe(true);
      const text = textBlock(result);
      expect(text).toContain('SPLERA_PLAN_LIMIT_EXCEEDED');
      expect(text).toContain('Plan cap reached: 3/3 experiments');
      expect(text).toContain('Upgrade at https://splera.app/pricing');

      const json = resourceJSON(result);
      expect(json).toEqual({
        code: 'SPLERA_PLAN_LIMIT_EXCEEDED',
        message: 'Plan cap reached: 3/3 experiments',
        hint: 'Upgrade at https://splera.app/pricing',
        status: 402,
      });
    });

    it('resource URI encodes the SPLERA_* code', async () => {
      const tool = makeTool(async () => {
        throw new SpleraError(
          'SPLERA_EXPERIMENT_NOT_FOUND',
          'not found',
          'Confirm UUID',
          404
        );
      });

      const result = await wrapToolHandler(tool, {});
      const block = result.content[1] as unknown as {
        resource: { uri: string };
      };
      expect(block.resource.uri).toBe(
        'splera-error://SPLERA_EXPERIMENT_NOT_FOUND'
      );
    });

    it('sets status: null in the resource JSON when SpleraError has no httpStatus', async () => {
      const tool = makeTool(async () => {
        throw new SpleraError('SPLERA_HTTP_ERROR', 'boom', 'retry');
      });

      const result = await wrapToolHandler(tool, {});
      const json = resourceJSON(result);
      expect(json.status).toBeNull();
    });
  });

  describe('generic Error → wrapped as SPLERA_HTTP_ERROR', () => {
    it('wraps a raw Error with SPLERA_HTTP_ERROR code + generic retry hint', async () => {
      const tool = makeTool(async () => {
        throw new Error('network timeout');
      });

      const result = await wrapToolHandler(tool, {});

      expect(result.isError).toBe(true);
      const text = textBlock(result);
      expect(text).toContain('SPLERA_HTTP_ERROR');
      expect(text).toContain('network timeout');

      const json = resourceJSON(result);
      expect(json.code).toBe('SPLERA_HTTP_ERROR');
      expect(json.message).toBe('network timeout');
      expect(json.hint).toMatch(/retry/i);
    });
  });

  describe('non-Error throw (string / object) → wrapped as SPLERA_HTTP_ERROR', () => {
    it('converts a thrown string into SPLERA_HTTP_ERROR', async () => {
      const tool = makeTool(async () => {
        // Intentional throw of a non-Error value to exercise the String() path.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string failure';
      });

      const result = await wrapToolHandler(tool, {});
      expect(result.isError).toBe(true);

      const json = resourceJSON(result);
      expect(json.code).toBe('SPLERA_HTTP_ERROR');
      expect(json.message).toBe('plain string failure');
    });

    it('converts a thrown object into SPLERA_HTTP_ERROR using String() coercion', async () => {
      const tool = makeTool(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { weird: 'object' };
      });

      const result = await wrapToolHandler(tool, {});
      expect(result.isError).toBe(true);

      const json = resourceJSON(result);
      expect(json.code).toBe('SPLERA_HTTP_ERROR');
      // String({...}) → "[object Object]"
      expect(json.message).toBe('[object Object]');
    });

    it('handles thrown null gracefully', async () => {
      const tool = makeTool(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw null;
      });

      const result = await wrapToolHandler(tool, {});
      expect(result.isError).toBe(true);

      const json = resourceJSON(result);
      expect(json.code).toBe('SPLERA_HTTP_ERROR');
      expect(json.message).toBe('null');
    });
  });

  describe('stack trace containment — correctness contract', () => {
    it('does NOT leak the stack trace in the text content block', async () => {
      // Throw an Error whose .stack contains the standard "at " prefixes
      // plus a filename. If wrapToolHandler ever swaps err.message → err.stack
      // (common regression), these assertions catch it.
      const tool = makeTool(async () => {
        throw new Error('synthetic failure');
      });

      const result = await wrapToolHandler(tool, {});
      const text = textBlock(result);

      // No stack frames. Node's stack format uses "    at functionName (file:line:col)".
      expect(text).not.toMatch(/\n\s+at\s/);
      // No absolute paths leaking internal file structure.
      expect(text).not.toContain('/packages/mcp/');
      // The raw "Error: message" repr (as produced by err.stack's first line)
      // should not appear — we only use err.message, not err.toString().
      expect(text).not.toMatch(/^Error:\s/m);
    });

    it('does NOT leak the stack trace in the resource JSON block', async () => {
      const tool = makeTool(async () => {
        throw new Error('another synthetic failure');
      });

      const result = await wrapToolHandler(tool, {});
      const block = result.content[1] as unknown as {
        resource: { text: string };
      };
      const raw = block.resource.text;

      expect(raw).not.toMatch(/\n\s+at\s/);
      expect(raw).not.toContain('/packages/mcp/');
      expect(raw).not.toContain('.ts:');
    });

    it('does NOT expose a .stack key on the resource JSON payload', async () => {
      const tool = makeTool(async () => {
        throw new Error('stack-key check');
      });

      const result = await wrapToolHandler(tool, {});
      const json = resourceJSON(result);

      // The payload shape is {code, message, hint, status} — nothing else.
      expect(Object.keys(json).sort()).toEqual(['code', 'hint', 'message', 'status']);
    });
  });

  describe('handler receives the args argument', () => {
    it('passes through args untouched to the handler', async () => {
      const spy = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'noop' }],
      } satisfies CallToolResult);
      const tool = makeTool(spy);

      await wrapToolHandler(tool, { hypothesis: 'test', variants: ['a', 'b'] });

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith({
        hypothesis: 'test',
        variants: ['a', 'b'],
      });
    });
  });
});
