import asyncio
import importlib.util
import json
import logging
import os
import sys
from pathlib import Path

try:
    import websockets
except ImportError:
    websockets = None

WS_PORT = int(os.environ.get("DECKY_WS_PORT", "8765"))
HTTP_PORT = int(os.environ.get("DECKY_HTTP_PORT", "8766"))
SANDBOX_ROOT = Path(os.environ.get("DECKY_SANDBOX_ROOT", Path.home() / ".decky-plugin-studio" / "sandbox" / "plugin"))
PLUGIN_ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DECKY_PLUGIN_ROOT", "."))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("decky-sidecar")

plugin_instance = None
hw_state = {
    "preset": "Idle",
    "cpuTemp": 42,
    "gpuTemp": 38,
    "battery": 87,
    "fanRpm": 1800,
    "tdp": 8,
    "cpuClock": 1400,
    "acPlugged": True,
    "dock": False,
}

def load_hw_state():
    global hw_state
    hw_file = Path(__file__).resolve().parent.parent / ".hw-state.json"
    if hw_file.exists():
        try:
            hw_state.update(json.loads(hw_file.read_text(encoding="utf-8")))
        except Exception:
            pass


def install_decky_shim():
    shim_root = Path(__file__).resolve().parent / "decky_shim"
    sys.path.insert(0, str(shim_root.parent))
    spec = importlib.util.spec_from_file_location("decky", shim_root / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    module.SANDBOX_ROOT = SANDBOX_ROOT
    module.PLUGIN_ROOT = PLUGIN_ROOT
    module.hw_state = hw_state
    sys.modules["decky"] = module
    spec.loader.exec_module(module)
    sys.modules["decky_shim"] = importlib.import_module("decky_shim")
    return module


def install_platform_stubs():
    if sys.platform == "win32" and "fcntl" not in sys.modules:
        import types

        fcntl_stub = types.ModuleType("fcntl")
        fcntl_stub.LOCK_EX = 2
        fcntl_stub.LOCK_NB = 4
        fcntl_stub.flock = lambda *args, **kwargs: None
        sys.modules["fcntl"] = fcntl_stub


async def load_plugin():
    global plugin_instance
    install_platform_stubs()
    py_modules = PLUGIN_ROOT / "py_modules"
    if py_modules.is_dir() and str(py_modules) not in sys.path:
        sys.path.insert(0, str(py_modules))
    if str(PLUGIN_ROOT) not in sys.path:
        sys.path.insert(0, str(PLUGIN_ROOT))
    shim = install_decky_shim()
    from decky_shim.state_io import load_state, save_state

    main_path = PLUGIN_ROOT / "main.py"
    if not main_path.exists():
        logger.warning("No main.py at %s", main_path)
        return None

    spec = importlib.util.spec_from_file_location("plugin_main", main_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    saved = load_state(SANDBOX_ROOT)
    if hasattr(mod, "Plugin"):
        plugin_instance = mod.Plugin()
        if saved:
            for k, v in saved.items():
                if hasattr(plugin_instance, k):
                    setattr(plugin_instance, k, v)
        if hasattr(plugin_instance, "_main"):
            await plugin_instance._main()
    return plugin_instance


async def teardown_plugin():
    global plugin_instance
    if plugin_instance is None:
        return
    from decky_shim.state_io import save_state

    state = {}
    for k, v in plugin_instance.__dict__.items():
        if k.startswith("_"):
            continue
        try:
            json.dumps(v)
            state[k] = v
        except TypeError:
            pass
    save_state(SANDBOX_ROOT, state)
    if hasattr(plugin_instance, "_unload"):
        try:
            result = plugin_instance._unload()
            if asyncio.iscoroutine(result):
                await result
        except Exception as exc:
            logger.error("unload failed: %s", exc)
    plugin_instance = None


async def handle_rpc(method, args):
    from decky_shim.rpc_allowlist import is_rpc_allowed

    if not is_rpc_allowed(method):
        return {"error": f"RPC method not allowlisted for preview: {method}"}
    if plugin_instance is None:
        await load_plugin()
    if plugin_instance is None:
        return {"error": "Plugin not loaded"}
    fn = getattr(plugin_instance, method, None)
    if fn is None:
        return {"error": f"Unknown method {method}"}
    result = fn(*args)
    if asyncio.iscoroutine(result):
        result = await result
    return {"result": result}


async def ws_handler(websocket):
    async for message in websocket:
        data = json.loads(message)
        if data.get("type") == "rpc":
            out = await handle_rpc(data.get("method"), data.get("args", []))
            if "error" in out:
                await websocket.send(json.dumps({"type": "rpc_result", "id": data["id"], "error": out["error"]}))
            else:
                await websocket.send(json.dumps({"type": "rpc_result", "id": data["id"], "result": out["result"]}))


async def handle_http(reader, writer):
    try:
        raw = await reader.read(65536)
        if not raw:
            writer.close()
            return
        head, _, body = raw.partition(b"\r\n\r\n")
        first = head.split(b"\r\n")[0].decode("utf-8", errors="replace")
        if "POST /rpc" not in first:
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        out = await handle_rpc(payload.get("method"), payload.get("args", []))
        body_out = json.dumps(out).encode("utf-8")
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/json\r\n"
            + f"Content-Length: {len(body_out)}\r\n\r\n".encode("utf-8")
            + body_out
        )
        await writer.drain()
    except Exception as exc:
        logger.error("HTTP handler error: %s", exc)
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def main():
    load_hw_state()
    SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)
    log_path = SANDBOX_ROOT / "plugin.log"
    if not log_path.exists():
        log_path.write_text("", encoding="utf-8")
    await load_plugin()
    if websockets is None:
        logger.error("websockets package required: pip install websockets")
        return
    http_server = await asyncio.start_server(handle_http, "127.0.0.1", HTTP_PORT)
    logger.info("Sidecar HTTP listening on http://127.0.0.1:%s/rpc", HTTP_PORT)
    async with websockets.serve(ws_handler, "127.0.0.1", WS_PORT):
        logger.info("Sidecar WS listening on ws://127.0.0.1:%s", WS_PORT)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
