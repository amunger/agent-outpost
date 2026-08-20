import { lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
} from "@github/copilot-sdk";
import type { ProjectValidationProfile } from "./project-registry.js";

const allowedUrlHosts = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
]);
const forbiddenCommandPatterns = [
  /\bgit\s+clean\b/i,
  /\bgit\s+config\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+(?:adduser|login|logout|token)\b/i,
  /[;&|`><]/,
  /\$\(/,
];
const allowedGitSegments = [
  /^git(?:\s+--no-pager)?\s+status(?:\s+--short)?$/i,
  /^git(?:\s+--no-pager)?\s+(?:diff|log|show|branch|rev-parse)(?:\s+[-\w./:^=]+)*$/i,
];
const safeNpmInstallOptions = "(?:\\s+--(?:no-audit|no-fund))*";
const allowedNpmSegments: Readonly<Record<ProjectValidationProfile, RegExp>> = {
  "agent-outpost": new RegExp(
    `^npm\\s+(?:(?:ci|install)${safeNpmInstallOptions}|test|run\\s+(?:build|test|typecheck))$`,
    "i",
  ),
  "node-nextjs": new RegExp(
    `^npm\\s+(?:(?:ci|install)${safeNpmInstallOptions}|test|run\\s+(?:build|lint|test))$`,
    "i",
  ),
};

function reject(feedback: string): PermissionRequestResult {
  return { kind: "reject", feedback };
}

function isWithinWorkspace(workspace: string, candidate: string): boolean {
  const absoluteCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(workspace, candidate);
  const pathFromWorkspace = relative(workspace, absoluteCandidate);
  if (
    pathFromWorkspace !== "" &&
    (pathFromWorkspace.startsWith("..") || isAbsolute(pathFromWorkspace))
  ) {
    return false;
  }

  let current = workspace;
  for (const component of pathFromWorkspace.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (metadata?.isSymbolicLink()) {
      return false;
    }
    if (!metadata) {
      break;
    }
  }
  return true;
}

function isAllowedUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && allowedUrlHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function configuredPushRemote(workspace: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "--push", "origin"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    }).trim();
  } catch (error) {
    if (error instanceof Error) {
      return undefined;
    }
    throw error;
  }
}

function approvePathRequest(
  workspace: string,
  request: Extract<PermissionRequest, { kind: "read" | "write" }>,
): PermissionRequestResult {
  const candidate = request.kind === "read" ? request.path : request.fileName;
  const pathFromWorkspace = relative(workspace, resolve(workspace, candidate)).replaceAll("\\", "/");
  if (
    request.kind === "write" &&
    (pathFromWorkspace === ".git/config" || pathFromWorkspace.startsWith(".git/hooks/"))
  ) {
    return reject("Changing Git remotes or hooks is not allowed");
  }
  return isWithinWorkspace(workspace, candidate)
    ? { kind: "approve-once" }
    : reject(`Access outside the configured workspace is not allowed: ${candidate}`);
}

function approveShellRequest(
  workspace: string,
  allowedGitRemote: string | undefined,
  validationProfile: ProjectValidationProfile,
  request: Extract<PermissionRequest, { kind: "shell" }>,
): PermissionRequestResult {
  if (forbiddenCommandPatterns.some((pattern) => pattern.test(request.fullCommandText))) {
    return reject("The command matches a destructive or credential-related deny rule");
  }
  if (request.hasWriteFileRedirection) {
    return reject("Shell output redirection is not allowed");
  }
  const segments = request.commandSegments?.map((segment) => segment.fullCommandText) ?? [
    // The runtime normally supplies parsed segments. Refuse auto-approval when it cannot.
  ];
  if (
    segments.length === 0 ||
    !segments.every(
      (segment) =>
        allowedGitSegments.some((pattern) => pattern.test(segment)) ||
        allowedNpmSegments[validationProfile].test(segment),
    )
  ) {
    return reject("Only constrained Git and npm validation commands are allowlisted");
  }
  if (!request.possiblePaths.every((candidate) => isWithinWorkspace(workspace, candidate))) {
    return reject("The command may access a path outside the configured workspace");
  }
  if (!request.possibleUrls.every((candidate) => isAllowedUrl(candidate.url))) {
    return reject("The command may access a network destination that is not allowlisted");
  }
  if (request.fullCommandText.toLowerCase() === "git push origin agent/current") {
    if (!allowedGitRemote) {
      return reject("Automatic push requires OUTPOST_ALLOWED_GIT_REMOTE");
    }
    const configuredRemote = configuredPushRemote(workspace);
    if (configuredRemote !== allowedGitRemote) {
      return reject("The origin push URL does not match OUTPOST_ALLOWED_GIT_REMOTE");
    }
  }
  return { kind: "approve-once" };
}

function approveUrlRequest(
  request: Extract<PermissionRequest, { kind: "url" }>,
): PermissionRequestResult {
  return isAllowedUrl(request.url)
    ? { kind: "approve-once" }
    : reject("The requested network destination is not allowlisted");
}

export function createPermissionHandler(
  workspace: string,
  allowedGitRemote?: string,
  validationProfile: ProjectValidationProfile = "agent-outpost",
): PermissionHandler {
  const canonicalWorkspace = realpathSync(workspace);

  return (request) => {
    if (request.managedApprovalRequired) {
      return reject("Organization policy requires an explicit approval not yet supported by this MVP");
    }
    if ("requestSandboxBypass" in request && request.requestSandboxBypass === true) {
      return reject("Sandbox bypass is not allowed");
    }

    switch (request.kind) {
      case "read":
      case "write":
        return approvePathRequest(canonicalWorkspace, request);
      case "shell":
        return approveShellRequest(
          canonicalWorkspace,
          allowedGitRemote,
          validationProfile,
          request,
        );
      case "url":
        return approveUrlRequest(request);
      default:
        return reject(`Permission kind ${request.kind} is not supported by this MVP`);
    }
  };
}
