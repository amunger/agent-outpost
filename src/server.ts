import { mkdir } from "node:fs/promises";

import { CopilotAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { EventStore } from "./event-store.js";
import { createOutpostServer } from "./http-server.js";
import { ResourceMonitor } from "./resource-monitor.js";
import { SseHub } from "./sse-hub.js";

const config = loadConfig();
await mkdir(config.workspace, { recursive: true });
await mkdir(config.dataDirectory, { recursive: true });

const eventStore = new EventStore(config.dataDirectory);
const resourceMonitor = new ResourceMonitor();
const eventHub = new SseHub();
const agent = new CopilotAgent({
  workspace: config.workspace,
  sessionId: config.sessionId,
  model: config.model,
  ...(config.allowedGitRemote ? { allowedGitRemote: config.allowedGitRemote } : {}),
  deploymentRequestDirectory: config.deploymentRequestDirectory,
  ...(config.githubRepository ? { githubRepository: config.githubRepository } : {}),
  eventStore,
  eventHub,
});

const server = createOutpostServer({ config, agent, eventStore, eventHub, resourceMonitor });
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
