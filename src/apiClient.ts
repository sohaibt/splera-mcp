import { loadConfig, isBelow, CURRENT_MCP_VERSION } from './config.js';
import { SpleraError, httpStatusToSpleraCode, HINTS } from './errors.js';

const { apiKey, apiUrl } = loadConfig();

/**
 * HTTPS fetch wrapper.
 *
 * Responsibilities:
 *   1. Adds Authorization: Bearer <key> header automatically.
 *   2. Honors X-Splera-MCP-Min-Version header — if the server tells us
 *      we're below the minimum supported client, we throw a clean
 *      SpleraError with the upgrade hint instead of a confusing schema error.
 *   3. Converts non-2xx responses into SpleraError with a SPLERA_* code
 *      so tool handlers never see raw HTTP failures.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Splera-MCP-Version': CURRENT_MCP_VERSION,
      ...init.headers,
    },
  });

  // Version-skew guard. Runs BEFORE the ok check — server might still
  // return 2xx with the header as a soft warning ("you'll break on next
  // breaking change"), and the agent should surface that anyway.
  const minVersion = res.headers.get('X-Splera-MCP-Min-Version');
  if (minVersion && isBelow(CURRENT_MCP_VERSION, minVersion)) {
    throw new SpleraError(
      'SPLERA_MCP_VERSION_TOO_OLD',
      `splera-mcp ${CURRENT_MCP_VERSION} is below minimum supported version ${minVersion}.`,
      HINTS.SPLERA_MCP_VERSION_TOO_OLD,
      426
    );
  }

  if (!res.ok) {
    const body = (await res
      .json()
      .catch(() => ({}))) as { error?: string; code?: string; hint?: string };
    const { code, hint } = httpStatusToSpleraCode(res.status, body.code);
    throw new SpleraError(
      code,
      body.error ?? res.statusText,
      body.hint ?? hint,
      res.status
    );
  }

  return (await res.json()) as T;
}

// Re-export config values so index.ts + tools can reference them for
// startup logging and URL construction (e.g. results_url) without
// re-reading the env.
export { apiUrl };
