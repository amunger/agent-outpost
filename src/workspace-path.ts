import { closeSync, constants, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface WorkspacePathOptions {
  readonly requireExistingFile: boolean;
}

export function resolveWorkspaceFile(
  workspace: string,
  requestedPath: string,
  options: WorkspacePathOptions,
): string {
  if (
    !requestedPath ||
    requestedPath.includes("\0") ||
    isAbsolute(requestedPath) ||
    requestedPath.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new Error("path must be a relative workspace path without parent traversal");
  }

  const canonicalWorkspace = realpathSync(workspace);
  const candidate = resolve(canonicalWorkspace, requestedPath);
  const relativePath = relative(canonicalWorkspace, candidate);
  const normalizedComponents = relativePath
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/");
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    normalizedComponents.includes(".git")
  ) {
    throw new Error("path must identify a non-Git file inside the workspace");
  }

  let current = canonicalWorkspace;
  const components = relativePath.split(sep);
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (metadata?.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in workspace edit paths: ${requestedPath}`);
    }
    const finalComponent = index === components.length - 1;
    if (!metadata) {
      if (options.requireExistingFile || !finalComponent) {
        throw new Error(`workspace path does not exist: ${requestedPath}`);
      }
      break;
    }
    if (finalComponent && options.requireExistingFile && !metadata.isFile()) {
      throw new Error(`workspace path is not a regular file: ${requestedPath}`);
    }
    if (!finalComponent && !metadata.isDirectory()) {
      throw new Error(`workspace path parent is not a directory: ${requestedPath}`);
    }
  }

  return candidate;
}

export function withAnchoredWorkspaceParent<T>(
  workspace: string,
  candidate: string,
  operation: (anchoredPath: string) => T,
): T {
  const canonicalWorkspace = realpathSync(workspace);
  const parent = dirname(candidate);

  if (process.platform !== "linux") {
    const canonicalParent = realpathSync(parent);
    const relativeParent = relative(canonicalWorkspace, canonicalParent);
    if (relativeParent.startsWith("..") || isAbsolute(relativeParent)) {
      throw new Error("workspace file parent escaped the workspace");
    }
    return operation(candidate);
  }

  const parentDescriptor = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const descriptorPath = `/proc/self/fd/${parentDescriptor}`;
    const openedParent = realpathSync(descriptorPath);
    const relativeParent = relative(canonicalWorkspace, openedParent);
    if (relativeParent.startsWith("..") || isAbsolute(relativeParent)) {
      throw new Error("workspace file parent escaped the workspace");
    }
    return operation(`${descriptorPath}/${basename(candidate)}`);
  } finally {
    closeSync(parentDescriptor);
  }
}
