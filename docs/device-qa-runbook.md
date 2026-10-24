# Device QA runbook

**Purpose:** What to run on the Steam Deck (or a stand-in) next, in priority order.

The in-IDE preview and its test suite were retired on 2026-10-24. All UI checks run on a machine.

Record **build id / git SHA**, **SteamOS**, and **the machine** (the `machine` stamp on every
result) when marking Pass / Partial / Fail.

---

## Before a run

1. **Pick the machine.** `deck.listMachines` lists them. Pass `machine: "<name>"` on every
   `deck.*` call; without it you drive `deck`, the real Deck. A stand-in's verdict is never the
   Deck's: every result says `machine: { name, kind, os }`.
2. **Make sure you hold the machine.** A driving call takes the machine's lease for your session.
   If another live session holds it, the call is refused and names them. Stop and tell the user.
3. **Run `deck.checkReady` first.** Declare what the run needs (`awake`, `buildMatches`,
   `runningAppId`, `pluginOpen`, `noForeignCdpTunnel`, `focusRingOwned`, ...). Add `machineKind:
   "deck"` when only the real Deck counts. On a Windows stand-in it also checks that Big Picture
   is in front. A `fail` or `unknown` stops the run at step zero.
4. **Hold it awake** for a long run with `deck.holdAwake`, and release it with
   `deck.restorePowerSettings` at the end. **Snapshot settings** first with
   `deck.snapshotSettings` if the run changes them, and put them back with
   `deck.restoreSettings`.

If anything looks wrong, call `deck.stopAutomation`. Only a human re-arms it.

---

## Tags

| Tag | Meaning |
|-----|---------|
| **P0–P3** | Importance — P0 = core product; P3 = polish |
| **S0–S3** | Setup cost — S0 = QAM open; S3 = reboot / clean install |
| **Tier 1–4** | Run order — complete lower tiers before higher unless PR-scoped |

---

## Preconditions

A row that needs the Deck in a particular state says so in its title or its first step, in
these words, so the rig can set the state up instead of a person:

| Wording in the row | Meaning | The rig satisfies it with |
|---|---|---|
| **with a game running** | `window.SteamUIStore.RunningApps` lists one app before the row's first press | `deck.launchGame { name }` (or `{ appid }`) — refuses if a *different* game is up; `alreadyRunning: true` costs no presses |
| **without a game running** / **no game** | `RunningApps` is empty | `deck.exitGame {}` — `nothingRunning: true` when it already is |
| **with a game running and without** | run the row twice, once in each state, and record both | `deck.launchGame`, the row, `deck.exitGame`, the row again |

Name the game in the row (e.g. *Half-Life 2*). `deck.listGames` shows what is installed and
what is on the Recent Games shelf, with no press. The rig launches only what it is told, and
never a second game.

**Fallbacks.** On the maintainer's Deck the Steam button has opened no menu since 2026-10-10.
The tools work round it, and the result says which route ran:

- `deck.launchGame` reports `launchRoute`: `shelf`, `library` (a game not on the shelf, found in
  the Library grid; never run on a Deck yet), or `home` (no menu: the QAM is closed with the
  GUIDE+A chord and the Home shelf is walked).
- `deck.exitGame` reports `via`: `steam-menu`, or `steam-close-call` when no menu opens (Steam's
  own close call, not a press). It also checks the process list, so a game that left
  `RunningApps` but still runs is not called exited.

Both leave the ring wherever Steam puts it. Get the plugin back with `deck.openPlugin`, which
opens the QAM over a running game. Each writes `runs/launch-game_<ts>.json` /
`runs/exit-game_<ts>.json`; cite the file in the row's evidence.

---

## Progress tracker

| Tier | Status | Last run | Notes |
|------|--------|----------|-------|
| 1 | Open | — | Core shipped features on Deck |
| 2 | Open | — | Extended / opt-in scenarios |
| 3 | Open | — | Boundaries, permissions edge cases |
| 4 | Open | — | Clean install, multi-session |

---

## Tier 1 — On-device core (S1)

Requires `deck.deploy` and QAM access on the Deck.

### Example checklist

- [ ] Plugin appears in QAM sidebar; opens without crash (`deck.openPlugin`).
- [ ] Primary user action works end-to-end (RPC + UI feedback).
- [ ] B / back returns to QAM without leaving orphaned modals.
- [ ] `deck.sweep` over the main pane reads `stopsFocusedButNotVisible: 0`.

---

## Tier 2+ — Extended QA

Save each passing run as a check with `deck.saveCheck`, and rerun them all after a deploy with
`deck.replayChecks`.

---

## Commands reference

```bash
# Build before on-device QA
./scripts/build.ps1   # Windows
./scripts/build.sh    # Linux / SteamOS
```

**On-device prerequisites:** Configure `DECK_IP` / `DECK_USER` (`deck.configure`) and SSH; use
MCP `deck.deploy` or the project deploy script; start the reverse tunnel for ingest if debugging
from a dev PC.
