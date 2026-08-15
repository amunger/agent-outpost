import { createReadStream } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, relative } from "node:path";

import type { AgentController } from "./agent.js";
import type { OutpostConfig } from "./config.js";
import { EventStore } from "./event-store.js";
import { ResourceMonitor } from "./resource-monitor.js";
import { SseHub } from "./sse-hub.js";

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface MessageBody {
  readonly content: string;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function isAuthorized(request: IncomingMessage, config: OutpostConfig): boolean {
  if (!config.allowedTailscaleUser) {
    return true;
  }
  const login = request.headers["tailscale-user-login"];
  return typeof login === "string" && login.toLowerCase() === config.allowedTailscaleUser;
}

function isSameOrigin(request: IncomingMessage, config: OutpostConfig): boolean {
  const origin = request.headers.origin;
  if (!config.allowedTailscaleUser && origin === undefined) {
    return true;
  }
  if (typeof origin !== "string" || typeof request.headers.host !== "string") {
    return false;
  }

  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function parseEventCursor(request: IncomingMessage, url: URL): number {
  const rawCursor = request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
  const value = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;
  const cursor = Number.parseInt(value ?? "0", 10);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) {
      throw new Error("Request body exceeds 64 KiB");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body) as unknown;
}

function parseMessageBody(value: unknown): MessageBody {
  if (
    typeof value !== "object" ||
    value === null ||
    !("content" in value) ||
    typeof value.content !== "string"
  ) {
    throw new Error("Request body must contain a string content field");
  }
  const content = value.content.trim();
  if (!content || content.length > 20_000) {
    throw new Error("Message content must contain 1 to 20,000 characters");
  }
  return { content };
}

async function serveStatic(
  requestPath: string,
  config: OutpostConfig,
  response: ServerResponse,
): Promise<void> {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const normalizedPath = normalize(relativePath);
  const candidate = join(config.publicDirectory, normalizedPath);
  const relativeCandidate = relative(config.publicDirectory, candidate);
  if (relativeCandidate.startsWith("..")) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    await access(candidate);
    const resolvedPublic = await realpath(config.publicDirectory);
    const resolvedCandidate = await realpath(candidate);
    if (relative(resolvedPublic, resolvedCandidate).startsWith("..")) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    throw error;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypes[extname(candidate)] ?? "application/octet-stream");
  response.setHeader("Cache-Control", relativePath === "index.html" ? "no-cache" : "public, max-age=3600");
  createReadStream(candidate).pipe(response);
}

export interface HttpServerDependencies {
  readonly config: OutpostConfig;
  readonly agent: AgentController;
  readonly eventStore: EventStore;
  readonly eventHub: SseHub;
  readonly resourceMonitor: ResourceMonitor;
}

export function createOutpostServer(dependencies: HttpServerDependencies) {
  const { config, agent, eventStore, eventHub, resourceMonitor } = dependencies;

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", "http://outpost.local");

    try {
      if (url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (url.pathname === "/ready") {
        const ready = agent.state === "idle" || agent.state === "running" || agent.state === "cancelling";
        sendJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready", state: agent.state });
        return;
      }

      if (url.pathname.startsWith("/api/") && !isAuthorized(request, config)) {
        sendJson(response, 401, { error: "Tailscale identity is not authorized" });
        return;
      }

      if (
        url.pathname.startsWith("/api/") &&
        request.method !== "GET" &&
        !isSameOrigin(request, config)
      ) {
        sendJson(response, 403, { error: "Cross-origin mutation rejected" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        sendJson(response, 200, { state: agent.state, events: eventStore.list() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session/events") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();
        const remove = eventHub.add(response, eventStore.list({ after: parseEventCursor(request, url) }));
        request.on("close", remove);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/messages") {
        const message = parseMessageBody(await readJsonBody(request));
        await agent.send(message.content);
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/cancel") {
        await agent.cancel();
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status/resources") {
        sendJson(response, 200, await resourceMonitor.snapshot(config.dataDirectory));
        return;
      }

      if (request.method === "GET") {
        await serveStatic(url.pathname, config, response);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = message.includes("already processing");
      sendJson(response, conflict ? 409 : 400, { error: message });
    }
  });
}
