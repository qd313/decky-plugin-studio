---
name: decky-onboard
description: >-
  First-hour Decky plugin setup with Decky Plugin Studio: Init Pack, deck.configure,
  preview smoke, first build/deploy, deck.openPlugin checklist, and first screenshot.
  Use when onboarding a new plugin repo or helping a new contributor get unblocked.
---

# Decky onboard

## When to use

- New plugin workspace (template clone or existing repo)
- User asks how to start with Decky Plugin Studio
- Before any Deck-facing feature work without MCP configured

## One-time setup

1. Command Palette → **Decky: Init Pack** (copies agents, skills, MCP config, scripts).
2. Configure Deck:
   - MCP **`deck.configure`** with `{ ip, user }`, or
   - Copy `.env.example` → `.env` with `DECK_IP` / `DECK_USER`.
   - Run **`scripts/setup-dev.ps1`** / **`scripts/setup-dev.sh`** once for SSH + passwordless sudo (dev-only).
3. Command Palette → **Decky: Open Preview**.

## First validation loop

| Step | MCP / command |
|------|----------------|
| Detect workspace | **`plugin.detect`** |
| Preview smoke | `node scripts/run-preview-suite.mjs --tier=smoke` (preview open) |
| Build | **`plugin.build`** |
| RPC contract | **`plugin.diffRpc`** — fix `frontendOnly` / `backendOnly` before deploy |
| Deploy | **`deck.deploy`** |
| Open plugin on Deck | **`deck.openPlugin`** — follow returned checklist |
| Screenshot | **`deck.captureScreenshot`** (QAM + plugin visible) |

## Environment snapshot

Run **`deck.getEnv`** and record `deckReachable`, `plugin.name`, and `remote` fields in your runbook when present.

## Escalation

- Focus/layout bugs on device → **decky-debugger** subagent
- Tier QA after onboard → **decky-tier-qa** skill

## Do not

- Ship based on preview alone — deploy for focus and Steam Input edge cases.
