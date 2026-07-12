# Subagent review reports

Structured findings from Cursor subagents in this folder (currently `decky-debugger.md`). Paste or summarize each run here so results live next to the agent definitions and survive chat context.

## How to use

- Add a new dated section under **Report log** after each review (newest first).
- Copy the matching **Template** block and fill in only confirmed items; if the agent outputs exactly `No session archived`, record that instead of inventing findings.
- Optional: one section can cover multiple files or scopes if you label them (e.g. `codebase`, `docs/roadmap.md`).

### Contract (plans and handoffs)

- Implementation plans in this repo should include a **Subagent reports and follow-ups** section when required by `.cursor/rules` (**Planning & subagent accountability**). That section ties the plan to reviewed agent output and to this log.
- After each substantive subagent run, add a dated **Report log** entry here so findings are not lost when chat context ends.

---

## Template: decky-debugger

Use when archiving a debugging session or postmortem from `.cursor/agents/decky-debugger.md` (Decky/Steam focus, D-pad, modals, clipping).

```text
Session: <short title>
Bug class: <focus|layout|backend|other>
Root cause: <what was wrong at the platform contract level>
Evidence: <signals that confirmed it: logs, activeElement, measurements, build parity>
Resolution: <smallest fix: which surface — e.g. onMoveLeft/onMoveRight, CSS vars, geometry>
Files: <paths touched or "see commit">
Regression checks: <plugin.build / build script, on-device smoke>
```

Example entry:

```text
Session: Modal D-pad only moved vertically
Bug class: focus
Root cause: Controller navigation used Deck focus-graph callbacks; DOM keydown did not fire reliably for horizontal routing assumptions.
Evidence: onButtonDown logged; nav-key/keydown absent; fix required Decky move handlers on catalog controls.
Resolution: Cross-column focus via onMoveLeft/onMoveRight and stable button refs; footer buttons found by walking ancestors from modal shell.
Files: src/components/ExampleModal.tsx
Regression checks: plugin.build; verified on Steam Deck
```

If there is nothing to archive from a run, record:

```text
No session archived
```

---

## Report log

(Newest first. Add entries after each substantive `decky-debugger` run.)
