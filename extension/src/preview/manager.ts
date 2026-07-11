import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { getPreviewServerRoot } from "../paths";
import { updateMcpState } from "../mcp/client";
import { startPreviewIpcBridge, stopPreviewIpcBridge } from "./ipcBridge";
import { syncRpcAllowlistForWorkspace } from "./syncRpcAllowlist";
import { getWebviewGamepadScript } from "./webviewGamepadScript";

const PREVIEW_STATE_PATH = path.join(os.homedir(), ".decky-plugin-studio", "preview-state.json");
const SIDECAR_HTTP_PORT = 8766;
const SIDECAR_WS_PORT = 8765;

function writePreviewState(state: {
  url: string;
  httpPort: number;
  wsPort: number;
  workspaceRoot: string;
}): void {
  fs.mkdirSync(path.dirname(PREVIEW_STATE_PATH), { recursive: true });
  fs.writeFileSync(PREVIEW_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export class PreviewManager {
  private panel: vscode.WebviewPanel | undefined;
  private viteProcess: cp.ChildProcess | null = null;
  private sidecarProcess: cp.ChildProcess | null = null;
  private previewUrl = "";
  private workspaceRoot = "";

  async open(workspaceRoot: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;

    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "deckyPreview",
      "Decky Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(getPreviewServerRoot()),
          vscode.Uri.file(path.join(getPreviewServerRoot(), "src")),
        ],
      }
    );

    this.panel.onDidDispose(() => {
      this.stop();
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "focusEvent") {
        // logged in webview console
      }
      if (msg.type === "runSequenceResult") {
        await vscode.commands.executeCommand("decky.refreshTree");
      }
    });

    await this.startServers();
    writePreviewState({
      url: this.previewUrl,
      httpPort: SIDECAR_HTTP_PORT,
      wsPort: SIDECAR_WS_PORT,
      workspaceRoot: this.workspaceRoot,
    });
    process.env.DECKY_PREVIEW_URL = this.previewUrl;
    this.render();
    startPreviewIpcBridge(this);
    updateMcpState({ previewRunning: true, previewUrl: this.previewUrl });
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  private async startServers(): Promise<void> {
    const previewRoot = getPreviewServerRoot();
    const port = 5173 + Math.floor(Math.random() * 1000);
    this.previewUrl = `http://127.0.0.1:${port}`;

    const viteBin = path.join(previewRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
    const viteCmd = fs.existsSync(viteBin) ? viteBin : "npx";

    this.viteProcess = cp.spawn(
      viteCmd,
      fs.existsSync(viteBin) ? ["--port", String(port), "--host", "127.0.0.1"] : ["vite", "--port", String(port), "--host", "127.0.0.1"],
      {
        cwd: previewRoot,
        env: {
          ...process.env,
          DECKY_PLUGIN_ROOT: this.workspaceRoot,
          DECKY_PREVIEW_PORT: String(port),
        },
        stdio: "pipe",
        shell: process.platform === "win32",
      }
    );

    const sidecarPath = path.join(previewRoot, "python", "sidecar.py");
    const sandboxRoot = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".decky-plugin-studio",
      "sandbox",
      path.basename(this.workspaceRoot)
    );
    syncRpcAllowlistForWorkspace(this.workspaceRoot);
    if (fs.existsSync(sidecarPath)) {
      this.sidecarProcess = cp.spawn("python", [sidecarPath, this.workspaceRoot], {
        cwd: previewRoot,
        env: {
          ...process.env,
          DECKY_PLUGIN_ROOT: this.workspaceRoot,
          DECKY_HTTP_PORT: String(SIDECAR_HTTP_PORT),
          DECKY_WS_PORT: String(SIDECAR_WS_PORT),
          DECKY_SANDBOX_ROOT: sandboxRoot,
        },
        stdio: "pipe",
      });
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  private render(): void {
    if (!this.panel) return;
    const framePath = vscode.Uri.file(
      path.join(__dirname, "..", "preview", "viewportFrame.html")
    );
    const frameUri = this.panel.webview.asWebviewUri(framePath);
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https: data:; script-src 'unsafe-inline' ${this.panel.webview.cspSource}; style-src 'unsafe-inline' ${this.panel.webview.cspSource}; frame-src ${this.previewUrl} http://127.0.0.1:*; connect-src ${this.previewUrl} ws://127.0.0.1:* http://127.0.0.1:*;`;

    this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    body { margin:0; padding:0; background:#1e1e1e; color:#d4d4d4; font-family:Segoe UI,sans-serif; height:100vh; display:flex; flex-direction:column; }
    .toolbar { display:flex; gap:8px; padding:8px; background:#252526; border-bottom:1px solid #3c3c3c; align-items:center; }
    .toolbar button { background:#333; color:#fff; border:1px solid #555; padding:4px 10px; border-radius:4px; cursor:pointer; }
    .toolbar button.active { background:#4ec9b0; color:#000; }
    .main { flex:1; display:flex; min-height:0; }
    .preview-col { flex:1; display:flex; flex-direction:column; min-width:0; }
    iframe { flex:1; border:none; background:#1b2838; }
    .hw-panel { width:280px; background:#252526; border-left:1px solid #3c3c3c; padding:12px; overflow:auto; font-size:12px; }
    .hw-panel h3 { margin:0 0 12px; font-size:11px; letter-spacing:1px; }
    .slider-row { margin-bottom:10px; }
    .slider-row label { display:flex; justify-content:space-between; margin-bottom:4px; }
    input[type=range] { width:100%; }
    .gamepad { display:flex; flex-direction:column; align-items:center; gap:8px; padding:8px; background:#252526; border-top:1px solid #3c3c3c; }
    .gamepad-controls { display:flex; justify-content:center; gap:24px; flex-wrap:wrap; width:100%; }
    .gamepad-meta { display:flex; align-items:center; gap:12px; font-size:11px; color:#9cdcfe; flex-wrap:wrap; justify-content:center; }
    .gamepad-meta label { display:flex; align-items:center; gap:4px; cursor:pointer; }
    #gamepadStatus { max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .dpad, .face { display:grid; gap:4px; }
    .dpad { grid-template-columns:repeat(3,32px); grid-template-rows:repeat(3,32px); }
    .face { grid-template-columns:repeat(3,36px); grid-template-rows:repeat(3,36px); }
    .gp-btn { border:none; border-radius:50%; cursor:pointer; font-weight:bold; }
    .console { max-height:120px; overflow:auto; background:#0d0d0d; font-family:monospace; font-size:10px; padding:6px; border-top:1px solid #333; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="active" id="modeQam">QAM</button>
    <button id="modeDesktop">Desktop</button>
    <button id="reload">Reload</button>
    <span style="flex:1"></span>
    <span id="status">Preview: ${this.previewUrl}</span>
  </div>
  <div class="main">
    <div class="preview-col">
      <iframe id="pluginFrame" src="${this.previewUrl}/sandbox-host.html?root=${encodeURIComponent(this.workspaceRoot)}"></iframe>
      <div class="gamepad">
        <div class="gamepad-meta">
          <span id="gamepadStatus">Controller: none</span>
          <label><input type="checkbox" id="physicalGamepadToggle" checked> Use physical controller</label>
        </div>
        <div class="gamepad-controls" id="gamepad"></div>
      </div>
      <div class="console" id="console"></div>
    </div>
    <div class="hw-panel" id="hwPanel"></div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const hwState = { preset:'Idle', cpuTemp:42, gpuTemp:38, battery:87, fanRpm:1800, tdp:8, cpuClock:1400, acPlugged:true, dock:false };
    const presets = {
      Idle: { cpuTemp:42, gpuTemp:38, battery:87, fanRpm:1800, tdp:8, cpuClock:1400, acPlugged:true },
      'Hot Game': { cpuTemp:85, gpuTemp:78, battery:32, fanRpm:4200, tdp:15, cpuClock:2800, acPlugged:false },
      'Low Battery': { cpuTemp:45, gpuTemp:40, battery:8, fanRpm:1200, tdp:5, cpuClock:1200, acPlugged:false },
    };
    function renderHw() {
      const el = document.getElementById('hwPanel');
      el.innerHTML = '<h3>HARDWARE SIMULATOR</h3>' +
        '<label>Preset <select id="preset">' + Object.keys(presets).map(p=>'<option'+((hwState.preset===p)?' selected':'')+'>'+p+'</option>').join('') + '</select></label>' +
        ['cpuTemp','gpuTemp','battery','fanRpm','tdp','cpuClock'].map(k=>{
          const labels = {cpuTemp:'CPU Temp',gpuTemp:'GPU Temp',battery:'Battery %',fanRpm:'Fan RPM',tdp:'TDP W',cpuClock:'CPU MHz'};
          const max = k==='battery'?100:k==='fanRpm'?6000:k==='cpuClock'?3500:100;
          return '<div class="slider-row"><label><span>'+labels[k]+'</span><span id="v_'+k+'">'+hwState[k]+'</span></label><input type="range" data-k="'+k+'" min="0" max="'+max+'" value="'+hwState[k]+'"></div>';
        }).join('') +
        '<label><input type="checkbox" id="acPlugged"'+(hwState.acPlugged?' checked':'')+'> AC Plugged</label> ' +
        '<label><input type="checkbox" id="dock"'+(hwState.dock?' checked':'')+'> Dock</label>' +
        '<div style="margin-top:12px;color:#6a9955">Ollama ● checking…</div>';
      el.querySelector('#preset').onchange = e => { Object.assign(hwState, presets[e.target.value]); hwState.preset=e.target.value; renderHw(); pushHw(); };
      el.querySelectorAll('input[type=range]').forEach(inp => inp.oninput = e => { hwState[e.target.dataset.k]=+e.target.value; document.getElementById('v_'+e.target.dataset.k).textContent=hwState[e.target.dataset.k]; pushHw(); });
      el.querySelector('#acPlugged').onchange = e => { hwState.acPlugged=e.target.checked; pushHw(); };
      el.querySelector('#dock').onchange = e => { hwState.dock=e.target.checked; pushHw(); };
    }
    function pushHw() {
      fetch('${this.previewUrl}/api/hw-state', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(hwState) }).catch(()=>{});
      vscode.postMessage({ type:'hwState', state: hwState });
    }
    function injectFocus(dir) {
      const frame = document.getElementById('pluginFrame');
      frame.contentWindow.postMessage({ type:'decky-focus', direction: dir }, '*');
      log('[FOCUS] inject ' + dir);
      vscode.postMessage({ type:'focusEvent', direction: dir });
    }
    function log(line) {
      const c = document.getElementById('console');
      c.textContent += new Date().toISOString().slice(11,23) + ' ' + line + '\\n';
      c.scrollTop = c.scrollHeight;
    }
    function renderGamepad() {
      const g = document.getElementById('gamepad');
      g.innerHTML = '<div class="dpad"><div></div><button class="gp-btn" data-d="Up">▲</button><div></div><button class="gp-btn" data-d="Left">◀</button><button class="gp-btn" data-d="Select">●</button><button class="gp-btn" data-d="Right">▶</button><div></div><button class="gp-btn" data-d="Down">▼</button><div></div></div>' +
        '<div><button class="gp-btn" data-d="Steam">Steam</button> <button class="gp-btn" data-d="QAM">QAM</button></div>' +
        '<div class="face"><div></div><button class="gp-btn" style="background:#ffd700" data-d="Y">Y</button><div></div><button class="gp-btn" style="background:#1e90ff;color:#fff" data-d="X">X</button><div></div><button class="gp-btn" style="background:#ff4040;color:#fff" data-d="B">B</button><div></div><button class="gp-btn" style="background:#4ade80" data-d="A">A</button><div></div></div>';
      g.querySelectorAll('[data-d]').forEach(b => b.onclick = () => injectFocus(b.dataset.d));
    }
    document.getElementById('reload').onclick = () => document.getElementById('pluginFrame').src = document.getElementById('pluginFrame').src;
    document.addEventListener('keydown', e => {
      const map = { ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right', Enter:'A', Escape:'B' };
      if (map[e.key]) { e.preventDefault(); injectFocus(map[e.key]); }
    });
    window.addEventListener('message', e => {
      if (e.data?.type === 'decky-log') log(e.data.line);
      if (e.data?.type === 'runSequenceDone') vscode.postMessage({ type:'runSequenceResult', result: e.data.result });
      if (e.data?.type === 'snapshotDomResult') vscode.postMessage({ type:'snapshotDomResult', result: e.data.result });
      if (e.data?.type === 'captureScreenshotResult') vscode.postMessage({ type:'captureScreenshotResult', result: e.data.result });
      if (e.data?.type === 'callTestHookResult') vscode.postMessage({ type:'callTestHookResult', result: e.data.result });
      if (e.data?.type === 'injectFocus') injectFocus(e.data.direction);
      if (e.data?.type === 'runSequence') {
        const frame = document.getElementById('pluginFrame');
        frame.contentWindow.postMessage({ type:'runSequence', inputs: e.data.inputs ?? [], delayMs: e.data.delayMs ?? 80 }, '*');
      }
      if (e.data?.type === 'snapshotDom') {
        const frame = document.getElementById('pluginFrame');
        frame.contentWindow.postMessage({ type:'snapshotDom', selector: e.data.selector }, '*');
      }
      if (e.data?.type === 'captureScreenshot') {
        const frame = document.getElementById('pluginFrame');
        frame.contentWindow.postMessage({ type:'captureScreenshot', selector: e.data.selector }, '*');
      }
      if (e.data?.type === 'callTestHook') {
        const frame = document.getElementById('pluginFrame');
        frame.contentWindow.postMessage({ type:'callTestHook', method: e.data.method, args: e.data.args ?? [] }, '*');
      }
    });
    ${getWebviewGamepadScript()}
    renderHw(); renderGamepad(); pushHw();
    fetch('http://127.0.0.1:11434/api/tags').then(r=>r.ok).then(ok=>{
      document.querySelector('.hw-panel div:last-child').textContent = ok ? 'Ollama ● reachable' : 'Ollama ○ not detected';
    }).catch(()=>{});
  </script>
</body>
</html>`;
  }

  injectFocus(direction: string): void {
    this.panel?.webview.postMessage({ type: "injectFocus", direction });
  }

  async runSequence(inputs: string[], delayMs = 80): Promise<unknown> {
    if (!this.panel) {
      throw new Error("Preview not open");
    }
    return this.waitForWebviewMessage("runSequenceResult", () => {
      this.panel!.webview.postMessage({ type: "runSequence", inputs, delayMs });
    });
  }

  async snapshotDom(opts: { selector?: string } = {}): Promise<unknown> {
    if (!this.panel) {
      throw new Error("Preview not open");
    }
    return this.waitForWebviewMessage("snapshotDomResult", () => {
      this.panel!.webview.postMessage({ type: "snapshotDom", selector: opts.selector });
    });
  }

  async captureScreenshot(opts: { selector?: string } = {}): Promise<unknown> {
    if (!this.panel) {
      throw new Error("Preview not open");
    }
    return this.waitForWebviewMessage("captureScreenshotResult", () => {
      this.panel!.webview.postMessage({ type: "captureScreenshot", selector: opts.selector });
    });
  }

  async callTestHook(method: string, args: unknown[] = []): Promise<unknown> {
    if (!this.panel) {
      throw new Error("Preview not open");
    }
    return this.waitForWebviewMessage("callTestHookResult", () => {
      this.panel!.webview.postMessage({ type: "callTestHook", method, args });
    });
  }

  private waitForWebviewMessage(
    resultType: string,
    trigger: () => void
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const disposable = this.panel!.webview.onDidReceiveMessage((msg) => {
        if (msg.type === resultType) {
          disposable.dispose();
          resolve(msg.result);
        }
      });
      trigger();
      setTimeout(() => {
        disposable.dispose();
        reject(new Error(`${resultType} timeout`));
      }, 120_000);
    });
  }

  stop(): void {
    stopPreviewIpcBridge();
    this.viteProcess?.kill();
    this.sidecarProcess?.kill();
    this.viteProcess = null;
    this.sidecarProcess = null;
    try {
      if (fs.existsSync(PREVIEW_STATE_PATH)) fs.unlinkSync(PREVIEW_STATE_PATH);
    } catch {
      /* ignore */
    }
    updateMcpState({ previewRunning: false, previewUrl: undefined });
  }
}
