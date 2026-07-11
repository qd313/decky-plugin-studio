import React from "react";
import { createRoot } from "react-dom/client";
import { bindFocusGraphKeyboard } from "./focusGraph";
import {
  clearFocusEventLog,
  getActiveFocusSelector,
  getFocusEventLog,
} from "./shim/focusManager";
import pluginMod from "@decky-plugin-entry";

declare global {
  interface Window {
    __DECKY_PREVIEW__?: boolean;
    __deckyPreviewTestHooks?: Record<string, unknown>;
    /** @deprecated use __deckyPreviewTestHooks */
    __bonsaiTestHooks?: Record<string, unknown>;
  }
}

function getPreviewTestHooks(): Record<string, (...a: unknown[]) => unknown> | undefined {
  const w = window as Window & {
    __deckyPreviewTestHooks?: Record<string, (...a: unknown[]) => unknown>;
    __bonsaiTestHooks?: Record<string, (...a: unknown[]) => unknown>;
  };
  return w.__deckyPreviewTestHooks ?? w.__bonsaiTestHooks;
}

bindFocusGraphKeyboard();
window.__DECKY_PREVIEW__ = true;

const params = new URLSearchParams(location.search);
const pluginRoot = params.get("root") ?? import.meta.env.DECKY_PLUGIN_ROOT;
const pluginEntry = import.meta.env.DECKY_PLUGIN_ENTRY ?? `${pluginRoot}/src/index.tsx`;

function captureDomSnapshot(selector?: string): { html: string; activeElement: string } {
  const target = selector ? document.querySelector(selector) : document.getElementById("root");
  const html = (target ?? document.body).innerHTML.slice(0, 8000);
  return { html, activeElement: getActiveFocusSelector() };
}

async function capturePngFallback(selector?: string): Promise<{ pngBase64?: string; htmlFallback?: string }> {
  const target = (selector ? document.querySelector(selector) : document.getElementById("root")) as HTMLElement | null;
  if (!target) {
    return { htmlFallback: "<!-- no target -->" };
  }
  const htmlFallback = target.innerHTML.slice(0, 4000);
  try {
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(target, {
      backgroundColor: "#1b2838",
      scale: Math.min(2, window.devicePixelRatio || 1),
      logging: false,
      useCORS: true,
      allowTaint: true,
      ignoreElements: (el) => el.tagName === "IFRAME",
    });
    const dataUrl = canvas.toDataURL("image/png");
    const pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    return { pngBase64, htmlFallback };
  } catch {
    try {
      const canvas = document.createElement("canvas");
      const rect = target.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width));
      canvas.height = Math.max(1, Math.floor(rect.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas context");
      ctx.fillStyle = "#1b2838";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#c7d5e0";
      ctx.font = "12px monospace";
      ctx.fillText("Decky preview snapshot (placeholder)", 12, 24);
      ctx.fillText(`${canvas.width}x${canvas.height}`, 12, 44);
      const dataUrl = canvas.toDataURL("image/png");
      const pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      return { pngBase64, htmlFallback };
    } catch {
      return { htmlFallback: target.innerHTML.slice(0, 8000) };
    }
  }
}

async function mount() {
  const rootEl = document.getElementById("root")!;
  try {
    const mod = pluginMod as { name?: string; content?: React.ReactNode };
    const PluginContent = mod?.content ?? mod;
    createRoot(rootEl).render(
      <div className="decky-qam-scope">
        {typeof PluginContent === "function" ? <PluginContent /> : PluginContent}
      </div>
    );
    window.parent.postMessage({ type: "decky-log", line: "[INFO] plugin mounted" }, "*");
  } catch (err) {
    rootEl.innerHTML = `<div class="loading">Preview error: ${String(err)}<br><small>${pluginEntry}</small></div>`;
    window.parent.postMessage({ type: "decky-log", line: `[ERROR] ${err}` }, "*");
  }

  window.addEventListener("message", async (e) => {
    if (e.data?.type === "runSequence") {
      const inputs: string[] = e.data.inputs ?? [];
      clearFocusEventLog();
      for (const dir of inputs) {
        window.postMessage({ type: "decky-focus", direction: dir }, "*");
        await new Promise((r) => setTimeout(r, e.data.delayMs ?? 80));
      }
      const snap = captureDomSnapshot();
      const result = {
        focusPath: getFocusEventLog().length ? getFocusEventLog() : inputs.map((d) => `onMove(${d})`),
        activeElement: snap.activeElement,
        domSnapshot: snap.html,
      };
      window.parent.postMessage({ type: "runSequenceDone", result }, "*");
      return;
    }

    if (e.data?.type === "snapshotDom") {
      const snap = captureDomSnapshot(e.data.selector);
      window.parent.postMessage({ type: "snapshotDomResult", result: snap }, "*");
      return;
    }

    if (e.data?.type === "captureScreenshot") {
      const shot = await capturePngFallback(e.data.selector);
      window.parent.postMessage({ type: "captureScreenshotResult", result: shot }, "*");
      return;
    }

    if (e.data?.type === "callTestHook") {
      const hooks = getPreviewTestHooks();
      const fn = hooks?.[e.data.method as string];
      if (typeof fn !== "function") {
        window.parent.postMessage(
          { type: "callTestHookResult", result: { ok: false, error: `Unknown preview hook: ${e.data.method}` } },
          "*"
        );
        return;
      }
      try {
        const out = await fn(...(e.data.args ?? []));
        window.parent.postMessage({ type: "callTestHookResult", result: { ok: true, value: out } }, "*");
      } catch (err) {
        window.parent.postMessage(
          { type: "callTestHookResult", result: { ok: false, error: String(err) } },
          "*"
        );
      }
    }
  });
}

mount();
