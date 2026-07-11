"""HTTP allowlist for local AI (Ollama / LM Studio) in preview."""
from __future__ import annotations

import os
import urllib.error
import urllib.request

DEFAULT_ALLOW = {"127.0.0.1:11434", "127.0.0.1:1234", "localhost:11434", "localhost:1234"}
_original_urlopen = urllib.request.urlopen


def _allowed(url: str) -> bool:
    extra = os.environ.get("DECKY_PREVIEW_HTTP_ALLOW", "")
    allow = set(DEFAULT_ALLOW)
    for part in extra.split(","):
        part = part.strip()
        if part:
            allow.add(part)
    for hostport in allow:
        if hostport in url:
            return True
    return False


def _patched_urlopen(url, *args, **kwargs):
    url_str = url.full_url if hasattr(url, "full_url") else str(url)
    if _allowed(url_str):
        return _original_urlopen(url, *args, **kwargs)
    raise urllib.error.URLError(f"Preview sandbox blocked HTTP to {url_str}")


def install() -> None:
    urllib.request.urlopen = _patched_urlopen

    try:
        import requests

        orig = requests.sessions.Session.request

        def guarded(self, method, url, *args, **kwargs):
            if _allowed(url):
                return orig(self, method, url, *args, **kwargs)
            raise requests.exceptions.ConnectionError(f"Preview sandbox blocked HTTP to {url}")

        requests.sessions.Session.request = guarded
    except ImportError:
        pass
