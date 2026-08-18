import { join } from "node:path";

import {
  CopilotClient,
  type AssistantMessageEvent,
  type MessageOptions,
  type ModelInfo,
  type SessionEvent,
  type SessionEventHandler,
} from "@github/copilot-sdk";

import type { AgentState, OutpostEvent } from "./domain.js";
import { EventStore } from "./event-store.js";
import { createDeploymentTools } from "./deployment-tool.js";
import { createRepositoryTools } from "./repository-tools.js";
import { createScreenshotTool } from "./screenshot-tool.js";
import { createWorkspaceTools } from "./workspace-tools.js";
import { createPermissionHandler } from "./permission-policy.js";
import { SseHub } from "./sse-hub.js";

export interface AgentController {
  readonly state: AgentState;
  readonly model: string;
  stateFor(chatId: string | null): AgentState;
  listModels(): Promise<string[]>;
  setModel(model: string): void;
  start(): Promise<void>;
  send(content: string, chatId: string | null): Promise<void>;
  cancel(chatId: string | null): Promise<void>;
  stop(): Promise<void>;
}

export interface CopilotSessionAdapter {
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  on(handler: SessionEventHandler): () => void;
  sendAndWait(
    options: MessageOptions,
    timeout?: number,
  ): Promise<AssistantMessageEvent | undefined>;
}

export interface CopilotClientAdapter {
  start(): ReturnType<CopilotClient["start"]>;
  stop(): ReturnType<CopilotClient["stop"]>;
  listModels(): ReturnType<CopilotClient["listModels"]>;
  getSessionMetadata(
    sessionId: string,
  ): ReturnType<CopilotClient["getSessionMetadata"]>;
  createSession(
    options: Parameters<CopilotClient["createSession"]>[0],
  ): Promise<CopilotSessionAdapter>;
  resumeSession(
    sessionId: string,
    options: Parameters<CopilotClient["resumeSession"]>[1],
  ): Promise<CopilotSessionAdapter>;
}

export interface CopilotAgentOptions {
  readonly workspace: string;
  readonly sessionId: string;
  readonly model: string;
  readonly allowedGitRemote?: string;
  readonly deploymentRequestDirectory: string;
  readonly githubRepository?: string;
  readonly artifactDirectory: string;
  readonly publicBaseUrl?: string;
  readonly tailscaleUser?: string;
  readonly eventStore: EventStore;
  readonly eventHub: SseHub;
  readonly client?: CopilotClientAdapter;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelId(model: ModelInfo): string | undefined {
  return typeof model.id === "string" ? model.id : undefined;
}

interface ChatRuntime {
  readonly session: CopilotSessionAdapter;
  state: AgentState;
  activeTurn?: Promise<void>;
  unsubscribe?: () => void;
}

export class CopilotAgent implements AgentController {
  readonly #client: CopilotClientAdapter;
  readonly #workspace: string;
  readonly #sessionId: string;
  #model: string;
  readonly #allowedGitRemote: string | undefined;
  readonly #deploymentRequestDirectory: string;
  readonly #githubRepository: string | undefined;
  readonly #artifactDirectory: string;
  readonly #publicBaseUrl: string | undefined;
  readonly #tailscaleUser: string | undefined;
  readonly #eventStore: EventStore;
  readonly #eventHub: SseHub;
  readonly #runtimes = new Map<string, ChatRuntime>();
  readonly #startingRuntimes = new Map<string, Promise<ChatRuntime>>();
  #startupState: AgentState = "starting";

  public constructor(options: CopilotAgentOptions) {
    this.#client = options.client ?? new CopilotClient();
    this.#workspace = options.workspace;
    this.#sessionId = options.sessionId;
    this.#model = options.model;
    this.#allowedGitRemote = options.allowedGitRemote;
    this.#deploymentRequestDirectory = options.deploymentRequestDirectory;
    this.#githubRepository = options.githubRepository;
    this.#artifactDirectory = options.artifactDirectory;
    this.#publicBaseUrl = options.publicBaseUrl;
    this.#tailscaleUser = options.tailscaleUser;
    this.#eventStore = options.eventStore;
    this.#eventHub = options.eventHub;
  }

  public get state(): AgentState {
    if (this.#startupState !== "idle") {
      return this.#startupState;
    }
    const states = [...this.#runtimes.values()].map(({ state }) => state);
    if (states.includes("cancelling")) {
      return "cancelling";
    }
    if (states.includes("running")) {
      return "running";
    }
    if (states.includes("failed")) {
      return "failed";
    }
    return "idle";
  }

  public stateFor(chatId: string | null): AgentState {
    if (this.#startupState !== "idle") {
      return this.#startupState;
    }
    return this.#runtimes.get(chatId ?? this.#sessionId)?.state ?? "idle";
  }

  public get model(): string {
    return this.#model;
  }

  public setModel(model: string): void {
    this.#model = model;
  }

  public async listModels(): Promise<string[]> {
    const models = await this.#client.listModels();
    return models.map(modelId).filter((value): value is string => value !== undefined);
  }

  public async start(): Promise<void> {
    try {
      await this.#client.start();
      this.#startupState = "idle";
      await this.#ensureRuntime(this.#sessionId);
    } catch (error) {
      this.#publishStored(
        this.#eventStore.append(
          {
            kind: "session.error",
            payload: { message: `Copilot initialization failed: ${errorMessage(error)}` },
          },
          null,
        ),
        null,
      );
      this.#startupState = "failed";
      throw error;
    }
  }

  public async send(content: string, chatId: string | null): Promise<void> {
    const message = content.trim();
    if (!message) {
      throw new Error("Message content is required");
    }
    if (this.#startupState !== "idle") {
      throw new Error("Copilot session is not ready");
    }
    const resolvedChatId = chatId ?? this.#sessionId;
    const runtime = await this.#ensureRuntime(resolvedChatId);
    if (runtime.activeTurn) {
      throw new Error("This chat is already processing a message");
    }

    this.#publishStored(
      this.#eventStore.append(
        { kind: "user.message", payload: { content: message } },
        resolvedChatId,
      ),
      resolvedChatId,
    );
    this.#setState(runtime, resolvedChatId, "running");
    const activeTurn = this.#processTurn(runtime, message, resolvedChatId);
    runtime.activeTurn = activeTurn;
    void activeTurn.finally(() => {
      if (runtime.activeTurn === activeTurn) {
        delete runtime.activeTurn;
      }
    });
  }

  public async cancel(chatId: string | null): Promise<void> {
    if (this.#startupState !== "idle") {
      throw new Error("Copilot session is not ready");
    }
    const resolvedChatId = chatId ?? this.#sessionId;
    const runtime = this.#runtimes.get(resolvedChatId);
    if (!runtime?.activeTurn) {
      return;
    }
    this.#setState(runtime, resolvedChatId, "cancelling");
    await runtime.session.abort();
  }

  public async stop(): Promise<void> {
    const errors: unknown[] = [];
    const activeTurns = [...this.#runtimes.values()].flatMap(({ activeTurn }) =>
      activeTurn ? [activeTurn] : [],
    );
    const turnResults = await Promise.allSettled(activeTurns);
    errors.push(
      ...turnResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
    );

    for (const runtime of this.#runtimes.values()) {
      runtime.unsubscribe?.();
      delete runtime.unsubscribe;
    }
    const disconnectResults = await Promise.allSettled(
      [...this.#runtimes.values()].map(({ session }) => session.disconnect()),
    );
    errors.push(
      ...disconnectResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    );
    this.#runtimes.clear();

    errors.push(...await this.#client.stop());
    if (errors.length > 0) {
      throw new AggregateError(errors, "Copilot client cleanup failed");
    }
  }

  async #processTurn(runtime: ChatRuntime, message: string, chatId: string): Promise<void> {
    try {
      await runtime.session.sendAndWait({ prompt: message }, 30 * 60 * 1_000);
    } catch (error) {
      const failure = this.#eventStore.append(
        {
          kind: "session.error",
          payload: { message: errorMessage(error) },
        },
        chatId,
      );
      this.#publishStored(failure, chatId);
      this.#setState(runtime, chatId, "failed");
    }
  }

  #handleSessionEvent(runtime: ChatRuntime, chatId: string, event: SessionEvent): void {
    switch (event.type) {
      case "assistant.message_delta":
        this.#eventHub.publish(
          {
            id: 0,
            kind: "assistant.delta",
            createdAt: new Date().toISOString(),
            payload: { content: event.data.deltaContent },
          },
          chatId,
        );
        break;
      case "assistant.message":
        this.#publishStored(
          this.#eventStore.append(
            {
              kind: "assistant.message",
              payload: { content: event.data.content },
            },
            chatId,
          ),
          chatId,
        );
        break;
      case "session.idle":
        this.#setState(runtime, chatId, "idle");
        break;
      case "session.error":
        this.#publishStored(
          this.#eventStore.append(
            {
              kind: "session.error",
              payload: { message: event.data.message },
            },
            chatId,
          ),
          chatId,
        );
        this.#setState(runtime, chatId, "failed");
        break;
    }
  }

  #setState(runtime: ChatRuntime, chatId: string, state: AgentState): void {
    if (runtime.state === state) {
      return;
    }
    runtime.state = state;
    this.#publishStored(
      this.#eventStore.append({ kind: "session.state", payload: { state } }, chatId),
      chatId,
    );
  }

  async #ensureRuntime(chatId: string): Promise<ChatRuntime> {
    const existing = this.#runtimes.get(chatId);
    if (existing) {
      return existing;
    }
    const starting = this.#startingRuntimes.get(chatId);
    if (starting) {
      return starting;
    }

    const runtimePromise = this.#createRuntime(chatId);
    this.#startingRuntimes.set(chatId, runtimePromise);
    try {
      return await runtimePromise;
    } finally {
      if (this.#startingRuntimes.get(chatId) === runtimePromise) {
        this.#startingRuntimes.delete(chatId);
      }
    }
  }

  async #createRuntime(chatId: string): Promise<ChatRuntime> {
    const deploymentTools =
      this.#allowedGitRemote === undefined
        ? []
        : createDeploymentTools({
            workspace: this.#workspace,
            allowedGitRemote: this.#allowedGitRemote,
            requestDirectory: this.#deploymentRequestDirectory,
            eventStore: this.#eventStore,
            eventHub: this.#eventHub,
          });
    const repositoryTools =
      this.#allowedGitRemote === undefined || this.#githubRepository === undefined
        ? []
        : createRepositoryTools({
            workspace: this.#workspace,
            allowedGitRemote: this.#allowedGitRemote,
            githubRepository: this.#githubRepository,
          });
    const workspaceTools = createWorkspaceTools(this.#workspace);
    const screenshotTools =
      this.#tailscaleUser === undefined
        ? []
        : [
            createScreenshotTool({
              artifactDirectory: this.#artifactDirectory,
              tailscaleUser: this.#tailscaleUser,
              ...(this.#publicBaseUrl ? { publicBaseUrl: this.#publicBaseUrl } : {}),
              eventStore: this.#eventStore,
              eventHub: this.#eventHub,
              workspacePublicDirectory: join(this.#workspace, "public"),
              chatId,
            }),
          ];
    const commonConfig = {
      clientName: "agent-outpost",
      workingDirectory: this.#workspace,
      model: this.#model,
      ...(this.#model !== "auto" ? { reasoningEffort: "medium" as const } : {}),
      streaming: true,
      enableExperimentalMode: true,
      enableConfigDiscovery: true,
      onPermissionRequest: createPermissionHandler(this.#workspace, this.#allowedGitRemote),
      tools: [...deploymentTools, ...repositoryTools, ...workspaceTools, ...screenshotTools],
      systemMessage: {
        mode: "append" as const,
        content:
          "You are running in Agent Outpost for one developer. Work only inside the configured workspace. " +
          "Run the repository's existing checks before publishing. " +
          "Never force-push, change credentials, access production secrets, or make system-level changes. " +
          "Use publish_agent_outpost_changes instead of shell git commit or push commands. " +
          "Publishing requires the agent/current branch. If a typed tool returns status blocked, report its " +
          "error and do not retry until the cause is resolved. " +
          "Use create_agent_outpost_issue instead of the gh shell command. " +
          "If apply_patch is unavailable, use replace_workspace_text or create_workspace_file. " +
          "Use capture_agent_outpost_screenshot with source workspace to validate unpublished UI changes, " +
          "including click, fill, scroll, and assertScroll browser actions, before publishing. " +
          "Use source deployed for the current live UI; it safely permits chat navigation and timeline " +
          "scrolling but rejects fill and mutation-capable selectors. " +
          "For conversation scrolling, open .chat-entry and assert #timeline at bottom; scroll it to top, " +
          "click #scroll-to-bottom, and assert #timeline at bottom again. It publishes the image directly into " +
          "the conversation, so do not repeat the artifact URL as plain text. " +
          "After publishing changes, call deploy_agent_outpost internally with the returned commit SHA; this creates " +
          "a Deployment candidate approval card and does not deploy. Never claim deployment is scheduled until the " +
          "user approves that card. For a plain-language request to deploy existing latest changes, call deploy_latest_agent_outpost without " +
          "asking the user for a SHA or CI status. Deployment validation belongs to the controller, not the user. " +
          "Tell the user to review and approve the Deployment candidate card.",
      },
    };
    const metadata = await this.#client.getSessionMetadata(chatId);
    const session = metadata
      ? await this.#client.resumeSession(chatId, commonConfig)
      : await this.#client.createSession({
          ...commonConfig,
          sessionId: chatId,
          model: this.#model,
        });
    const runtime: ChatRuntime = { session, state: "starting" };
    this.#runtimes.set(chatId, runtime);
    runtime.unsubscribe = session.on((event) => {
      this.#handleSessionEvent(runtime, chatId, event);
    });
    this.#setState(runtime, chatId, "idle");
    return runtime;
  }

  #publishStored(event: OutpostEvent, chatId: string | null): void {
    this.#eventHub.publish(event, chatId);
  }
}
