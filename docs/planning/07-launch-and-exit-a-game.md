# Plan 07 — Launch a game, and exit it, by pressing buttons

**Raised 2026-09-02 by the maintainer, during bonsAI plan 30 (the collapsing tab bar).** That
plan's device spike has a matrix row that reads *"LB and RB still switch tabs, with a game running
and without"*. The rig could do the second half and not the first, and the agent's draft answer was
to ask a human to start a game. The maintainer's reply, verbatim: *"The rig can certainly launch a
game. I've seen it. If you can press buttons on a controller, you can press buttons within
SteamOS. Draw it up and make sure that the DPS repo knows about it."*

**Status:** implemented 2026-09-02 — `deck_launchGame`, `deck_exitGame` and `deck_pressChord` are
in the tree (`mcp-server/src/deck/gameSession.ts`, the registry, the dispatch, the docs; § 4
lists every file), unit-tested through seams (24 tests in `gameSession.test.ts`, plus 3 for the
§ 6.1 `deck_openPlugin` change in `openPlugin.test.ts`). **Device run pending:** the first
end-to-end `runs/LAUNCH-GAME-01.json` / `runs/EXIT-GAME-01.json` (§ 5) have not been recorded yet.
The *Measured* sections were filled in from the device during the bonsAI spike of the same day,
before the code was written; nothing in them is predicted.

---

## 1. The gap, stated precisely

A game running is a **precondition** that several consumer QA rows need and none can set up:

- bonsAI **CHAT-SLOTS-V2-05** (bumper routing with a game running and without) and plan 30
  **W1a** (the same matrix, with Steam's tab header hidden).
- bonsAI's running-game context line (*"Context: no active game detected"* vs a named game)
  and every knowledge-base row keyed on the running app id.
- Any plugin whose panel changes shape when a game is up.

Today the rig has no verb for it. Worse, the obvious first attempt is a trap:

- **`deck_pressButton` with `[GUIDE, A]` is not the QAM chord.** It sends both bits in one HID
  report, which Steam reads as a bare GUIDE press: the *main menu* opens and the A lands in
  whatever that menu is showing. The tool's own description says the opposite ("Several at once
  is a chord, e.g. [GUIDE, A] opens the Quick Access Menu"). The real hold-then-tap chord
  (`pressChord` → `bridge/tools/chord.py`) exists, is correct, and is reachable only from inside
  `deck_openPlugin`. `pressButton.ts:262-272` records the hour this cost on 2026-08-26 — and
  that the mistake was "one press away from launching a game".

So this plan adds three verbs and fixes one description.

## 2. What is already true (measured 2026-09-02, no presses)

All of it read over CDP with `deck_readPage`, targets named as Steam names them.

- **Steam's running-app list is readable.** In the `SharedJSContext` target,
  `window.SteamUIStore.RunningApps` is an array of `{ appid, display_name, … }`; it was `[]`
  with no game up. `window.collectionStore.allAppsCollection.allApps` lists every app with
  `appid`, `display_name` and `installed` (the first five were "007 - GoldenEye" ×2 — non-Steam
  shortcuts get their own ids — "2 Ship 2 Harkinian", "ARC Raiders", "Arcade Paradise").
  `window.appStore` and `window.SteamClient` are present. None of these is used to *drive*
  anything; they answer "is it running?" and "which app id is that name?".
- **The `SharedJSContext` target's URL tracks the main window's route.** It read
  `https://steamloopback.host/routes/library/home` while the Deck sat on the Home screen.
  **UNKNOWN until measured** whether it changes to `/library/app/<appid>` on an app page; § 6.
- **The Home screen's Recent Games shelf identifies its tiles two ways.** In the
  `Steam Big Picture Mode` target, `[aria-label="Recent Games"]` is a `ReactVirtualized__Grid`
  (4286px wide, 107 focusables, ~21 tiles). Each tile's text is the name twice plus playtime
  (`"Left 4 Dead 2Left 4 Dead 2Last two weeks: 14.4 hrs"`), and each tile holds an `<img>`
  whose `src` carries the app id: `/assets/550/library_600x900.jpg` for a local asset,
  `…/store_item_assets/steam/apps/2321470/…/library_header_2x.jpg` for a store one. The
  first tile is the most recent game (564px wide); the rest are 184px portrait tiles. **Tiles
  have no `aria-label`** — the rig's label fallback reads their text, so `walkTo RIGHT
  "Left 4 Dead 2"` would match, and the image URL is the exact check.
- **The main menu is walkable.** `runs/steam-main-menu-walk.json` (an earlier session) walked
  `#MainNavMenuContainer` DOWN through *Home, Library, Store, Friends & Chat, Media, Downloads,
  Settings, Power* — every entry labelled, every press routed.
- **Installed games on the maintainer's Deck** (from `appmanifest_*.acf` over SSH): 60-odd,
  including small native ones that boot in seconds — Undertale (155 MB), Brotato (217 MB),
  Stardew Valley (676 MB), The Yawhg (91 MB). A `StateFlags` of 4 is fully installed; 6 has
  an update pending and would show *Update* instead of *Play*.

## 3. The verbs

Same safety model as `deck_openPlugin` (`openPlugin.ts:1-27`), restated because every one of
these presses A on Steam's own UI, not the plugin's:

- **Rule 1 — only the D-pad while searching.** Direction presses move the ring. A, B, GUIDE
  change state; they are pressed only at named stages, never while looking for something.
- **Rule 2 — A only on a control the read taken immediately before it identified.** For a
  tile that means the app id in its image URL, not a substring of its text; for the Play
  button it means the exact label *Play*. *Install*, *Update*, *Buy*, *Pre-load* and anything
  else are refusals, because the press would spend the user's disk or money.
- **Rule 3 — one game at a time.** `launchGame` refuses when a different app is already in
  `RunningApps`, names it, and points at `exitGame`. It never launches a second one.
- **Rule 4 — every stage is bounded and reported.** Budgets on every walk; a refusal returns
  the stages run, the controls seen, and the manual checklist. The killswitch latch is checked
  before every press, as in `openPlugin`.
- **Rule 5 — the caller gets the QAM back with `deck_openPlugin`.** Launching leaves the ring
  wherever Steam puts it; reopening the panel is the existing verb's job, and it already
  handles the closed-QAM chord.

### 3.1 `deck_launchGame` — `{ name?, appid?, budget?, waitMs?, port?, cdpUrl? }`

One of `name` or `appid` is required; there is deliberately no "launch whatever is first".

| Stage | Presses | Verified by |
|---|---|---|
| `read-running` | 0 | `RunningApps`. Target already up → `ok, alreadyRunning: true`, done. Other app up → refuse (Rule 3) |
| `resolve-app` | 0 | `allApps`: exact name, then case-insensitive contains; more than one hit → refuse and list them; `installed: false` → refuse |
| `leave-qam` | see § 6 | a QAM pane visible → close it; the press that does this is **measured**, not assumed (B repeats, or GUIDE, whichever the read confirms) |
| `open-main-menu` | 1 (GUIDE) | the ring is in `MainMenu_uid2` on a labelled entry |
| `go-home` | ≤ 8 D-pad + 1 A | walk to *Home* (exact), A; `SharedJSContext` URL ends in `/library/home` |
| `find-tile` | ≤ budget RIGHT | at every stop, the focused element's descendant `<img src>` contains `/<appid>/` or `/apps/<appid>/`; text is recorded, not trusted |
| `open-app-page` | 1 A | route changes to the app page (§ 6), or a control labelled *Play* exists |
| `find-play` | ≤ 10 D-pad | walk to *Play*, exact; any of the Rule 2 refusal labels ends the run |
| `press-play` | 1 A | `RunningApps` contains the app id within `waitMs` (poll 1s); the *first* appearance is the launch, the game's own window is not waited for |

Result: `{ ok, appid, name, alreadyRunning, running: { appid, name } | null, stages, seen,
presses, fidelity, stopped, reason?, checklist?, summary }`, in the shape of `OpenPluginResult`
so the same reader serves both.

**Not on the Recent Games shelf** is a refusal in v1, with the reason spelled out: play it once by
hand, or extend `find-tile` to the Library grid (§ 8). The shelf is the shorter path and it is
where a game a tester keeps using will be.

### 3.2 `deck_exitGame` — `{ waitMs?, port?, cdpUrl? }`

| Stage | Presses | Verified by |
|---|---|---|
| `read-running` | 0 | `RunningApps` empty → `ok, nothingRunning: true`, done |
| `open-main-menu` | 1 (GUIDE) | ring in `MainMenu_uid2` |
| `find-exit` | 1 RIGHT + ≤ 10 DOWN | **measured**: the ring starts on the game's entry; RIGHT lands on *Resume game*; DOWN ×7 reaches ***Exit game*** (exact, lower-case g), the panel's last row — `walkTo DOWN "Exit game"` found it in 7 presses |
| `confirm` | 1 A | **measured**: Steam always asks; the modal opens with the ring on **Confirm** (exact label). A is pressed only after a read names it; anything else on the ring is a refusal |
| `verify` | 0 | `RunningApps` empty within `waitMs` |

### 3.3 `deck_pressChord` — `{ hold, tap, port? }`

Exposes `pressChord` as it is. `hold: "GUIDE", tap: "A"` is the QAM toggle. The description of
`deck_pressButton` changes to say what a list actually does: a *simultaneous* press, which for
GUIDE plus anything opens the main menu — use `deck_pressChord` for chords.

## 4. Where it goes, and the "DPS knows about it" checklist

Found by grepping for `deck_openPlugin`; a new verb that misses one of these is invisible in
that surface.

| File | Change | Done 2026-09-02 |
|---|---|---|
| `mcp-server/src/deck/gameSession.ts` (new) | `launchGame`, `exitGame`, shared readers (`readRunningApps`, `readAllApps`, `readRoute`, `readFocusedTile`), `resolveApp`; seams `pressFn` / `readFocusFn` / `readPageFn` / `sleepFn` as `openPlugin.ts` has. No `chordFn`: neither verb sends a chord — the measured press out of the QAM is a bare GUIDE (§ 6) | ✅ |
| `mcp-server/src/deck/gameSession.test.ts` (new) | 24 tests through the seams: refuses on a second game, an ambiguous name, an uninstalled game and *Install*; every A is preceded by the read that named its target (asserted per A); shelf not found; the exit happy path and the Cancel-on-the-ring refusal; the latch stops the run before its next press; the evidence file's contents | ✅ |
| `mcp-server/src/deck/openPlugin.ts` | § 6.1: when no page carries a ring AND the Quick Access page itself reports no pane, the chord goes first (stage `open-qam-blind`, `RunningApps` in its detail) and a D-pad press follows only once a read shows Steam UI; `chordFn` seam; 3 tests in `openPlugin.test.ts` | ✅ |
| `mcp-server/src/index.ts` | three `case "tools/…"` entries in `handle()` | ✅ |
| `mcp-server/src/toolRegistry.ts` | three definitions; `deck_pressButton`'s description corrected (a list is a *simultaneous* press); `toolRegistry.test.ts` agrees with the dispatch | ✅ |
| `mcp-server/package.json` | both new test files in the `test` script's list | ✅ |
| `docs/MCP_TOOLS.md` | three bullets under *Focus rig*; the `deck.pressButton` bullet corrected | ✅ |
| `AGENTS.md`, `pack/AGENTS.md`, `extension/resources/pack/AGENTS.md` | three rows in the tool table | ✅ |
| `docs/device-qa-runbook.md` | a *Preconditions* section: how a row says "with a game running" and how the rig satisfies it | ✅ |
| `CHANGELOG.md` | *Added* entries under *Unreleased* (the 2026-08-26 chord trap named) and a *Fixed* entry for the 2026-09-02 `deck_openPlugin` gap | ✅ |
| `extension/src/ui/treeProvider.ts` | it lists tools by name, so the three were added under *MCP tools* | ✅ |
| `runs/LAUNCH-GAME-01.json`, `runs/EXIT-GAME-01.json` | the first end-to-end device run (§ 5) | ⬜ pending — needs the board and the Deck |

`.claude/worktrees/*` copies are not edited; they are agents' checkouts.

## 5. Evidence

Every run writes `runs/<runName>.json` the way `runSequence` does — stages, presses, the labels
seen, the `RunningApps` read before and after. The first end-to-end run on the maintainer's Deck
is committed as `runs/LAUNCH-GAME-01.json` and `runs/EXIT-GAME-01.json`, and bonsAI's plan 30
§ 8 cites them for its W1a "with a game" half.

## 6. Measured on the device

Filled in during the bonsAI plan 30 spike, 2026-09-02. Each line names the run file.

| Question | Answer | Evidence |
|---|---|---|
| Which press leaves the QAM cleanly, and where does the ring land? | One bare **GUIDE** with the QAM open and the ring on Decky's Back button: the QAM closes, the main menu opens, the ring is on **Home** (read 67% visible while the menu was still sliding in). No B presses needed | bonsAI `runs/LAUNCH-GAME-01-guide-from-qam.json` |
| After GUIDE, which entry holds the ring in the main menu? | **Home** with no game running; **the running game's entry** (above Home) with one running. Both read 67% visible on the first read because the menu was still sliding in — a settle of ~800ms is enough | `LAUNCH-GAME-01…`, `EXIT-GAME-01…` |
| Does the `SharedJSContext` URL change on an app page? To what? | Better than the URL: `window.SteamUIStore.WindowStore.GamepadUIMainWindowInstance.m_history.location.pathname` in `SharedJSContext` reads the main window's route directly — `/library/home` on the Home screen. App-page value: not read (the ring landed on *Play* and the next press launched); the running-game value is **`/apprunning`** | `deck_readPage`, 2026-09-02 |
| After A on *Home*, where is the ring — on the shelf, or above it? | On the shelf's **first tile** ("Deep Rock Galactic: Survivor", the most recent game), 100% visible, 1.6s settle. Also seen right after a Decky Loader restart: the ring sat on that same tile before the QAM was opened | bonsAI `runs/LAUNCH-GAME-02-a-on-home.json` |
| What does the Play button read for an installed, up-to-date game? | **"Play"** (a `<DIV>` Focusable, aria label "Play"), and A on the tile lands the ring on it directly — the `find-play` walk needed **0** presses for Half-Life 2. Tile identity was confirmed first: the focused element's own `<img src>` was `/assets/220/…/library_600x900.jpg` | bonsAI `runs/LAUNCH-GAME-03-a-on-tile.json` |
| How long from A on *Play* to the app id appearing in `RunningApps`? | **Under a second.** A `deck_waitFor` on `RunningApps` (1s interval, started alongside the press) was satisfied on its first poll, 485ms in, with `{ appid: 220, name: "Half-Life 2" }`. The main-window route became **`/apprunning`** and the ring moved to an unlabelled container on that screen. The game's own window was still loading; `RunningApps` is the launch signal, not the game being playable | bonsAI `runs/LAUNCH-GAME-04-a-on-play.json` |
| With a game up, what does GUIDE show — an *Exit Game* entry, or the app page? | The main menu, with a **new top entry named after the game** ("Half-Life 2", aria-label the same, 264×53) holding the ring, above *Home … Power*. To its right a game panel with eight text-only rows (no aria labels): *Resume game, Controller settings, View game details, Achievements, Guides, Notes, Game Recording, **Exit game*** (lower-case g), each 304×40. Read from `MainMenu_uid2` while the QAM was still on screen underneath | bonsAI `runs/EXIT-GAME-01-guide-in-game.json` |
| Does exiting ask for confirmation, and what is the confirm control called? | **Yes.** A on *Exit game* opens a modal (`#ModalDialogOverlay_Modal_0`, a `GenericDialogBase` form) with the ring already on **`<BUTTON> "Confirm"`** (`DialogButton Primary`, 100% visible, 1.6s settle). The game kept running while the dialog was up: a 25s `RunningApps` poll stayed non-empty | bonsAI `runs/EXIT-GAME-03-a-on-exit.json` |
| After exit, does `RunningApps` empty before the game's window is gone? | Not measured by the rig: the session paused on the dialog and the confirm was pressed by hand meanwhile. What was read afterwards: `RunningApps` empty, the main window back on the **app page** (`/library/app/220`) with the ring on *Play* — that is the post-exit state `exitGame` should expect and report | `deck_readFocus` / `deck_readPage`, 2026-09-02 |

## 6.1 Found on the way: `deck_openPlugin` cannot open the QAM over a running game

Measured 2026-09-02, first attempt to get bonsAI back after Half-Life 2 launched. With the game in
the foreground **no CEF target carries `gpfocus`** — the game owns input, Steam's windows own no
ring. `openPluginDriven` reads focus first (`openPlugin.ts:326-357`), spends its acquire press
(a DOWN, which went into the game's menu), reads again, still finds nothing, and refuses with
*"could not read the Deck's focus state even after placing the ring"*. Its chord stage
(`openPlugin.ts:379-401`) is never reached, because the guard for it is `visibleQuickAccessTab ===
null` on a read that never succeeded.

So the one state `launchGame` leaves the Deck in is the one state `openPlugin` cannot start from.
The fix belongs in `openPlugin`, not in the caller:

- When the initial read finds **no ring anywhere and no QAM pane**, treat that as "a game or a
  full-screen surface owns input", **send the chord first**, wait, and only then read and acquire.
  `RunningApps` non-empty is the confirming signal and goes into the stage detail.
- The acquire press moves **before** the chord only when a read shows Steam UI on screen; a blind
  D-pad press into a running game is a press into the game.

Until that lands, the workaround used here was the chord script itself, `python
bridge/tools/chord.py GUIDE A`, which is the same four-step hold/tap the tool sends — with the
caveat that it bypasses the killswitch latch check in the TS layer, so it is a maintainer-in-the-
room workaround, not a pattern.

## 7. Out of scope

- Launching by URL (`steam://rungameid/<id>` over SSH, or `SteamClient.Apps.RunAppById` over
  CDP). Both work and both are *driving by script*, which the rig exists not to do: a test that
  starts a game the way no thumb can is not evidence about what a thumb gets. Kept as a named
  escape hatch for a machine with no bridge board, off by default, if anyone asks for it.
- Typing into Steam's search. Text entry through the bridge is a plan of its own.
- Non-Steam shortcuts and games that show a launcher or a controller-layout prompt before
  `RunningApps` changes. `launchGame` reports what `RunningApps` said and nothing more.

## 8. Follow-ups

- `find-tile` over the Library grid (*All games*, alphabetical, virtualised), for a game that is
  not recent. Same identification, longer walk, a row/column budget.
- `deck_sweep` and `deck_walkTo` gain a `target` so they can walk Steam's own windows, not only
  the QAM; today they find the ring wherever it is but describe it in QAM terms.
