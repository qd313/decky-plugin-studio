let ws: WebSocket | null = null;
let connectPromise: Promise<void> | null = null;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reqId = 0;
const eventHandlers: Array<(event: string, args: unknown[]) => void> = [];

export const serverInfo = { port: 8765 };

function ensureWs(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connectPromise) return connectPromise;
  connectPromise = new Promise((resolve, reject) => {
    ws = new WebSocket("ws://127.0.0.1:8765");
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WS connect failed"));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "rpc_result" && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
      if (msg.type === "emit") {
        for (const h of eventHandlers) h(msg.event, msg.args ?? []);
      }
    };
    ws.onclose = () => {
      ws = null;
      connectPromise = null;
    };
  });
  return connectPromise;
}

export function onBackendEvent(handler: (event: string, args: unknown[]) => void) {
  eventHandlers.push(handler);
}

export async function wsCall(method: string, args: unknown[]): Promise<unknown> {
  await ensureWs();
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws!.send(JSON.stringify({ type: "rpc", id, method, args }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }
    }, 30_000);
  });
}
