/**
 * The install snippet create_experiment hands the agent. MUST match the web
 * dashboard's `buildScriptTag` (packages/web/src/pages/experiments/lib/
 * installPrompts.ts) — the SDK reads `data-experiment` + `data-api-url` from
 * the tag and `getVariant(id, variantIds)` returns the variant synchronously.
 * 0.1.1 shipped a callback form + no data-api-url, so nothing was tracked.
 * Guarded by __tests__/installSnippet.test.ts.
 */
const SDK_URL = 'https://splera.app/sdk/splera.js';
const API_URL = 'https://splera.app';

// Same rule as the web builder (Codex #23): code literals JSON-encoded, prose one line.
const inline = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

export function buildInstallSnippet(
  experimentId: string,
  variants: { id: string; name: string }[],
  primaryEventName: string,
  decisionMode: string,
): string {
  const branches = variants
    .map((v, i) => {
      const keyword = i === 0 ? 'if' : '} else if';
      return `  ${keyword} (variant === ${JSON.stringify(v.id)}) {\n    // Show ${inline(v.name)}`;
    })
    .join('\n');

  return `<script src="${SDK_URL}"
        data-experiment="${experimentId}"
        data-api-url="${API_URL}"${decisionMode === 'bandit' ? '\n        data-decision-mode="bandit"' : ''}></script>

<script>
  const variant = Splera.getVariant("${experimentId}", ${JSON.stringify(variants.map((v) => v.id))});
${branches}
  }

  // Call this when the conversion event happens:
  Splera.track(${JSON.stringify(primaryEventName)});
</script>`;
}
