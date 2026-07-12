"""Decky runtime shim for preview sidecar."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

SANDBOX_ROOT = Path(os.environ.get("DECKY_SANDBOX_ROOT", Path.home() / ".decky-plugin-studio" / "sandbox" / "plugin"))
PLUGIN_ROOT = Path(os.environ.get("DECKY_PLUGIN_ROOT", "."))
PLUGIN_NAME = os.environ.get("DECKY_PLUGIN_NAME", PLUGIN_ROOT.name)

HOME = str(Path.home())
USER = os.environ.get("USER", "deck")
DECKY_VERSION = "v3.0.0-preview"
DECKY_USER = USER
DECKY_USER_HOME = HOME
DECKY_HOME = str(Path(HOME) / "homebrew")
DECKY_PLUGIN_DIR = str(PLUGIN_ROOT)
DECKY_PLUGIN_NAME = PLUGIN_NAME
DECKY_PLUGIN_VERSION = "0.0.1"
DECKY_PLUGIN_AUTHOR = "preview"
DECKY_PLUGIN_SETTINGS_DIR = str(SANDBOX_ROOT / "settings")
DECKY_PLUGIN_RUNTIME_DIR = str(SANDBOX_ROOT / "data")
DECKY_PLUGIN_LOG_DIR = str(SANDBOX_ROOT / "logs")
DECKY_PLUGIN_LOG = str(SANDBOX_ROOT / "logs" / "plugin.log")

for d in (DECKY_PLUGIN_SETTINGS_DIR, DECKY_PLUGIN_RUNTIME_DIR, DECKY_PLUGIN_LOG_DIR):
    Path(d).mkdir(parents=True, exist_ok=True)

logger = logging.getLogger("decky")
if not logger.handlers:
    handler = logging.FileHandler(DECKY_PLUGIN_LOG, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

# Sidecar may inject a populated dict before exec_module; preserve that reference.
_existing_hw = globals().get("hw_state")
hw_state: dict[str, Any] = _existing_hw if isinstance(_existing_hw, dict) else {}

_emit_handlers: list = []


def register_emit_handler(fn):
    _emit_handlers.append(fn)


async def emit(event: str, *args: Any) -> None:
    for h in _emit_handlers:
        h(event, args)


def migrate_any(target_dir: str, *files_or_directories: str) -> dict[str, str]:
    return {}


def migrate_settings(*files_or_directories: str) -> dict[str, str]:
    return migrate_any(DECKY_PLUGIN_SETTINGS_DIR, *files_or_directories)


def migrate_runtime(*files_or_directories: str) -> dict[str, str]:
    return migrate_any(DECKY_PLUGIN_RUNTIME_DIR, *files_or_directories)


def migrate_logs(*files_or_directories: str) -> dict[str, str]:
    return migrate_any(DECKY_PLUGIN_LOG_DIR, *files_or_directories)


# Install interceptors on import
from . import hwmon_intercept, http_allowlist  # noqa: E402

hwmon_intercept.install(hw_state)
http_allowlist.install()
