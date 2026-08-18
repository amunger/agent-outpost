import { isAbsolute, resolve } from "node:path";

export interface OutpostConfig {
  readonly host: string;
  readonly port: number;
  readonly workspace: string;
  readonly dataDirectory: string;
  readonly publicDirectory: string;
  readonly allowedTailscaleUser?: string;
  readonly allowedGitRemote?: string;
  readonly githubRepository?: string;
  readonly deploymentRequestDirectory: string;
  readonly artifactDirectory: string;
  readonly publicBaseUrl?: string;
  readonly projectRegistryPath?: string;
  readonly sessionId: string;
  readonly model: string;
  readonly production: boolean;
}

function requiredPath(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  return isAbsolute(candidate) ? candidate : resolve(candidate);
}

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`OUTPOST_PORT must be an integer from 1 through 65535; received ${value ?? ""}`);
  }
  return port;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): OutpostConfig {
  const allowedTailscaleUser = environment.OUTPOST_ALLOWED_TAILSCALE_USER?.trim().toLowerCase();
  const allowedGitRemote = environment.OUTPOST_ALLOWED_GIT_REMOTE?.trim();
  const githubRepository = environment.OUTPOST_GITHUB_REPOSITORY?.trim();
  const publicBaseUrl = environment.OUTPOST_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const projectRegistryPath = environment.OUTPOST_PROJECT_REGISTRY?.trim();
  const production = environment.NODE_ENV === "production";
  if (production && !allowedTailscaleUser) {
    throw new Error("OUTPOST_ALLOWED_TAILSCALE_USER is required when NODE_ENV=production");
  }
  if (production && !projectRegistryPath && !allowedGitRemote) {
    throw new Error("OUTPOST_ALLOWED_GIT_REMOTE is required when NODE_ENV=production");
  }
  if (production && !projectRegistryPath && !githubRepository) {
    throw new Error("OUTPOST_GITHUB_REPOSITORY is required when NODE_ENV=production");
  }

  return {
    host: environment.OUTPOST_HOST?.trim() || "127.0.0.1",
    port: parsePort(environment.OUTPOST_PORT),
    workspace: requiredPath(environment.OUTPOST_WORKSPACE, process.cwd()),
    dataDirectory: requiredPath(environment.OUTPOST_DATA_DIR, "./data"),
    publicDirectory: requiredPath(environment.OUTPOST_PUBLIC_DIR, "./public"),
    ...(allowedTailscaleUser ? { allowedTailscaleUser } : {}),
    ...(allowedGitRemote ? { allowedGitRemote } : {}),
    ...(githubRepository ? { githubRepository } : {}),
    deploymentRequestDirectory: requiredPath(
      environment.OUTPOST_DEPLOY_REQUEST_DIR,
      "./data/deploy-requests",
    ),
    artifactDirectory: requiredPath(environment.OUTPOST_ARTIFACT_DIR, "./data/artifacts"),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(projectRegistryPath
      ? { projectRegistryPath: requiredPath(projectRegistryPath, projectRegistryPath) }
      : {}),
    sessionId: environment.OUTPOST_SESSION_ID?.trim() || "agent-outpost-main",
    model: environment.OUTPOST_MODEL?.trim() || "auto",
    production,
  };
}
