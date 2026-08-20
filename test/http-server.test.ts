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
import { ProjectRegistry } from "../src/project-registry.js";

class FakeAgent implements AgentController {
  public state: AgentState = "idle";
  public model = "auto";
  public readonly messages: string[] = [];
  public readonly sentChatIds: (string | null)[] = [];
  public readonly states = new Map<string, AgentState>();

  public stateFor(chatId: string | null): AgentState {
    return this.states.get(chatId ?? "test") ?? this.state;
  }

  public async listModels(): Promise<string[]> {
    return ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-sonnet-4.5"];
  }

  public setModel(model: string): void {
    this.model = model;
  }

  public async start(): Promise<void> {}

  public async send(content: string, chatId: string | null): Promise<void> {
    this.messages.push(content);
    this.sentChatIds.push(chatId);
  }

  public async cancel(_chatId: string | null): Promise<void> {}

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
  eventStore.createChat({
    id: "disabled-project-chat",
    projectId: "disabled-project",
    name: "Disabled",
    repository: "amunger/disabled",
  });
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
  const projects = new ProjectRegistry("agent-outpost", [
    {
      id: "agent-outpost",
      name: "Agent Outpost",
      repository: "amunger/agent-outpost",
      workspace: directory,
      allowedGitRemote: "https://github.com/amunger/agent-outpost.git",
      integrationBranch: "agent/current",
      githubRepository: "amunger/agent-outpost",
      deploymentTargetId: "agent-outpost",
      deploymentRequestDirectory: join(directory, "deploy-requests"),
      validationProfile: "agent-outpost",
      workspacePreview: "static-public",
    },
    {
      id: "second-repo",
      name: "Second Repo",
      repository: "amunger/second-repo",
      workspace: join(directory, "second-repo"),
      allowedGitRemote: "https://github.com/amunger/second-repo.git",
      integrationBranch: "agent/current",
      githubRepository: "amunger/second-repo",
      deploymentTargetId: "second-repo",
      deploymentRequestDirectory: join(directory, "second-deploy-requests"),
      validationProfile: "node-nextjs",
      workspacePreview: "none",
    },
  ]);
  const server = createOutpostServer({
    config,
    agent,
    eventStore,
    eventHub,
    resourceMonitor,
    projects,
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

    const modelResponse = await fetch(`${baseUrl}/api/model`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    assert.equal(modelResponse.status, 200);
    const modelBody = (await modelResponse.json()) as {
      model: string;
      models: string[];
      reasoningEffort: string;
    };
    assert.equal(modelBody.models.slice(0, 3).join(","), "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna");
    assert.equal(modelBody.reasoningEffort, "medium");

    const repositories = await fetch(`${baseUrl}/api/repositories`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    const repositoriesBody = (await repositories.json()) as { repositories: string[] };
    assert.deepEqual(repositoriesBody.repositories, [
      "amunger/agent-outpost",
      "amunger/second-repo",
    ]);

    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    const projectBody = (await projectResponse.json()) as {
      projects: Array<{ id: string; name: string; repository: string }>;
    };
    assert.deepEqual(projectBody.projects, [
      { id: "agent-outpost", name: "Agent Outpost", repository: "amunger/agent-outpost" },
      { id: "second-repo", name: "Second Repo", repository: "amunger/second-repo" },
    ]);
    const chatListResponse = await fetch(`${baseUrl}/api/chats`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    const chatListBody = (await chatListResponse.json()) as {
      chats: Array<{ id: string }>;
    };
    assert.equal(
      chatListBody.chats.some(({ id }) => id === "disabled-project-chat"),
      false,
    );

    const unregisteredChat = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
        Origin: baseUrl,
      },
      body: JSON.stringify({ repository: "amunger/unregistered" }),
    });
    assert.equal(unregisteredChat.status, 400);
    assert.match(
      ((await unregisteredChat.json()) as { error: string }).error,
      /not registered/,
    );

    const createdChat = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
        Origin: baseUrl,
      },
      body: JSON.stringify({ projectId: "second-repo" }),
    });
    assert.equal(createdChat.status, 201);
    const createdChatBody = (await createdChat.json()) as {
      chat: { id: string; projectId: string; repository: string };
    };
    const chat = createdChatBody.chat;
    assert.equal(chat.repository, "amunger/second-repo");
    assert.equal(chat.projectId, "second-repo");
    assert.equal(eventStore.listChats().some(({ id }) => id === chat.id), true);

    const renamedChat = await fetch(`${baseUrl}/api/chats/${encodeURIComponent(chat.id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
        Origin: baseUrl,
      },
      body: JSON.stringify({ name: "Release notes" }),
    });
    assert.equal(renamedChat.status, 200);
    const renamedChatBody = (await renamedChat.json()) as { chat: { name: string } };
    assert.equal(renamedChatBody.chat.name, "Release notes");
    assert.equal(eventStore.listChats().find(({ id }) => id === chat.id)?.name, "Release notes");

    eventStore.append({ kind: "user.message", payload: { content: "primary chat message" } }, "test");
    const selectedChat = await fetch(`${baseUrl}/api/chats/${encodeURIComponent(chat.id)}/select`, {
      method: "POST",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Origin: baseUrl,
      },
    });
    assert.equal(selectedChat.status, 200);
    const newChatSession = await fetch(`${baseUrl}/api/session?chatId=${encodeURIComponent(chat.id)}`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    const newChatSessionBody = (await newChatSession.json()) as { events: unknown[] };
    assert.deepEqual(newChatSessionBody.events, []);

    const statistics = await fetch(
      `${baseUrl}/api/chats/${encodeURIComponent(chat.id)}/statistics`,
      { headers: { "Tailscale-User-Login": "owner@example.com" } },
    );
    assert.equal(statistics.status, 200);
    const statisticsBody = (await statistics.json()) as {
      statistics: {
        messageCount: number;
        estimatedTokens: number;
        aicUsage: number;
        firstMessageAt: string | null;
        createdAt: string;
      };
    };
    assert.equal(statisticsBody.statistics.messageCount, 0);
    assert.equal(statisticsBody.statistics.firstMessageAt, null);
    assert.equal(typeof statisticsBody.statistics.createdAt, "string");

    const primaryStatistics = await fetch(
      `${baseUrl}/api/chats/${encodeURIComponent("test")}/statistics`,
      { headers: { "Tailscale-User-Login": "owner@example.com" } },
    );
    assert.equal(primaryStatistics.status, 200);

    const protectedDelete = await fetch(`${baseUrl}/api/chats/${encodeURIComponent("test")}`, {
      method: "DELETE",
      headers: { "Tailscale-User-Login": "owner@example.com", Origin: baseUrl },
    });
    assert.equal(protectedDelete.status, 409);

    const deletedChat = await fetch(`${baseUrl}/api/chats/${encodeURIComponent(chat.id)}`, {
      method: "DELETE",
      headers: { "Tailscale-User-Login": "owner@example.com", Origin: baseUrl },
    });
    assert.equal(deletedChat.status, 200);
    assert.equal(eventStore.listChats().some(({ id }) => id === chat.id), false);

    const missingDelete = await fetch(`${baseUrl}/api/chats/${encodeURIComponent(chat.id)}`, {
      method: "DELETE",
      headers: { "Tailscale-User-Login": "owner@example.com", Origin: baseUrl },
    });
    assert.equal(missingDelete.status, 404);

    eventStore.append(
      {
        kind: "deployment.candidate",
        payload: {
          candidateId: "11111111-1111-4111-8111-111111111111",
          projectId: "agent-outpost",
          projectName: "Agent Outpost",
          targetId: "agent-outpost",
          integrationBranch: "agent/current",
          chatId: "test",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          description: "Test deployment candidate",
          files: [],
          diffUrl: "/api/deployment-candidates/11111111-1111-4111-8111-111111111111/diff",
          status: "pending",
        },
      },
      "test",
    );
    const messageAfterCandidate = await fetch(`${baseUrl}/api/session/messages?chatId=test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: "message after deployment candidate" }),
    });
    assert.equal(messageAfterCandidate.status, 202);
    assert.deepEqual(agent.messages, ["hello", "message after deployment candidate"]);
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

test("Concurrent chat switches do not cross-contaminate message routing or history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-http-contamination-"));
  const publicDirectory = join(directory, "public");
  const artifactDirectory = join(directory, "artifacts");
  mkdirSync(publicDirectory);
  mkdirSync(artifactDirectory);
  writeFileSync(join(publicDirectory, "index.html"), "<h1>Outpost</h1>");
  writeFileSync(join(publicDirectory, "app.js"), "console.log('outpost');");
  writeFileSync(join(publicDirectory, "styles.css"), "body { color: red; }");

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
    sessionId: "primary-chat",
    model: "auto",
    production: true,
  };
  const server = createOutpostServer({
    config,
    agent,
    eventStore,
    eventHub,
    resourceMonitor,
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { "Tailscale-User-Login": "owner@example.com", Origin: baseUrl };

    const createdChat = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "amunger/agent-outpost" }),
    });
    const secondChat = ((await createdChat.json()) as { chat: { id: string } }).chat;
    agent.states.set("primary-chat", "running");
    agent.states.set(secondChat.id, "idle");

    const chatsResponse = await fetch(`${baseUrl}/api/chats`, { headers });
    const chats = ((await chatsResponse.json()) as {
      chats: { id: string; state: AgentState }[];
    }).chats;
    assert.equal(chats.find(({ id }) => id === "primary-chat")?.state, "running");
    assert.equal(chats.find(({ id }) => id === secondChat.id)?.state, "idle");

    // Select the second chat first (simulating a second browser tab), then send
    // a message intended for the primary chat. The message must be attributed
    // to the primary chat, not silently redirected to whichever chat was most
    // recently selected by an unrelated tab/request.
    await fetch(`${baseUrl}/api/chats/${encodeURIComponent(secondChat.id)}/select`, {
      method: "POST",
      headers,
    });
    const sendResponse = await fetch(
      `${baseUrl}/api/session/messages?chatId=${encodeURIComponent("primary-chat")}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "message for primary chat" }),
      },
    );
    assert.equal(sendResponse.status, 202);
    assert.deepEqual(agent.sentChatIds, ["primary-chat"]);

    // Simulate the agent turn's own event persistence, scoped to the chatId it was given.
    eventStore.append(
      { kind: "user.message", payload: { content: "message for primary chat" } },
      "primary-chat",
    );

    const primarySession = await fetch(
      `${baseUrl}/api/session?chatId=${encodeURIComponent("primary-chat")}`,
      { headers },
    );
    const primaryEvents = ((await primarySession.json()) as { events: { payload: { content?: string } }[] }).events;
    assert.equal(
      primaryEvents.some((event) => event.payload.content === "message for primary chat"),
      true,
      "the primary chat's own history must contain its message",
    );

    const secondSession = await fetch(
      `${baseUrl}/api/session?chatId=${encodeURIComponent(secondChat.id)}`,
      { headers },
    );
    const secondSnapshot = (await secondSession.json()) as {
      state: AgentState;
      events: { payload: { content?: string } }[];
    };
    assert.equal(
      secondSnapshot.events.some((event) => event.payload.content === "message for primary chat"),
      false,
      "the second chat must not see a message that belongs to the primary chat",
    );
    assert.equal(
      secondSnapshot.state,
      "idle",
      "an idle chat must not inherit the running state of another chat",
    );
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
