# Decky plugin — Claude Code guidance

This file is the Claude Code equivalent of the pack's always-on Cursor rules
(`.cursor/rules/*.mdc` with `alwaysApply: true`). Agents, skills and hooks live
under `.claude/`.

## Decky platform contract

- Treat Steam/Decky controller navigation as a **focus-graph contract**. Implement D-pad via Decky `Focusable` callbacks (`onMoveLeft`, `onMoveRight`, `onMoveUp`, `onMoveDown`, `onOKButton`, `onCancelButton`, `onButtonDown`) before DOM `keydown`.
- NEVER implement Decky D-pad sibling or column hops by discovering targets with `document.querySelector` / `aria-label` / `data-*` / class probes, or by treating `document.activeElement` as proof that focus moved. On Deck those lookups repeatedly miss even when the controls are on-screen, and returning `false` from `onMove*` then lets Steam spatial nav steal the hop (wrong diagonal). ALWAYS register the mounted Deck focus-owner nodes at render time (callback refs / a small registry) and hop between those registered owners; return `true` from `onMove*` once the target is registered so Steam spatial nav cannot steal the move.
- NEVER apply durable layout corrections via ref-set inline styles on React-managed nodes; route dynamic geometry through CSS custom properties on a stable scope root consumed by `!important` rules, or the JSX `style` prop.
- After changes to `src/`, `main.py`, or `plugin.json`, run **`plugin_build`** (MCP) or `./scripts/build.ps1` / `./scripts/build.sh` before on-device QA.
- For Deck debug sessions, use the MCP tools: `deck_startTunnel`, `deck_probeIngest`, `deck_tailIngest`, `preview_runSequence` — do not ask the user to run tunnel scripts manually.
- Plugin `fetch` to `http://127.0.0.1:7682` on the Deck requires a reverse tunnel from the dev PC unless developing on local SteamOS/Bazzite.

See `docs/focus-graph-patterns.md` for the worked patterns, including Pattern D
(mount-time focus-owner registries).

## Git & remote branches

- NEVER run `git push`, `git push -u`, or `gh` publish commands unless the user explicitly asks to push in the current message.
- Prefer local commits; open PRs only when requested.
- Release tags (`git push origin vX.Y.Z`) only when the user explicitly requests a release push.

## Planning and subagent accountability

When drafting or updating an implementation plan, include **Subagent reports and
follow-ups** when `decky-debugger` (or another specialist) applies or was used.
Summarize findings and cite `.claude/SUBAGENT_REPORTS.md` (Report log).

Before closing risky work (RPC, logging, permissions, focus/layout), state triage
vs deferred follow-up.

## MCP tool naming

The studio's MCP server exposes tools with **underscores**, not the dotted names
used in older prose: `deck_deploy`, `preview_runSequence`, `plugin_diffRpc`. In
Claude Code they appear fully qualified as
`mcp__decky-plugin-studio__deck_deploy`. Run `plugin_detect` first to confirm the
workspace really is a Decky plugin.

## Conditional guidance → skills

These were glob-scoped Cursor rules. Claude Code has no glob-conditional rules,
so invoke the matching skill when the trigger applies:

| When you are editing | Use |
|---|---|
| `src/components/**`, `src/utils/build*Element.tsx` | `decky-ui-change-focus-gate` skill — mandatory D-pad gate before shipping |
| `src/**`, `main.py`, `py_modules/**` | `decky-dev-loop` skill — build, deploy, watch, regression gates |
| Anything Deck-facing, before handoff | `decky-dev-loop`; the `Stop` hook also prints a reminder |
| Debugging Deck or Steam UI from captures | `decky-screenshot-ingest` skill |

## Agents

- `decky-debugger` — runtime Steam UI / plugin bugs; gathers its own evidence. The only agent that edits.
- `decky-focus-architect` — design-time focus-graph planning, before implementation. Read-only.
- `decky-ui-focus-gate` — pre-ship D-pad triage on Deck UI edits. Triage-only; escalates to `decky-debugger`.
