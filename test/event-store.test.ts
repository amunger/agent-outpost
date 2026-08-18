import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EventStore } from "../src/event-store.js";

test("EventStore appends and lists durable ordered events", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-"));
  try {
    using store = new EventStore(directory);
    const first = store.append({ kind: "user.message", payload: { content: "hello" } });
    const second = store.append({ kind: "session.state", payload: { state: "running" } });

    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.deepEqual(store.list({ after: 1 }), [second]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("EventStore persists and replays screenshot artifact events", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-artifact-"));
  try {
    using store = new EventStore(directory);
    const stored = store.append({
      kind: "assistant.artifact",
      payload: {
        caption: "Mobile UI screenshot",
        url: "/api/artifacts/screenshot-1-11111111-1111-1111-1111-111111111111.png",
        kind: "screenshot",
        absoluteUrl: "https://outpost.example.ts.net/api/artifacts/screenshot-1-11111111-1111-1111-1111-111111111111.png",
      },
    });

    assert.equal(stored.kind, "assistant.artifact");
    assert.deepEqual(store.list({ after: 0 }), [stored]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("EventStore isolates events between concurrently active chats", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-chat-isolation-"));
  try {
    using store = new EventStore(directory);
    store.append({ kind: "user.message", payload: { content: "chat A message" } }, "chat-a");
    store.append({ kind: "user.message", payload: { content: "chat B message" } }, "chat-b");

    const chatAEvents = store.list({ chatId: "chat-a" });
    const chatBEvents = store.list({ chatId: "chat-b" });

    assert.deepEqual(
      chatAEvents.map((event) => event.payload),
      [{ content: "chat A message" }],
    );
    assert.deepEqual(
      chatBEvents.map((event) => event.payload),
      [{ content: "chat B message" }],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("EventStore no longer exposes shared mutable active-chat state", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-no-active-chat-"));
  try {
    using store = new EventStore(directory);
    assert.equal("setActiveChat" in store, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("EventStore finds deployment candidates beyond the bounded timeline window", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-candidates-"));
  try {
    using store = new EventStore(directory);
    for (let index = 0; index < 501; index += 1) {
      store.append(
        { kind: "system.notice", payload: { message: `notice ${index}` } },
        "busy-chat",
      );
    }
    const candidate = store.append(
      {
        kind: "deployment.candidate",
        payload: {
          candidateId: "11111111-1111-4111-8111-111111111111",
          commitSha: "a".repeat(40),
          description: "Independent chat sessions",
          files: [],
          diffUrl: "/api/deployment-candidates/11111111-1111-4111-8111-111111111111/diff",
          status: "pending",
        },
      },
      "busy-chat",
    );

    assert.equal(store.list({ chatId: "busy-chat" }).includes(candidate), false);
    assert.deepEqual(store.listByKind("deployment.candidate"), [candidate]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("EventStore persists project-backed chats across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-chats-"));
  try {
    {
      using store = new EventStore(directory);
      store.ensureChat({
        id: "default-chat",
        projectId: "github-default",
        name: "Default chat",
        repository: "owner/default",
        createdAt: new Date(0).toISOString(),
        lastUsedAt: null,
      });

      test("EventStore migrates legacy repository metadata without reassigning removed projects", () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-outpost-project-migration-"));
        try {
          using store = new EventStore(directory);
          store.createChat({
            id: "legacy-chat",
            projectId: "github-0123456789abcdef",
            name: "Legacy",
            repository: "owner/metadata-only",
          });
          store.createChat({
            id: "removed-project-chat",
            projectId: "removed-project",
            name: "Removed",
            repository: "owner/removed",
          });

          store.adoptLegacyProjects("agent-outpost", "owner/agent-outpost");

          assert.equal(store.getChat("legacy-chat")?.projectId, "agent-outpost");
          assert.equal(store.getChat("legacy-chat")?.repository, "owner/agent-outpost");
          assert.equal(store.getChat("removed-project-chat")?.projectId, "removed-project");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
      store.createChat({
        id: "second-chat",
        projectId: "github-second",
        name: "Second chat",
        repository: "owner/second",
      });
    }

    {
      using store = new EventStore(directory);
      const chats = store.listChats();
      assert.equal(chats.length, 2);
      assert.deepEqual(
        chats.map(({ id, projectId, repository }) => ({ id, projectId, repository })),
        [
          { id: "second-chat", projectId: "github-second", repository: "owner/second" },
          { id: "default-chat", projectId: "github-default", repository: "owner/default" },
        ],
      );
      assert.equal(store.touchChat("missing-chat"), undefined);
      assert.equal(store.touchChat("default-chat")?.id, "default-chat");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
