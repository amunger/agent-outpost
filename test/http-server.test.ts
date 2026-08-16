import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  const artifactDirectory = join(directory, "artifacts");
  mkdirSync(publicDirectory);
  mkdirSync(artifactDirectory);
  writeFileSync(join(publicDirectory, "index.html"), "<h1>Outpost</h1>");
  writeFileSync(join(publicDirectory, "app.js"), "console.log('outpost');");
  writeFileSync(join(publicDirectory, "styles.css"), "body { color: red; }");
  const artifactName = "screenshot-123-12345678-1234-1234-1234-123456789abc.png";
  const expiredArtifactName = "screenshot-122-12345678-1234-1234-1234-123456789abc.png";
  writeFileSync(join(artifactDirectory, artifactName), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const expiredArtifactPath = join(artifactDirectory, expiredArtifactName);
  writeFileSync(expiredArtifactPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(expiredArtifactPath, expiredAt, expiredAt);

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
    allowedGitRemote: "https://github.com/amunger/agent-outpost.git",
    githubRepository: "amunger/agent-outpost",
    deploymentRequestDirectory: join(directory, "deploy-requests"),
    artifactDirectory,
    sessionId: "test",
    model: "auto",
    production: true,
  };
  const server = createOutpostServer({
    config,
    agent,
    eventStore,
    eventHub,
    resourceMonitor,
    listRepositories: () => ["amunger/agent-outpost", "amunger/second-repo"],
  });

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

    const artifact = await fetch(`${baseUrl}/api/artifacts/${artifactName}`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const expiredArtifact = await fetch(`${baseUrl}/api/artifacts/${expiredArtifactName}`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    assert.equal(expiredArtifact.status, 404);

    const script = await fetch(`${baseUrl}/app.js`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    assert.equal(script.headers.get("cache-control"), "no-cache");

    const styles = await fetch(`${baseUrl}/styles.css`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    assert.equal(styles.headers.get("cache-control"), "no-cache");

    const repositories = await fetch(`${baseUrl}/api/repositories`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    const repositoriesBody = (await repositories.json()) as { repositories: string[] };
    assert.deepEqual(repositoriesBody.repositories, [
      "amunger/agent-outpost",
      "amunger/second-repo",
    ]);

    const createdChat = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
        Origin: baseUrl,
      },
      body: JSON.stringify({ repository: "amunger/second-repo" }),
    });
    assert.equal(createdChat.status, 201);
    const createdChatBody = (await createdChat.json()) as {
      chat: { id: string; projectId: string; repository: string };
    };
    const chat = createdChatBody.chat;
    assert.equal(chat.repository, "amunger/second-repo");
    assert.match(chat.projectId, /^github-[0-9a-f]{16}$/);
    assert.equal(eventStore.listChats().some(({ id }) => id === chat.id), true);

    const selectedChat = await fetch(`${baseUrl}/api/chats/${encodeURIComponent(chat.id)}/select`, {
      method: "POST",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Origin: baseUrl,
      },
    });
    assert.equal(selectedChat.status, 200);
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
