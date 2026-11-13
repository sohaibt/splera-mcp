import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiFetch, apiUrl } from '../apiClient.js';
import { buildInstallSnippet } from '../installSnippet.js';
import type { ExperimentRow, Tool } from '../types.js';

/**
 * MCP tool: `create_experiment`.
 *
 * Thin translator between MCP tool-call args and `POST /api/experiments/create`.
 * The API route does NOT auto-generate variant IDs — it takes whatever the
 * caller sends — so this handler slugifies variant IDs the same way the web
 * dashboard does (`control`, `variant_b`, `variant_c`, ...) before POSTing.
 * Agents rely on those IDs in the JSON block to call `ship_winner` later.
 *
 * Error handling: `apiFetch` throws `SpleraError` on non-2xx. We let it
 * propagate; `toolRunner.ts#wrapToolHandler` converts it into the error
 * content array. Never catch here — would swallow the SPLERA_* code.
 */

interface VariantInput {
  name: string;
}

interface MetricInput {
  name: string;
  event_name: string;
  type?: 'conversion';
  goal?: 'increase' | 'decrease';
  is_primary?: boolean;
}

interface CreateExperimentArgs {
  name: string;
  hypothesis: string;
  variants: VariantInput[];
  metrics: MetricInput[];
  decision_mode?: 'quick_decision' | 'rigorous' | 'bandit';
  platform?: 'replit' | 'lovable' | 'bolt' | 'claude_design' | 'other';
}

/**
 * Mirror of `packages/web/src/pages/experiments/lib/createExperiment.ts#variantId`.
 * Duplicated rather than imported because @splera/shared doesn't export it and
 * the MCP package is meant to be independently publishable — we'd rather eat
 * the 4 lines of drift risk than add a cross-package dep just for this.
 */
function variantIdForIndex(index: number): string {
  if (index === 0) return 'control';
  // 97 = 'a'; index 1 → 'b', 2 → 'c', ... maxItems=5 so 'e' is the ceiling.
  return `variant_${String.fromCharCode(97 + index)}`;
}

export const createExperimentTool: Tool = {
  name: 'create_experiment',
  description:
    'Create a new A/B test. Returns the experiment ID, variant IDs, and SDK installation instructions. ' +
    'The installation snippet in the text block is what the agent should paste into the user\'s codebase. ' +
    'Variant IDs are server-assigned slugs (control, variant_b, variant_c, ...) — use those (not the variant names) ' +
    'when calling ship_winner later.',
  inputSchema: {
    type: 'object',
    required: ['name', 'hypothesis', 'variants', 'metrics'],
    properties: {
      name: {
        type: 'string',
        minLength: 3,
        maxLength: 80,
        description: 'Short human-readable name.',
      },
      hypothesis: {
        type: 'string',
        minLength: 10,
        maxLength: 500,
        description: 'What you expect will happen and why.',
      },
      variants: {
        type: 'array',
        minItems: 2,
        maxItems: 5,
        items: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        description:
          'Control first, then 1-4 test variants. IDs are server-generated (control, variant_b, variant_c, ...).',
      },
      // NOTE: spec uses `metrics` (plural, minItems: 1) — NOT singular `metric`.
      // DX review change from design pass.
      metrics: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          required: ['name', 'event_name'],
          properties: {
            name: { type: 'string', description: 'Human-readable metric name.' },
            event_name: {
              type: 'string',
              description: "Event name the SDK will track, e.g. 'signup_completed'.",
            },
            type: { type: 'string', enum: ['conversion'], default: 'conversion' },
            goal: { type: 'string', enum: ['increase', 'decrease'], default: 'increase' },
            is_primary: {
              type: 'boolean',
              default: false,
              description: 'First metric is implicitly primary if unset.',
            },
          },
        },
        description:
          'Primary metric first. Secondary metrics track side-effects (e.g. pageviews alongside signups).',
      },
      decision_mode: {
        type: 'string',
        enum: ['quick_decision', 'rigorous', 'bandit'],
        default: 'quick_decision',
      },
      platform: {
        type: 'string',
        enum: ['replit', 'lovable', 'bolt', 'claude_design', 'other'],
        default: 'other',
      },
    },
  },
  handler: async (rawArgs: unknown): Promise<CallToolResult> => {
    const args = rawArgs as CreateExperimentArgs;

    // Build the payload the API expects. The API route reads `variants[i].id`
    // directly (no server-side slug generation) and stores the array verbatim
    // in JSONB, so we assign IDs here. First variant is implicitly control.
    const variants = args.variants.map((v, i) => ({
      id: variantIdForIndex(i),
      name: v.name,
      is_control: i === 0,
    }));

    // First metric becomes primary if none explicitly marked. Matches the web
    // path's convention — keeps /results working without extra branching.
    const hasExplicitPrimary = (args.metrics ?? []).some((m) => m.is_primary === true);
    const metrics = (args.metrics ?? []).map((m, i) => ({
      name: m.name,
      event_name: m.event_name,
      type: m.type ?? 'conversion',
      goal: m.goal ?? 'increase',
      is_primary: hasExplicitPrimary ? m.is_primary === true : i === 0,
    }));

    const body = {
      name: args.name,
      hypothesis: args.hypothesis,
      variants,
      metrics,
      platform: args.platform ?? 'other',
      decision_mode: args.decision_mode ?? 'quick_decision',
    };

    const res = await apiFetch<{ experiment: ExperimentRow }>('/api/experiments/create', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const exp = res.experiment;

    const primaryMetric = metrics.find((m) => m.is_primary) ?? metrics[0];
    const resultsUrl = `https://splera.app/experiments/${exp.id}`;

    // Human-readable text block. The install snippet is the "aha moment" —
    // agents paste it verbatim, so keep the formatting stable.
    const variantLines = variants
      .map((v) => `  ${v.id.padEnd(9)} -> "${v.name}"`)
      .join('\n');
    const text =
      `Experiment created: "${exp.name}"\n` +
      `ID: ${exp.id}\n` +
      `Variants:\n${variantLines}\n` +
      `Primary metric: ${primaryMetric.event_name} (goal: ${primaryMetric.goal})\n\n` +
      `Add this to the page (the first <script> in <head>, the second where the element renders),\n` +
      `then put each variant's UI in its branch and move Splera.track() to the moment the conversion happens:\n\n` +
      buildInstallSnippet(exp.id, variants, primaryMetric.event_name, body.decision_mode) +
      `\n\nThe SDK is permanent: keep it installed after the test ends.\n\n` +
      `View live results: ${resultsUrl}`;

    // Structured JSON block. CRITICAL: agents parse this, not the prose.
    // `apiUrl` from config isn't substituted into results_url because the
    // customer-facing dashboard is always splera.app — apiUrl may be an
    // internal/api subdomain.
    const jsonBlock = {
      experiment_id: exp.id,
      variants: variants.map((v) => ({
        id: v.id,
        name: v.name,
        is_control: v.is_control,
      })),
      primary_metric: {
        name: primaryMetric.name,
        event_name: primaryMetric.event_name,
        goal: primaryMetric.goal,
      },
      sdk_script_url: 'https://splera.app/sdk/splera.js',
      install_snippet: buildInstallSnippet(exp.id, variants, primaryMetric.event_name, body.decision_mode),
      results_url: resultsUrl,
      api_url: apiUrl,
    };

    return {
      content: [
        { type: 'text', text },
        {
          type: 'resource',
          resource: {
            uri: `splera://experiment/${exp.id}`,
            mimeType: 'application/json',
            text: JSON.stringify(jsonBlock),
          },
        },
      ],
    };
  },
};
