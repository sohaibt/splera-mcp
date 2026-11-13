/**
 * SPLERA_* error taxonomy + HTTP-status-to-code mapping.
 *
 * All agent-facing errors MUST go through here so they land on the agent
 * with a consistent, namespaced prefix. No raw HTTP codes, no generic
 * "internal server error" strings. The agent will surface `hint` to the
 * end user verbatim.
 */

export class SpleraError extends Error {
  code: string;
  hint: string;
  httpStatus?: number;

  constructor(code: string, message: string, hint: string, httpStatus?: number) {
    super(message);
    this.name = 'SpleraError';
    this.code = code;
    this.hint = hint;
    this.httpStatus = httpStatus;
  }
}

/**
 * User-facing hints per SPLERA_* code. Agents relay these verbatim.
 * Keep them actionable — every hint ends in a thing the user can DO.
 */
export const HINTS: Record<string, string> = {
  SPLERA_API_KEY_MISSING:
    'Set SPLERA_API_KEY in the env block of your MCP config (generate a key at https://splera.ai/settings), then restart your agent.',
  SPLERA_INVALID_API_KEY:
    'Check SPLERA_API_KEY or regenerate at https://splera.ai/settings.',
  SPLERA_PLAN_LIMIT_EXCEEDED:
    'Upgrade at https://splera.ai/pricing, or ship/stop an existing experiment to free a slot.',
  SPLERA_DOMAIN_NOT_ALLOWED:
    'This experiment is locked to specific domains. Add the requesting origin at the experiment\'s /settings.',
  SPLERA_EXPERIMENT_NOT_FOUND:
    'Experiment not found — it may have been deleted. Confirm the UUID from create_experiment.',
  SPLERA_VALIDATION_ERROR:
    'Check the tool input — see server message for details.',
  SPLERA_MCP_VERSION_TOO_OLD:
    'splera-mcp client is below the minimum supported version. Run: npm update -g splera-mcp',
  SPLERA_HTTP_ERROR:
    'Transient Splera API error. Retry in a moment, or check https://splera.ai for status.',
  SPLERA_UNKNOWN_TOOL:
    'Unknown tool name. Expected one of: create_experiment, get_results, ship_winner.',
  SPLERA_JWT_REQUIRED:
    'This action requires a browser session, not an API key. Sign in at https://splera.ai/settings.',
};

/**
 * Maps an HTTP status (+ optional server-returned code) to a SPLERA_* code
 * and its hint. If the server already returned a SPLERA_* code we trust it;
 * otherwise we fall back to the status-based mapping.
 */
export function httpStatusToSpleraCode(
  status: number,
  serverCode?: string
): { code: string; hint: string } {
  if (serverCode && serverCode.startsWith('SPLERA_') && HINTS[serverCode]) {
    return { code: serverCode, hint: HINTS[serverCode] };
  }

  switch (status) {
    case 401:
      return { code: 'SPLERA_INVALID_API_KEY', hint: HINTS.SPLERA_INVALID_API_KEY };
    case 402:
      return { code: 'SPLERA_PLAN_LIMIT_EXCEEDED', hint: HINTS.SPLERA_PLAN_LIMIT_EXCEEDED };
    case 403:
      return { code: 'SPLERA_DOMAIN_NOT_ALLOWED', hint: HINTS.SPLERA_DOMAIN_NOT_ALLOWED };
    case 404:
      return { code: 'SPLERA_EXPERIMENT_NOT_FOUND', hint: HINTS.SPLERA_EXPERIMENT_NOT_FOUND };
    case 422:
      return { code: 'SPLERA_VALIDATION_ERROR', hint: HINTS.SPLERA_VALIDATION_ERROR };
    case 426:
      return { code: 'SPLERA_MCP_VERSION_TOO_OLD', hint: HINTS.SPLERA_MCP_VERSION_TOO_OLD };
    default:
      return { code: 'SPLERA_HTTP_ERROR', hint: HINTS.SPLERA_HTTP_ERROR };
  }
}
