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
