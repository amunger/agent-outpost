import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeploymentTools } from "../src/deployment-tool.js";
import { EventStore } from "../src/event-store.js";
import { SseHub } from "../src/sse-hub.js";

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

function initializeRepository(
  root: string,
  remote: string,
  branch = "agent/current",
): string {
  const repository = join(root, "repository");
  execFileSync("git", ["init", `--initial-branch=${branch}`, repository]);
  git(repository, ["config", "user.name", "Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["remote", "add", "origin", remote]);
  writeFileSync(join(repository, "README.md"), "ready\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "Initial"]);
  return repository;
}

test("deployment candidate records its registered project and branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-project-deploy-"));
  const requests = join(root, "requests");
  const remote = "https://github.com/amunger/collected-recipes.git";
  const eventStore = new EventStore(join(root, "data"));
  const eventHub = new SseHub();

  try {
    const repository = initializeRepository(root, remote, "recipes/current");
    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    const [exact] = createDeploymentTools({
      projectId: "collected-recipes",
      projectName: "Collected Recipes",
      targetId: "collected-recipes",
      integrationBranch: "recipes/current",
      chatId: "recipes-chat",
      workspace: repository,
      allowedGitRemote: remote,
      requestDirectory: requests,
      eventStore,
      eventHub,
    });

    await exact.handler?.(
      { commitSha },
      {
        sessionId: "recipes-chat",
        toolCallId: "project-candidate",
        toolName: exact.name,
        arguments: { commitSha },
      },
    );

    const candidate = eventStore.listByKind("deployment.candidate").at(-1)?.payload;
    assert.ok(candidate);
    assert.equal(candidate.projectId, "collected-recipes");
    assert.equal(candidate.projectName, "Collected Recipes");
    assert.equal(candidate.targetId, "collected-recipes");
    assert.equal(candidate.integrationBranch, "recipes/current");
    assert.equal(candidate.chatId, "recipes-chat");
    assert.equal(existsSync(join(requests, "pending")), false);
  } finally {
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment tool schedules only the exact clean agent/current commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-deploy-tool-"));
  const requests = join(root, "requests");
  const remote = "https://github.com/amunger/agent-outpost.git";

  try {
    const repository = initializeRepository(root, remote);
    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    const [exact] = createDeploymentTools({
      workspace: repository,
      allowedGitRemote: remote,
      requestDirectory: requests,
    });

    assert.ok(exact.handler);
    const result = await exact.handler(
      { commitSha },
      {
        sessionId: "test",
        toolCallId: "exact-1",
        toolName: exact.name,
        arguments: { commitSha },
      },
    );

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
  const requests = join(root, "requests");
  const remote = "https://github.com/amunger/agent-outpost.git";

  try {
    const repository = initializeRepository(root, remote);
    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(join(repository, "dirty.txt"), "dirty\n");
    const [exact] = createDeploymentTools({
      workspace: repository,
      allowedGitRemote: remote,
      requestDirectory: requests,
    });

    assert.ok(exact.handler);
    const result = await exact.handler?.(
      { commitSha },
      {
        sessionId: "test",
        toolCallId: "dirty-1",
        toolName: exact.name,
        arguments: { commitSha },
      },
    );
    assert.deepEqual(result, {
      status: "blocked",
      error: "The workspace must be clean before deployment",
      message:
        "Deployment was not scheduled and no candidate was created. Resolve this error before retrying.",
    });
    assert.equal(existsSync(join(requests, "pending")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("latest deployment resolves and fast-forwards origin/agent/current", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-latest-deploy-"));
  const remote = join(root, "remote.git");
  const operator = join(root, "operator");
  const publisher = join(root, "publisher");
  const requests = join(root, "requests");

  try {
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "--initial-branch=agent/current", operator]);
    git(operator, ["config", "user.name", "Test"]);
    git(operator, ["config", "user.email", "test@example.com"]);
    git(operator, ["remote", "add", "origin", remote]);
    writeFileSync(join(operator, "README.md"), "initial\n");
    git(operator, ["add", "README.md"]);
    git(operator, ["commit", "-m", "Initial"]);
    git(operator, ["push", "--set-upstream", "origin", "agent/current"]);

    execFileSync("git", ["clone", "--branch", "agent/current", remote, publisher]);
    git(publisher, ["config", "user.name", "Publisher"]);
    git(publisher, ["config", "user.email", "publisher@example.com"]);
    writeFileSync(join(publisher, "README.md"), "latest\n");
    git(publisher, ["add", "README.md"]);
    git(publisher, ["commit", "-m", "Latest"]);
    git(publisher, ["push", "origin", "agent/current"]);
    const expectedSha = git(publisher, ["rev-parse", "HEAD"]);

    const [, latest] = createDeploymentTools({
      workspace: operator,
      allowedGitRemote: remote,
      requestDirectory: requests,
    });
    assert.ok(latest.handler);
    const result = await latest.handler(
      {},
      {
        sessionId: "test",
        toolCallId: "latest-1",
        toolName: latest.name,
        arguments: {},
      },
    );

    assert.deepEqual(result, {
      status: "scheduled",
      commitSha: expectedSha,
      message:
        "Deployment was scheduled. Send the user a concise confirmation now; " +
        "the service will restart after the response is persisted.",
    });
    assert.equal(git(operator, ["rev-parse", "HEAD"]), expectedSha);
    assert.equal(readFileSync(join(requests, "pending"), "utf8"), "latest\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment tools reject mismatched fetch and push remotes", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-deploy-remotes-"));
  const requests = join(root, "requests");
  const approvedRemote = "https://github.com/amunger/agent-outpost.git";

  try {
    const repository = initializeRepository(
      root,
      "https://github.com/attacker/repository.git",
    );
    git(repository, ["remote", "set-url", "--push", "origin", approvedRemote]);
    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    const [exact] = createDeploymentTools({
      workspace: repository,
      allowedGitRemote: approvedRemote,
      requestDirectory: requests,
    });

    assert.ok(exact.handler);
    const result = await exact.handler?.(
      { commitSha },
      {
        sessionId: "test",
        toolCallId: "remote-1",
        toolName: exact.name,
        arguments: { commitSha },
      },
    );
    assert.deepEqual(result, {
      status: "blocked",
      error: "The origin fetch and push URLs must exactly match the registered project remote",
      message:
        "Deployment was not scheduled and no candidate was created. Resolve this error before retrying.",
    });
    assert.equal(existsSync(join(requests, "pending")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment request publication does not replace an existing request", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-deploy-request-"));
  const requests = join(root, "requests");
  const remote = "https://github.com/amunger/agent-outpost.git";

  try {
    const repository = initializeRepository(root, remote);
    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    const [exact] = createDeploymentTools({
      workspace: repository,
      allowedGitRemote: remote,
      requestDirectory: requests,
    });

    assert.ok(exact.handler);
    await exact.handler(
      { commitSha },
      {
        sessionId: "test",
        toolCallId: "request-1",
        toolName: exact.name,
        arguments: { commitSha },
      },
    );
    const result = await exact.handler?.(
      { commitSha },
      {
        sessionId: "test",
        toolCallId: "request-2",
        toolName: exact.name,
        arguments: { commitSha },
      },
    );
    assert.deepEqual(result, {
      status: "blocked",
      error: "A deployment request is already pending",
      message:
        "Deployment was not scheduled and no candidate was created. Resolve this error before retrying.",
    });
    assert.equal(readFileSync(join(requests, "pending"), "utf8"), `${commitSha}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
