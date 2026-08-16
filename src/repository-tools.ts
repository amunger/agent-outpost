import { execFileSync, spawnSync } from "node:child_process";

import { defineTool, type Tool } from "@github/copilot-sdk";

const coauthorTrailer = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";
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
const dangerousLocalConfig =
  /^(?:alias\.|core\.(?:attributesfile|fsmonitor|hookspath|sshcommand)|credential\.|diff\.external|filter\.|include(?:if)?\.|merge\..*\.driver|url\.)/i;

interface PublishArguments {
  readonly message: string;
}

interface IssueArguments {
  readonly title: string;
  readonly body: string;
}

interface CommandOptions {
  readonly cwd?: string;
  readonly timeout?: number;
}

type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: CommandOptions,
) => string;

export interface RepositoryToolOptions {
  readonly workspace: string;
  readonly allowedGitRemote: string;
  readonly githubRepository: string;
  readonly commandRunner?: CommandRunner;
}

function defaultCommandRunner(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): string {
  return execFileSync(executable, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
  }).trim();
}

function validatePublishArguments(value: unknown): PublishArguments {
  if (
    typeof value !== "object" ||
    value === null ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    throw new Error("message is required");
  }
  const message = value.message.trim();
  if (
    message.length < 1 ||
    message.length > 72 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._():/-]*$/.test(message)
  ) {
    throw new Error(
      "message must be a single safe commit subject from 1 through 72 characters",
    );
  }
  return { message };
}

function validateIssueArguments(value: unknown): IssueArguments {
  if (
    typeof value !== "object" ||
    value === null ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("body" in value) ||
    typeof value.body !== "string"
  ) {
    throw new Error("title and body are required");
  }
  const title = value.title.trim();
  const body = value.body.trim();
  if (title.length < 1 || title.length > 120 || /[\r\n]/.test(title)) {
    throw new Error("title must be one line from 1 through 120 characters");
  }
  if (body.length < 1 || body.length > 10_000) {
    throw new Error("body must contain from 1 through 10,000 characters");
  }
  return { title, body };
}

function publishTool(options: RepositoryToolOptions, run: CommandRunner): Tool<PublishArguments> {
  return defineTool<PublishArguments>("publish_agent_outpost_changes", {
    description:
      "Stage all Agent Outpost workspace changes, create a commit with the required " +
      "Copilot coauthor trailer, and push agent/current. Returns the exact commit SHA to deploy.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: {
          type: "string",
          minLength: 1,
          maxLength: 72,
          description: "A concise one-line commit subject without shell syntax.",
        },
      },
    },
    defer: "never",
    skipPermission: true,
    handler: (value: PublishArguments) => {
      const { message } = validatePublishArguments(value);
      const git = (args: readonly string[]): string =>
        run("git", [...safeGitConfiguration, ...args], {
          cwd: options.workspace,
          timeout: 30_000,
        });
      const gitExitCode = (args: readonly string[]): number | null =>
        spawnSync("git", [...safeGitConfiguration, ...args], {
          cwd: options.workspace,
          env: {
            ...process.env,
            GIT_EDITOR: "true",
            GIT_SEQUENCE_EDITOR: "true",
            GIT_TERMINAL_PROMPT: "0",
          },
          windowsHide: true,
        }).status;
      const isAncestor = (ancestor: string, descendant: string): boolean =>
        gitExitCode(["merge-base", "--is-ancestor", ancestor, descendant]) === 0;
      const rebaseOntoRemote = (): void => {
        try {
          git(["rebase", "origin/agent/current"]);
        } catch (error) {
          git(["rebase", "--abort"]);
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Could not reconcile with origin/agent/current: ${message}`);
        }
      };

      if (git(["branch", "--show-current"]) !== "agent/current") {
        throw new Error("Publishing is allowed only from agent/current");
      }
      if (git(["remote", "get-url", "--push", "origin"]) !== options.allowedGitRemote) {
        throw new Error("The origin push URL does not match OUTPOST_ALLOWED_GIT_REMOTE");
      }
      const localConfigKeys = git(["config", "--local", "--includes", "--name-only", "--list"])
        .split(/\r?\n/)
        .filter(Boolean);
      const unsafeKey = localConfigKeys.find((key) => dangerousLocalConfig.test(key));
      if (unsafeKey) {
        throw new Error(`Publishing is blocked by unsafe local Git configuration: ${unsafeKey}`);
      }

      git(["fetch", "--prune", "origin", "agent/current"]);
      const initialStatus = git(["status", "--porcelain=v1"]);
      if (!isAncestor("origin/agent/current", "HEAD")) {
        if (initialStatus !== "") {
          throw new Error(
            "Local agent/current diverged from origin while the workspace has uncommitted changes",
          );
        }
        if (isAncestor("HEAD", "origin/agent/current")) {
          git(["merge", "--ff-only", "origin/agent/current"]);
        } else {
          rebaseOntoRemote();
        }
      }

      if (git(["status", "--porcelain=v1"]) !== "") {
        git(["add", "--all"]);
        git(["diff", "--cached", "--check"]);
        const stagedFiles = git(["diff", "--cached", "--name-only"]);
        if (!stagedFiles) {
          throw new Error("No staged changes are available to publish");
        }
        git(["commit", "-m", message, "-m", coauthorTrailer]);
      }

      let commitSha = git(["rev-parse", "HEAD"]);
      const remoteSha = git(["rev-parse", "origin/agent/current"]);
      if (commitSha === remoteSha) {
        throw new Error("There are no unpublished changes on agent/current");
      }
      try {
        git(["push", "origin", "agent/current"]);
      } catch {
        git(["fetch", "--prune", "origin", "agent/current"]);
        if (!isAncestor("origin/agent/current", "HEAD")) {
          rebaseOntoRemote();
        }
        git(["push", "origin", "agent/current"]);
        commitSha = git(["rev-parse", "HEAD"]);
      }

      return {
        status: "published",
        commitSha,
        message: "Changes were committed and pushed. Use deploy_agent_outpost with commitSha.",
      };
    },
  });
}

function issueTool(options: RepositoryToolOptions, run: CommandRunner): Tool<IssueArguments> {
  return defineTool<IssueArguments>("create_agent_outpost_issue", {
    description:
      "Create an issue in the configured Agent Outpost GitHub repository. " +
      "Use this instead of running gh from the shell.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        body: { type: "string", minLength: 1, maxLength: 10_000 },
      },
    },
    defer: "never",
    skipPermission: true,
    handler: (value: IssueArguments) => {
      const { title, body } = validateIssueArguments(value);
      const output = run(
        "gh",
        ["issue", "create", "--repo", options.githubRepository, "--title", title, "--body", body],
        { cwd: options.workspace, timeout: 30_000 },
      );
      const expectedPrefix = `https://github.com/${options.githubRepository}/issues/`;
      const issueUrl = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith(expectedPrefix));
      if (!issueUrl) {
        throw new Error("GitHub CLI did not return the created issue URL");
      }
      return { status: "created", issueUrl, title };
    },
  });
}

export function createRepositoryTools(
  options: RepositoryToolOptions,
): [Tool<PublishArguments>, Tool<IssueArguments>] {
  const run = options.commandRunner ?? defaultCommandRunner;
  return [publishTool(options, run), issueTool(options, run)];
}
