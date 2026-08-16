import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineTool, type Tool } from "@github/copilot-sdk";

interface DeploymentArguments {
  readonly commitSha: string;
}

export interface DeploymentToolOptions {
  readonly workspace: string;
  readonly allowedGitRemote: string;
  readonly requestDirectory: string;
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  }).trim();
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

export function createDeploymentTool(options: DeploymentToolOptions): Tool<DeploymentArguments> {
  return defineTool<DeploymentArguments>("deploy_agent_outpost", {
    description:
      "Deploy the exact clean commit currently checked out on agent/current. " +
      "Call this only after validation, commit, and push have succeeded.",
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
      const branch = git(options.workspace, ["branch", "--show-current"]);
      if (branch !== "agent/current") {
        throw new Error(`Deployment is allowed only from agent/current; current branch is ${branch}`);
      }
      const head = git(options.workspace, ["rev-parse", "HEAD"]);
      if (head !== commitSha) {
        throw new Error(`Requested commit ${commitSha} is not the checked-out HEAD ${head}`);
      }
      if (git(options.workspace, ["status", "--porcelain=v1"]) !== "") {
        throw new Error("The workspace must be clean before deployment");
      }
      const pushRemote = git(options.workspace, ["remote", "get-url", "--push", "origin"]);
      if (pushRemote !== options.allowedGitRemote) {
        throw new Error("The origin push URL does not match OUTPOST_ALLOWED_GIT_REMOTE");
      }

      mkdirSync(options.requestDirectory, { recursive: true, mode: 0o700 });
      const temporaryPath = join(options.requestDirectory, `.pending-${process.pid}-${Date.now()}`);
      const pendingPath = join(options.requestDirectory, "pending");
      if (existsSync(pendingPath)) {
        throw new Error("A deployment request is already pending");
      }
      writeFileSync(temporaryPath, `${commitSha}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, pendingPath);

      return {
        status: "scheduled",
        commitSha,
        message:
          "Deployment was scheduled. Send the user a concise confirmation now; " +
          "the service will restart after the response is persisted.",
      };
    },
  });
}
