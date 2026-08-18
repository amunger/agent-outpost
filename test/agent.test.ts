import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SessionEvent } from "@github/copilot-sdk";

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
  readonly resolve: () => void;
}

interface FakeSession {
  readonly adapter: CopilotSessionAdapter;
  readonly pendingTurns: PendingTurn[];
  readonly abortCalls: number;
  emit(event: SessionEvent): void;
}

function createFakeCopilotClient(): {
  readonly client: CopilotClientAdapter;
  readonly sessions: Map<string, FakeSession>;
  readonly workingDirectories: Map<string, string>;
} {
  const sessions = new Map<string, FakeSession>();
  const workingDirectories = new Map<string, string>();

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
        await new Promise<void>((resolve) => {
          pendingTurns.push({ prompt, resolve });
        });
        return undefined;
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
    listModels: async () => [],
    getSessionMetadata: async () => undefined,
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
      return session.adapter;
    },
    resumeSession: async (sessionId) => {
      const session = createSession();
      sessions.set(sessionId, session);
      return session.adapter;
    },
  };
  return { client, sessions, workingDirectories };
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
