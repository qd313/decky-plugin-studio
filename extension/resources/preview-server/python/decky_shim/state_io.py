"""Persist plugin instance state across sidecar restarts."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

STATE_FILE = ".state.json"


def state_path(sandbox_root: Path) -> Path:
    return sandbox_root / STATE_FILE


def save_state(sandbox_root: Path, state: dict[str, Any]) -> None:
    sandbox_root.mkdir(parents=True, exist_ok=True)
    state_path(sandbox_root).write_text(json.dumps(state, indent=2), encoding="utf-8")


def load_state(sandbox_root: Path) -> dict[str, Any]:
    p = state_path(sandbox_root)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
