# Device QA runbook

**Purpose:** What to run on Steam Deck (or in preview) next, in priority order.

**Automated preview suite:** `node scripts/run-preview-suite.mjs --tier=smoke` (requires **Decky: Open Preview in Cursor**).  
**Evidence:** `node scripts/run-preview-suite.mjs --tier=smoke --evidence` → `docs/test-evidence/<batch>/<date>-<sha>/`.

Record **build id / git SHA** and **SteamOS** when marking Pass / Partial / Fail.

---

## Tags

| Tag | Meaning |
|-----|---------|
| **P0–P3** | Importance — P0 = core product; P3 = polish |
| **S0–S3** | Setup cost — S0 = QAM open; S3 = reboot / clean install |
| **Tier 0–4** | Run order — complete lower tiers before higher unless PR-scoped |

---

## Preconditions

A row that needs the Deck in a particular state says so in its title or its first step, in
these words, so the rig can set the state up instead of a person:

| Wording in the row | Meaning | The rig satisfies it with |
|---|---|---|
| **with a game running** | `window.SteamUIStore.RunningApps` lists one app before the row's first press | `deck.launchGame { name }` (or `{ appid }`) — refuses if a *different* game is up; `alreadyRunning: true` costs no presses |
| **without a game running** / **no game** | `RunningApps` is empty | `deck.exitGame {}` — `nothingRunning: true` when it already is |
| **with a game running and without** | run the row twice, once in each state, and record both | `deck.launchGame`, the row, `deck.exitGame`, the row again |

Name the game in the row (e.g. *Half-Life 2*): the rig launches only what it is told, from the
Recent Games shelf, and never launches a second game. Both verbs leave the ring wherever Steam
puts it — get the plugin back with `deck.openPlugin`, which opens the QAM over a running game.
Each writes `runs/launch-game_<ts>.json` / `runs/exit-game_<ts>.json`; cite the file in the
row's evidence. Design and device measurements: `docs/planning/07-launch-and-exit-a-game.md`.

---

## Progress tracker

| Tier | Status | Last run | Notes |
|------|--------|----------|-------|
| 0 | Open | — | Preview smoke batch (`--tier=smoke`) |
| 1 | Open | — | Core shipped features on Deck |
| 2 | Open | — | Extended / opt-in scenarios |
| 3 | Open | — | Boundaries, permissions edge cases |
| 4 | Open | — | Clean install, multi-session |

---

## Tier 0 — Preview smoke (S0)

Run in Cursor with preview open, or on Deck after `deck.deploy`.

### SMOKE-RPC-greeting (P0)

- [ ] `get_greeting` RPC returns expected string for a test name.
- [ ] No traceback in plugin log.

**Automated:** `node scripts/run-preview-suite.mjs --filter=SMOKE-RPC`

### SMOKE-DOM-shell (P0)

- [ ] Plugin shell renders (title, primary controls visible).
- [ ] No crash on first paint.

**Automated:** `node scripts/run-preview-suite.mjs --filter=SMOKE-DOM-shell`

### SMOKE-DOM-focus-sequence (P1)

- [ ] D-pad **Down** moves focus within the plugin panel.
- [ ] Focus path includes a `Focusable` node.

**Automated:** `node scripts/run-preview-suite.mjs --filter=focus-sequence`

---

## Tier 1 — On-device core (S1)

Requires `deck.deploy` and QAM access on Steam Deck.

### Example checklist

- [ ] Plugin appears in QAM sidebar; opens without crash.
- [ ] Primary user action works end-to-end (RPC + UI feedback).
- [ ] B / back returns to QAM without leaving orphaned modals.

---

## Tier 2+ — Extended QA

Add plugin-specific scenarios under `tests/preview-suite/` and reference them from `tier-manifest.json`.

| Batch key | JSON file | When to run |
|-----------|-----------|-------------|
| `smoke` | `smoke.json` | Every PR touching `src/`, `main.py`, or `plugin.json` |
| *(add)* | *(add)* | Release candidates, feature flags |

---

## Commands reference

```bash
# Smoke batch (preview)
node scripts/run-preview-suite.mjs --tier=smoke

# Single scenario by id fragment
node scripts/run-preview-suite.mjs --tier=smoke --filter=SMOKE-RPC

# Capture evidence artifacts
node scripts/run-preview-suite.mjs --tier=smoke --evidence

# Build before on-device QA
./scripts/build.ps1   # Windows
./scripts/build.sh    # Linux / SteamOS
```

**Preview prerequisites:** Open preview in Cursor; IPC bridge uses `~/.decky-plugin-studio/preview-ipc/`; state in `~/.decky-plugin-studio/preview-state.json`.

**On-device prerequisites:** Configure `DECK_IP` / SSH; use MCP `deck.deploy` or project deploy script; reverse tunnel for ingest if debugging from dev PC.
