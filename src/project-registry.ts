import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

export type ProjectValidationProfile = "agent-outpost" | "node-nextjs";
export type ProjectWorkspacePreview = "none" | "static-public";

export interface ProjectDefinition {
  readonly id: string;
  readonly name: string;
  readonly repository: string;
  readonly workspace: string;
  readonly allowedGitRemote?: string;
  readonly integrationBranch: string;
  readonly githubRepository?: string;
  readonly deploymentTargetId: string;
  readonly deploymentRequestDirectory: string;
  readonly validationProfile: ProjectValidationProfile;
  readonly workspacePreview: ProjectWorkspacePreview;
}

interface ProjectRegistryDocument {
  readonly version: 1;
  readonly defaultProjectId: string;
  readonly projects: readonly ProjectDefinition[];
}

export interface ProjectRegistryOptions {
  readonly registryPath?: string;
  readonly requireRootOwned?: boolean;
  readonly legacyProject: ProjectDefinition;
}

const projectIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const targetIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const validationProfiles = new Set<ProjectValidationProfile>(["agent-outpost", "node-nextjs"]);
const workspacePreviews = new Set<ProjectWorkspacePreview>(["none", "static-public"]);

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function safeBranch(value: string, context: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".")
  ) {
    throw new Error(`${context}.integrationBranch is not a safe branch name`);
  }
  return value;
}

function absolutePath(value: string, context: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${context} must be an absolute path`);
  }
  return normalize(value);
}

function parseProject(value: unknown, index: number): ProjectDefinition {
  const context = `projects[${index}]`;
  const record = objectValue(value, context);
  const id = stringValue(record, "id", context);
  const name = stringValue(record, "name", context);
  const repository = stringValue(record, "repository", context);
  const allowedGitRemote = stringValue(record, "allowedGitRemote", context);
  const integrationBranch = safeBranch(
    stringValue(record, "integrationBranch", context),
    context,
  );
  const githubRepository = stringValue(record, "githubRepository", context);
  const deploymentTargetId = stringValue(record, "deploymentTargetId", context);
  const validationProfile = stringValue(record, "validationProfile", context);
  const workspacePreview = stringValue(record, "workspacePreview", context);

  if (!projectIdPattern.test(id)) {
    throw new Error(`${context}.id must be a lowercase slug`);
  }
  if (name.length > 100) {
    throw new Error(`${context}.name must not exceed 100 characters`);
  }
  if (!repositoryPattern.test(repository) || githubRepository !== repository) {
    throw new Error(
      `${context}.repository and githubRepository must contain the same owner/name value`,
    );
  }
  if (!targetIdPattern.test(deploymentTargetId)) {
    throw new Error(`${context}.deploymentTargetId must be a lowercase slug`);
  }
  if (!validationProfiles.has(validationProfile as ProjectValidationProfile)) {
    throw new Error(`${context}.validationProfile is not allowlisted`);
  }
  if (!workspacePreviews.has(workspacePreview as ProjectWorkspacePreview)) {
    throw new Error(`${context}.workspacePreview is not allowlisted`);
  }

  return {
    id,
    name,
    repository,
    workspace: absolutePath(stringValue(record, "workspace", context), `${context}.workspace`),
    allowedGitRemote,
    integrationBranch,
    githubRepository,
    deploymentTargetId,
    deploymentRequestDirectory: absolutePath(
      stringValue(record, "deploymentRequestDirectory", context),
      `${context}.deploymentRequestDirectory`,
    ),
    validationProfile: validationProfile as ProjectValidationProfile,
    workspacePreview: workspacePreview as ProjectWorkspacePreview,
  };
}

function parseRegistryDocument(value: unknown): ProjectRegistryDocument {
  const record = objectValue(value, "project registry");
  if (record.version !== 1) {
    throw new Error("project registry.version must equal 1");
  }
  const defaultProjectId = stringValue(record, "defaultProjectId", "project registry");
  if (!Array.isArray(record.projects) || record.projects.length === 0) {
    throw new Error("project registry.projects must be a non-empty array");
  }
  return {
    version: 1,
    defaultProjectId,
    projects: record.projects.map(parseProject),
  };
}

function validateUniqueProjects(projects: readonly ProjectDefinition[]): void {
  const seenIds = new Set<string>();
  const seenRepositories = new Set<string>();
  const seenWorkspaces = new Set<string>();
  const seenRequestDirectories = new Set<string>();

  for (const project of projects) {
    const repository = project.repository.toLowerCase();
    const workspace = project.workspace.toLowerCase();
    const requestDirectory = project.deploymentRequestDirectory.toLowerCase();
    if (seenIds.has(project.id)) {
      throw new Error(`Duplicate project id: ${project.id}`);
    }
    if (seenRepositories.has(repository)) {
      throw new Error(`Duplicate project repository: ${project.repository}`);
    }
    if (seenWorkspaces.has(workspace)) {
      throw new Error(`Duplicate project workspace: ${project.workspace}`);
    }
    if (seenRequestDirectories.has(requestDirectory)) {
      throw new Error(
        `Duplicate project deployment request directory: ${project.deploymentRequestDirectory}`,
      );
    }
    seenIds.add(project.id);
    seenRepositories.add(repository);
    seenWorkspaces.add(workspace);
    seenRequestDirectories.add(requestDirectory);
  }
}

export class ProjectRegistry {
  readonly #projects: ReadonlyMap<string, ProjectDefinition>;

  public readonly defaultProjectId: string;

  public constructor(defaultProjectId: string, projects: readonly ProjectDefinition[]) {
    validateUniqueProjects(projects);
    this.#projects = new Map(projects.map((project) => [project.id, project]));
    if (!this.#projects.has(defaultProjectId)) {
      throw new Error(`Default project is not registered: ${defaultProjectId}`);
    }
    this.defaultProjectId = defaultProjectId;
  }

  public get defaultProject(): ProjectDefinition {
    return this.require(this.defaultProjectId);
  }

  public list(): readonly ProjectDefinition[] {
    return [...this.#projects.values()];
  }

  public get(id: string): ProjectDefinition | undefined {
    return this.#projects.get(id);
  }

  public require(id: string): ProjectDefinition {
    const project = this.get(id);
    if (!project) {
      throw new Error(`Project is not registered: ${id}`);
    }
    return project;
  }
}

export function loadProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  if (!options.registryPath) {
    return new ProjectRegistry(options.legacyProject.id, [options.legacyProject]);
  }

  const metadata = lstatSync(options.registryPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Project registry must be a regular, non-symlink file");
  }
  if (
    options.requireRootOwned === true &&
    process.platform !== "win32" &&
    (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
  ) {
    throw new Error("Production project registry must be root-owned and not group/other writable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(options.registryPath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load project registry ${options.registryPath}: ${message}`);
  }
  const document = parseRegistryDocument(parsed);
  return new ProjectRegistry(document.defaultProjectId, document.projects);
}
