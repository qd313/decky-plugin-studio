export type RpcHandler = (...args: unknown[]) => unknown | Promise<unknown>;

let defaultHandlers: Record<string, RpcHandler> = {};
let handlers: Record<string, RpcHandler> = {};
let callLog: Array<{ method: string; args: unknown[] }> = [];

/** Replace the default handler map (used on reset). */
export function registerRpcHandlers(map: Record<string, RpcHandler>): void {
  defaultHandlers = { ...map };
  handlers = { ...defaultHandlers };
}

export function resetFakeDeckyRpc(): void {
  handlers = { ...defaultHandlers };
  callLog = [];
}

export function setRpcHandler(method: string, handler: RpcHandler): void {
  handlers[method] = handler;
}

export function getRpcCallLog(): ReadonlyArray<{ method: string; args: unknown[] }> {
  return callLog;
}

export async function dispatchFakeRpc(method: string, args: unknown[]): Promise<unknown> {
  callLog.push({ method, args: [...args] });
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`[fakeDeckyRpc] unhandled method: ${method}`);
  }
  return await handler(...args);
}

export function assertAllRpcMethodsRegistered(methods: readonly string[]): void {
  const missing = methods.filter((m) => !(m in defaultHandlers));
  if (missing.length > 0) {
    throw new Error(`[fakeDeckyRpc] missing default handlers: ${missing.join(", ")}`);
  }
}
