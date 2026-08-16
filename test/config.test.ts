import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig applies safe local defaults", () => {
  const config = loadConfig({});

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.equal(config.sessionId, "agent-outpost-main");
  assert.equal(config.allowedTailscaleUser, undefined);
  assert.equal(config.production, false);
  assert.match(config.deploymentRequestDirectory, /data[\\/]deploy-requests$/);
  assert.match(config.artifactDirectory, /data[\\/]artifacts$/);
});

test("loadConfig requires a Tailscale identity in production", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /OUTPOST_ALLOWED_TAILSCALE_USER/);
});

test("loadConfig requires an allowed Git remote in production", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OUTPOST_ALLOWED_TAILSCALE_USER: "owner@example.com",
      }),
    /OUTPOST_ALLOWED_GIT_REMOTE/,
  );
});

test("loadConfig requires a GitHub repository in production", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OUTPOST_ALLOWED_TAILSCALE_USER: "owner@example.com",
        OUTPOST_ALLOWED_GIT_REMOTE: "https://github.com/owner/repository.git",
      }),
    /OUTPOST_GITHUB_REPOSITORY/,
  );
});

test("loadConfig rejects an invalid port", () => {
  assert.throws(() => loadConfig({ OUTPOST_PORT: "70000" }), /OUTPOST_PORT/);
});

test("loadConfig normalizes a Tailscale login", () => {
  const config = loadConfig({ OUTPOST_ALLOWED_TAILSCALE_USER: "Aaron@Example.com " });

  assert.equal(config.allowedTailscaleUser, "aaron@example.com");
});
