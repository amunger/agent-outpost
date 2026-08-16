import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createWorkspaceTools } from "../src/workspace-tools.js";

test("workspace tools replace exact text and create a new file", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-outpost-workspace-tools-"));
  writeFileSync(join(workspace, "existing.txt"), "before\n");
  const [replace, create] = createWorkspaceTools(workspace);

  try {
    assert.ok(replace.handler);
    assert.deepEqual(
      await replace.handler(
        { path: "existing.txt", oldText: "before", newText: "after" },
        {
          sessionId: "test",
          toolCallId: "replace-1",
          toolName: replace.name,
          arguments: {},
        },
      ),
      { status: "updated", path: "existing.txt" },
    );
    assert.equal(readFileSync(join(workspace, "existing.txt"), "utf8"), "after\n");

    assert.ok(create.handler);
    assert.deepEqual(
      await create.handler(
        { path: join(workspace, "created.txt"), content: "created\n" },
        {
          sessionId: "test",
          toolCallId: "create-1",
          toolName: create.name,
          arguments: {},
        },
      ),
      { status: "created", path: join(workspace, "created.txt") },
    );
    assert.equal(readFileSync(join(workspace, "created.txt"), "utf8"), "created\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspace tools reject ambiguous replacements and Git paths", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-outpost-workspace-policy-"));
  mkdirSync(join(workspace, ".git"));
  writeFileSync(join(workspace, "repeated.txt"), "same same");
  const [replace, create] = createWorkspaceTools(workspace);

  try {
    assert.ok(replace.handler);
    await assert.rejects(
      async () =>
        replace.handler?.(
          { path: "repeated.txt", oldText: "same", newText: "different" },
          {
            sessionId: "test",
            toolCallId: "replace-ambiguous",
            toolName: replace.name,
            arguments: {},
          },
        ),
      /exactly once/,
    );

    assert.ok(create.handler);
    await assert.rejects(
      async () =>
        create.handler?.(
          { path: "nested/.GIT/config", content: "unsafe" },
          {
            sessionId: "test",
            toolCallId: "create-git",
            toolName: create.name,
            arguments: {},
          },
        ),
      /non-Git file/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("replace tool rejects invalid UTF-8 without changing the file", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-outpost-workspace-encoding-"));
  const path = join(workspace, "binary.txt");
  const original = Buffer.from([0x62, 0x65, 0x66, 0x6f, 0x72, 0x65, 0xff]);
  writeFileSync(path, original);
  const [replace] = createWorkspaceTools(workspace);

  try {
    assert.ok(replace.handler);
    await assert.rejects(
      async () =>
        replace.handler?.(
          { path: "binary.txt", oldText: "before", newText: "after" },
          {
            sessionId: "test",
            toolCallId: "replace-binary",
            toolName: replace.name,
            arguments: {},
          },
        ),
      /valid UTF-8/,
    );
    assert.deepEqual(readFileSync(path), original);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspace tools reject symlink paths", async (context) => {
  if (process.platform === "win32") {
    context.skip("File symlink creation requires Windows developer mode");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-workspace-symlink-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, "target.txt"), "outside");
  symlinkSync(join(outside, "target.txt"), join(workspace, "linked.txt"), "file");
  const [replace] = createWorkspaceTools(workspace);

  try {
    assert.ok(replace.handler);
    await assert.rejects(
      async () =>
        replace.handler?.(
          { path: "linked.txt", oldText: "outside", newText: "changed" },
          {
            sessionId: "test",
            toolCallId: "replace-link",
            toolName: replace.name,
            arguments: {},
          },
        ),
      /symbolic links/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
