import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeploymentTool } from "../src/deployment-tool.js";

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

test("deployment tool schedules only the exact clean agent/current commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-deploy-tool-"));
  const repository = join(root, "repository");
  const requests = join(root, "requests");
  const remote = "https://github.com/amunger/agent-outpost.git";

  try {
    execFileSync("git", ["init", "--initial-branch=agent/current", repository]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["remote", "add", "origin", remote]);
    writeFileSync(join(repository, "README.md"), "ready\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Initial"]);
    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    const tool = createDeploymentTool({
      workspace: repository,
      allowedGitRemote: remote,
      requestDirectory: requests,
    });

    assert.ok(tool.handler);
    const result = await tool.handler({ commitSha }, {
      sessionId: "test",
      toolCallId: "call-1",
      toolName: tool.name,
      arguments: { commitSha },
    });

    assert.deepEqual(result, {
      status: "scheduled",
      commitSha,
      message:
        "Deployment was scheduled. Send the user a concise confirmation now; " +
        "the service will restart after the response is persisted.",
    });
    assert.equal(readFileSync(join(requests, "pending"), "utf8"), `${commitSha}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment tool rejects a dirty workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-dirty-deploy-"));
  const repository = join(root, "repository");
  const requests = join(root, "requests");
  const remote = "https://github.com/amunger/agent-outpost.git";

  try {
    execFileSync("git", ["init", "--initial-branch=agent/current", repository]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["remote", "add", "origin", remote]);
    writeFileSync(join(repository, "README.md"), "ready\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Initial"]);
    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(join(repository, "dirty.txt"), "dirty\n");
    const tool = createDeploymentTool({
      workspace: repository,
      allowedGitRemote: remote,
      requestDirectory: requests,
    });

    assert.ok(tool.handler);
    await assert.rejects(
      async () =>
        tool.handler?.({ commitSha }, {
          sessionId: "test",
          toolCallId: "call-2",
          toolName: tool.name,
          arguments: { commitSha },
        }),
      /clean/,
    );
    assert.equal(existsSync(join(requests, "pending")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
