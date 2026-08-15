import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentController } from "../src/agent.js";
import type { OutpostConfig } from "../src/config.js";
import type { AgentState } from "../src/domain.js";
import { EventStore } from "../src/event-store.js";
import { createOutpostServer } from "../src/http-server.js";
import { ResourceMonitor } from "../src/resource-monitor.js";
import { SseHub } from "../src/sse-hub.js";

class FakeAgent implements AgentController {
  public state: AgentState = "idle";
  public readonly messages: string[] = [];

  public async start(): Promise<void> {}

  public async send(content: string): Promise<void> {
    this.messages.push(content);
  }

  public async cancel(): Promise<void> {}

  public async stop(): Promise<void> {}
}

test("HTTP server enforces Tailscale identity and same-origin mutations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-http-"));
  const publicDirectory = join(directory, "public");
  mkdirSync(publicDirectory);
  writeFileSync(join(publicDirectory, "index.html"), "<h1>Outpost</h1>");

  const eventStore = new EventStore(directory);
  const resourceMonitor = new ResourceMonitor();
  const eventHub = new SseHub();
  const agent = new FakeAgent();
  const config: OutpostConfig = {
    host: "127.0.0.1",
    port: 3000,
    workspace: directory,
    dataDirectory: directory,
    publicDirectory,
    allowedTailscaleUser: "owner@example.com",
    allowedGitRemote: "https://github.com/owner/agent-outpost.git",
    sessionId: "test",
    model: "auto",
    production: true,
  };
  const server = createOutpostServer({ config, agent, eventStore, eventHub, resourceMonitor });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const unauthorized = await fetch(`${baseUrl}/api/session`);
    assert.equal(unauthorized.status, 401);

    const crossOrigin = await fetch(`${baseUrl}/api/session/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
        Origin: "https://malicious.example",
      },
      body: JSON.stringify({ content: "hello" }),
    });
    assert.equal(crossOrigin.status, 403);

    const accepted = await fetch(`${baseUrl}/api/session/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: "hello" }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(agent.messages, ["hello"]);
  } finally {
    eventHub.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    resourceMonitor[Symbol.dispose]();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});
