import { join } from "node:path";

import { CopilotClient, type CopilotSession, type SessionEvent } from "@github/copilot-sdk";

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
  setModel(model: string): void;
  start(): Promise<void>;
  send(content: string): Promise<void>;
  cancel(): Promise<void>;
  stop(): Promise<void>;
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CopilotAgent implements AgentController {
  readonly #client = new CopilotClient();
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
  #session: CopilotSession | undefined;
  #state: AgentState = "starting";
  #activeTurn: Promise<void> | undefined;
  #unsubscribe: (() => void) | undefined;

  public constructor(options: CopilotAgentOptions) {
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
    return this.#state;
  }

  public get model(): string {
    return this.#model;
  }

  public setModel(model: string): void {
    this.#model = model;
  }

  public async start(): Promise<void> {
    try {
      await this.#client.start();
      const deploymentTools =
        this.#allowedGitRemote === undefined
          ? []
          : createDeploymentTools({
                workspace: this.#workspace,
                allowedGitRemote: this.#allowedGitRemote,
                requestDirectory: this.#deploymentRequestDirectory,
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
              }),
            ];
      const commonConfig = {
        clientName: "agent-outpost",
        workingDirectory: this.#workspace,
        model: this.#model,
        reasoningEffort: "medium" as const,
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
            "After publishing changes, call deploy_agent_outpost internally with the returned commit SHA. " +
            "For a plain-language request to deploy existing latest changes, call deploy_latest_agent_outpost without " +
            "asking the user for a SHA or CI status. Deployment validation belongs to the controller, not the user. " +
            "Tell the user immediately when deployment has been scheduled.",
        },
      };
      const metadata = await this.#client.getSessionMetadata(this.#sessionId);
      this.#session = metadata
        ? await this.#client.resumeSession(this.#sessionId, commonConfig)
        : await this.#client.createSession({
            ...commonConfig,
            sessionId: this.#sessionId,
            model: this.#model,
          });
      this.#unsubscribe = this.#session.on((event) => {
        this.#handleSessionEvent(event);
      });
      this.#setState("idle");
    } catch (error) {
      this.#publishStored(
        this.#eventStore.append({
          kind: "session.error",
          payload: { message: `Copilot initialization failed: ${errorMessage(error)}` },
        }),
      );
      this.#setState("failed");
      throw error;
    }
  }

  public async send(content: string): Promise<void> {
    const message = content.trim();
    if (!message) {
      throw new Error("Message content is required");
    }
    if (!this.#session) {
      throw new Error("Copilot session is not ready");
    }
    if (this.#activeTurn) {
      throw new Error("The agent is already processing a message");
    }

    this.#publishStored(this.#eventStore.append({ kind: "user.message", payload: { content: message } }));
    this.#setState("running");
    this.#activeTurn = this.#processTurn(message);
    void this.#activeTurn.finally(() => {
      this.#activeTurn = undefined;
    });
  }

  public async cancel(): Promise<void> {
    if (!this.#session) {
      throw new Error("Copilot session is not ready");
    }
    if (!this.#activeTurn) {
      return;
    }
    this.#setState("cancelling");
    await this.#session.abort();
  }

  public async stop(): Promise<void> {
    if (this.#activeTurn) {
      await this.#activeTurn;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#session) {
      await this.#session.disconnect();
      this.#session = undefined;
    }
    const errors = await this.#client.stop();
    if (errors.length > 0) {
      throw new AggregateError(errors, "Copilot client cleanup failed");
    }
  }

  async #processTurn(message: string): Promise<void> {
    const session = this.#session;
    if (!session) {
      throw new Error("Copilot session disconnected before the turn started");
    }

    try {
      await session.sendAndWait({ prompt: message }, 30 * 60 * 1_000);
    } catch (error) {
      const failure = this.#eventStore.append({
        kind: "session.error",
        payload: { message: errorMessage(error) },
      });
      this.#publishStored(failure);
      this.#setState("failed");
    }
  }

  #handleSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case "assistant.message_delta":
        this.#eventHub.publish({
          id: 0,
          kind: "assistant.delta",
          createdAt: new Date().toISOString(),
          payload: { content: event.data.deltaContent },
        });
        break;
      case "assistant.message":
        this.#publishStored(
          this.#eventStore.append({
            kind: "assistant.message",
            payload: { content: event.data.content },
          }),
        );
        break;
      case "session.idle":
        this.#setState("idle");
        break;
      case "session.error":
        this.#publishStored(
          this.#eventStore.append({
            kind: "session.error",
            payload: { message: event.data.message },
          }),
        );
        this.#setState("failed");
        break;
    }
  }

  #setState(state: AgentState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#publishStored(this.#eventStore.append({ kind: "session.state", payload: { state } }));
  }

  #publishStored(event: OutpostEvent): void {
    this.#eventHub.publish(event);
  }
}
