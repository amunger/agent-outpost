import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
} {
  const sessions = new Map<string, FakeSession>();

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
      const session = createSession();
      sessions.set(options.sessionId, session);
      return session.adapter;
    },
    resumeSession: async (sessionId) => {
      const session = createSession();
      sessions.set(sessionId, session);
      return session.adapter;
    },
  };
  return { client, sessions };
}

test("A phone can leave one chat running and use another without mixing replies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-agent-"));
  const eventStore = new EventStore(directory);
  const eventHub = new SseHub();
  const { client, sessions } = createFakeCopilotClient();
  const agent = new CopilotAgent({
    workspace: directory,
    sessionId: "primary-chat",
    model: "auto",
    deploymentRequestDirectory: join(directory, "deploy-requests"),
    artifactDirectory: join(directory, "artifacts"),
    eventStore,
    eventHub,
    client,
  });

  try {
    await agent.start();
    await agent.send("work in the first chat", "first-chat");
    await agent.send("work in the second chat", "second-chat");

    const firstSession = sessions.get("first-chat");
    const secondSession = sessions.get("second-chat");
    assert.ok(firstSession);
    assert.ok(secondSession);
    assert.notEqual(firstSession, secondSession);
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
  } finally {
    await agent.stop();
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});
