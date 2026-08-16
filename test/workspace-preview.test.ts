import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chromium } from "playwright";

import { EventStore } from "../src/event-store.js";
import { createWorkspacePreviewServer } from "../src/http-server.js";
import { createScreenshotTool } from "../src/screenshot-tool.js";
import { SseHub } from "../src/sse-hub.js";

test("workspace preview serves local assets with read-only API fixtures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-preview-"));
  const publicDirectory = join(directory, "public");
  mkdirSync(publicDirectory);
  writeFileSync(join(publicDirectory, "index.html"), "<h1>Workspace revision</h1>");
  writeFileSync(join(publicDirectory, "styles.css"), "body { color: blue; }");
  const server = createWorkspacePreviewServer(publicDirectory);

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<h1>Workspace revision</h1>");

    const stylesheet = await fetch(`${baseUrl}/styles.css`);
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers.get("cache-control"), "no-cache");

    const session = await fetch(`${baseUrl}/api/session`);
    const sessionBody = await session.json() as {
      readonly state: string;
      readonly events: readonly unknown[];
    };
    assert.equal(sessionBody.state, "idle");
    assert.equal(sessionBody.events.length, 30);

    const chats = await fetch(`${baseUrl}/api/chats`);
    const chatsBody = await chats.json() as { readonly chats: readonly unknown[] };
    assert.equal(chatsBody.chats.length, 1);

    const resources = await fetch(`${baseUrl}/api/status/resources`);
    assert.deepEqual(await resources.json(), {
      cpu: { usagePercent: 0 },
      memory: { usagePercent: 0 },
      disk: { usagePercent: 0 },
      loadAverage: [0, 0, 0],
    });

    const mutation = await fetch(`${baseUrl}/api/session/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "do not send" }),
    });
    assert.equal(mutation.status, 409);
    assert.deepEqual(await mutation.json(), { error: "Workspace preview is read-only" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("chat selection and down-arrow controls scroll the timeline to the bottom", async (context) => {
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const publicDirectory = join(process.cwd(), "public");
  const server = createWorkspacePreviewServer(publicDirectory);
  const browser = await chromium.launch({ headless: true });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator(".chat-entry").click();

    const timeline = page.locator("#timeline");
    await assertBottom(timeline);
    await timeline.evaluate((element) => element.scrollTo({ top: 0 }));
    await page.locator("#scroll-to-bottom").waitFor({ state: "visible" });
    await page.locator("#scroll-to-bottom").click();
    await assertBottom(timeline);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function assertBottom(locator: import("playwright").Locator): Promise<void> {
  await assert.doesNotReject(async () => {
    await locator.evaluate(async (element) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
        if (element.clientHeight > 0 && distance <= 1) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
      throw new Error(
        `Timeline did not reach bottom: clientHeight=${element.clientHeight}, distance=${distance}`,
      );
    });
  });
}

test("screenshot tool verifies workspace conversation scrolling with typed actions", async (context) => {
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-screenshot-actions-"));
  const artifactDirectory = join(directory, "artifacts");
  const eventStore = new EventStore(directory);
  const eventHub = new SseHub();
  const tool = createScreenshotTool({
    artifactDirectory,
    tailscaleUser: "owner@example.com",
    workspacePublicDirectory: join(process.cwd(), "public"),
    eventStore,
    eventHub,
  });

  try {
    assert.ok(tool.handler);
    const actions = [
      { type: "click", selector: ".chat-entry" },
      { type: "assertScroll", selector: "#timeline", position: "bottom" },
      { type: "scroll", selector: "#timeline", position: "top" },
      { type: "assertScroll", selector: "#timeline", position: "top" },
      { type: "click", selector: "#scroll-to-bottom" },
      { type: "assertScroll", selector: "#timeline", position: "bottom" },
    ] as const;
    const result = await tool.handler(
      { source: "workspace", viewport: "mobile", actions },
      {
        sessionId: "test",
        toolCallId: "call-scroll",
        toolName: tool.name,
        arguments: { source: "workspace", viewport: "mobile", actions },
      },
    ) as { readonly artifactUrl: string; readonly source: string };

    assert.equal(result.source, "workspace");
    assert.equal(existsSync(join(artifactDirectory, result.artifactUrl.split("/").at(-1) ?? "")), true);
    assert.equal(eventStore.list().at(-1)?.kind, "assistant.artifact");
  } finally {
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("screenshot tool reports unsafe deployed interactions without retrying the browser", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-screenshot-safety-"));
  const eventStore = new EventStore(directory);
  const eventHub = new SseHub();
  const tool = createScreenshotTool({
    artifactDirectory: join(directory, "artifacts"),
    tailscaleUser: "owner@example.com",
    workspacePublicDirectory: join(process.cwd(), "public"),
    eventStore,
    eventHub,
  });

  try {
    assert.ok(tool.handler);
    const actions = [{ type: "click", selector: "#send" }] as const;
    const result = await tool.handler(
      { source: "deployed", actions },
      {
        sessionId: "test",
        toolCallId: "call-unsafe",
        toolName: tool.name,
        arguments: { source: "deployed", actions },
      },
    );

    assert.deepEqual(result, {
      status: "failed",
      error: "Deployed clicks are not allowed on #send",
      message: "The screenshot was not captured. Report this error instead of retrying unchanged.",
    });
    assert.deepEqual(eventStore.list(), []);
  } finally {
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});
