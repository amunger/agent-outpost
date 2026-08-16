import { closeSync, constants, createReadStream, fstatSync, openSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, normalize, relative } from "node:path";

import type { AgentController } from "./agent.js";
import type { OutpostConfig } from "./config.js";
import type { AgentState } from "./domain.js";
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

interface ChatCreateBody {
  readonly repository: string;
}

interface ChatRecord {
  readonly id: string;
  readonly name: string;
  readonly repository: string;
  lastUsedAt: string | null;
  state: AgentState;
}

function repositoryLabel(value: string): string {
  const match = value.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return match?.[1] ?? value;
}

function parseChatCreateBody(value: unknown): ChatCreateBody {
  if (
    typeof value !== "object" ||
    value === null ||
    !("repository" in value) ||
    typeof value.repository !== "string"
  ) {
    throw new Error("Request body must contain a string repository field");
  }
  const repository = value.repository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must use owner/name format");
  }
  return { repository };
}

function listOwnedRepositories(owner: string): string[] {
  const output = execFileSync(
    "gh",
    ["repo", "list", owner, "--json", "nameWithOwner", "--limit", "1000", "--no-archived"],
    { encoding: "utf8", timeout: 30_000 },
  );
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) {
    throw new Error("GitHub CLI returned an invalid repository list");
  }
  return value
    .flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "nameWithOwner" in entry &&
      typeof entry.nameWithOwner === "string"
        ? [entry.nameWithOwner]
        : [],
    )
    .filter((repository) => repository.startsWith(`${owner}/`))
    .sort((left, right) => left.localeCompare(right));
}

function repositoryOwner(repository: string | undefined): string | undefined {
  return repository?.match(/^([^/]+)\//)?.[1];
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
  publicDirectory: string,
  response: ServerResponse,
  cacheAssets = true,
): Promise<void> {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const normalizedPath = normalize(relativePath);
  const candidate = join(publicDirectory, normalizedPath);
  const relativeCandidate = relative(publicDirectory, candidate);
  if (relativeCandidate.startsWith("..")) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    await access(candidate);
    const resolvedPublic = await realpath(publicDirectory);
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

  const noCacheExtensions = new Set([".html", ".js", ".css"]);
  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypes[extname(candidate)] ?? "application/octet-stream");
  response.setHeader(
    "Cache-Control",
    !cacheAssets || noCacheExtensions.has(extname(candidate)) ? "no-cache" : "public, max-age=3600",
  );
  createReadStream(candidate).pipe(response);
}

export function createWorkspacePreviewServer(publicDirectory: string): Server {
  const previewEvents = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    kind: index % 2 === 0 ? "user.message" : "assistant.message",
    createdAt: new Date(index * 1_000).toISOString(),
    payload: {
      content: `Preview message ${index + 1}: enough content to exercise conversation scrolling.`,
    },
  }));

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", "http://preview.local");

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        sendJson(response, 200, { state: "idle", events: previewEvents });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/chats") {
        sendJson(response, 200, {
          chats: [
            {
              id: "workspace-preview",
              name: "Workspace preview",
              repository: basename(join(publicDirectory, "..")),
              lastUsedAt: new Date(0).toISOString(),
            },
          ],
        });
        return;
      }

      if (request.method === "POST" && /^\/api\/chats\/[^/]+\/select$/.test(url.pathname)) {
        sendJson(response, 200, { selected: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session/events") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();
        response.write(": workspace preview\n\n");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status/resources") {
        sendJson(response, 200, {
          cpu: { usagePercent: 0 },
          memory: { usagePercent: 0 },
          disk: { usagePercent: 0 },
          loadAverage: [0, 0, 0],
        });
        return;
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/api/session/messages" || url.pathname === "/api/session/cancel")
      ) {
        sendJson(response, 409, { error: "Workspace preview is read-only" });
        return;
      }

      if (request.method === "GET") {
        await serveStatic(url.pathname, publicDirectory, response, false);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function serveArtifact(
  requestPath: string,
  config: OutpostConfig,
  response: ServerResponse,
): Promise<void> {
  const filename = requestPath.slice("/api/artifacts/".length);
  if (!/^screenshot-[0-9]+-[0-9a-f-]{36}\.png$/.test(filename)) {
    sendJson(response, 404, { error: "Artifact not found" });
    return;
  }
  const candidate = join(config.artifactDirectory, filename);
  let descriptor: number;
  try {
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ELOOP")
    ) {
      sendJson(response, 404, { error: "Artifact not found" });
      return;
    }
    throw error;
  }
  const metadata = fstatSync(descriptor);
  const expired = metadata.mtimeMs < Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (!metadata.isFile() || expired) {
    closeSync(descriptor);
    sendJson(response, 404, { error: "Artifact not found" });
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", "image/png");
  response.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  response.setHeader("Cache-Control", "private, no-cache");
  createReadStream(candidate, { fd: descriptor, autoClose: true }).pipe(response);
}

export interface HttpServerDependencies {
  readonly config: OutpostConfig;
  readonly agent: AgentController;
  readonly eventStore: EventStore;
  readonly eventHub: SseHub;
  readonly resourceMonitor: ResourceMonitor;
  readonly listRepositories?: (owner: string) => readonly string[];
}

export function createOutpostServer(dependencies: HttpServerDependencies) {
  const { config, agent, eventStore, eventHub, resourceMonitor } = dependencies;
  const listRepositories = dependencies.listRepositories ?? listOwnedRepositories;
  const owner = repositoryOwner(config.githubRepository);
  const chats = new Map<string, ChatRecord>();
  const initialRepository = repositoryLabel(config.allowedGitRemote ?? basename(config.workspace));
  chats.set(config.sessionId, {
    id: config.sessionId,
    name: "Mobile agent",
    repository: initialRepository,
    lastUsedAt: eventStore.list().at(-1)?.createdAt ?? null,
    state: agent.state,
  });

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

      if (request.method === "GET" && url.pathname === "/api/chats") {
        const current = chats.get(config.sessionId);
        if (current) {
          current.lastUsedAt = eventStore.list().at(-1)?.createdAt ?? current.lastUsedAt;
          current.state = agent.state;
        }
        sendJson(response, 200, {
          chats: [...chats.values()].sort(
            (left, right) =>
              (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? ""),
          ),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/repositories") {
        if (!owner) {
          throw new Error("GitHub repository owner is not configured");
        }
        sendJson(response, 200, { repositories: listRepositories(owner) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chats") {
        const body = parseChatCreateBody(await readJsonBody(request));
        if (!owner || !body.repository.startsWith(`${owner}/`)) {
          throw new Error("Repository is not owned by the configured GitHub owner");
        }
        const repositories = listRepositories(owner);
        if (!repositories.includes(body.repository)) {
          throw new Error("Repository is not available for this Agent Outpost");
        }
        const id = `${config.sessionId}-${Date.now()}`;
        const chat: ChatRecord = {
          id,
          name: "New chat",
          repository: body.repository,
          lastUsedAt: new Date().toISOString(),
          state: agent.state,
        };
        chats.set(id, chat);
        sendJson(response, 201, { chat });
        return;
      }

      const chatSelection = url.pathname.match(/^\/api\/chats\/([^/]+)\/select$/);
      if (request.method === "POST" && chatSelection) {
        const chat = chats.get(decodeURIComponent(chatSelection[1] ?? ""));
        if (!chat) {
          sendJson(response, 404, { error: "Chat not found" });
          return;
        }
        chat.lastUsedAt = new Date().toISOString();
        sendJson(response, 200, { chat });
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

      if (request.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
        await serveArtifact(url.pathname, config, response);
        return;
      }

      if (request.method === "GET") {
        await serveStatic(url.pathname, config.publicDirectory, response);
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
