/**
 * Inline script injected into the preview webview for W3C Gamepad API polling.
 * Kept in a separate module so manager.ts stays readable.
 */
export function getWebviewGamepadScript(): string {
  return `
    (function initPhysicalGamepad() {
      const BUTTON_MAP = {
        12: 'Up',
        13: 'Down',
        14: 'Left',
        15: 'Right',
        0: 'A',
        1: 'B',
        8: 'Select',
      };
      const AXIS_DEADZONE = 0.5;
      let physicalEnabled = true;
      let pollActive = false;
      let rafId = 0;
      let preferredIndex = -1;
      let activationHintShown = false;
      const prevButtons = new Map();
      const prevAxisDirs = new Map();

      function updateStatus(label, detail) {
        const el = document.getElementById('gamepadStatus');
        if (!el) return;
        el.textContent = label;
        el.title = detail || label;
      }

      function pickGamepad(pads) {
        if (preferredIndex >= 0 && pads[preferredIndex]) return pads[preferredIndex];
        for (let i = 0; i < pads.length; i++) {
          if (pads[i]) return pads[i];
        }
        return null;
      }

      function axisDirection(axisX, axisY) {
        const dirs = [];
        if (axisY <= -AXIS_DEADZONE) dirs.push('Up');
        if (axisY >= AXIS_DEADZONE) dirs.push('Down');
        if (axisX <= -AXIS_DEADZONE) dirs.push('Left');
        if (axisX >= AXIS_DEADZONE) dirs.push('Right');
        return dirs;
      }

      function readAxisPairs(pad) {
        const pairs = [];
        if (pad.axes.length >= 8) pairs.push([pad.axes[6], pad.axes[7]]);
        if (pad.axes.length >= 10) pairs.push([pad.axes[8], pad.axes[9]]);
        if (pad.axes.length >= 2 && pairs.length === 0) pairs.push([pad.axes[0], pad.axes[1]]);
        return pairs;
      }

      function pollGamepads() {
        rafId = 0;
        if (!physicalEnabled || document.visibilityState !== 'visible') {
          if (pollActive) schedulePoll();
          return;
        }

        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        const pad = pickGamepad(pads);
        if (!pad) {
          updateStatus('Controller: none', 'Connect a standard gamepad (XInput/DirectInput).');
          prevButtons.clear();
          prevAxisDirs.clear();
          schedulePoll();
          return;
        }

        updateStatus('Controller: ' + (pad.id || ('Gamepad ' + pad.index)), pad.id || '');
        const prev = prevButtons.get(pad.index) || [];

        for (const [btnIndex, dir] of Object.entries(BUTTON_MAP)) {
          const idx = Number(btnIndex);
          const pressed = Boolean(pad.buttons[idx]?.pressed);
          if (pressed && !prev[idx]) injectFocus(dir);
        }

        const activeDirs = new Set();
        for (const [x, y] of readAxisPairs(pad)) {
          for (const dir of axisDirection(x, y)) activeDirs.add(dir);
        }
        const prevDirs = prevAxisDirs.get(pad.index) || new Set();
        for (const dir of activeDirs) {
          if (!prevDirs.has(dir)) injectFocus(dir);
        }

        prevButtons.set(
          pad.index,
          pad.buttons.map((b) => Boolean(b?.pressed))
        );
        prevAxisDirs.set(pad.index, activeDirs);
        schedulePoll();
      }

      function schedulePoll() {
        if (!pollActive) return;
        if (!rafId) rafId = requestAnimationFrame(pollGamepads);
      }

      function startPolling() {
        if (pollActive) return;
        pollActive = true;
        schedulePoll();
      }

      function stopPolling() {
        pollActive = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
      }

      window.addEventListener('gamepadconnected', (e) => {
        preferredIndex = e.gamepad.index;
        log('[GAMEPAD] connected: ' + e.gamepad.id);
        if (!activationHintShown) {
          log('[GAMEPAD] Press any controller button while this panel is focused.');
          activationHintShown = true;
        }
        startPolling();
      });

      window.addEventListener('gamepaddisconnected', (e) => {
        log('[GAMEPAD] disconnected: ' + e.gamepad.id);
        prevButtons.delete(e.gamepad.index);
        prevAxisDirs.delete(e.gamepad.index);
        if (preferredIndex === e.gamepad.index) preferredIndex = -1;
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        if (!pickGamepad(pads)) {
          stopPolling();
          updateStatus('Controller: none', 'Connect a standard gamepad (XInput/DirectInput).');
        }
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && pickGamepad(navigator.getGamepads?.() || [])) {
          startPolling();
        }
      });

      const toggle = document.getElementById('physicalGamepadToggle');
      if (toggle) {
        toggle.checked = physicalEnabled;
        toggle.onchange = () => {
          physicalEnabled = toggle.checked;
          if (physicalEnabled && pickGamepad(navigator.getGamepads?.() || [])) startPolling();
          else if (!physicalEnabled) stopPolling();
          log('[GAMEPAD] physical input ' + (physicalEnabled ? 'enabled' : 'disabled'));
        };
      }

      if (navigator.getGamepads) {
        const existing = pickGamepad(navigator.getGamepads());
        if (existing) {
          preferredIndex = existing.index;
          startPolling();
        } else {
          updateStatus('Controller: none', 'Connect a standard gamepad (XInput/DirectInput).');
        }
      } else {
        updateStatus('Controller: unsupported', 'Gamepad API unavailable in this webview.');
      }
    })();
  `;
}
