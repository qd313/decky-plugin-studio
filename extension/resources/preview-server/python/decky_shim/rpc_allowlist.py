"""Load preview RPC allowlist from sandbox preview-rpc.json (written by MCP / extension)."""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("decky-sidecar.rpc_allowlist")

DEFAULT_DENYLIST = frozenset({"_main", "_unload", "_migration"})


def _sandbox_rpc_path() -> Path:
    import os

    sandbox = Path(os.environ.get("DECKY_SANDBOX_ROOT", Path.home() / ".decky-plugin-studio" / "sandbox" / "plugin"))
    return sandbox / "preview-rpc.json"


def load_rpc_policy() -> tuple[str, frozenset[str], frozenset[str]]:
    """
    Returns (rpc_mode, allowed_set, denylist).
    allowed_set contains '*' when dev mode allows all non-denied methods.
    """
    path = _sandbox_rpc_path()
    if not path.exists():
        logger.warning("No preview-rpc.json at %s — denying all RPC until synced", path)
        return "missing", frozenset(), DEFAULT_DENYLIST

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.error("Failed to read preview-rpc.json: %s", exc)
        return "error", frozenset(), DEFAULT_DENYLIST

    mode = str(data.get("rpcMode", "discover"))
    deny = frozenset(data.get("denylist", [])) | DEFAULT_DENYLIST
    allowed_raw = data.get("allowed", [])
    allowed = frozenset(allowed_raw) if isinstance(allowed_raw, list) else frozenset()

    if mode == "dev":
        return "dev", frozenset({"*"}), deny

    return mode, allowed, deny


def is_rpc_allowed(method: str) -> bool:
    if not method or method.startswith("_"):
        return False
    mode, allowed, deny = load_rpc_policy()
    if method in deny:
        return False
    if mode == "dev" or "*" in allowed:
        return True
    if mode == "missing":
        return False
    return method in allowed
