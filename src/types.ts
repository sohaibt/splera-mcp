/**
 * Shared types for tool handlers + core modules.
 */

import type {
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Input schema shape — plain JSON Schema that MCP passes to the client.
 * We keep it loose (Record<string, unknown>) because the MCP SDK doesn't
 * enforce a TypeScript type over it; the validation happens at call time
 * via the input schema the tool declares.
 */
export type JsonSchema = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * Handler receives the arguments object (already parsed from JSON by the
   * MCP SDK). It returns a full CallToolResult — text + structured resource
   * content blocks — OR throws. Throws are caught by wrapToolHandler() which
   * converts them to SPLERA_* error content blocks.
   */
  handler: (args: unknown) => Promise<CallToolResult>;
}

// Per-route API response shapes live inside each tool handler when they
// diverge from the spec (see `ApiResultsResponse` in tools/getResults.ts).
// Types exported here are the ones shared across multiple handlers or that
// match the API shape verbatim.

/**
 * Shape returned by `POST /api/experiments/create` → `{ experiment: ExperimentRow }`
 * and by `POST /api/experiments/:id/ship` → `{ experiment: ExperimentRow }`.
 * Matches the DB row. Only the fields tool handlers actually read are typed;
 * the API returns more.
 */
export interface ExperimentRow {
  id: string;
  name: string;
  hypothesis: string;
  variants: Array<{ id: string; name: string; is_control?: boolean }>;
  metrics: Array<{
    name: string;
    event_name: string;
    type?: string;
    goal?: 'increase' | 'decrease';
    is_primary?: boolean;
  }>;
  status: string;
  decision_mode: string;
  platform: string;
  winning_variant_id?: string | null;
  shipped_at?: string | null;
  guard_window_days?: number | null;
  created_at: string;
}

/**
 * Adapted from ExperimentRow by shipWinner.ts — it takes the ship-route's
 * `{ experiment: ExperimentRow }` response and derives `guard_window_ends_at`
 * from `shipped_at + guard_window_days`, since the API returns the pieces
 * but not the pre-computed end timestamp.
 */
export interface ShipResponse {
  winning_variant_id: string;
  shipped_at: string;
  guard_window_ends_at: string;
}
