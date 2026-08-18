import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadProjectRegistry,
  type ProjectDefinition,
} from "../src/project-registry.js";

function legacyProject(root: string): ProjectDefinition {
  return {
    id: "agent-outpost",
    name: "Agent Outpost",
    repository: "amunger/agent-outpost",
    workspace: join(root, "agent-outpost"),
    allowedGitRemote: "https://github.com/amunger/agent-outpost.git",
    integrationBranch: "agent/current",
    githubRepository: "amunger/agent-outpost",
    deploymentTargetId: "agent-outpost",
    deploymentRequestDirectory: join(root, "agent-outpost-requests"),
    validationProfile: "agent-outpost",
    workspacePreview: "static-public",
  };
}

test("loadProjectRegistry loads only explicitly registered projects", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-projects-"));
  const registryPath = join(root, "projects.json");
  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        defaultProjectId: "agent-outpost",
        projects: [
          legacyProject(root),
          {
            id: "collected-recipes",
            name: "Collected Recipes",
            repository: "amunger/collected-recipes",
            workspace: join(root, "collected-recipes"),
            allowedGitRemote: "https://github.com/amunger/collected-recipes.git",
            integrationBranch: "agent/current",
            githubRepository: "amunger/collected-recipes",
            deploymentTargetId: "collected-recipes",
            deploymentRequestDirectory: join(root, "collected-recipes-requests"),
            validationProfile: "node-nextjs",
            workspacePreview: "none",
          },
        ],
      }),
    );

    const registry = loadProjectRegistry({
      registryPath,
      legacyProject: legacyProject(root),
    });

    assert.equal(registry.defaultProject.id, "agent-outpost");
    assert.deepEqual(
      registry.list().map(({ id }) => id),
      ["agent-outpost", "collected-recipes"],
    );
    assert.equal(
      registry.require("collected-recipes").workspace,
      join(root, "collected-recipes"),
    );
    assert.throws(() => registry.require("unregistered"), /not registered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadProjectRegistry rejects duplicate workspace and request boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-project-duplicate-"));
  const registryPath = join(root, "projects.json");
  try {
    const first = legacyProject(root);
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        defaultProjectId: first.id,
        projects: [
          first,
          {
            ...first,
            id: "second",
            repository: "amunger/second",
            githubRepository: "amunger/second",
            allowedGitRemote: "https://github.com/amunger/second.git",
            deploymentTargetId: "second",
          },
        ],
      }),
    );

    assert.throws(
      () => loadProjectRegistry({ registryPath, legacyProject: first }),
      /Duplicate project workspace/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadProjectRegistry rejects arbitrary validation profiles and commands", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-outpost-project-profile-"));
  const registryPath = join(root, "projects.json");
  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        defaultProjectId: "agent-outpost",
        projects: [
          {
            ...legacyProject(root),
            validationProfile: "npm run whatever",
          },
        ],
      }),
    );

    assert.throws(
      () =>
        loadProjectRegistry({
          registryPath,
          legacyProject: legacyProject(root),
        }),
      /validationProfile is not allowlisted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
