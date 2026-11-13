import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiFetch } from '../apiClient.js';
import type { ExperimentRow, ShipResponse, Tool } from '../types.js';

/**
 * MCP tool: `ship_winner`.
 *
 * Thin wrapper over `POST /api/experiments/:id/ship`. The API route returns
 * the updated experiment row ({ experiment: ExperimentRow }) — we flatten it
 * into the spec's `ShipResponse` shape (winning_variant_id, shipped_at,
 * guard_window_ends_at) for the JSON block.
 *
 * Rollback is deliberately NOT exposed via MCP in v1 — too destructive to
 * trigger without a human. Users click the dashboard link in the text block.
 */

interface ShipWinnerArgs {
  experiment_id: string;
  winning_variant_id: string;
}

/**
 * Actual API response shape from `packages/api/src/routes/ship-experiment.ts`:
 * returns `{ experiment: <full experiment row> }` after the conditional UPDATE.
 * We pluck the fields the tool surfaces — the row has everything else too,
 * but it's cheaper for the agent to read a 3-field JSON block than the 20
 * columns the DB returns.
 */
interface ShipApiResponse {
  experiment: ExperimentRow & {
    shipped_at: string;
    guard_window_days: number;
    winning_variant_id: string;
    variants: Array<{ id: string; name: string; is_control?: boolean }>;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const shipWinnerTool: Tool = {
  name: 'ship_winner',
  description:
    'Ship the winning variant to 100% of traffic. The SDK will flip server-side within 30 seconds — no code deploy needed. ' +
    'Use after get_results confirms the experiment is ship-ready.',
  inputSchema: {
    type: 'object',
    required: ['experiment_id', 'winning_variant_id'],
    properties: {
      experiment_id: {
        type: 'string',
        description: 'UUID returned by create_experiment.',
      },
      winning_variant_id: {
        type: 'string',
        // CRITICAL wording: agents confuse the variant NAME ("Get started")
        // with the variant ID ("variant_b"). The API rejects names with a 400
        // and the error looks like our bug — so spell it out in the schema
        // description, which the agent sees on every tool-selection pass.
        description:
          "Variant ID from get_results.leading_variant_id (or variants[i].id where is_leading=true). " +
          "NOT the variant name — use the slug-style ID like 'variant_b' or 'control'.",
      },
    },
  },
  handler: async (rawArgs: unknown): Promise<CallToolResult> => {
    const args = rawArgs as ShipWinnerArgs;

    const res = await apiFetch<ShipApiResponse>(
      `/api/experiments/${args.experiment_id}/ship`,
      {
        method: 'POST',
        body: JSON.stringify({ winning_variant_id: args.winning_variant_id }),
      }
    );

    const exp = res.experiment;
    const winningVariant = exp.variants.find((v) => v.id === exp.winning_variant_id);
    const winningLabel = winningVariant
      ? `${exp.winning_variant_id} ("${winningVariant.name}")`
      : exp.winning_variant_id;

    // Derive guard_window_ends_at from shipped_at + guard_window_days.
    // The API does not return this composite directly.
    const guardWindowEndsAt = new Date(
      new Date(exp.shipped_at).getTime() + exp.guard_window_days * DAY_MS
    ).toISOString();
    const guardWindowEndsDate = guardWindowEndsAt.slice(0, 10); // YYYY-MM-DD
    const resultsUrl = `https://splera.ai/experiments/${exp.id}`;

    const text =
      `Shipped ${winningLabel} to 100% of traffic.\n` +
      `SDK will refresh within 30 seconds worldwide — no redeploy needed.\n\n` +
      `Guard window: ${exp.guard_window_days} days (until ${guardWindowEndsDate}).\n` +
      `  - Use get_results to monitor for degradation.\n` +
      `  - If the live rate drops below baseline past the alert threshold, you'll get an email alert.\n` +
      `  - Roll back in one click from the dashboard: ${resultsUrl}\n` +
      `  - On Pro, turn on auto-rollback in Settings to roll back automatically on a drop.\n\n` +
      `Keep the Splera <script> tag installed: it is how this ship (and any rollback)\n` +
      `reaches the site, and it runs future experiments.\n\n` +
      `Next step (optional): once the winner is stable, hardcode it and remove only this\n` +
      `experiment's getVariant branches and track() calls. The dashboard's Finalize step\n` +
      `walks you through it.`;

    // Flatten to the spec's ShipResponse shape in the JSON block.
    const shipResponse: ShipResponse & { results_url: string } = {
      winning_variant_id: exp.winning_variant_id,
      shipped_at: exp.shipped_at,
      guard_window_ends_at: guardWindowEndsAt,
      results_url: resultsUrl,
    };

    return {
      content: [
        { type: 'text', text },
        {
          type: 'resource',
          resource: {
            uri: `splera://experiment/${exp.id}/ship`,
            mimeType: 'application/json',
            text: JSON.stringify(shipResponse),
          },
        },
      ],
    };
  },
};
