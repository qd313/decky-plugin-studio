# 02 — D-pad contract and focus linter

Drafted 2026-08-14 against DPS `284e505` (v0.3.6+). Discovery is complete; the decisions in
§ 0 are settled.

**What this document is.** The umbrella plan for making D-pad navigation something a Decky
plugin developer does not have to think about. Its companion,
[01-dpad-focus-oracle-and-issue-intake.md](01-dpad-focus-oracle-and-issue-intake.md), covers
the on-device half (reading focus, pressing buttons) plus issue intake and the triage agent.

**Why it exists.** Decky plugin developers largely build with a mouse, a trackpad, or a
touchscreen. The Deck's primary input is a D-pad. The gap between those two facts is the
single most repeated failure mode in Decky plugin development, and today nothing in the
toolchain catches it.

**How to read it.** § 0–§ 4 are the design and are stable. § 5 is the week-one build, written
as ordered tasks meant to be executed literally. § 6 is everything after, deliberately kept at
shape-level.

---

## § 0 — Decisions already made

**These are settled. Do not reopen them, do not offer alternatives, do not "improve" them
while implementing.** Where a decision looks suboptimal in isolation, it was chosen against
context recorded in this document.

| # | Decision | Settled as |
|---|---|---|
| 1 | The two upstream bugs | Focus oracle (★★) + input injection (★★★★) |
| 2 | Scope | Fix the two bugs as slice 1; the contract is this separate plan |
| 3 | Enforcement style | **Tell the developer** (warn). Do **not** build a library that wires focus automatically. |
| 4 | Where intended order comes from | **Visual** — read the rendered UI. (Applies to ordering rules only; see § 5 preamble.) |
| 5 | Wrapping | Up from the top stop does **not** wrap to the bottom |
| 6 | Tabs | Excepted from the horizontal rules. Do not touch tab behavior. |
| 7 | Failure mode | **Warn**, never block a build. Maximum relevant detail in the warning. |
| 8 | Where the linter runs | **Agent tool only.** No editor integration, no commit hook, no CI job. |
| 9 | Reveal-warning filter | Only warn when the hidden region contains at least one focus stop |
| 10 | Warning style | Short and skimmable: one headline, ≤3 bullets, one action line |
| 11 | How a developer clears a reveal warning | **Declare the state** (§ 4). Not a mute comment, not a code-shape match. |
| 12 | Async data | Backend data arriving gets its own warning — the map changes with no user action |
| 13 | Map scope | **Focus only** — where the highlight goes. Not what a press *does*. |
| 14 | Map authorship | **Generated.** A hand-maintained map recreates the problem it solves. |
| 15 | Oracle release | Ships alone, before injection exists |
| 16 | Weak press methods | **Not built.** Refuse rather than degrade. |
| 17 | State list | **One shared list** drives both the linter and on-device runs |
| 18 | Virtual gamepad enable | Explicit enable; disable fully removes the device |
| 19 | Controllers | Never drive the virtual pad and the real controller at once |
| 20 | Device helper | Installs nothing — SteamOS `/usr` is read-only |
| 21 | Focus settle timing | Poll until settled with a timeout; never sample once |

Related roadmap entries, already filed in [../ROADMAP.md](../ROADMAP.md): spam-left escape
chain (★★★★★, deferred — Steam owns that press), studio issue intake (★★), pluckable studio
(★★★), automated issue triage agent (★★★).

---

## § 1 — Rules for whoever implements this

### 1.1 The one rule that matters most

**When the linter cannot analyze something, it must say so. It must never stay silent.**

Every instinct pushes toward returning a clean result. Resist it. This project exists because
DPS tools have repeatedly returned success-shaped results for work that did not happen — a
focus trace that echoed its own inputs, a screenshot that was a drawn placeholder, a health
check that passed against a dead server, a focus check that read the wrong property. A linter
that silently skips a `.map()` of buttons is that same bug wearing new clothes.

So the output has **three** states, not two:

- **pass** — checked, and it is fine
- **warn** — checked, and here is the problem
- **not analyzed** — could not check, and here is exactly what was skipped

"Not analyzed" is a visible count in the summary. It is never omitted, never rounded to zero,
never folded into "pass".

### 1.2 Non-goals for the week-one build

Do **not** do any of these, even if they seem natural:

- Do not implement the ordering rules (R6, R7, R8). They need a render; this build is source-only.
- Do not start the preview, connect to a Deck, or open a network connection of any kind.
- Do not auto-fix anything or edit the developer's source.
- Do not fail a build, exit non-zero on findings, or add a git hook.
- Do not add an editor extension, diagnostic provider, or CI workflow.
- Do not invent a focus-wiring helper library for developers to adopt.
- Do not add npm dependencies beyond the one decided in Task 1.

### 1.3 House conventions discovered in this repo — follow them

These were verified in the codebase, not assumed. Getting any one wrong breaks the build or
silently hides the tool.

1. **Adding an MCP tool is a three-file change.** The dispatch `switch` in
   `mcp-server/src/index.ts`, the `TOOLS` array in `mcp-server/src/toolRegistry.ts`, and
   `mcp-server/src/toolRegistry.test.ts`, which diffs the two. Miss one and either the build
   fails or the tool is invisible to every external agent. `toolRegistry.ts` says this in its
   own header comment — read it before starting.
2. **MCP tool names use underscores; the internal method uses a slash.** Tool `plugin_lintFocus`
   routes to `tools/plugin_lintFocus`. Match the existing `plugin_diffRpc` / `deck_readPluginLog`
   pattern exactly.
3. **Tests run under `node --test`, not vitest**, and each test file is named explicitly in
   the `test` script in `mcp-server/package.json`. A new test file that is not added to that
   string will never run. This is easy to miss and produces a green build with zero coverage.
4. **`mcp-server` is ESM** (`"type": "module"`). Relative imports need the `.js` extension
   even from `.ts` sources — see any existing import in `src/`.
5. **Tool descriptions are written for an agent choosing a tool**, and by house convention say
   both what the tool does *and when it is the wrong choice*. Match that voice.

### 1.4 Task format

Every task below has the same shape. Execute them in order. Do not begin a task whose
dependency is unfinished.

- **File** — exactly which file, and whether it is new
- **Do** — what to build
- **Do not** — the specific wrong turns available at this step
- **Done when** — a check that can be run, whose output is stated
- **If stuck** — what to report rather than guess

Report a task complete only when its "Done when" check has actually been run and produced the
stated output. If it did not, say so plainly and stop.

---

## § 2 — The contract

Twelve rules. Each is phrased so it is true or false about a piece of code — anything needing
judgment is not a rule yet.

### 2.1 The shape of a Decky plugin

A plugin lives in a narrow vertical column in the Quick Access Menu, roughly 400px wide. Nearly
every plugin is a stack of rows. Therefore:

**Vertical is the primary axis. Horizontal chooses between items within a row.**

That sentence drives most of what follows.

### 2.2 Directions

As established with the maintainer, and verified on hardware where noted:

| Direction | Means |
|---|---|
| Up | Toward the top of the plugin |
| Down | Toward the bottom of the plugin |
| Left | Toward the centre of the screen (the QAM sits on the right) |
| Right | Toward the right edge — deeper into the plugin, tabs, menus |

**Boundary behavior, verified on hardware 2026-08-14:** pressing Left at the plugin's leftmost
stop moves focus to Steam's own QAM icon rail, and further Left presses do nothing. Steam owns
that press. The plugin must not try to own it. Anything beyond that boundary is the deferred
roadmap item, not this plan.

### 2.3 The rules

**Tier 1 — provable from source alone. These are the week-one build.**

| # | Rule | What it catches |
|---|---|---|
| R1 | If Down from A goes to B, then Up from B goes back to A | One-way trips — the most common real bug |
| R2 | Every focus stop is the target of at least one move, or is a declared entry point | The button nothing can reach |
| R3 | Every interactive control has an A-button path (`onButtonDown` / `onActivate` / equivalent) | Reachable but not pressable |
| R4 | No `document.activeElement` anywhere in focus logic | The false-positive trap that cost bonsAI three shipped no-op fixes |
| R5 | No page-searching (`querySelector`, `aria-label`, `data-*`, class probes) to find move targets | Timing-dependent focus bugs that are miserable to diagnose |
| R11 | Any region that reveals or removes focus stops is flagged | Toggles and modals that rearrange the map |
| R12 | Any focus stops whose count depends on backend data are flagged | The map changing with no user action at all |

**Tier 2 — needs a render. Deferred to a later phase.**

| # | Rule | Why it needs a render |
|---|---|---|
| R6 | Left is not consumed at the leftmost stop | Requires knowing which stop is leftmost |
| R7 | Down moves visually downward, Up upward | Requires layout |
| R8 | Left/Right do not change vertical position (tabs excepted) | Requires layout |

**Tier 3 — not decidable statically. These become "not analyzed", loudly.**

| # | Situation |
|---|---|
| R9 | Focus stops produced by `.map()` over runtime data |
| R10 | Refs threaded across module boundaries |

Note R11/R12 are the *upgrade* of Tier 3 from silence into a warning. Where the old design
said "cannot analyze", the contract now says "cannot analyze, here is specifically why that is
dangerous, here is the one thing to do about it."

### 2.4 Rule R5 in plain language — for user-facing text

The linter's own output and docs should explain R5 like this, not in jargon:

> When your code needs to send focus somewhere, don't search the live page for the target.
> Searching finds things that look right but that Steam doesn't consider focusable, or finds
> them before they exist, or finds a stale copy. Instead, have each element register itself
> when it is created, and use that handle later.
>
> **Remember where things are when you build them; don't go looking for them afterwards.**

**A contradiction to head off before this ships.** R5 tells developers not to inspect the page,
while our own checker (in a later phase) renders the plugin and inspects it. A developer will
notice and file a bug against our documentation. The existing pack rules state the ban flatly
and must be reworded when this lands. The distinction is *who* and *when*: a checker measuring
a finished build has no deadline and its mistakes produce a bad report; a plugin measuring
itself mid-press has to be right instantly or the user is stuck. Suggested wording:

> Your plugin must not search the page at runtime. Tools that check your plugin may.

Files to reword when this ships: `pack/.claude/skills/decky-ui-change-focus-gate/SKILL.md`
(step 5), `pack/.claude/agents/decky-ui-focus-gate.md` (mandatory item 5),
`pack/.cursor/rules/ui-change-focus-gate.mdc`, and their duplicates under
`extension/resources/pack/` and `.cursor/`.

---

## § 3 — The map

### 3.1 What it is

For each state the plugin can be in, for each focus stop, where each direction leads:

```
state: menu-closed
  Reset    ↑ Toggle    ↓ Save     ← —    → —
  Save     ↑ Reset     ↓ —        ← —    → —
```

### 3.2 Why it is the centre of the design

The same table can be produced two independent ways:

- **Predicted** — the linter works out what should happen
- **Observed** — the Deck presses every button and records what did happen

Any disagreement is a bug, found automatically, with no human writing an assertion.

**The cost is smaller than it looks.** A 20-stop plugin across 4 states is about 320 presses.
At roughly half a second of settle time each, that is about three minutes of machine time to
exhaustively verify every D-pad path in a plugin. That number is the entire argument for the
injection work in `01`.

### 3.3 Boundaries

- **Focus only.** Where the highlight goes. Not what a press *does* — not dialogs opened, not
  requests sent, not data changed. That belongs to the plugin author. Holding this line is what
  keeps the map finite.
- **Generated, never hand-written.** The moment a developer maintains it by hand, they are
  thinking about D-pad again, which is the thing we are removing.
- **A stale map is worse than no map.** It must be regenerated as part of producing it, never
  committed as a source of truth that drifts.

---

## § 4 — The state list

One file, shared by the linter and by on-device runs (decision 17).

**Location:** `.decky/focus-states.json` in the plugin repo, alongside the existing
`.decky/preview.json`.

**Shape:**

```json
{
  "states": [
    {
      "name": "default",
      "description": "Plugin as it first opens",
      "reach": []
    },
    {
      "name": "advanced-open",
      "description": "Advanced section expanded",
      "reach": [
        { "press": "Down", "times": 2 },
        { "press": "A" }
      ]
    },
    {
      "name": "messages-loaded",
      "description": "After the message list returns from the backend",
      "reach": [],
      "waitFor": "messages.length > 0"
    }
  ]
}
```

- `reach` — the presses that get from `default` to this state. Empty means it is reachable
  without input (e.g. a data-loaded state).
- `waitFor` — for states that arrive on their own, a description of the condition. Week one
  treats this as documentation only.

**Week one uses only `name` and `description`** — enough to clear a reveal warning by declaring
that the state exists and was considered. Rendering and pressing come later, and `reach` is
what will drive them.

**Do not invent additional fields.** Later phases will need them; adding them speculatively now
produces a format nobody validates.

---

## § 5 — Week one: the source-only linter

**Ship target: the week of 2026-08-17.** Effort ★★.

**Why this is first, given decision 4 said "visual".** Going back through the rules, seven of
them need nothing but the source code — including both reveal warnings, which is the part that
most directly helps a D-pad-unaware developer. Visual reading is still the right way to
determine *order*, but ordering is not where the value starts. This also means the linter has
no dependency on the preview, which currently has a mount-blocking bug, and it makes the linter
independently pluckable per the roadmap item.

### Task 1 — choose the parser and wire the dependency

**File:** `mcp-server/package.json`

**Context you need:** `typescript` is currently a **devDependency** of `mcp-server`. The
shipped MCP server runs from `dist/` and is bundled into the VSIX under
`extension/resources/mcp-server/`. Importing `typescript` at runtime without promoting it will
work in the dev tree and fail for every installed user — a failure that will not show up in
local testing.

The existing house style for source scanning is regex (see `CALL_RE` / `SERVER_CALL_RE` in
`mcp-server/src/preview/rpcDiff.ts`). That works for "find `call("name")"`. It does not work for
this: focus analysis needs JSX element boundaries, nesting, prop values, and identifier
identity. A regex implementation will produce both false positives and false negatives, and
those will be blamed on the rules rather than the parser.

**Do:** move `typescript` from `devDependencies` to `dependencies` in
`mcp-server/package.json`. Use the TypeScript compiler API (`ts.createSourceFile`,
`ts.forEachChild`) for all parsing in later tasks.

**Do not:** add any other parser (`@babel/parser`, `acorn`, `jsx-parser`, etc.). Do not attempt
a regex implementation. Do not modify the VSIX bundling step in this task.

**Done when:** `cd mcp-server && npm install && npm run build` succeeds, and
`node -e "import('typescript').then(t => console.log(t.default.version))"` run from
`mcp-server/` prints a version number.

**If stuck:** if promoting the dependency measurably breaks VSIX packaging, stop and report the
size delta and the error. Do not switch to regex on your own initiative — that is a decision
for the maintainer, recorded as H1 in § 7.

### Task 2 — extract the file walker

**File:** `mcp-server/src/lint/files.ts` (new)

**Context:** `walkSourceFiles` already exists at `mcp-server/src/preview/rpcDiff.ts:10` but is
module-private. It skips `node_modules` and `dist` and matches `.ts/.tsx/.js/.jsx`. That
behavior is correct; duplicating it is not.

**Do:** move that function into the new file, export it, and update `rpcDiff.ts` to import it.
Behavior must not change.

**Do not:** alter which directories are skipped or which extensions match. Do not add
configuration for it.

**Done when:** `npm run build` passes and `npm test` still passes with `rpcDiff.test.ts` green.

**If stuck:** report if `rpcDiff.test.ts` fails — it means behavior changed and it must not.

### Task 3 — identify focus stops

**File:** `mcp-server/src/lint/focusables.ts` (new)

**This is the hardest task in the build, and the one most likely to be done badly. Read all of
it before starting.**

A JSX element is a focus stop if **any** of these hold:

1. Its tag is one of: `Focusable`, `Button`, `DialogButton`, `ButtonItem`, `ToggleField`,
   `SliderField`, `DropdownItem`, `Dropdown`, `TextField`
2. It has a `focusable` prop
3. It has any of these props: `onMoveUp`, `onMoveDown`, `onMoveLeft`, `onMoveRight`,
   `onButtonDown`, `onActivate`, `onOKButton`, `onCancelButton`, `onSecondaryButton`

These are containers and are **not** themselves stops: `PanelSection`, `PanelSectionRow`,
`DialogBody`, `Fragment`, plain HTML elements with no `focusable` prop.

**The part that matters most:** a developer's own component — `<MySettingsRow/>`,
`<SpoilerFence/>` — may wrap a `Focusable` and therefore *be* a stop. You cannot know without
resolving it, and resolving across files is Tier 3.

**These go in a `notAnalyzed` list with the component name and location. They are never assumed
to be non-focusable.** Assuming a custom component is not a focus stop makes every later rule
quietly wrong, and it is exactly the class of silent failure this whole effort exists to remove.

**Do:** export

```ts
export interface FocusStop {
  id: string;          // stable: `${relPath}:${line}:${tagName}`
  tagName: string;
  file: string;        // repo-relative
  line: number;
  props: string[];     // prop names present
  isContainer: boolean;
}

export interface NotAnalyzed {
  reason: "unknown-component" | "dynamic-children" | "cross-file-ref";
  detail: string;
  file: string;
  line: number;
}

export function findFocusStops(pluginRoot: string): {
  stops: FocusStop[];
  notAnalyzed: NotAnalyzed[];
};
```

**Do not:** guess whether an unknown component is focusable. Do not follow imports into other
files. Do not add heuristics based on component naming (`*Button`, `*Row`) — a wrong guess here
is worse than an honest gap.

**Done when:** run against `example-plugin/` it returns a non-empty `stops` array, every entry
has a real file and line, and any custom components present appear in `notAnalyzed`.

**If stuck:** report the component you could not classify. Do not classify it.

### Task 4 — build the move graph

**File:** `mcp-server/src/lint/graph.ts` (new)

**Do:** for every stop from Task 3, read its move props and resolve each target where the target
is a ref or identifier defined in the same file. Produce:

```ts
export interface Move {
  from: string;              // FocusStop.id
  direction: "up" | "down" | "left" | "right";
  to: string | null;         // FocusStop.id, or null if unresolved
  unresolvedReason?: string;
}

export function buildGraph(stops: FocusStop[], pluginRoot: string): {
  moves: Move[];
  notAnalyzed: NotAnalyzed[];
};
```

A target that cannot be resolved in-file produces `to: null` **and** a `notAnalyzed` entry with
reason `cross-file-ref`. It does not produce a warning — an unresolved target is unknown, not
wrong, and warning on it would train developers to ignore output.

**Do not:** treat JSX source order as an implied move. Nothing in this build infers order; that
is what the deferred visual phase is for.

**Done when:** against `example-plugin/`, every `Move` has a `from` that exists in `stops`, and
every `to` is either a real stop id or null with a reason.

### Task 5 — rule R1, reversibility

**File:** `mcp-server/src/lint/rules/reversibility.ts` (new)

**Do:** for every move A→B in direction D where both ends resolved, check that a move exists
B→A in the opposite direction. Opposites: up/down, left/right. Where it is missing, emit:

```
⚠ {file}:{line} — one-way move
   · {A} ↓ {B}, but {B} ↑ goes to {C or nothing}
   · a user who moves down here cannot get back the same way
   → add onMoveUp on {B} pointing at {A}
```

Skip pairs where either end is unresolved. Skipped pairs are counted in `notAnalyzed`.

**Do not:** warn when the reverse move exists but points at a *different* stop that is itself
reachable — that is a legitimate pattern (entering a section, leaving via its header). Report
those in a separate `info` bucket, not as warnings.

**Done when:** a fixture with a deliberate one-way move yields exactly one warning; a fixture
with correct wiring yields zero.

### Task 6 — rule R2, unreachable stops

**File:** `mcp-server/src/lint/rules/reachable.ts` (new)

**Do:** any stop that is not the `to` of any resolved move, and is not the first stop in its
file, is unreachable:

```
⚠ {file}:{line} — {tagName} cannot be reached
   · nothing points to it with any direction
   · it is visible but the D-pad can never land on it
   → point a neighbour's onMove* at it
```

**Do not:** run this rule at all when the file has any `notAnalyzed` entry of reason
`cross-file-ref` or `dynamic-children`. In that case emit one `not analyzed` line for the file
instead. An unresolved ref can be exactly the move that makes the stop reachable, and warning
anyway produces confident false accusations — the fastest way to get a linter disabled.

**Done when:** a fixture with an orphan button yields one warning; the same fixture with a
cross-file ref added yields zero warnings and one `not analyzed` line.

### Task 7 — rule R3, activation

**File:** `mcp-server/src/lint/rules/activation.ts` (new)

**Do:** any stop that is not a container and has none of `onButtonDown`, `onActivate`,
`onOKButton`, `onClick`, `onChange` gets:

```
⚠ {file}:{line} — {tagName} has no A-button action
   · the D-pad can reach it but pressing A does nothing
   → add onButtonDown or onActivate
```

**Do not:** warn on `Focusable` used purely as a wrapper with children — a scroll container is a
legitimate stop with no action of its own.

**Done when:** a fixture button with no handler yields one warning; a wrapper `Focusable` yields
none.

### Task 8 — rules R4 and R5, banned patterns

**File:** `mcp-server/src/lint/rules/banned.ts` (new)

**Do:** flag these anywhere inside a move handler or any file containing focus wiring:

| Pattern | Rule |
|---|---|
| `document.activeElement` | R4 |
| `querySelector`, `querySelectorAll` | R5 |
| `getElementById`, `getElementsByClassName`, `getElementsByTagName` | R5 |
| `.closest(`, `.matches(` | R5 |
| String literals containing `aria-label` or `data-` used as selectors | R5 |

R4 wording:

```
⚠ {file}:{line} — activeElement is not a focus oracle on Deck
   · Steam's gamepad focus and the browser's activeElement disagree
   · a check written this way reports moves that never happened
   → use a registered focus owner instead
```

R5 wording:

```
⚠ {file}:{line} — searching the page for a focus target
   · finds elements before they exist, or stale copies, or ones Steam won't focus
   → register the element when it is created and use that handle
```

**Do not:** flag these outside focus context — a `querySelector` in unrelated code is not this
rule's business. Do not attempt to auto-fix.

**Done when:** a fixture using `document.activeElement` in an `onMoveDown` yields exactly one
R4 warning.

### Task 9 — rules R11 and R12, reveal detection

**File:** `mcp-server/src/lint/rules/reveal.ts` (new)

**The filter is what makes this rule usable.** Conditional rendering is everywhere in React —
a typical plugin has dozens. **Only warn when the conditional region contains at least one
focus stop** (decision 9). Without that filter the warning is noise and will be turned off on
day one.

Detect: `{cond && <JSX/>}`, `{cond ? <A/> : <B/>}`, conditional `display`/`className`, early
`return null`, and `.map()` producing focus stops.

R11 wording — exactly this shape, five lines, no more:

```
⚠ {file}:{line} — `{condition}` reveals {n} focus stops
   · nothing points in — {neighbour} ↓ skips to {target}
   · on close, focus may land nowhere → D-pad freezes
   · checked: {state} only
   → declare the other state in .decky/focus-states.json
```

R12 wording, for stops whose count comes from backend data:

```
⚠ {file}:{line} — `{name}` fills after a backend call, no user action
   · {n} stops now, unknown after load
   · checked: {state} only
   → declare the loaded state in .decky/focus-states.json
```

Suppress a warning when `.decky/focus-states.json` declares a state whose `description`
references the same condition. Week one matches on the developer having declared *a* state
beyond `default` for that file. Matching precision improves when rendering lands.

**Do not:** support a mute comment (`// dpad-ok` or similar). Decision 11 is explicit: the only
way to clear this is declaring the state. A mute mechanism will be requested; the answer is no,
because a mute is a claim and a declaration is checkable.

**Done when:** a fixture with a toggle revealing two buttons yields one R11 warning; adding a
declared state to `.decky/focus-states.json` reduces it to zero.

### Task 10 — output formatting

**File:** `mcp-server/src/lint/format.ts` (new)

**Do:** render findings as text. Every run ends with a summary in this exact form:

```
3 warnings · 2 not analyzed · 14 stops checked across 6 files

not analyzed:
  src/components/Spoiler.tsx:12  unknown component <SpoilerFence>
  src/components/List.tsx:40     stops built from data at runtime
```

**The `not analyzed` block is never omitted, even when empty** — print `not analyzed: none`.
Silence there is the failure this project exists to prevent, and an implementer trimming it as
"cleaner output" would undo the point of the build.

**Do not:** use colour codes, spinners, or progress output. Do not sort warnings by severity —
file order is more useful for someone working through them.

**Done when:** running against `example-plugin/` prints warnings and a summary in the form
above.

### Task 11 — register the MCP tool

**Files:** `mcp-server/src/lint/index.ts` (new), `mcp-server/src/index.ts`,
`mcp-server/src/toolRegistry.ts`, `mcp-server/src/toolRegistry.test.ts`,
`extension/src/ui/treeProvider.ts`

**Do:**

1. `lint/index.ts` exports `lintFocus(pluginRoot?: string)` returning
   `{ warnings, notAnalyzed, stopsChecked, filesChecked, text }`.
2. Add `case "tools/plugin_lintFocus":` to the dispatch switch in `src/index.ts`.
3. Add to `TOOLS` in `toolRegistry.ts`, in the `plugin_*` group, with a description in the
   house voice — what it does and when it is the wrong choice. Suggested:

   > Check a plugin's D-pad focus wiring from source: one-way moves, unreachable controls,
   > controls with no A-button action, banned focus patterns, and sections that reveal or
   > remove focus stops. Static only — it does not render or use a Deck, so it cannot check
   > visual ordering. For "does this press actually work on hardware", use `deck_assertFocusMove`.

   Input schema: `{ pluginRoot?: string }`, `additionalProperties: false`.
4. Update `toolRegistry.test.ts` so the dispatch/registry diff passes.
5. Add `tool("plugin.lintFocus")` to the MCP tools list in `treeProvider.ts` (~line 56, in the
   `plugin.*` group).

**Do not:** add extra parameters. Options invite an agent to pick the permissive one; there is
nothing to configure here.

**Done when:** `npm run build && npm test` pass in `mcp-server/`, and `tools/list` includes
`plugin_lintFocus`.

**If stuck:** if the registry test fails, read the header comment at the top of
`toolRegistry.ts` — it explains the intended relationship between the two files.

### Task 12 — fixtures and tests

**Files:** `mcp-server/src/lint/lint.test.ts` (new), fixtures under
`mcp-server/src/lint/__fixtures__/`

**Do:** one small fixture per rule — a good case and a bad case for each of R1, R2, R3, R4, R5,
R11, R12 — plus one fixture with an unresolvable custom component that must land in
`notAnalyzed`. Then **add `src/lint/lint.test.ts` to the `test` script string in
`mcp-server/package.json`.**

**Do not:** skip that last step. The runner takes explicit filenames; a test file not listed
there never runs, and the build stays green while covering nothing.

**Done when:** `npm test` runs the new file and all cases pass. Confirm the new tests actually
executed by checking the count in the output rose — do not infer it from a green exit.

---

## § 6 — After week one

Shape only, deliberately. Detail gets written when each phase starts; writing it now produces
a document that is stale before anyone opens it.

| Phase | What | Stars | Gated on |
|---|---|---|---|
| Preview reliability | The mount-blocking shim gap and the dead-backend-reports-healthy bug. Unglamorous, and it unblocks everything visual. | ★★ | nothing |
| Visual rules | R6, R7, R8 plus the ordering model. Renders the plugin, measures positions. | ★★★ | preview reliability |
| Oracle (`01` § A.1) | Read what Steam thinks is focused. Ships alone. | ★★ | nothing |
| Injection spike (`01` § A.3) | Two hours on hardware. **Run this early** — largest unknown in the plan. | ★ | nothing |
| Injection (`01` § A.2) | Press buttons through a virtual gamepad | ★★★★ | spike |
| Observed map | Walk every stop × every direction × every state on device | ★★ | injection |
| Map comparison | Predicted vs observed; disagreements are bugs | ★ | both maps |
| Pack updates (`01` § A.5) | Gate steps require real evidence; reword R5 per § 2.4 | ★★ | assertFocusMove |

**Two tracks, no mutual blocking:**

```
Track A (software)   linter → preview fixes → visual rules → predicted map
Track B (hardware)   spike → oracle → injection → observed map
                                                       ↓
                                     compare the two maps = the payoff
```

One person should run Track A first — it needs no hardware and no preview. Run the spike early
anyway, because a bad answer there re-shapes Track B entirely.

---

## § 7 — Open decisions

| # | Decision | Recommendation |
|---|---|---|
| **H1** | Promote `typescript` to a runtime dependency of `mcp-server`, or scan with regex? | **Promote it.** Focus analysis needs real structure; regex will be wrong in ways blamed on the rules. Mitigate size in the existing `bundle-for-vsix.mjs` step if it matters. Task 1 assumes this. |
| **H2** | Does the preview get a design rewrite as its own roadmap item? | Raised in conversation, not filed. Keep it separate from the ★★ reliability fixes so the linter never waits on a redesign. |
| **H3** | Does `plugin.lintFocus` land in the pack's focus-gate agent as required evidence now, or after the visual rules? | **Now, as partial evidence.** The gate currently demands on-device verification it has no tool for; source-only findings are a real improvement over nothing. |
