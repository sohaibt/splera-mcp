import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SpleraError } from './errors.js';
import type { Tool } from './types.js';

/**
 * Wraps a tool handler so any thrown error — SpleraError or otherwise —
 * converts to a proper MCP content array with isError: true + SPLERA_*
 * code in the text block + structured JSON in the resource block.
 *
 * This is the ONLY path by which tool-handler errors reach the agent.
 * The guarantee: every agent-facing error has a SPLERA_* code. No leaked
 * generic JSON-RPC errors, no leaked stack traces.
 */
export async function wrapToolHandler(
  tool: Tool,
  args: unknown
): Promise<CallToolResult> {
  try {
    return await tool.handler(args);
  } catch (err) {
    const sp = toSpleraError(err);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${sp.code}: ${sp.message}\n\nHint: ${sp.hint}`,
        },
        {
          type: 'resource',
          resource: {
            uri: `splera-error://${sp.code}`,
            mimeType: 'application/json',
            text: JSON.stringify({
              code: sp.code,
              message: sp.message,
              hint: sp.hint,
              status: sp.httpStatus ?? null,
            }),
          },
        },
      ],
    };
  }
}

function toSpleraError(err: unknown): SpleraError {
  if (err instanceof SpleraError) return err;
  if (err instanceof Error) {
    return new SpleraError(
      'SPLERA_HTTP_ERROR',
      err.message,
      'Unexpected error. Check Splera API status or retry in a moment.'
    );
  }
  return new SpleraError(
    'SPLERA_HTTP_ERROR',
    String(err),
    'Unexpected error. Check Splera API status or retry in a moment.'
  );
}
