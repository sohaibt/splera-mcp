# splera-mcp

A/B testing for vibe coders, exposed as a Model Context Protocol (MCP) server. Your AI agent creates experiments, reads results, and ships winners without you leaving chat.

<!-- TODO: add demo GIF at docs/demo.gif before v0.2.0 -->

Three native tools your agent gets once installed: `create_experiment`, `get_results`, `ship_winner`. The agent calls them, edits your code to wire the SDK and variant, and reports stats back in plain English. No dashboard tab, no copy-paste, no test infrastructure to learn.

- npm: [`splera-mcp`](https://www.npmjs.com/package/splera-mcp)
- Web docs: [splera.ai/docs/mcp](https://splera.ai/docs/mcp)
- Issues: [github.com/sohaibt/splera-mcp/issues](https://github.com/sohaibt/splera-mcp/issues)

---

## What you can do

Once installed, paste any of these into your agent:

> *Create a Splera A/B test for my homepage headline: 'Ship faster.' vs 'Ship with confidence.'*

> *How's my checkout experiment doing?*

> *Ship the winning variant.*

The agent picks the right tool, makes the call, and either edits your code to install the SDK, reports Bayesian stats in human terms, or flips the winning variant server-side (takes effect in ~30 seconds worldwide, no redeploy).

---

## Install

### 1. Generate an API key

Go to [splera.ai/settings](https://splera.ai/settings), click **Generate new key**, name it something like `claude-code-macbook`. Copy the key from the one-time modal. It starts with `splera_live_`. You will not see the full key again. If you close the modal without copying, revoke and regenerate.

### 2. Add the config to your agent

| Agent | Config file | Method |
|---|---|---|
| **Claude Code** | `~/.config/claude-code/mcp.json` | One-liner (below) or edit JSON |
| **Cursor** | `~/.cursor/mcp.json` | Edit JSON (or Settings → MCP) |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | Edit JSON |
| **Zed** | `~/.config/zed/settings.json` (`context_servers` block) | Edit JSON |
| **Replit Agent** | Not supported in v1 (cloud-hosted, can't load local stdio MCP) | — |

#### Claude Code

```bash
claude mcp add splera npx -y splera-mcp@latest --env SPLERA_API_KEY=splera_live_your_key_here
```

Then restart Claude Code.

#### Cursor / Windsurf

Same JSON shape for both, just different file paths.

```json
{
  "mcpServers": {
    "splera": {
      "command": "npx",
      "args": ["-y", "splera-mcp@latest"],
      "env": {
        "SPLERA_API_KEY": "splera_live_your_key_here"
      }
    }
  }
}
```

Restart the agent.

#### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "splera": {
      "command": {
        "path": "npx",
        "args": ["-y", "splera-mcp@latest"],
        "env": { "SPLERA_API_KEY": "splera_live_your_key_here" }
      }
    }
  }
}
```

Restart Zed.

---

## Verify your install

### Option A: check the key from any terminal

```bash
curl -H "Authorization: Bearer splera_live_your_key_here" https://splera.app/api/me
```

`200 OK` with a JSON body means the key works. `401` means the key is bad or revoked, regenerate at [splera.ai/settings](https://splera.ai/settings).

### Option B: check the agent's MCP panel after restart

Open your agent's **Server logs** or **MCP** panel. You should see:

```
splera-mcp: connecting to https://splera.app
splera-mcp: ready. 3 tools loaded. User: you@example.com
```

If those lines are missing, the MCP isn't loading. Check your config file path and JSON syntax.

---

## Troubleshooting

### "splera is not available" / "tool not found"

The MCP config isn't being read. Check that (1) you edited the right file for your agent (see install table above), (2) the JSON is valid, no trailing commas, (3) you restarted the agent after editing.

### `SPLERA_API_KEY not set` / `SPLERA_API_KEY_MISSING` on every call

The server starts without a key (so your agent still lists the tools), but every call fails until the key is set. The `env` block in your MCP config is missing or malformed. The key must start with `splera_live_`. Re-check the examples above.

### 401 / `SPLERA_INVALID_API_KEY` on every call

The key is wrong, revoked, or truncated during copy. Go to [splera.ai/settings](https://splera.ai/settings), revoke the existing key, generate a new one, update the config, restart the agent.

### `SPLERA_PLAN_LIMIT_EXCEEDED` on create_experiment

You've hit your plan's monthly experiment cap. Options: [upgrade](https://splera.ai/pricing) or ship / stop an existing experiment to free a slot. The error `hint` field tells you which plan and how many slots are used.

### `get_results` says NOT_READY forever

The SDK isn't reaching the page being tested. Verify the script tag is in place:

```html
<script src="https://splera.app/sdk/splera.js"
        data-experiment="YOUR-EXPERIMENT-UUID"
        data-api-url="https://splera.app"></script>
```

`data-api-url` is required: without it the SDK tracks nothing. If your experiment was created with splera-mcp 0.1.1, its install code was missing this attribute and used a callback form of `getVariant` that never runs. Re-copy the snippet from the experiment page on the dashboard.

Also confirm the page is receiving real traffic. The dashboard shows live exposure counts at [splera.ai/experiments/:id](https://splera.ai).

### Agent doesn't use the Splera tool even when I ask

Most agents need explicit mentions of the tool until it's familiar. Try prompts like *"use the splera MCP to create an experiment"* instead of generic *"set up an A/B test"*. Once the agent calls it once, it remembers.

---

## Tool reference

### `create_experiment`

Create a new A/B test. Returns the experiment ID, variant IDs, and an SDK install snippet the agent can paste into your codebase.

**Required:** `name` (3-80 chars), `hypothesis` (10-500 chars), `variants` (2-5 items, control first), `metrics` (1-5 items, each with `name` + `event_name`).

**Optional:** `decision_mode` (`quick_decision` / `rigorous` / `bandit`, default `quick_decision`), `platform` (`replit` / `lovable` / `bolt` / `claude_design` / `other`, default `other`).

**Example prompt:**

> *Create a Splera experiment on my pricing page — test "Start free" vs "Get started" on the primary CTA. Primary metric is signup_completed.*

### `get_results`

Fetch current results for an experiment. Returns variant stats, Bayesian leader probability, ship-readiness verdict, and (post-ship) guard-window status. Safe to call once per minute during active experiments. For long-horizon monitoring, use the dashboard.

**Required:** `experiment_id` (UUID from `create_experiment`).

The response includes a `next_check_recommended_at` timestamp so the agent knows when it's worth checking again, instead of spamming the endpoint.

**Example prompt:**

> *How's my hero CTA experiment doing? Ready to ship?*

### `ship_winner`

Ship the winning variant to 100% of traffic. The SDK flips server-side within 30 seconds worldwide. No redeploy, no code change on your end. After shipping, a guard window monitors the live rate against a frozen pre-ship baseline and emails you if performance degrades.

**Required:** `experiment_id`, `winning_variant_id` (the slug-style ID like `variant_b` or `control`, not the variant's display name — use `leading_variant_id` from `get_results`).

**Example prompt:**

> *Ship variant_b on experiment 7f3e9a2b.*

---

## Privacy

- `splera-mcp` makes HTTPS calls to `splera.app` only. No local telemetry, no third-party analytics from this package.
- Your API key stays on your machine in your agent's MCP config. It's never logged server-side.
- Keys are stored as `sha256` hashes in our database. Even if our DB were compromised, the raw keys are not recoverable.
- Revoke any key instantly at [splera.ai/settings](https://splera.ai/settings). Revocation takes effect within 60 seconds.

---

## Links

- [Settings / API keys](https://splera.ai/settings) — generate, name, revoke
- [Pricing](https://splera.ai/pricing) — plan limits and upgrade
- [Web docs](https://splera.ai/docs/mcp) — longer-form setup guide with screenshots
- [GitHub issues](https://github.com/sohaibt/splera/issues) — bug reports and feature requests

Built by [Splera](https://splera.ai). A/B testing for vibe coders.
