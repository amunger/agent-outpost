import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import type { PermissionRequest } from "@github/copilot-sdk";

import { createPermissionHandler } from "../src/permission-policy.js";

const workspace = resolve(".");
const handler = createPermissionHandler(workspace);
const invocation = { sessionId: "test" };

test("permission policy allows workspace writes", async () => {
  const request = {
    kind: "write",
    fileName: resolve(workspace, "src/index.ts"),
    intention: "Update source",
    diff: "",
    canOfferSessionApproval: false,
  } satisfies PermissionRequest;

  assert.deepEqual(await handler(request, invocation), { kind: "approved" });
});

test("permission policy rejects writes outside the workspace", async () => {
  const request = {
    kind: "write",
    fileName: resolve(workspace, "..", "secret.txt"),
    intention: "Read secret",
    diff: "",
    canOfferSessionApproval: false,
  } satisfies PermissionRequest;

  assert.equal((await handler(request, invocation)).kind, "reject");
});

test("permission policy allows ordinary git pushes but rejects force pushes", async () => {
  const repository = mkdtempSync(join(tmpdir(), "agent-outpost-git-policy-"));
  const allowedRemote = "https://github.com/amunger/agent-outpost.git";
  execFileSync("git", ["init"], { cwd: repository });
  execFileSync("git", ["remote", "add", "origin", allowedRemote], { cwd: repository });
  const gitHandler = createPermissionHandler(repository, allowedRemote);
  const shellRequest = (fullCommandText: string): PermissionRequest => ({
    kind: "shell",
    fullCommandText,
    intention: "Push validated changes",
    commands: [{ identifier: "git", readOnly: false }],
    commandSegments: [{ identifier: "git", fullCommandText }],
    possiblePaths: [repository],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: false,
  });

  try {
    assert.equal(
      (await gitHandler(shellRequest("git push origin agent/current"), invocation)).kind,
      "approved",
    );
    assert.equal(
      (
        await gitHandler(
          shellRequest("git push --force-with-lease origin agent/current"),
          invocation,
        )
      ).kind,
      "reject",
    );
    assert.equal(
      (await gitHandler(shellRequest("git push origin +HEAD:main"), invocation)).kind,
      "reject",
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("permission policy rejects a push after origin is repointed", async () => {
  const repository = mkdtempSync(join(tmpdir(), "agent-outpost-remote-policy-"));
  const allowedRemote = "https://github.com/amunger/agent-outpost.git";
  execFileSync("git", ["init"], { cwd: repository });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/attacker/repository.git"], {
    cwd: repository,
  });
  const gitHandler = createPermissionHandler(repository, allowedRemote);
  const request = {
    kind: "shell",
    fullCommandText: "git push origin agent/current",
    intention: "Push changes",
    commands: [{ identifier: "git", readOnly: false }],
    commandSegments: [{ identifier: "git", fullCommandText: "git push origin agent/current" }],
    possiblePaths: [repository],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: false,
  } satisfies PermissionRequest;

  try {
    assert.equal((await gitHandler(request, invocation)).kind, "reject");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("permission policy rejects interpreters and shell redirection", async () => {
  const request = (fullCommandText: string, identifier: string): PermissionRequest => ({
    kind: "shell",
    fullCommandText,
    intention: "Run arbitrary code",
    commands: [{ identifier, readOnly: false }],
    commandSegments: [{ identifier, fullCommandText }],
    possiblePaths: [workspace],
    possibleUrls: [],
    hasWriteFileRedirection: fullCommandText.includes(">"),
    canOfferSessionApproval: false,
  });

  assert.equal((await handler(request("node -e \"console.log(process.env)\"", "node"), invocation)).kind, "reject");
  assert.equal((await handler(request("npm test > output.txt", "npm"), invocation)).kind, "reject");
  assert.equal((await handler(request("git status ; node -e attack", "git"), invocation)).kind, "reject");
});

test("permission policy rejects symlink escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-policy-"));
  const isolatedWorkspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(isolatedWorkspace);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(isolatedWorkspace, "escape"), process.platform === "win32" ? "junction" : "dir");

  try {
    const isolatedHandler = createPermissionHandler(isolatedWorkspace);
    const request = {
      kind: "read",
      path: join(isolatedWorkspace, "escape", "secret.txt"),
      intention: "Read through symlink",
    } satisfies PermissionRequest;

    assert.equal((await isolatedHandler(request, invocation)).kind, "reject");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission policy rejects dangling symlinks for writes", async (context) => {
  if (process.platform === "win32") {
    context.skip("File symlink creation requires Windows developer mode");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-dangling-policy-"));
  const isolatedWorkspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(isolatedWorkspace);
  mkdirSync(outside);
  symlinkSync(join(outside, "created.txt"), join(isolatedWorkspace, "link.txt"), "file");

  try {
    const isolatedHandler = createPermissionHandler(isolatedWorkspace);
    const request = {
      kind: "write",
      fileName: join(isolatedWorkspace, "link.txt"),
      intention: "Write through dangling symlink",
      diff: "",
      canOfferSessionApproval: false,
    } satisfies PermissionRequest;

    assert.equal((await isolatedHandler(request, invocation)).kind, "reject");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission policy rejects managed approvals and sandbox bypass", async () => {
  const request = {
    kind: "read",
    path: workspace,
    intention: "Read workspace",
    managedApprovalRequired: true,
  } satisfies PermissionRequest;

  assert.equal((await handler(request, invocation)).kind, "reject");
});
