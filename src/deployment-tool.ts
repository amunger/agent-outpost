import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineTool, type Tool } from "@github/copilot-sdk";

interface DeploymentArguments {
  readonly commitSha: string;
}

type LatestDeploymentArguments = Record<string, never>;

export interface DeploymentToolOptions {
  readonly workspace: string;
  readonly allowedGitRemote: string;
  readonly requestDirectory: string;
}

const safeGitConfiguration = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
] as const;

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", [...safeGitConfiguration, ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  }).trim();
}

function isAncestor(workspace: string, ancestor: string, descendant: string): boolean {
  return (
    spawnSync(
      "git",
      [...safeGitConfiguration, "merge-base", "--is-ancestor", ancestor, descendant],
      {
        cwd: workspace,
        env: {
          ...process.env,
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
          GIT_TERMINAL_PROMPT: "0",
        },
        windowsHide: true,
      },
    ).status === 0
  );
}

function validateArguments(value: unknown): DeploymentArguments {
  if (
    typeof value !== "object" ||
    value === null ||
    !("commitSha" in value) ||
    typeof value.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.commitSha)
  ) {
    throw new Error("commitSha must be a full 40-character lowercase Git commit SHA");
  }
  return { commitSha: value.commitSha };
}

function scheduleDeployment(
  requestDirectory: string,
  requestValue: string,
  reportedCommitSha: string,
): {
  readonly status: "scheduled";
  readonly commitSha: string;
  readonly message: string;
} {
  mkdirSync(requestDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(requestDirectory, `.pending-${process.pid}-${Date.now()}`);
  const pendingPath = join(requestDirectory, "pending");
  writeFileSync(temporaryPath, `${requestValue}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    // A hard link provides atomic no-replace publication after the complete
    // request content has been written.
    linkSync(temporaryPath, pendingPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("A deployment request is already pending");
    }
    throw error;
  } finally {
    unlinkSync(temporaryPath);
  }

  return {
    status: "scheduled",
    commitSha: reportedCommitSha,
    message:
      "Deployment was scheduled. Send the user a concise confirmation now; " +
      "the service will restart after the response is persisted.",
  };
}

function assertDeploymentWorkspace(
  options: DeploymentToolOptions,
): void {
  const branch = git(options.workspace, ["branch", "--show-current"]);
  if (branch !== "agent/current") {
    throw new Error(`Deployment is allowed only from agent/current; current branch is ${branch}`);
  }
  if (git(options.workspace, ["status", "--porcelain=v1"]) !== "") {
    throw new Error("The workspace must be clean before deployment");
  }
  const fetchRemotes = git(options.workspace, ["remote", "get-url", "--all", "origin"])
    .split(/\r?\n/)
    .filter(Boolean);
  const pushRemotes = git(options.workspace, ["remote", "get-url", "--all", "--push", "origin"])
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    fetchRemotes.length !== 1 ||
    pushRemotes.length !== 1 ||
    fetchRemotes[0] !== options.allowedGitRemote ||
    pushRemotes[0] !== options.allowedGitRemote
  ) {
    throw new Error("The origin fetch and push URLs must exactly match OUTPOST_ALLOWED_GIT_REMOTE");
  }
}

function exactDeploymentTool(options: DeploymentToolOptions): Tool<DeploymentArguments> {
  return defineTool<DeploymentArguments>("deploy_agent_outpost", {
    description:
      "Deploy the exact clean commit currently checked out on agent/current. " +
      "This is an internal handoff from the typed publisher; never ask the user to provide the SHA.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["commitSha"],
      properties: {
        commitSha: {
          type: "string",
          pattern: "^[0-9a-f]{40}$",
          description: "The full commit SHA already pushed to origin/agent/current.",
        },
      },
    },
    defer: "never",
    skipPermission: true,
    handler: (value: DeploymentArguments) => {
      const { commitSha } = validateArguments(value);
      assertDeploymentWorkspace(options);
      const head = git(options.workspace, ["rev-parse", "HEAD"]);
      if (head !== commitSha) {
        throw new Error(`Requested commit ${commitSha} is not the checked-out HEAD ${head}`);
      }
      return scheduleDeployment(options.requestDirectory, commitSha, commitSha);
    },
  });
}

function latestDeploymentTool(
  options: DeploymentToolOptions,
): Tool<LatestDeploymentArguments> {
  return defineTool<LatestDeploymentArguments>("deploy_latest_agent_outpost", {
    description:
      "Resolve and deploy the latest clean origin/agent/current revision. " +
      "Use for plain-language requests such as deploy the latest changes. " +
      "The user does not provide a commit SHA or CI status; the deployment controller runs validation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    defer: "never",
    skipPermission: true,
    handler: () => {
      assertDeploymentWorkspace(options);
      git(options.workspace, ["fetch", "--prune", "origin", "agent/current"]);
      const head = git(options.workspace, ["rev-parse", "HEAD"]);
      const remoteHead = git(options.workspace, ["rev-parse", "origin/agent/current"]);

      if (head !== remoteHead) {
        if (!isAncestor(options.workspace, head, remoteHead)) {
          throw new Error(
            "The local operator branch is ahead of or diverged from origin/agent/current; " +
              "publish or reconcile it before deployment",
          );
        }
        git(options.workspace, ["merge", "--ff-only", "origin/agent/current"]);
      }

      const commitSha = git(options.workspace, ["rev-parse", "HEAD"]);
      return scheduleDeployment(options.requestDirectory, "latest", commitSha);
    },
  });
}

export function createDeploymentTools(
  options: DeploymentToolOptions,
): [Tool<DeploymentArguments>, Tool<LatestDeploymentArguments>] {
  return [exactDeploymentTool(options), latestDeploymentTool(options)];
}
