#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { apiFetch, apiUrl } from './apiClient.js';
import { wrapToolHandler } from './toolRunner.js';
import { CURRENT_MCP_VERSION } from './config.js';
import { createExperimentTool } from './tools/createExperiment.js';
import { getResultsTool } from './tools/getResults.js';
import { shipWinnerTool } from './tools/shipWinner.js';

// Startup log — appears in the MCP host's "Server logs" panel. Users who
// mistype config see this line appear (or not) and know the MCP is wired
// up correctly before the first tool call.
console.error(`splera-mcp: connecting to ${apiUrl}`);

// Install verification with a 5s timeout. Slow networks should not hang
// the MCP host — hosts typically kill a server that doesn't respond in ~10s.
// On timeout or network error: soft-fail (warn + continue). The first real
// tool call will re-surface the error with full context. On 401: hard-fail
// with regenerate guidance.
const VERIFY_TIMEOUT_MS = 5_000;
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
  const me = await apiFetch<{ user: { email: string } }>('/api/me', {
    signal: ctrl.signal,
  });
  clearTimeout(t);
  console.error(`splera-mcp: ready. 3 tools loaded. User: ${me.user.email}`);
} catch (err) {
  const msg = (err as Error).message ?? String(err);
  const code = (err as { code?: string }).code ?? '';
  if (code === 'SPLERA_INVALID_API_KEY') {
    console.error(
      'splera-mcp: API key rejected (401).\n' +
        'Regenerate at https://splera.app/settings or verify with:\n' +
        '  curl -H "Authorization: Bearer $SPLERA_API_KEY" https://splera.app/api/me'
    );
    process.exit(1);
  }
  console.error(
    `splera-mcp: startup verification skipped (${msg}). Will retry on first tool call.`
  );
}

const tools = [createExperimentTool, getResultsTool, shipWinnerTool];

const server = new Server(
  { name: 'splera-mcp', version: CURRENT_MCP_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `SPLERA_UNKNOWN_TOOL: ${req.params.name}\n\nHint: Expected one of: create_experiment, get_results, ship_winner.`,
        },
      ],
    };
  }
  return wrapToolHandler(tool, req.params.arguments ?? {});
});

await server.connect(new StdioServerTransport());
