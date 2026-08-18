import { mkdir } from "node:fs/promises";

import { CopilotAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { EventStore } from "./event-store.js";
import { createOutpostServer } from "./http-server.js";
import { ResourceMonitor } from "./resource-monitor.js";
import { SseHub } from "./sse-hub.js";
import {
  loadProjectRegistry,
  type ProjectDefinition,
} from "./project-registry.js";

const config = loadConfig();
await mkdir(config.workspace, { recursive: true });
await mkdir(config.dataDirectory, { recursive: true });

const eventStore = new EventStore(config.dataDirectory);
const legacyProject: ProjectDefinition = {
  id: "agent-outpost",
  name: "Agent Outpost",
  repository: config.githubRepository ?? "local/agent-outpost",
  workspace: config.workspace,
  ...(config.allowedGitRemote ? { allowedGitRemote: config.allowedGitRemote } : {}),
  integrationBranch: "agent/current",
  ...(config.githubRepository ? { githubRepository: config.githubRepository } : {}),
  deploymentTargetId: "agent-outpost",
  deploymentRequestDirectory: config.deploymentRequestDirectory,
  validationProfile: "agent-outpost",
  workspacePreview: "static-public",
};
const projects = loadProjectRegistry({
  legacyProject,
  ...(config.projectRegistryPath ? { registryPath: config.projectRegistryPath } : {}),
  requireRootOwned: config.production,
});
eventStore.adoptLegacyProjects(
  projects.defaultProject.id,
  projects.defaultProject.repository,
);
const resourceMonitor = new ResourceMonitor();
const eventHub = new SseHub();
const agent = new CopilotAgent({
  workspace: config.workspace,
  sessionId: config.sessionId,
  model: config.model,
  ...(config.allowedGitRemote ? { allowedGitRemote: config.allowedGitRemote } : {}),
  deploymentRequestDirectory: config.deploymentRequestDirectory,
  ...(config.githubRepository ? { githubRepository: config.githubRepository } : {}),
  artifactDirectory: config.artifactDirectory,
  ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
  ...(config.allowedTailscaleUser ? { tailscaleUser: config.allowedTailscaleUser } : {}),
  eventStore,
  eventHub,
  projects,
  resolveProjectId: (chatId) => eventStore.getChat(chatId)?.projectId,
});

const server = createOutpostServer({
  config,
  agent,
  eventStore,
  eventHub,
  resourceMonitor,
  projects,
});
server.listen(config.port, config.host, () => {
  console.log(`Agent Outpost listening on http://${config.host}:${config.port}`);
});
void agent.start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`Received ${signal}; shutting down`);
  eventHub.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  try {
    await agent.stop();
  } finally {
    resourceMonitor[Symbol.dispose]();
    eventStore[Symbol.dispose]();
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
