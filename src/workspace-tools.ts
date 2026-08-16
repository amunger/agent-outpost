import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { defineTool, type Tool } from "@github/copilot-sdk";

import { resolveWorkspaceFile, withAnchoredWorkspaceParent } from "./workspace-path.js";

const maximumFileBytes = 1024 * 1024;
const maximumEditTextLength = 200_000;

interface ReplaceArguments {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

interface CreateArguments {
  readonly path: string;
  readonly content: string;
}

function atomicWrite(anchoredPath: string, content: string, mode: number): void {
  const temporaryPath = join(
    dirname(anchoredPath),
    `.${basename(anchoredPath)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
    renameSync(temporaryPath, anchoredPath);
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
}

function validateRequestedPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) {
    throw new Error("path must contain from 1 through 500 characters");
  }
  return value;
}

function replaceTool(workspace: string): Tool<ReplaceArguments> {
  return defineTool<ReplaceArguments>("replace_workspace_text", {
    description:
      "Replace one exact text occurrence in an existing UTF-8 workspace file. " +
      "Use when apply_patch is unavailable. Symbolic links and .git paths are rejected.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "oldText", "newText"],
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "A relative path or absolute path inside the configured workspace.",
        },
        oldText: { type: "string", minLength: 1, maxLength: maximumEditTextLength },
        newText: { type: "string", maxLength: maximumEditTextLength },
      },
    },
    defer: "never",
    skipPermission: true,
    handler: (value: ReplaceArguments) => {
      const path = resolveWorkspaceFile(workspace, validateRequestedPath(value.path), {
        requireExistingFile: true,
      });
      if (
        typeof value.oldText !== "string" ||
        !value.oldText ||
        value.oldText.length > maximumEditTextLength ||
        typeof value.newText !== "string" ||
        value.newText.length > maximumEditTextLength
      ) {
        throw new Error("oldText and newText exceed the supported edit limits");
      }
      withAnchoredWorkspaceParent(workspace, path, (anchoredPath) => {
        const descriptor = openSync(anchoredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        let mode: number;
        try {
          const metadata = fstatSync(descriptor);
          if (!metadata.isFile() || metadata.size > maximumFileBytes) {
            throw new Error("workspace file is not a regular text file under 1 MiB");
          }
          bytes = readFileSync(descriptor);
          mode = metadata.mode & 0o777;
        } finally {
          closeSync(descriptor);
        }
        const content = bytes.toString("utf8");
        if (!Buffer.from(content, "utf8").equals(bytes) || content.includes("\0")) {
          throw new Error("workspace file is not valid UTF-8 text");
        }
        const firstIndex = content.indexOf(value.oldText);
        if (
          firstIndex < 0 ||
          content.indexOf(value.oldText, firstIndex + value.oldText.length) >= 0
        ) {
          throw new Error("oldText must occur exactly once in the workspace file");
        }
        const updated =
          content.slice(0, firstIndex) +
          value.newText +
          content.slice(firstIndex + value.oldText.length);
        atomicWrite(anchoredPath, updated, mode);
      });
      return { status: "updated", path: value.path };
    },
  });
}

function createTool(workspace: string): Tool<CreateArguments> {
  return defineTool<CreateArguments>("create_workspace_file", {
    description:
      "Create a new UTF-8 file under an existing workspace directory. " +
      "Use when apply_patch is unavailable. Existing files, symbolic links, and .git paths are rejected.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "A relative path or absolute path inside the configured workspace.",
        },
        content: { type: "string", maxLength: maximumFileBytes },
      },
    },
    defer: "never",
    skipPermission: true,
    handler: (value: CreateArguments) => {
      const path = resolveWorkspaceFile(workspace, validateRequestedPath(value.path), {
        requireExistingFile: false,
      });
      if (typeof value.content !== "string" || Buffer.byteLength(value.content) > maximumFileBytes) {
        throw new Error("content exceeds the 1 MiB file limit");
      }
      withAnchoredWorkspaceParent(workspace, path, (anchoredPath) => {
        const descriptor = openSync(
          anchoredPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o644,
        );
        try {
          writeFileSync(descriptor, value.content, { encoding: "utf8" });
        } finally {
          closeSync(descriptor);
        }
      });
      return { status: "created", path: value.path };
    },
  });
}

export function createWorkspaceTools(workspace: string): [Tool<ReplaceArguments>, Tool<CreateArguments>] {
  return [replaceTool(workspace), createTool(workspace)];
}
