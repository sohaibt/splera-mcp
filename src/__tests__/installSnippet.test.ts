import { describe, it, expect } from 'vitest';
import { buildInstallSnippet } from '../installSnippet.js';
// The web dashboard's snippet is the proven one; the MCP must hand out the same code.
import { buildScriptTag } from '../../../web/src/pages/experiments/lib/installPrompts.js';

const variants = [
  { id: 'control', name: 'Blue "button"', is_control: true },
  { id: 'variant_b', name: 'Green\nbutton', is_control: false },
  { id: 'variant_c', name: 'Red', is_control: false },
];

describe('buildInstallSnippet', () => {
  for (const mode of ['quick_decision', 'bandit'] as const) {
    it(`matches the web dashboard snippet byte for byte (${mode})`, () => {
      const exp = {
        id: 'f02c0eea-a7cd-4016-97bc-646f93cb07ea',
        variants,
        metrics: [{ name: 'CTA', event_name: 'cta_clicked', type: 'conversion', goal: 'increase', is_primary: true }],
        decision_mode: mode,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(buildInstallSnippet(exp.id, variants, 'cta_clicked', mode)).toBe(buildScriptTag(exp as any));
    });
  }

  it('wires the tag + sync getVariant the SDK actually reads (0.1.1 regression)', () => {
    const s = buildInstallSnippet('exp-1', variants, 'cta_clicked', 'bandit');
    expect(s).toContain('data-experiment="exp-1"');
    expect(s).toContain('data-api-url="https://splera.app"');
    expect(s).toContain('data-decision-mode="bandit"');
    expect(s).toContain('const variant = Splera.getVariant("exp-1", ["control","variant_b","variant_c"]);');
    expect(s).not.toMatch(/\basync\b|=>/);
  });
});
