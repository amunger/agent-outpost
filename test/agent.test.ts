import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AssistantMessageEvent, ModelInfo, SessionEvent } from "@github/copilot-sdk";

import {
  CopilotAgent,
  type CopilotClientAdapter,
  type CopilotSessionAdapter,
} from "../src/agent.js";
import { EventStore } from "../src/event-store.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { SseHub } from "../src/sse-hub.js";

interface PendingTurn {
  readonly prompt: string;
  readonly resolve: (response?: AssistantMessageEvent) => void;
}

interface FakeSession {
  readonly adapter: CopilotSessionAdapter;
  readonly pendingTurns: PendingTurn[];
  readonly abortCalls: number;
  emit(event: SessionEvent): void;
}

function model(id: string, multiplier: number): ModelInfo {
  return {
    id,
    name: id,
    capabilities: {
      supports: { vision: false, reasoningEffort: false },
      limits: { max_context_window_tokens: 16_000 },
    },
    policy: { state: "enabled", terms: "" },
    billing: { multiplier },
  };
}

function assistantMessage(content: string): AssistantMessageEvent {
  return {
    type: "assistant.message",
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    data: { content, messageId: randomUUID() },
  };
}

test("A phone chat gets a short generated name while its first response completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-chat-title-"));
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const eventStore = new EventStore(directory);
  eventStore.ensureChat({
    id: "primary-chat",
    projectId: "agent-outpost",
    name: "New chat",
    repository: "owner/agent-outpost",
    lastUsedAt: null,
  });
  const projects = new ProjectRegistry("agent-outpost", [
    {
      id: "agent-outpost",
      name: "Agent Outpost",
      repository: "owner/agent-outpost",
      workspace,
      integrationBranch: "agent/current",
      deploymentTargetId: "agent-outpost",
      deploymentRequestDirectory: join(directory, "deploy-requests"),
      validationProfile: "agent-outpost",
      workspacePreview: "none",
    },
  ]);
  const eventHub = new SseHub();
  const { client, sessions, sessionModels, models } = createFakeCopilotClient();
  models.push(model("expensive-model", 5), model("cheap-model", 0.5));
  const agent = new CopilotAgent({
    workspace,
    sessionId: "primary-chat",
    model: "expensive-model",
    deploymentRequestDirectory: join(directory, "deploy-requests"),
    artifactDirectory: join(directory, "artifacts"),
    eventStore,
    eventHub,
    projects,
    resolveProjectId: (chatId) => eventStore.getChat(chatId)?.projectId,
    client,
  });

  try {
    await agent.start();
    await agent.send("Automatically name completed chat sessions", "primary-chat");
    const mainSession = sessions.get("primary-chat");
    assert.ok(mainSession);
    mainSession.pendingTurns[0]?.resolve(
      assistantMessage("I implemented automatic chat naming."),
    );

    let titleEntry: [string, FakeSession] | undefined;
    for (let attempt = 0; attempt < 20 && !titleEntry; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      titleEntry = [...sessions.entries()].find(([id]) => id.startsWith("title-"));
    }
    assert.ok(titleEntry);
    assert.equal(sessionModels.get(titleEntry[0]), "cheap-model");
    assert.match(
      titleEntry[1].pendingTurns[0]?.prompt ?? "",
      /Automatically name completed chat sessions/,
    );
    titleEntry[1].pendingTurns[0]?.resolve(assistantMessage("Automatic Chat Titles"));

    for (
      let attempt = 0;
      attempt < 20 && eventStore.getChat("primary-chat")?.name === "New chat";
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(eventStore.getChat("primary-chat")?.name, "Automatic Chat Titles");
  } finally {
    await agent.stop();
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFakeCopilotClient(): {
  readonly client: CopilotClientAdapter;
  readonly sessions: Map<string, FakeSession>;
  readonly workingDirectories: Map<string, string>;
  readonly sessionModels: Map<string, string>;
  readonly models: ModelInfo[];
} {
  const sessions = new Map<string, FakeSession>();
  const workingDirectories = new Map<string, string>();
  const sessionModels = new Map<string, string>();
  const models: ModelInfo[] = [];

  function createSession(): FakeSession {
    const listeners = new Set<(event: SessionEvent) => void>();
    const pendingTurns: PendingTurn[] = [];
    let abortCalls = 0;
    const adapter: CopilotSessionAdapter = {
      abort: async () => {
        abortCalls += 1;
      },
      disconnect: async () => {},
      on: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendAndWait: async ({ prompt }) => {
        return new Promise<AssistantMessageEvent | undefined>((resolve) => {
          pendingTurns.push({ prompt, resolve });
        });
      },
    };
    return {
      adapter,
      pendingTurns,
      get abortCalls() {
        return abortCalls;
      },
      emit: (event) => {
        for (const listener of listeners) {
          listener(event);
        }
      },
    };
  }

  const client: CopilotClientAdapter = {
    start: async () => {},
    stop: async () => [],
    listModels: async () => models,
    getSessionMetadata: async () => undefined,
    deleteSession: async (sessionId) => {
      sessions.delete(sessionId);
      workingDirectories.delete(sessionId);
    },
    createSession: async (options) => {
      if (!options.sessionId) {
        throw new Error("Fake Copilot sessions require a sessionId");
      }
      if (!options.workingDirectory) {
        throw new Error("Fake Copilot sessions require a workingDirectory");
      }
      const session = createSession();
      sessions.set(options.sessionId, session);
      workingDirectories.set(options.sessionId, options.workingDirectory);
      if (options.model) {
        sessionModels.set(options.sessionId, options.model);
      }
      return session.adapter;
    },
    resumeSession: async (sessionId) => {
      const session = createSession();
      sessions.set(sessionId, session);
      return session.adapter;
    },
  };
  return { client, sessions, workingDirectories, sessionModels, models };
}

test("A phone can use different projects concurrently without crossing workspaces", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-agent-"));
  const firstWorkspace = join(directory, "first-workspace");
  const secondWorkspace = join(directory, "second-workspace");
  mkdirSync(firstWorkspace);
  mkdirSync(secondWorkspace);
  const eventStore = new EventStore(directory);
  eventStore.ensureChat({
    id: "primary-chat",
    projectId: "first-project",
    name: "Primary",
    repository: "owner/first",
    lastUsedAt: null,
  });
  eventStore.createChat({
    id: "first-chat",
    projectId: "first-project",
    name: "First",
    repository: "owner/first",
  });
  eventStore.createChat({
    id: "same-project-chat",
    projectId: "first-project",
    name: "Same project",
    repository: "owner/first",
  });
  eventStore.createChat({
    id: "second-chat",
    projectId: "second-project",
    name: "Second",
    repository: "owner/second",
  });
  const projects = new ProjectRegistry("first-project", [
    {
      id: "first-project",
      name: "First Project",
      repository: "owner/first",
      workspace: firstWorkspace,
      integrationBranch: "agent/current",
      deploymentTargetId: "first-project",
      deploymentRequestDirectory: join(directory, "first-requests"),
      validationProfile: "agent-outpost",
      workspacePreview: "none",
    },
    {
      id: "second-project",
      name: "Second Project",
      repository: "owner/second",
      workspace: secondWorkspace,
      integrationBranch: "agent/current",
      deploymentTargetId: "second-project",
      deploymentRequestDirectory: join(directory, "second-requests"),
      validationProfile: "node-nextjs",
      workspacePreview: "none",
    },
  ]);
  const eventHub = new SseHub();
  const { client, sessions, workingDirectories } = createFakeCopilotClient();
  const agent = new CopilotAgent({
    workspace: directory,
    sessionId: "primary-chat",
    model: "auto",
    deploymentRequestDirectory: join(directory, "deploy-requests"),
    artifactDirectory: join(directory, "artifacts"),
    eventStore,
    eventHub,
    projects,
    resolveProjectId: (chatId) => eventStore.getChat(chatId)?.projectId,
    client,
  });

  try {
    await agent.start();
    await agent.send("work in the first chat", "first-chat");
    await agent.send("work in the second chat", "second-chat");
    await assert.rejects(
      agent.send("conflicting work", "same-project-chat"),
      /First Project is already processing a message/,
    );

    const firstSession = sessions.get("first-chat");
    const secondSession = sessions.get("second-chat");
    assert.ok(firstSession);
    assert.ok(secondSession);
    assert.notEqual(firstSession, secondSession);
    assert.equal(workingDirectories.get("first-chat"), firstWorkspace);
    assert.equal(workingDirectories.get("second-chat"), secondWorkspace);
    assert.deepEqual(firstSession.pendingTurns.map(({ prompt }) => prompt), [
      "work in the first chat",
    ]);
    assert.deepEqual(secondSession.pendingTurns.map(({ prompt }) => prompt), [
      "work in the second chat",
    ]);
    assert.equal(agent.stateFor("first-chat"), "running");
    assert.equal(agent.stateFor("second-chat"), "running");

    await agent.cancel("first-chat");
    assert.equal(firstSession.abortCalls, 1);
    assert.equal(secondSession.abortCalls, 0);
    assert.equal(agent.stateFor("first-chat"), "cancelling");
    assert.equal(agent.stateFor("second-chat"), "running");

    firstSession.emit({
      type: "assistant.message",
      id: "first-assistant-event",
      parentId: null,
      timestamp: new Date().toISOString(),
      data: { content: "first response", messageId: "first-assistant-message" },
    });
    firstSession.emit({
      type: "session.idle",
      id: "first-idle-event",
      parentId: "first-assistant-event",
      timestamp: new Date().toISOString(),
      ephemeral: true,
      data: {},
    });
    firstSession.pendingTurns[0]?.resolve();

    assert.equal(agent.stateFor("first-chat"), "idle");
    assert.equal(agent.stateFor("second-chat"), "running");
    assert.equal(
      eventStore.list({ chatId: "first-chat" }).some(
        (event) =>
          event.kind === "assistant.message" &&
          "content" in event.payload &&
          event.payload.content === "first response",
      ),
      true,
    );
    assert.equal(
      eventStore.list({ chatId: "second-chat" }).some(
        (event) =>
          event.kind === "assistant.message" &&
          "content" in event.payload &&
          event.payload.content === "first response",
      ),
      false,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await agent.send("work after the first chat finishes", "same-project-chat");
    const sameProjectSession = sessions.get("same-project-chat");
    assert.ok(sameProjectSession);
    assert.deepEqual(sameProjectSession.pendingTurns.map(({ prompt }) => prompt), [
      "work after the first chat finishes",
    ]);

    secondSession.emit({
      type: "assistant.message",
      id: "second-assistant-event",
      parentId: null,
      timestamp: new Date().toISOString(),
      data: { content: "second response", messageId: "second-assistant-message" },
    });
    secondSession.emit({
      type: "session.idle",
      id: "second-idle-event",
      parentId: "second-assistant-event",
      timestamp: new Date().toISOString(),
      ephemeral: true,
      data: {},
    });
    secondSession.pendingTurns[0]?.resolve();
    sameProjectSession.pendingTurns[0]?.resolve();
  } finally {
    await agent.stop();
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});
