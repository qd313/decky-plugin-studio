import { wsCall, onBackendEvent, serverInfo } from "../bridge/wsClient";

type PluginFactory = () => {
  name?: string;
  titleView?: unknown;
  content?: unknown;
  icon?: string;
  onDismount?: () => void;
};

let pluginInstance: ReturnType<PluginFactory> | null = null;

export function definePlugin(factory: PluginFactory) {
  pluginInstance = factory();
  return pluginInstance;
}

export async function call(method: string, ...args: unknown[]): Promise<unknown> {
  return wsCall(method, args);
}

export const toaster = {
  toast: (opts: { title?: string; body?: string; duration?: number }) => {
    console.log("[toaster]", opts.title, opts.body);
  },
};

const listeners = new Map<string, Set<( ...args: unknown[]) => void>>();

export function addEventListener(event: string, handler: (...args: unknown[]) => void) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  onBackendEvent((name, args) => {
    if (name === event) handler(...args);
  });
}

export function removeEventListener(event: string, handler: (...args: unknown[]) => void) {
  listeners.get(event)?.delete(handler);
}

export function getPluginInstance() {
  return pluginInstance;
}

export { serverInfo };
export {
  isPreviewPermissionGranted,
  getPreviewPermissions,
  setPreviewPermissions,
} from "./permissions";
