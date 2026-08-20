import { closeSync, constants, createReadStream, fstatSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, normalize, relative } from "node:path";

import type { AgentController } from "./agent.js";
import type { OutpostConfig } from "./config.js";
import type { AgentState } from "./domain.js";
import { EventStore, type StoredChat } from "./event-store.js";
import { ResourceMonitor } from "./resource-monitor.js";
import { SseHub } from "./sse-hub.js";
import {
  ProjectRegistry,
  type ProjectDefinition,
} from "./project-registry.js";
import {
  approveDeploymentCandidate,
  deploymentDiffBase,
  type DeploymentCandidate,
} from "./deployment-tool.js";

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
  readonly projectId?: string;
  readonly repository?: string;
}

interface ChatRenameBody {
  readonly name: string;
}

interface ModelBody {
  readonly model: string;
}

interface ChatRecord {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly name: string;
  readonly repository: string;
  readonly createdAt: string;
  lastUsedAt: string | null;
  state: AgentState;
}

function parseModelBody(value: unknown): ModelBody {
  if (typeof value !== "object" || value === null || !("model" in value) || typeof value.model !== "string") {
    throw new Error("Request body must contain a string model field");
  }
  const model = value.model.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model) || model.length > 100) {
    throw new Error("Model ID is invalid");
  }
  return { model };
}

function parseChatCreateBody(value: unknown): ChatCreateBody {
  if (typeof value !== "object" || value === null) {
    throw new Error("Request body must select a registered project");
  }
  const projectId =
    "projectId" in value && typeof value.projectId === "string"
      ? value.projectId.trim()
      : undefined;
  const repository =
    "repository" in value && typeof value.repository === "string"
      ? value.repository.trim()
      : undefined;
  if (projectId && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(projectId)) {
    throw new Error("Project ID is invalid");
  }
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must use owner/name format");
  }
  if (!projectId && !repository) {
    throw new Error("Request body must select a registered project");
  }
  return {
    ...(projectId ? { projectId } : {}),
    ...(repository ? { repository } : {}),
  };
}

function parseChatRenameBody(value: unknown): ChatRenameBody {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string"
  ) {
    throw new Error("Request body must contain a string name field");
  }
  const name = value.name.trim();
  if (!name || name.length > 100) {
    throw new Error("Chat name must be between 1 and 100 characters");
  }
  return { name };
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

function deploymentCandidateEvents(eventStore: EventStore): Map<string, DeploymentCandidate & { status: "pending" | "approved" | "rejected" }> {
  const candidates = new Map<string, DeploymentCandidate & { status: "pending" | "approved" | "rejected" }>();
  for (const event of eventStore.listByKind("deployment.candidate")) {
    const payload = event.payload as DeploymentCandidate & { status: "pending" | "approved" | "rejected" };
    candidates.set(payload.candidateId, payload);
  }
  return candidates;
}

function sessionEvents(eventStore: EventStore, chatId: string, after: number) {
  const scoped = eventStore.list({ chatId, after });
  const global = eventStore.list({ chatId: null, after });
  return [...scoped, ...global].sort((left, right) => left.id - right.id);
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

export interface WorkspacePreviewOptions {
  readonly multiProject?: boolean;
  readonly sessionDelayMs?: number;
}

export function createWorkspacePreviewServer(
  publicDirectory: string,
  options: WorkspacePreviewOptions = {},
): Server {
  const previewEvents = [
    ...Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      kind: index % 2 === 0 ? "user.message" : "assistant.message",
      createdAt: new Date(index * 1_000).toISOString(),
      payload: {
        content: `Preview message ${index + 1}: enough content to exercise conversation scrolling.`,
      },
    })),
    {
      id: 31,
      kind: "deployment.candidate",
      createdAt: new Date(30_000).toISOString(),
      payload: {
        candidateId: "11111111-1111-4111-8111-111111111111",
        projectId: "agent-outpost",
        projectName: "Agent Outpost",
        targetId: "agent-outpost",
        integrationBranch: "agent/current",
        chatId: "workspace-preview",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        description: "Preview deployment candidate",
        files: [
          { path: "public/app.js", added: 18, removed: 4 },
          { path: "src/http-server.ts", added: 9, removed: 2 },
        ],
        diffUrl: "/api/deployment-candidates/11111111-1111-4111-8111-111111111111/diff",
        status: "pending",
      },
    },
    {
      id: 32,
      kind: "assistant.message",
      createdAt: new Date(31_000).toISOString(),
      payload: { content: "Overview of the change after the deployment candidate." },
    },
    {
      id: 33,
      kind: "user.message",
      createdAt: new Date(32_000).toISOString(),
      payload: { content: "Follow-up after reviewing the deployment." },
    },
  ];
  const transitionFixtures = {
    working: [
      {
        id: 1,
        kind: "user.message",
        createdAt: new Date(0).toISOString(),
        payload: { content: "Show the working transition." },
      },
      {
        id: 2,
        kind: "assistant.delta",
        createdAt: new Date(1_000).toISOString(),
        payload: { content: "This streamed delta must not be shown." },
      },
    ],
    completed: [
      {
        id: 1,
        kind: "user.message",
        createdAt: new Date(0).toISOString(),
        payload: { content: "Show the completed transition." },
      },
      {
        id: 2,
        kind: "assistant.delta",
        createdAt: new Date(1_000).toISOString(),
        payload: { content: "This streamed delta must not be shown." },
      },
      {
        id: 3,
        kind: "assistant.message",
        createdAt: new Date(2_000).toISOString(),
        payload: { content: "The completed assistant response appears exactly once." },
      },
    ],
    cancelled: [
      {
        id: 1,
        kind: "user.message",
        createdAt: new Date(0).toISOString(),
        payload: { content: "Cancel this transition." },
      },
      {
        id: 2,
        kind: "assistant.delta",
        createdAt: new Date(1_000).toISOString(),
        payload: { content: "This delta must be removed on cancellation." },
      },
      {
        id: 3,
        kind: "session.state",
        createdAt: new Date(2_000).toISOString(),
        payload: { state: "cancelling" },
      },
    ],
    failed: [
      {
        id: 1,
        kind: "user.message",
        createdAt: new Date(0).toISOString(),
        payload: { content: "Fail this transition." },
      },
      {
        id: 2,
        kind: "assistant.delta",
        createdAt: new Date(1_000).toISOString(),
        payload: { content: "This delta must be removed on failure." },
      },
      {
        id: 3,
        kind: "session.error",
        createdAt: new Date(2_000).toISOString(),
        payload: { message: "Preview failure." },
      },
    ],
    idle: [
      {
        id: 1,
        kind: "user.message",
        createdAt: new Date(0).toISOString(),
        payload: { content: "Finish idle without a response." },
      },
      {
        id: 2,
        kind: "assistant.delta",
        createdAt: new Date(1_000).toISOString(),
        payload: { content: "This delta must be removed on idle." },
      },
      {
        id: 3,
        kind: "session.state",
        createdAt: new Date(2_000).toISOString(),
        payload: { state: "idle" },
      },
    ],
  } as const;
  const previewChats = [
    {
      id: "workspace-preview",
      projectId: "agent-outpost",
      projectName: "Agent Outpost",
      name: "Workspace preview",
      repository: basename(join(publicDirectory, "..")),
      lastUsedAt: new Date(0).toISOString(),
    },
    ...(options.multiProject
      ? [
          {
            id: "other-project-chat",
            projectId: "other-project",
            projectName: "Other Project",
            name: "Other project secret",
            repository: "other/project",
            lastUsedAt: new Date(0).toISOString(),
          },
        ]
      : []),
  ];

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", "http://preview.local");

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        if (options.sessionDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.sessionDelayMs));
        }
        const scenario = url.searchParams.get("scenario");
        const events =
          scenario && scenario in transitionFixtures
            ? transitionFixtures[scenario as keyof typeof transitionFixtures]
            : previewEvents;
        const state =
          scenario === "working"
            ? "running"
            : scenario === "cancelled"
              ? "cancelling"
              : scenario === "failed"
                ? "failed"
                : "idle";
        sendJson(response, 200, { state, events });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/chats") {
        sendJson(response, 200, {
          chats: previewChats,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        sendJson(response, 200, {
          projects: [
            {
              id: "agent-outpost",
              name: "Agent Outpost",
              repository: basename(join(publicDirectory, "..")),
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
  readonly projects?: ProjectRegistry;
}

export function createOutpostServer(dependencies: HttpServerDependencies) {
  const { config, agent, eventStore, eventHub, resourceMonitor } = dependencies;
  const legacyProject: ProjectDefinition = {
    id: "agent-outpost",
    name: "Agent Outpost",
    repository: config.githubRepository ?? "local/agent-outpost",
    workspace: config.workspace,
    ...(config.allowedGitRemote ? { allowedGitRemote: config.allowedGitRemote } : {}),
    integrationBranch: "agent/current",
    ...(config.githubRepository ? { githubRepository: config.githubRepository } : {}),
    deploymentTargetId: "agent-outpost",
    deploymentRequestDirectory: config.deploymentRequestDirectory,
    validationProfile: "agent-outpost",
    workspacePreview: "static-public",
  };
  const projects = dependencies.projects ?? new ProjectRegistry(legacyProject.id, [legacyProject]);
  const defaultProject = projects.defaultProject;
  const lastDeploymentAt = new Date().toISOString();
  eventStore.adoptLegacyEvents(config.sessionId);
  eventStore.adoptLegacyProjects(
    defaultProject.id,
    defaultProject.repository,
  );
  eventStore.ensureChat({
    id: config.sessionId,
    projectId: defaultProject.id,
    name: "Mobile agent",
    repository: defaultProject.repository,
    lastUsedAt: eventStore.list({ chatId: config.sessionId }).at(-1)?.createdAt ?? null,
  });
  const chatRecord = (chat: StoredChat): ChatRecord => {
    const project = projects.require(chat.projectId);
    return {
      ...chat,
      projectName: project.name,
      state: agent.stateFor(chat.id),
    };
  };

  function resolveChatId(url: URL): string {
    const chatId = url.searchParams.get("chatId") ?? config.sessionId;
    const chat = eventStore.getChat(chatId);
    if (!chat || !projects.get(chat.projectId)) {
      throw new Error("Chat is not associated with a registered project");
    }
    return chatId;
  }

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

      if (request.method === "GET" && url.pathname === "/api/model") {
        const preferred = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
        const available = await agent.listModels();
        const preferredAvailable = preferred.filter((model) => available.includes(model));
        const models = [...preferredAvailable, ...available.filter((model) => !preferredAvailable.includes(model))];
        sendJson(response, 200, {
          model: agent.model,
          models,
          reasoningEffort: "medium",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/model") {
        const body = parseModelBody(await readJsonBody(request));
        agent.setModel(body.model);
        sendJson(response, 200, { model: agent.model, reasoningEffort: "medium" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/chats") {
        sendJson(response, 200, {
          chats: eventStore
            .listChats()
            .filter(({ projectId }) => projects.get(projectId) !== undefined)
            .map(chatRecord),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        sendJson(response, 200, {
          projects: projects.list().map(({ id, name, repository }) => ({
            id,
            name,
            repository,
          })),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/repositories") {
        sendJson(response, 200, {
          repositories: projects.list().map(({ repository }) => repository),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chats") {
        const body = parseChatCreateBody(await readJsonBody(request));
        const project = body.projectId
          ? projects.get(body.projectId)
          : projects.list().find(({ repository }) => repository === body.repository);
        if (!project) {
          throw new Error("Project is not registered for this Agent Outpost");
        }
        const chat = eventStore.createChat({
          id: randomUUID(),
          projectId: project.id,
          name: "New chat",
          repository: project.repository,
        });
        sendJson(response, 201, { chat: chatRecord(chat) });
        return;
      }

      const chatSelection = url.pathname.match(/^\/api\/chats\/([^/]+)\/select$/);
      if (request.method === "POST" && chatSelection) {
        const chat = eventStore.touchChat(decodeURIComponent(chatSelection[1] ?? ""));
        if (!chat) {
          sendJson(response, 404, { error: "Chat not found" });
          return;
        }
        sendJson(response, 200, { chat: chatRecord(chat) });
        return;
      }

      const chatStatistics = url.pathname.match(/^\/api\/chats\/([^/]+)\/statistics$/);
      if (request.method === "GET" && chatStatistics) {
        const id = decodeURIComponent(chatStatistics[1] ?? "");
        const chat = eventStore.listChats().find((entry) => entry.id === id);
        if (!chat) {
          sendJson(response, 404, { error: "Chat not found" });
          return;
        }
        const statistics = eventStore.chatStatistics(id);
        sendJson(response, 200, { statistics: { ...statistics, createdAt: chat.createdAt } });
        return;
      }

      const chatDeletion = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
      if (request.method === "PATCH" && chatDeletion) {
        const id = decodeURIComponent(chatDeletion[1] ?? "");
        const chat = eventStore.renameChat(id, parseChatRenameBody(await readJsonBody(request)).name);
        if (!chat) {
          sendJson(response, 404, { error: "Chat not found" });
          return;
        }
        sendJson(response, 200, { chat: chatRecord(chat) });
        return;
      }

      if (request.method === "DELETE" && chatDeletion) {
        const id = decodeURIComponent(chatDeletion[1] ?? "");
        if (id === config.sessionId) {
          sendJson(response, 409, { error: "The primary chat cannot be deleted" });
          return;
        }
        if (!eventStore.deleteChat(id)) {
          sendJson(response, 404, { error: "Chat not found" });
          return;
        }
        sendJson(response, 200, { deleted: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        const chatId = resolveChatId(url);
        sendJson(response, 200, { state: agent.stateFor(chatId), events: eventStore.list({ chatId }) });
        return;
      }

      const candidateApproval = url.pathname.match(/^\/api\/deployment-candidates\/([^/]+)\/approve$/);
      if (request.method === "POST" && candidateApproval) {
        const candidate = deploymentCandidateEvents(eventStore).get(decodeURIComponent(candidateApproval[1] ?? ""));
        if (!candidate || candidate.status !== "pending") {
          sendJson(response, 409, { error: "Deployment candidate is stale or already handled" });
          return;
        }
        const project = projects.require(candidate.projectId ?? defaultProject.id);
        if (!project.allowedGitRemote) throw new Error("Deployment is not configured");
        if (candidate.chatId) {
          const chat = eventStore.getChat(candidate.chatId);
          if (!chat || chat.projectId !== project.id) {
            throw new Error("Deployment candidate is not associated with its registered project");
          }
        }
        sendJson(response, 202, approveDeploymentCandidate({
          projectId: project.id,
          projectName: project.name,
          targetId: project.deploymentTargetId,
          integrationBranch: project.integrationBranch,
          ...(candidate.chatId ? { chatId: candidate.chatId } : {}),
          workspace: project.workspace,
          allowedGitRemote: project.allowedGitRemote,
          requestDirectory: project.deploymentRequestDirectory,
          eventStore,
          eventHub,
        }, candidate));
        return;
      }

      const candidateDiff = url.pathname.match(/^\/api\/deployment-candidates\/([^/]+)\/diff$/);
      if (request.method === "GET" && candidateDiff) {
        const candidate = deploymentCandidateEvents(eventStore).get(decodeURIComponent(candidateDiff[1] ?? ""));
        if (!candidate) { sendJson(response, 404, { error: "Deployment candidate not found" }); return; }
        const project = projects.require(candidate.projectId ?? defaultProject.id);
        const base = deploymentDiffBase(
          project.workspace,
          project.deploymentRequestDirectory,
          candidate.commitSha,
        );
        const diff = execFileSync("git", ["--no-pager", "diff", "--no-ext-diff", base, candidate.commitSha], {
          cwd: project.workspace, encoding: "utf8", maxBuffer: 256 * 1024,
        }).slice(0, 200_000);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.setHeader("Cache-Control", "private, no-cache");
        response.end(diff);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session/events") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();
        const chatId = resolveChatId(url);
        const remove = eventHub.add(
          response,
          sessionEvents(eventStore, chatId, parseEventCursor(request, url)),
          chatId,
        );
        request.on("close", remove);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/messages") {
        const chatId = resolveChatId(url);
        const message = parseMessageBody(await readJsonBody(request));
        eventStore.touchChat(chatId);
        await agent.send(message.content, chatId);
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/cancel") {
        await agent.cancel(resolveChatId(url));
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status/resources") {
        const resources = await resourceMonitor.snapshot(config.dataDirectory);
        sendJson(response, 200, { ...resources, lastDeploymentAt });
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
