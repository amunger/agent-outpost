import assert from "node:assert/strict";
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

  assert.deepEqual(await handler(request, invocation), { kind: "approve-once" });
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

test("permission policy rejects raw git pushes in favor of the typed publish tool", async () => {
  const shellRequest = (fullCommandText: string): PermissionRequest => ({
    kind: "shell",
    fullCommandText,
    intention: "Push validated changes",
    commands: [{ identifier: "git", readOnly: false }],
    commandSegments: [{ identifier: "git", fullCommandText }],
    possiblePaths: [workspace],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: false,
  });

  assert.equal(
    (await handler(shellRequest("git push origin agent/current"), invocation)).kind,
    "reject",
  );
  assert.equal(
    (await handler(shellRequest("git push --force-with-lease origin agent/current"), invocation))
      .kind,
    "reject",
  );
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

  test("permission policy applies the registered validation profile", async () => {
    const request = {
      kind: "shell",
      fullCommandText: "npm run lint",
      intention: "Lint the registered project",
      commands: [{ identifier: "npm", readOnly: false }],
      commandSegments: [{ identifier: "npm", fullCommandText: "npm run lint" }],
      possiblePaths: [workspace],
      possibleUrls: [],
      hasWriteFileRedirection: false,
      canOfferSessionApproval: false,
    } satisfies PermissionRequest;

    assert.equal((await handler(request, invocation)).kind, "reject");
    const nextHandler = createPermissionHandler(workspace, undefined, "node-nextjs");
    assert.equal((await nextHandler(request, invocation)).kind, "approve-once");
  });

  test("permission policy allows read-only diff validation", async () => {
    const request = {
      kind: "shell",
      fullCommandText: "git diff --check",
      intention: "Validate whitespace",
      commands: [{ identifier: "git diff --check", readOnly: true }],
      commandSegments: [{ identifier: "git diff", fullCommandText: "git diff --check" }],
      possiblePaths: [],
      possibleUrls: [],
      hasWriteFileRedirection: false,
      canOfferSessionApproval: false,
    } satisfies PermissionRequest;

    assert.equal((await handler(request, invocation)).kind, "approve-once");
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
