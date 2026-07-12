---
name: decky-tier-qa
description: >-
  Agentic tier-by-tier QA for Decky plugins: preGate → Tier 0 → Tier 1+ preview
  batches, evidence under docs/test-evidence/, doc writeback when the project
  defines prompt-testing docs. Pivot to single-scenario runs when a batch is
  flaky; use deck.deploy for deck-only scenarios.
---

# Decky tier QA loop

## When to use

- Closing a runbook tier (`docs/device-qa-runbook.md` when present)
- After changes to `src/`, `main.py`, preview scenarios, or RPC paths
- User asks for preview-suite / tier QA / evidence writeback

Companion skills: [decky-preview](../decky-preview/SKILL.md), [decky-dev-loop](../decky-dev-loop/SKILL.md).

---

## Preflight

1. **Shell gates** (no preview required) — adapt to your repo:
   ```bash
   pnpm exec tsc --noEmit
   pnpm run test:preview:tier -- --tier=preGate --evidence --write
   ```
   Skip commands your `package.json` does not define.

2. **Preview panel** — Command Palette → **Decky: Open Preview** (keep tab open).

3. **Sidecar** — Confirm RPC works:
   - `preview.status` or read `~/.decky-plugin-studio/preview-state.json` for `url` + `httpPort`
   - If tier0 RPC steps fail with `fetch failed`, restart preview or start sidecar manually.

4. **External deps** — Run only tiers your manifest marks as required (e.g. Ollama, hardware RPC).

5. **Build parity** — After `src/` / `main.py` / `plugin.json` edits: **`plugin.build`** then **`deck.deploy`** before on-device QA.

Record environment in your test docs (`docs/prompt-testing.md` **Environment matrix**) before Tier 1+ when that file exists.

---

## Tier loop

Batches and order: `tests/preview-suite/tier-manifest.json` → `executionOrder` (when the project ships a preview suite).

```bash
# Full tier with evidence + doc writeback
pnpm run test:preview:tier -- --tier=tier0 --write

# Evidence only (no doc mutation)
pnpm run test:preview:tier -- --tier=tier0 --evidence
```

| Batch | Typical scope | Preview | Notes |
|-------|---------------|---------|-------|
| `preGate` | Unit/regression | No | Shell-only |
| `tier0` | Tier 0 smokes | Yes | Focus, navigation, core RPC |
| `tier1Core` | Tier 1 | Yes | May need sidecar deps |
| `tier1Boundaries` | Edge cases | Yes | |
| `tier2` | Opt-in deep | Yes | |
| `deckOnly` | On-Deck only | **No** (skipped) | See E-bucket below |

After each batch:

1. Read `docs/test-evidence/<batch>/<date>-<sha>/batch-summary.json`
2. Review FAIL rows in `docs/prompt-testing-failures.md` (if present)
3. Update `docs/device-qa-runbook.md` progress tracker (auto via `--write` when supported)
4. **Do not proceed** to next tier if core smokes FAIL without triage

---

## Pivot to single scenario

When a batch is flaky or one scenario blocks the rest:

```bash
pnpm run test:preview:tier -- --tier=tier0 --filter=SMOKE-A --evidence --write
```

Inspect evidence per scenario:

- `manifest.json` — status, error, file list
- `dom-final.html`, `focus-path.json`, `rpc-last.json`
- `final.png` (html2canvas when extension ≥ 0.1.2)
- `plugin-log-tail.txt`

Fix root cause, re-run **only** the failed ID, then re-run the full tier batch once green.

---

## E-bucket (deck-only)

Scenarios in `tests/preview-suite/deck-only-*.json` (or equivalent) are **not runnable in preview**. Runner marks them `skipped` and writes stub manifests.

**On-Deck path:**

1. **`deck.configure`** — set DECK_IP, DECK_USER
2. **`plugin.build`** → **`deck.deploy`**
3. Optional: **`deck.startTunnel`** → **`deck.probeIngest`** / **`deck.tailIngest`**
4. Manual runbook steps for QAM, CEF/CORS, clean install
5. Record PASS/FAIL in project test docs with build + SteamOS version

Use [decky-screenshot-ingest](../decky-screenshot-ingest/SKILL.md) or **`deck.captureScreenshot`** for layout/focus evidence.

---

## Doc writeback rules (`--write`)

When the preview tier runner supports `--write`:

- **PASS** → upsert row in `docs/prompt-testing.md` Test Results (dedupe by scenario ID)
- **FAIL** → upsert row in `docs/prompt-testing-failures.md`
- Notes are short: link to `test-evidence/.../manifest.json` (+ truncated error on FAIL)

---

## Subagent escalation

| Issue | Persona |
|-------|---------|
| Focus / layout / ingest | **master-debugger** |
| RPC / logging / permissions | **security-auditor** |
| Ship scope / tier priority | Maintainer / roadmap |

Archive substantive runs in `.cursor/agents/SUBAGENT_REPORTS.md`.
