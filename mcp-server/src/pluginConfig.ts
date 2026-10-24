import fs from "fs";
import path from "path";
import { getWorkspaceRoot } from "./config.js";

/**
 * What a plugin keeps in `.decky/preview.json`.
 *
 * The file name is a leftover from the in-IDE preview, which was retired on
 * 2026-10-24. It stays because plugins already have the file (bonsAI does), and
 * two things still read it: deck_openPlugin (panelRootSelector) and deck_deploy
 * (preDeployCommand). Any other key in the file is ignored.
 */
export type PluginConfig = {
  preDeployCommand?: string;
  /**
   * CSS selector for an element this plugin's panel renders at its root, e.g.
   * ".bonsai-scope". deck_openPlugin uses it to tell "my panel is open" from
   * "my name appears in Decky's plugin list" -- a distinction it cannot make
   * from Decky's own markup, and getting it wrong reports an unmounted panel as
   * open (P1-9).
   */
  panelRootSelector?: string;
};

export function getPluginConfigPath(workspaceRoot?: string): string {
  return path.join(workspaceRoot ?? getWorkspaceRoot(), ".decky", "preview.json");
}

export function loadPluginConfig(workspaceRoot?: string): PluginConfig {
  const configPath = getPluginConfigPath(workspaceRoot);
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<PluginConfig>;
    return {
      preDeployCommand: raw.preDeployCommand,
      panelRootSelector: raw.panelRootSelector,
    };
  } catch {
    return {};
  }
}
