/**
 * Env var parsing + validation. Loaded once at startup.
 *
 * Fails fast (process.exit(1)) on missing or malformed env vars so the
 * user learns the problem in the MCP host's server-logs panel instead of
 * getting a 30-second stuck agent or silent auth failures downstream.
 */

export interface Config {
  apiKey: string;
  apiUrl: string;
}

export function loadConfig(): Config {
  const apiKey = process.env.SPLERA_API_KEY;
  if (!apiKey) {
    console.error(
      'splera-mcp: SPLERA_API_KEY not set.\n' +
        'Generate a key at https://splera.app/settings.\n' +
        'Your MCP config env block should look like:\n' +
        '  { "splera": { "command": "npx", "args": ["-y", "splera-mcp@latest"], ' +
        '"env": { "SPLERA_API_KEY": "splera_live_..." } } }'
    );
    process.exit(1);
  }

  const rawUrl = process.env.SPLERA_API_URL ?? 'https://splera.app';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error(`splera-mcp: SPLERA_API_URL is not a valid URL: "${rawUrl}"`);
    process.exit(1);
  }

  const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    console.error(
      `splera-mcp: SPLERA_API_URL must use https:// (got "${parsed.protocol}").\n` +
        'Plain http is only allowed for localhost/127.0.0.1 (local dev).'
    );
    process.exit(1);
  }

  return { apiKey, apiUrl: parsed.origin };
}

/**
 * Semver comparison used by the X-Splera-MCP-Min-Version guard in apiClient.
 * Returns true if `current` is strictly less than `minimum`.
 * Both args are expected to be plain dotted triples (e.g. "0.1.0", "1.2.3").
 * Pre-release / build metadata is NOT supported — we don't ship those for MCP.
 */
export function isBelow(current: string, minimum: string): boolean {
  const a = current.split('.').map((n) => parseInt(n, 10));
  const b = minimum.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}

export const CURRENT_MCP_VERSION = '0.1.3';
