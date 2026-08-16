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
