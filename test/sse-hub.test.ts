import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { SseHub } from "../src/sse-hub.js";

class FakeResponse extends EventEmitter {
  public readonly chunks: string[] = [];

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  public end(): void {}
}

test("SseHub does not deliver chat-scoped events to clients subscribed to a different chat", () => {
  const hub = new SseHub();
  const clientA = new FakeResponse();
  const clientB = new FakeResponse();

  hub.add(clientA as unknown as import("node:http").ServerResponse, [], "chat-a");
  hub.add(clientB as unknown as import("node:http").ServerResponse, [], "chat-b");

  hub.publish(
    { id: 1, kind: "user.message", createdAt: new Date().toISOString(), payload: { content: "hello from A" } },
    "chat-a",
  );

  const clientAReceived = clientA.chunks.some((chunk) => chunk.includes("hello from A"));
  const clientBReceived = clientB.chunks.some((chunk) => chunk.includes("hello from A"));

  assert.equal(clientAReceived, true, "the subscriber for chat-a should receive its own event");
  assert.equal(clientBReceived, false, "a subscriber for chat-b must not receive chat-a's event");
});
