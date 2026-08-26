import http from "http";
import type { IncomingMessage, ServerResponse } from "http";

export interface IngestEvent {
  sessionId?: string;
  hypothesisId?: string;
  location?: string;
  message?: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

const events: IngestEvent[] = [];
let server: http.Server | null = null;
let port = 7682;

export function startIngestServer(listenPort = 7682): void {
  if (server) return;
  port = listenPort;
  server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url?.startsWith("/ingest")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const event = JSON.parse(body) as IngestEvent;
          events.push({ ...event, timestamp: event.timestamp ?? Date.now() });
          if (events.length > 10_000) events.shift();
        } catch {
          /* ignore */
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, count: events.length }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // A second MCP server instance (VS Code extension + a CLI client, or two
  // workspaces) would otherwise die here: an unhandled 'error' event on the
  // http.Server takes the whole process down with EADDRINUSE, so the MCP
  // handshake never completes. Ingest is optional; the rest of the server is not.
  server.on("error", (err: NodeJS.ErrnoException) => {
    const detail =
      err.code === "EADDRINUSE"
        ? `ingest port ${port} is already in use; debug ingest is disabled for this instance. Set DEBUG_INGEST_PORT to a free port to enable it.`
        : `ingest server error: ${err.message}`;
    console.error(`[decky-plugin-studio] ${detail}`);
    server = null;
  });
  server.listen(port, "127.0.0.1");
}

export function isIngestRunning(): boolean {
  return server !== null;
}

export function stopIngestServer(): void {
  server?.close();
  server = null;
}

export function getIngestPort(): number {
  return port;
}

export function getIngestCount(): number {
  return events.length;
}

export function tailIngest(opts: {
  since?: number;
  lines?: number;
  hypothesisId?: string;
}): IngestEvent[] {
  let filtered = events;
  if (opts.since) filtered = filtered.filter((e) => (e.timestamp ?? 0) >= opts.since!);
  if (opts.hypothesisId)
    filtered = filtered.filter((e) => e.hypothesisId === opts.hypothesisId);
  const lines = opts.lines ?? 50;
  return filtered.slice(-lines);
}

export async function probeIngest(ingestPort = port): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      sessionId: "probe",
      location: "probe",
      message: "probe",
      timestamp: Date.now(),
    });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: ingestPort,
        path: "/ingest/probe",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        resolve({ ok: res.statusCode === 204 || res.statusCode === 200, status: res.statusCode ?? 0 });
      }
    );
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.write(payload);
    req.end();
  });
}
