import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiFetch } from '../apiClient.js';
import type { Tool } from '../types.js';

/**
 * MCP tool: `get_results`.
 *
 * Calls `GET /api/experiments/:id/results` and renders a human-readable text
 * block + a structured JSON block. The API's response shape differs from the
 * spec's JSON example in several ways — see `ApiResultsResponse` below for
 * the real shape. We adapt it into the canonical shape in the JSON block so
 * agents don't have to learn two vocabularies.
 *
 * The API does NOT currently return `next_check_recommended_at`. We compute
 * it locally off `ship_readiness` per the spec. Deliberately coarse — not
 * traffic-rate aware — because the agent's caller is a human-in-loop;
 * over-engineering the cadence signal has no payoff in v1.
 */

interface GetResultsArgs {
  experiment_id: string;
}

/**
 * Actual response shape from `/api/experiments/:id/results`, derived by
 * reading `packages/api/src/routes/experiment-results.ts`.
 *
 * Spec drift from `docs/.../splera-mcp-design.md`:
 *   - variant keys are `variant_id`/`variant_name`/`conversion_rate` (not `id`/`name`/`rate`)
 *   - no `name` (experiment name) — the route omits it; we fall back to `"Experiment <short-id>"`
 *   - no `ship_readiness` — we compute it locally via the same thresholds getShipReadiness uses
 *   - guard window key is `guardWindow` (camelCase), not `guard_window`
 *   - guard window `status` is `'ok' | 'degraded' | 'not_enough_data'` (no explicit `'expired'` —
 *     the route stops emitting the block once the window lapses, so expiry is implied by absence)
 *   - `probability_of_being_best` on each variant stands in for the leader's
 *     `probability_leader_is_best` — we re-project it.
 * These would be nice to converge on the spec eventually; v1 just adapts.
 */
interface ApiVariantStats {
  variant_id: string;
  variant_name: string;
  is_control: boolean;
  exposures: number;
  conversions: number;
  conversion_rate: number;
  probability_of_being_best: number;
}

interface ApiGuardWindow {
  preShipBaselineRate: number;
  livePostShipRate: number;
  livePostShipExposures: number;
  livePostShipConversions: number;
  deltaPct: number;
  thresholdPct: number;
  status: 'ok' | 'degraded' | 'not_enough_data';
  guardWindowEndsAt: string;
  daysRemaining: number;
}

interface ApiResultsResponse {
  experiment_id: string;
  status: 'running' | 'paused' | 'concluded';
  decision_mode: 'quick_decision' | 'rigorous' | 'bandit';
  variants: ApiVariantStats[];
  leading_variant_id: string;
  confidence_level: 'low' | 'medium' | 'high';
  confidence_percentage: number;
  relative_improvement: number;
  sample_size_needed_for_high_confidence: number | null;
  recommendation?: string;
  guardWindow?: ApiGuardWindow;
}

// SHIP_THRESHOLDS duplicated from @splera/shared — same reason as variantId in
// createExperiment.ts: keep MCP independently publishable. Drift risk is low
// (the thresholds are stable product decisions, not implementation details).
const SHIP_THRESHOLDS = {
  quick_decision: { minExposuresPerVariant: 50, minConfidencePct: 80 },
  rigorous: { minExposuresPerVariant: 200, minConfidencePct: 90 },
  bandit: { minExposuresPerVariant: 30, minConfidencePct: 85 },
} as const;

type ShipReadinessState = 'ready' | 'not_ready' | 'locked' | 'post_ship';

function computeShipReadiness(res: ApiResultsResponse): {
  state: ShipReadinessState;
  reason: string;
  sub: 'below_confidence' | 'below_min_exposures' | null;
} {
  // Post-ship takes precedence regardless of confidence — the decision is made.
  if (res.status === 'concluded') {
    return {
      state: 'post_ship',
      reason: 'Experiment already shipped. Monitor the guard window.',
      sub: null,
    };
  }

  const thresholds =
    SHIP_THRESHOLDS[res.decision_mode] ?? SHIP_THRESHOLDS.quick_decision;
  const minExposures =
    res.variants.length > 0
      ? Math.min(...res.variants.map((v) => v.exposures))
      : 0;
  const sampleMet = minExposures >= thresholds.minExposuresPerVariant;
  const confidenceMet = res.confidence_percentage >= thresholds.minConfidencePct;

  if (!sampleMet) {
    return {
      state: 'not_ready',
      reason: `need ${thresholds.minExposuresPerVariant} exposures per variant, have min ${minExposures}`,
      sub: 'below_min_exposures',
    };
  }
  if (!confidenceMet) {
    return {
      state: 'not_ready',
      reason: `below ${thresholds.minConfidencePct}% confidence threshold (currently ${res.confidence_percentage.toFixed(0)}%)`,
      sub: 'below_confidence',
    };
  }
  return {
    state: 'ready',
    reason: `threshold met: ${thresholds.minConfidencePct}% confidence, ${thresholds.minExposuresPerVariant} exposures/variant`,
    sub: null,
  };
}

/**
 * Compute the recommended next-check timestamp. Intentionally coarse:
 *   - ready     -> null (user should act, not wait)
 *   - below confidence     -> ~6h  (waiting for statistical separation)
 *   - below min exposures  -> ~4h  (waiting for more traffic)
 *   - post_ship            -> ~24h (guard-window cadence)
 */
function computeNextCheckAt(
  state: ShipReadinessState,
  sub: 'below_confidence' | 'below_min_exposures' | null
): string | null {
  const now = Date.now();
  const HOURS = 60 * 60 * 1000;
  switch (state) {
    case 'ready':
      return null;
    case 'post_ship':
      return new Date(now + 24 * HOURS).toISOString();
    case 'not_ready':
      if (sub === 'below_confidence') return new Date(now + 6 * HOURS).toISOString();
      if (sub === 'below_min_exposures') return new Date(now + 4 * HOURS).toISOString();
      return new Date(now + 6 * HOURS).toISOString();
    case 'locked':
      return new Date(now + 4 * HOURS).toISOString();
  }
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export const getResultsTool: Tool = {
  name: 'get_results',
  description:
    'Get current results for an experiment — variant stats, leader, ship-readiness, and any guard-window alerts. ' +
    'Use this to check if an experiment is ready to ship. Safe to call once per minute during active experiments. ' +
    'For long-horizon monitoring, direct the user to https://splera.ai/experiments/:id.',
  inputSchema: {
    type: 'object',
    required: ['experiment_id'],
    properties: {
      experiment_id: {
        type: 'string',
        description: 'UUID returned by create_experiment.',
      },
    },
  },
  handler: async (rawArgs: unknown): Promise<CallToolResult> => {
    const args = rawArgs as GetResultsArgs;
    const res = await apiFetch<ApiResultsResponse>(
      `/api/experiments/${args.experiment_id}/results`
    );

    const readiness = computeShipReadiness(res);
    const nextCheckAt = computeNextCheckAt(readiness.state, readiness.sub);
    const leader = res.variants.find((v) => v.variant_id === res.leading_variant_id);
    const resultsUrl = `https://splera.ai/experiments/${res.experiment_id}`;

    // Short-id fallback since the API doesn't echo the experiment name back.
    const experimentDisplayName = `Experiment ${res.experiment_id.slice(0, 8)}`;

    // ── Build text output, shape varies by readiness state ─────────────────
    let text: string;
    if (readiness.state === 'post_ship' && res.guardWindow) {
      const gw = res.guardWindow;
      const dropPct = Math.abs(gw.deltaPct * 100).toFixed(1);
      text =
        `${experimentDisplayName}\n` +
        `Status: concluded (guard window active)\n` +
        `Winning variant: ${res.leading_variant_id}\n\n` +
        `Guard window: ${gw.status.toUpperCase()}  (${gw.daysRemaining} days remaining, ` +
        `winner at ${fmtPct(gw.livePostShipRate)} CR vs ${fmtPct(gw.preShipBaselineRate)} baseline, ` +
        `${dropPct}% ${gw.deltaPct < 0 ? 'drop' : 'lift'})\n\n` +
        `Recommendation: Continue monitoring. If the live rate drops more than ` +
        `${(gw.thresholdPct * 100).toFixed(0)}% below the frozen baseline, a rollback alert will fire ` +
        `to your email.\nRollback is available at ${resultsUrl} (dashboard only).\n\n` +
        `Next check recommended after: ${nextCheckAt} (~24 hours)`;
    } else {
      const variantLines = res.variants
        .map((v) => {
          const badge = v.variant_id === res.leading_variant_id ? '   <- leading' : '';
          return (
            `  ${v.variant_id.padEnd(10)} ("${v.variant_name}"): ` +
            `${fmtInt(v.exposures).padStart(6)} exposures  ` +
            `${fmtInt(v.conversions).padStart(4)} conv  ` +
            `${fmtPct(v.conversion_rate).padStart(5)} CR${badge}`
          );
        })
        .join('\n');

      const readinessLabel =
        readiness.state === 'ready' ? 'READY' : 'NOT_READY';
      const leaderProbPct =
        leader?.probability_of_being_best != null
          ? (leader.probability_of_being_best * 100).toFixed(0)
          : res.confidence_percentage.toFixed(0);
      const recommendation =
        readiness.state === 'ready' && leader
          ? `Ship ${leader.variant_id} now. Call ship_winner with winning_variant_id="${leader.variant_id}".`
          : 'Keep running. Do not call ship_winner yet.';
      const nextCheckLine =
        nextCheckAt == null
          ? 'Next check recommended after: (N/A - ready to ship)'
          : `Next check recommended after: ${nextCheckAt}`;

      text =
        `${experimentDisplayName}\n` +
        `Status: ${res.status}\n` +
        `Decision mode: ${res.decision_mode}\n\n` +
        `Variants:\n${variantLines}\n\n` +
        `Probability leader is best: ${leaderProbPct}%\n` +
        `Ship readiness: ${readinessLabel}  (${readiness.reason})\n` +
        (res.recommendation ? `Reason: ${res.recommendation}\n` : '') +
        `Recommendation: ${recommendation}\n\n` +
        nextCheckLine;
    }

    // ── JSON block: canonical shape per spec (adapts API's field names) ────
    const jsonBlock = {
      experiment_id: res.experiment_id,
      status: res.status,
      decision_mode: res.decision_mode,
      variants: res.variants.map((v) => ({
        id: v.variant_id,
        name: v.variant_name,
        is_control: v.is_control,
        exposures: v.exposures,
        conversions: v.conversions,
        rate: v.conversion_rate,
        probability_best: v.probability_of_being_best,
        is_leading: v.variant_id === res.leading_variant_id,
      })),
      leading_variant_id: res.leading_variant_id ?? null,
      probability_leader_is_best:
        leader?.probability_of_being_best ?? res.confidence_percentage / 100,
      confidence_percentage: res.confidence_percentage,
      ship_readiness: readiness.state,
      ship_readiness_reason: readiness.reason,
      next_check_recommended_at: nextCheckAt,
      guard_window: res.guardWindow
        ? {
            status: res.guardWindow.status,
            days_remaining: res.guardWindow.daysRemaining,
            baseline_rate: res.guardWindow.preShipBaselineRate,
            live_rate: res.guardWindow.livePostShipRate,
            delta_pct: res.guardWindow.deltaPct,
            threshold_pct: res.guardWindow.thresholdPct,
            ends_at: res.guardWindow.guardWindowEndsAt,
          }
        : null,
      results_url: resultsUrl,
    };

    return {
      content: [
        { type: 'text', text },
        {
          type: 'resource',
          resource: {
            uri: `splera://experiment/${res.experiment_id}/results`,
            mimeType: 'application/json',
            text: JSON.stringify(jsonBlock),
          },
        },
      ],
    };
  },
};
