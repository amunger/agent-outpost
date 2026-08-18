import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createRepositoryTools } from "../src/repository-tools.js";

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

test("publish tool stages, commits with trailer, and pushes agent/current", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-publish-tool-"));
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");

  try {
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "--initial-branch=agent/current", repository]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["remote", "add", "origin", remote]);
    writeFileSync(join(repository, "README.md"), "initial\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Initial"]);
    git(repository, ["push", "--set-upstream", "origin", "agent/current"]);
    writeFileSync(join(repository, "README.md"), "updated\n");

    const [publish] = createRepositoryTools({
      workspace: repository,
      allowedGitRemote: remote,
      githubRepository: "owner/repository",
    });

    assert.ok(publish.handler);
    const result = await publish.handler({ message: "Update readme" }, {
      sessionId: "test",
      toolCallId: "publish-1",
      toolName: publish.name,
      arguments: { message: "Update readme" },
    });

    test("publish tool uses the registered project's integration branch", async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-outpost-project-publish-"));
      const remote = join(root, "remote.git");
      const repository = join(root, "repository");

      try {
        execFileSync("git", ["init", "--bare", remote]);
        execFileSync("git", ["init", "--initial-branch=recipes/current", repository]);
        git(repository, ["config", "user.name", "Test"]);
        git(repository, ["config", "user.email", "test@example.com"]);
        git(repository, ["remote", "add", "origin", remote]);
        writeFileSync(join(repository, "README.md"), "initial\n");
        git(repository, ["add", "README.md"]);
        git(repository, ["commit", "-m", "Initial"]);
        git(repository, ["push", "--set-upstream", "origin", "recipes/current"]);
        writeFileSync(join(repository, "README.md"), "updated\n");

        const [publish] = createRepositoryTools({
          projectName: "Collected Recipes",
          workspace: repository,
          allowedGitRemote: remote,
          integrationBranch: "recipes/current",
          githubRepository: "owner/collected-recipes",
        });
        const result = await publish.handler?.(
          { message: "Update recipe app" },
          {
            sessionId: "recipes-chat",
            toolCallId: "project-publish",
            toolName: publish.name,
            arguments: { message: "Update recipe app" },
          },
        );

        assert.ok(result && typeof result === "object" && "status" in result && "commitSha" in result);
        assert.equal(result.status, "published");
        assert.equal(typeof result.commitSha, "string");
        assert.equal(
          git(repository, ["rev-parse", "origin/recipes/current"]),
          result.commitSha,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    assert.deepEqual(result, {
      status: "published",
      commitSha,
      message: "Changes were committed and pushed. Use deploy_agent_outpost with commitSha.",
    });
    assert.equal(git(repository, ["rev-parse", "origin/agent/current"]), commitSha);
    assert.match(
      git(repository, ["show", "-s", "--format=%B", "HEAD"]),
      /Co-authored-by: Copilot <223556219\+Copilot@users\.noreply\.github\.com>/,
    );
    assert.equal(readFileSync(join(repository, "README.md"), "utf8"), "updated\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue tool uses the configured repository and returns the issue URL", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const [, createIssue] = createRepositoryTools({
    workspace: process.cwd(),
    allowedGitRemote: "https://github.com/amunger/agent-outpost.git",
    githubRepository: "amunger/agent-outpost",
    commandRunner: (executable, args) => {
      calls.push({ executable, args });
      return "https://github.com/amunger/agent-outpost/issues/123";
    },
  });

  assert.ok(createIssue.handler);

  const result = await createIssue.handler(
    { title: "Capability test", body: "Issue body" },
    {
      sessionId: "test",
      toolCallId: "issue-1",
      toolName: createIssue.name,
      arguments: { title: "Capability test", body: "Issue body" },
    },
  );

  assert.deepEqual(result, {
    status: "created",
    issueUrl: "https://github.com/amunger/agent-outpost/issues/123",
    title: "Capability test",
  });
  assert.deepEqual(calls, [
    {
      executable: "gh",
      args: [
        "issue",
        "create",
        "--repo",
        "amunger/agent-outpost",
        "--title",
        "Capability test",
        "--body",
        "Issue body",
      ],
    },
  ]);
});

test("publish tool rejects a remote that is not explicitly allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-publish-remote-"));
  const repository = join(root, "repository");

  try {
    execFileSync("git", ["init", "--initial-branch=agent/current", repository]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["remote", "add", "origin", "https://github.com/attacker/repository.git"]);
    writeFileSync(join(repository, "README.md"), "initial\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Initial"]);

    const [publish] = createRepositoryTools({
      workspace: repository,
      allowedGitRemote: "https://github.com/amunger/agent-outpost.git",
      githubRepository: "amunger/agent-outpost",
    });

    assert.ok(publish.handler);
    const result = await publish.handler(
      { message: "Publish changes" },
      {
        sessionId: "test",
        toolCallId: "publish-remote",
        toolName: publish.name,
        arguments: { message: "Publish changes" },
      },
    );
    assert.deepEqual(result, {
      status: "blocked",
      error: "The origin push URL does not match the registered project remote",
      message: "Publishing was not attempted or did not complete. Resolve this error before retrying.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publish tool rejects executable local Git configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-publish-config-"));
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");

  try {
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "--initial-branch=agent/current", repository]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "filter.danger.clean", "node -e attack"]);
    git(repository, ["remote", "add", "origin", remote]);
    writeFileSync(join(repository, "README.md"), "initial\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Initial"]);
    git(repository, ["push", "--set-upstream", "origin", "agent/current"]);
    writeFileSync(join(repository, "README.md"), "updated\n");

    const [publish] = createRepositoryTools({
      workspace: repository,
      allowedGitRemote: remote,
      githubRepository: "owner/repository",
    });
    assert.ok(publish.handler);
    const result = await publish.handler(
      { message: "Publish changes" },
      {
        sessionId: "test",
        toolCallId: "publish-config",
        toolName: publish.name,
        arguments: { message: "Publish changes" },
      },
    );
    assert.deepEqual(result, {
      status: "blocked",
      error: "Publishing is blocked by unsafe local Git configuration: filter.danger.clean",
      message: "Publishing was not attempted or did not complete. Resolve this error before retrying.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
