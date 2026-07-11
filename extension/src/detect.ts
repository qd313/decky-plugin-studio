import { detectPlugin, getWorkspaceRoot } from "./paths";

export { detectPlugin, type PluginInfo } from "./paths";

export function isDeckyWorkspace(): boolean {
  const root = getWorkspaceRoot();
  if (!root) return false;
  return detectPlugin(root) !== null;
}
