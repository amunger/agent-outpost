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
