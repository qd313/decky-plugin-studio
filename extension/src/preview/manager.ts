import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as net from "net";
import * as http from "http";
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True if nothing is currently bound to the port on loopback. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Pick a free port instead of guessing. The previous implementation was
 * `5173 + random(1000)` with no check at all, so two previews — or any other
 * Vite server on the machine — could silently collide.
 */
async function findFreePort(base: number, span: number, attempts = 40): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = base + Math.floor(Math.random() * span);
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in ${base}-${base + span} after ${attempts} attempts`);
}

function probeHttp(url: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function probeTcp(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 150
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
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
    const port = await findFreePort(5173, 1000);
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

    // Wait for readiness rather than sleeping a fixed 1500ms and hoping. On a
    // cold Vite start that sleep was too short (blank iframe); on a warm one it
    // was pure latency.
    const viteReady = await waitUntil(
      () => probeHttp(`${this.previewUrl}/sandbox-host.html`),
      20_000
    );
    if (!viteReady) {
      vscode.window.showWarningMessage(
        `Decky preview: Vite did not respond on ${this.previewUrl} within 20s. The panel may be blank — check the Output panel and try Reload.`
      );
    }

    // The sidecar speaks raw "POST /rpc" only, so there is no health URL to GET.
    // A TCP connect is the honest readiness signal.
    if (this.sidecarProcess) {
      const sidecarReady = await waitUntil(() => probeTcp(SIDECAR_HTTP_PORT), 15_000);
      if (!sidecarReady) {
        vscode.window.showWarningMessage(
          `Decky preview: Python sidecar not listening on ${SIDECAR_HTTP_PORT}. RPC calls to main.py will fail. Is python on PATH?`
        );
      }
    }
  }

  private render(): void {
    if (!this.panel) return;
    // The same token + control sheets the sandboxed iframe loads. Sharing them
    // is what keeps the chrome and the plugin content in one design system
    // instead of the VS Code gray / Steam blue split they used to have.
    // No CSP change needed: these resolve under `webview.cspSource`, and
    // localResourceRoots already covers getPreviewServerRoot().
    const styleDir = path.join(getPreviewServerRoot(), "src", "styles");
    const tokensUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(styleDir, "tokens.css"))
    );
    const controlsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(styleDir, "controls.css"))
    );
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https: data:; script-src 'unsafe-inline' ${this.panel.webview.cspSource}; style-src 'unsafe-inline' ${this.panel.webview.cspSource}; frame-src ${this.previewUrl} http://127.0.0.1:*; connect-src ${this.previewUrl} ws://127.0.0.1:* http://127.0.0.1:*;`;

    this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${tokensUri}">
  <link rel="stylesheet" href="${controlsUri}">
  <style>
    /* decky-theme.css sets this for the iframe, but the chrome only loads
       tokens + controls. Without it the stage's 1px border pushes the device
       frame to 1282x802 and the flyout to 401 — geometry that is supposed to be
       exact. */
    *, *::before, *::after { box-sizing: border-box; }

    body {
      margin:0; padding:0; height:100vh;
      background:var(--decky-bg-deep); color:var(--decky-text);
      font-family:var(--decky-font); font-size:13px;
      display:flex; flex-direction:column;
      -webkit-font-smoothing:antialiased;
    }

    /* ---- Toolbar ---- */
    .toolbar {
      display:flex; gap:6px; padding:8px 10px; align-items:center;
      background:var(--decky-grad-chrome);
      border-bottom:1px solid var(--decky-border);
    }
    .toolbar button {
      background:var(--decky-bg-row); color:var(--decky-text);
      border:1px solid var(--decky-border-strong);
      padding:5px 12px; border-radius:var(--decky-radius);
      font-family:inherit; font-size:12px; cursor:pointer;
      transition:background 90ms ease-out, color 90ms ease-out;
    }
    .toolbar button:hover { background:var(--decky-bg-raised); color:var(--decky-text-strong); }
    .toolbar button.active {
      background:var(--decky-grad-btn); color:var(--decky-text-strong);
      border-color:transparent; box-shadow:0 0 0 1px var(--decky-accent-glow);
    }
    .toolbar .status {
      font-family:var(--decky-font-mono); font-size:11px; color:var(--decky-text-dim);
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:40%;
    }

    .main { flex:1; display:flex; min-height:0; }
    .preview-col { flex:1; display:flex; flex-direction:column; min-width:0; }

    /* ---- Device stage ----
       The stage is a fixed 1280x800 Deck panel; it is SCALED to fit, never
       resized, so plugin content always sees true device geometry. */
    .qam-stage-wrap {
      position:relative; flex:1; min-height:0; overflow:hidden;
      background:radial-gradient(ellipse at 35% 35%, #16202b 0%, #070a0d 75%);
    }
    .qam-stage {
      position:absolute; left:50%; top:50%;
      width:var(--decky-stage-w); height:var(--decky-stage-h);
      transform:translate(-50%,-50%) scale(var(--stage-scale,1));
      transform-origin:center center;
      background:linear-gradient(135deg,#16202b 0%,#0b1117 100%);
      border:1px solid var(--decky-border);
      border-radius:var(--decky-radius-lg);
      overflow:hidden;
      box-shadow:0 10px 48px rgba(0,0,0,0.7);
    }
    /* Stand-in for the game/library behind the QAM, so the flyout reads as an
       overlay rather than the whole screen. */
    .qam-stage::before {
      content:""; position:absolute; inset:0;
      background:
        linear-gradient(180deg, rgba(26,159,255,0.05) 0%, transparent 55%),
        repeating-linear-gradient(115deg, rgba(255,255,255,0.014) 0 2px, transparent 2px 9px);
      pointer-events:none;
    }
    .qam-stage__label {
      position:absolute; left:14px; top:12px;
      font-size:11px; letter-spacing:0.14em; text-transform:uppercase;
      color:var(--decky-text-dim); opacity:0.5; pointer-events:none;
    }
    .qam-flyout {
      position:absolute; top:0; right:0; bottom:0;
      width:var(--decky-qam-w);
      display:flex;
      background:var(--decky-bg-deep);
      border-left:1px solid var(--decky-accent);
      box-shadow:-16px 0 40px rgba(0,0,0,0.75);
    }
    .qam-flyout iframe { flex:1; width:100%; height:100%; border:none; background:var(--decky-bg-deep); }
    /* Desktop mode: same stage, flyout expanded to the full panel. */
    .qam-stage.desktop .qam-flyout {
      inset:0; width:auto; border-left:none; box-shadow:none;
    }
    .qam-stage.desktop .qam-stage__label { display:none; }

    /* ---- Hardware simulator ---- */
    .hw-panel {
      width:280px; flex-shrink:0; overflow:auto; padding:12px 14px; font-size:12px;
      background:var(--decky-grad-chrome);
      border-left:1px solid var(--decky-border);
    }
    .hw-panel h3 {
      margin:0 0 12px; padding-bottom:6px;
      font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase;
      color:var(--decky-text-dim);
      border-bottom:1px solid var(--decky-border);
    }
    .hw-panel > label { display:block; margin-bottom:12px; }
    .hw-toggles { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
    .hw-toggles label { display:flex; align-items:center; gap:8px; cursor:pointer; }
    .slider-row { margin-bottom:12px; }
    .slider-row label { display:flex; justify-content:space-between; margin-bottom:4px; }
    .slider-row label span:last-child {
      color:var(--decky-accent-hi); font-variant-numeric:tabular-nums;
    }
    .hw-status {
      margin-top:16px; padding-top:10px; font-size:11px;
      border-top:1px solid var(--decky-border); color:var(--decky-text-dim);
    }
    .hw-status.ok { color:var(--decky-success); }
    .hw-status.off { color:var(--decky-text-dim); }

    /* ---- Gamepad tray ---- */
    .gamepad {
      display:flex; flex-direction:column; align-items:center; gap:10px;
      padding:10px 8px;
      background:var(--decky-grad-chrome);
      border-top:1px solid var(--decky-border);
    }
    .gamepad-controls { display:flex; justify-content:center; align-items:center; gap:28px; flex-wrap:wrap; width:100%; }
    .gamepad-meta {
      display:flex; align-items:center; gap:12px; font-size:11px;
      color:var(--decky-text-dim); flex-wrap:wrap; justify-content:center;
    }
    .gamepad-meta label { display:flex; align-items:center; gap:6px; cursor:pointer; }
    #gamepadStatus { max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #gamepadStatus.connected { color:var(--decky-success); }
    .dpad, .face { display:grid; gap:4px; }
    .dpad { grid-template-columns:repeat(3,30px); grid-template-rows:repeat(3,30px); }
    .face { grid-template-columns:repeat(3,34px); grid-template-rows:repeat(3,34px); }
    .gp-btn {
      border:1px solid var(--decky-border-strong); border-radius:50%;
      background:var(--decky-bg-row); color:var(--decky-text);
      cursor:pointer; font-family:inherit; font-weight:700; font-size:12px;
      display:flex; align-items:center; justify-content:center;
      transition:transform 60ms ease-out, box-shadow 90ms ease-out, filter 90ms ease-out;
    }
    .gp-btn:hover { filter:brightness(1.25); }
    .gp-btn:active, .gp-btn.pressed {
      transform:scale(0.9);
      box-shadow:0 0 0 3px var(--decky-accent-glow);
    }
    .gp-sys { display:flex; gap:8px; }
    .gp-sys .gp-btn {
      border-radius:var(--decky-radius); width:auto; padding:0 12px; height:28px;
      font-size:11px; letter-spacing:0.06em; text-transform:uppercase;
    }
    .gp-a { background:var(--decky-glyph-a); color:#fff; border-color:transparent; }
    .gp-b { background:var(--decky-glyph-b); color:#fff; border-color:transparent; }
    .gp-x { background:var(--decky-glyph-x); color:#fff; border-color:transparent; }
    .gp-y { background:var(--decky-glyph-y); color:#20160a; border-color:transparent; }

    /* ---- Log console ---- */
    .console {
      max-height:120px; overflow:auto; padding:6px 8px;
      background:var(--decky-bg-sunken);
      font-family:var(--decky-font-mono); font-size:11px; line-height:1.5;
      border-top:1px solid var(--decky-border);
    }
    .log-line { white-space:pre-wrap; word-break:break-word; }
    .log-line .ts { color:var(--decky-text-dim); opacity:0.65; margin-right:8px; }
    .lvl-info  { color:var(--decky-text); }
    .lvl-focus { color:var(--decky-accent-hi); }
    .lvl-warn  { color:var(--decky-warn); }
    .lvl-error { color:var(--decky-danger); }

    @media (prefers-reduced-motion: reduce) {
      .toolbar button, .gp-btn { transition:none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="active" id="modeQam">QAM</button>
    <button id="modeDesktop">Desktop</button>
    <button id="reload">Reload</button>
    <span style="flex:1"></span>
    <span class="status" id="status">${this.previewUrl}</span>
  </div>
  <div class="main">
    <div class="preview-col">
      <div class="qam-stage-wrap" id="stageWrap">
        <div class="qam-stage" id="stage">
          <div class="qam-stage__label">Steam Deck &middot; 1280 &times; 800</div>
          <div class="qam-flyout">
            <iframe id="pluginFrame" src="${this.previewUrl}/sandbox-host.html?root=${encodeURIComponent(this.workspaceRoot)}"></iframe>
          </div>
        </div>
      </div>
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
      el.innerHTML = '<h3>Hardware Simulator</h3>' +
        '<label><span class="decky-field-label">Preset</span><select id="preset">' + Object.keys(presets).map(p=>'<option'+((hwState.preset===p)?' selected':'')+'>'+p+'</option>').join('') + '</select></label>' +
        ['cpuTemp','gpuTemp','battery','fanRpm','tdp','cpuClock'].map(k=>{
          const labels = {cpuTemp:'CPU Temp',gpuTemp:'GPU Temp',battery:'Battery %',fanRpm:'Fan RPM',tdp:'TDP W',cpuClock:'CPU MHz'};
          const max = k==='battery'?100:k==='fanRpm'?6000:k==='cpuClock'?3500:100;
          return '<div class="slider-row"><label><span>'+labels[k]+'</span><span id="v_'+k+'">'+hwState[k]+'</span></label><input type="range" data-k="'+k+'" min="0" max="'+max+'" value="'+hwState[k]+'"></div>';
        }).join('') +
        '<div class="hw-toggles">' +
        '<label><input type="checkbox" id="acPlugged"'+(hwState.acPlugged?' checked':'')+'> AC Plugged</label>' +
        '<label><input type="checkbox" id="dock"'+(hwState.dock?' checked':'')+'> Dock</label>' +
        '</div>' +
        // Addressed by id, not by position. This used to be found via
        // a .hw-panel div:last-child selector, which broke on any markup change.
        '<div class="hw-status" id="ollamaStatus">Ollama &#9679; checking&hellip;</div>';
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
      if (!c) return;
      const lvl = /\\[ERROR\\]/.test(line) ? 'lvl-error'
        : /\\[WARN\\]/.test(line) ? 'lvl-warn'
        : /\\[FOCUS\\]/.test(line) ? 'lvl-focus'
        : 'lvl-info';
      const row = document.createElement('div');
      row.className = 'log-line ' + lvl;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = new Date().toISOString().slice(11,23);
      row.appendChild(ts);
      row.appendChild(document.createTextNode(line));
      c.appendChild(row);
      // The old implementation appended to textContent forever; a long session
      // could grow the console unbounded.
      while (c.childElementCount > 500) c.removeChild(c.firstChild);
      c.scrollTop = c.scrollHeight;
    }
    function renderGamepad() {
      const g = document.getElementById('gamepad');
      g.innerHTML = '<div class="dpad"><div></div><button class="gp-btn" data-d="Up">&#9650;</button><div></div><button class="gp-btn" data-d="Left">&#9664;</button><button class="gp-btn" data-d="Select">&#9679;</button><button class="gp-btn" data-d="Right">&#9654;</button><div></div><button class="gp-btn" data-d="Down">&#9660;</button><div></div></div>' +
        '<div class="gp-sys"><button class="gp-btn" data-d="Steam">Steam</button><button class="gp-btn" data-d="QAM">QAM</button></div>' +
        '<div class="face"><div></div><button class="gp-btn gp-y" data-d="Y">Y</button><div></div><button class="gp-btn gp-x" data-d="X">X</button><div></div><button class="gp-btn gp-b" data-d="B">B</button><div></div><button class="gp-btn gp-a" data-d="A">A</button><div></div></div>';
      g.querySelectorAll('[data-d]').forEach(b => b.onclick = () => injectFocus(b.dataset.d));
    }
    /* Flash the on-screen button matching a direction, so keyboard and physical
       pad input are visible in the tray too. */
    function flashButton(dir) {
      const b = document.querySelector('[data-d="' + dir + '"]');
      if (!b) return;
      b.classList.add('pressed');
      setTimeout(() => b.classList.remove('pressed'), 120);
    }
    /* Scale the fixed 1280x800 stage to fit the panel. The stage keeps its real
       pixel size so plugin content always lays out at device geometry. */
    function fitStage() {
      const wrap = document.getElementById('stageWrap');
      const stage = document.getElementById('stage');
      if (!wrap || !stage) return;
      // Before first layout the wrap reports 0, which would pin the stage at the
      // clamp floor and leave it there. Skip until it has a real box; the
      // ResizeObserver below fires again as soon as it does.
      if (!wrap.clientWidth || !wrap.clientHeight) return;
      const pad = 24;
      const sw = stage.offsetWidth || 1280;
      const sh = stage.offsetHeight || 800;
      const s = Math.min((wrap.clientWidth - pad) / sw, (wrap.clientHeight - pad) / sh);
      stage.style.setProperty('--stage-scale', String(Math.max(0.1, Math.min(1, s))));
    }
    function setMode(mode) {
      const stage = document.getElementById('stage');
      if (!stage) return;
      stage.classList.toggle('desktop', mode === 'desktop');
      document.getElementById('modeQam').classList.toggle('active', mode === 'qam');
      document.getElementById('modeDesktop').classList.toggle('active', mode === 'desktop');
      log('[INFO] view mode: ' + mode);
      fitStage();
    }
    // These two buttons existed and were styled but were never wired to
    // anything — clicking them did nothing at all.
    document.getElementById('modeQam').onclick = () => setMode('qam');
    document.getElementById('modeDesktop').onclick = () => setMode('desktop');
    // A ResizeObserver on the wrap, not a window resize listener: it fires on
    // first real layout AND when the VS Code editor split is dragged, which does
    // not always emit a window resize.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(fitStage).observe(document.getElementById('stageWrap'));
    } else {
      window.addEventListener('resize', fitStage);
    }
    document.getElementById('reload').onclick = () => document.getElementById('pluginFrame').src = document.getElementById('pluginFrame').src;
    document.addEventListener('keydown', e => {
      const map = { ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right', Enter:'A', Escape:'B' };
      if (map[e.key]) { e.preventDefault(); injectFocus(map[e.key]); flashButton(map[e.key]); }
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
    renderHw(); renderGamepad(); pushHw(); setMode('qam'); fitStage();
    function setOllamaStatus(ok) {
      const el = document.getElementById('ollamaStatus');
      if (!el) return;
      el.textContent = ok ? 'Ollama \\u25cf reachable' : 'Ollama \\u25cb not detected';
      el.className = 'hw-status ' + (ok ? 'ok' : 'off');
    }
    fetch('http://127.0.0.1:11434/api/tags')
      .then(r => setOllamaStatus(r.ok))
      .catch(() => setOllamaStatus(false));
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
