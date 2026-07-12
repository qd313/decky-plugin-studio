"""Serve synthetic hardware values for sysfs/hwmon reads."""
from __future__ import annotations

import builtins
from typing import Any

_original_open = builtins.open
_hw_state: dict[str, Any] = {}


def _synthetic_for_path(path: str) -> str | None:
    p = path.replace("\\", "/")
    if "temp" in p and "hwmon" in p:
        if "gpu" in p.lower() or "edge" in p.lower():
            return str(int(_hw_state.get("gpuTemp", 38) * 1000))
        return str(int(_hw_state.get("cpuTemp", 42) * 1000))
    if "power_supply" in p and "capacity" in p:
        return str(int(_hw_state.get("battery", 87)))
    if "fan" in p and "input" in p:
        return str(int(_hw_state.get("fanRpm", 1800)))
    return None


class _SyntheticFile:
    def __init__(self, content: str):
        self._content = content

    def read(self):
        return self._content

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _patched_open(file, mode="r", *args, **kwargs):
    if isinstance(file, (str, bytes)):
        path = file.decode() if isinstance(file, bytes) else file
        if "r" in mode and not any(x in mode for x in ("b", "+", "w", "a")):
            val = _synthetic_for_path(path)
            if val is not None:
                return _SyntheticFile(val)
    return _original_open(file, mode, *args, **kwargs)


def install(hw_state: dict[str, Any]) -> None:
    global _hw_state
    _hw_state = hw_state
    builtins.open = _patched_open

    try:
        import psutil

        def fake_sensors_temperatures(fahrenheit=False):
            return {
                "coretemp": [
                    type("T", (), {"current": _hw_state.get("cpuTemp", 42), "label": "CPU"})()
                ]
            }

        def fake_battery():
            return type(
                "B",
                (),
                {
                    "percent": _hw_state.get("battery", 87),
                    "power_plugged": _hw_state.get("acPlugged", True),
                },
            )()

        psutil.sensors_temperatures = fake_sensors_temperatures
        psutil.sensors_battery = fake_battery
    except ImportError:
        pass
