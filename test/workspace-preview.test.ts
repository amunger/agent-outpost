import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { chromium } from "playwright";

import { EventStore } from "../src/event-store.js";
import { createWorkspacePreviewServer } from "../src/http-server.js";
import {
  createScreenshotTool,
  MAX_MODEL_INPUT_IMAGE_BYTES,
  MAX_SCREENSHOT_HEIGHT,
  MAX_SCREENSHOT_WIDTH,
  validateScreenshotLimits,
} from "../src/screenshot-tool.js";
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
    assert.equal(sessionBody.events.length, 33);

    const chats = await fetch(`${baseUrl}/api/chats`);
    const chatsBody = await chats.json() as { readonly chats: readonly unknown[] };
    assert.equal(chatsBody.chats.length, 1);

    const projects = await fetch(`${baseUrl}/api/projects`);
    assert.deepEqual(await projects.json(), {
      projects: [
        {
          id: "agent-outpost",
          name: "Agent Outpost",
          repository: basename(join(publicDirectory, "..")),
        },
      ],
    });

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

test("workspace preview renders a deployment candidate approval card", async (context) => {
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const server = createWorkspacePreviewServer(join(process.cwd(), "public"));
  const browser = await chromium.launch({ headless: true });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator(".chat-entry").click();
    const card = page.locator(".deployment-candidate");
    await assert.equal(
      await card.locator("h2").textContent(),
      "Agent Outpost deployment candidate",
    );
    await assert.equal(await card.locator("details").getAttribute("open"), null);
    await assert.equal(await card.getAttribute("data-pinned"), null);
    const messages = page.locator("#timeline > .message");
    await assert.equal(
      await messages.nth(31).getAttribute("data-candidate-id"),
      await card.getAttribute("data-candidate-id"),
    );
    await assert.equal(await messages.nth(32).getAttribute("data-role"), "user");
    await assert.equal(await card.locator("button").textContent(), "Deploy");
    await assert.equal(await card.locator("li").count(), 2);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("workspace preview keeps streamed deltas text-free in Working state", async (context) => {
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const server = createWorkspacePreviewServer(join(process.cwd(), "public"));
  const browser = await chromium.launch({ headless: true });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/?scenario=working`);
    await page.locator(".chat-entry").click();

    const messages = page.locator("#timeline > .message");
    await messages.nth(1).waitFor({ state: "visible" });
    assert.equal(await messages.count(), 2);
    assert.equal(await messages.nth(1).textContent().then((value) => value?.includes("Working…")), true);
    assert.equal(await messages.nth(1).textContent().then((value) => value?.includes("delta")), false);
    assert.equal(await page.locator(".message-working").count(), 1);
    assert.equal(await page.locator("#state").getAttribute("data-state"), "running");
    assert.equal(await page.locator("#state").textContent(), "Running");
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("workspace preview replaces Working state with exactly one completed response on mobile", async (context) => {
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const server = createWorkspacePreviewServer(join(process.cwd(), "public"));
  const browser = await chromium.launch({ headless: true });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/?scenario=completed`);
    await page.locator(".chat-entry").click();

    const messages = page.locator("#timeline > .message");
    await messages.nth(1).waitFor({ state: "visible" });
    assert.equal(await messages.count(), 2);
    assert.equal(await page.locator(".message-working").count(), 0);
    assert.equal(
      await messages.nth(1).textContent().then((value) =>
        value?.includes("The completed assistant response appears exactly once."),
      ),
      true,
    );
    assert.equal(await messages.nth(1).textContent().then((value) => value?.includes("delta")), false);
    assert.equal(
      await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("workspace preview clears Working state on cancellation, failure, and idle without a final response", async (context) => {
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const server = createWorkspacePreviewServer(join(process.cwd(), "public"));
  const browser = await chromium.launch({ headless: true });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    for (const scenario of ["cancelled", "failed", "idle"] as const) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`http://127.0.0.1:${port}/?scenario=${scenario}`);
      await page.locator(".chat-entry").click();
      await page.locator("#timeline > .message").first().waitFor({ state: "visible" });
      assert.equal(await page.locator(".message-working").count(), 0);
      assert.equal(
        await page.locator("#timeline > .message").allTextContents().then((values) =>
          values.some((value) => value.includes("delta")),
        ),
        false,
      );
      if (scenario === "failed") {
        assert.equal(await page.locator('[data-role="error"]').count(), 1);
      } else {
        assert.equal(await page.locator('[data-role="error"]').count(), 0);
      }
      await page.close();
    }
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
    ) as {
      readonly artifactUrl: string;
      readonly source: string;
      readonly binaryResultsForLlm?: readonly { readonly data: string; readonly mimeType: string }[];
      readonly textResultForLlm?: string;
      readonly diagnostics?: { readonly body: { readonly scrollWidth: number; readonly clientWidth: number } };
    };

    assert.equal(result.source, "workspace", JSON.stringify(result));
    assert.equal(result.binaryResultsForLlm?.[0]?.mimeType, "image/png");
    assert.ok(result.binaryResultsForLlm?.[0]?.data.length);
    assert.match(result.textResultForLlm ?? "", /"consoleErrors":\[/);
    assert.ok(result.diagnostics);
    assert.equal(result.diagnostics.body.scrollWidth <= result.diagnostics.body.clientWidth, true);
    const diagnostics = JSON.parse(result.textResultForLlm ?? "{}") as {
      readonly domAccessibility?: {
        readonly labelled?: readonly { readonly ariaLabel: string | null; readonly text: string }[];
      };
    };
    assert.equal(
      diagnostics.domAccessibility?.labelled?.some(
        ({ ariaLabel, text }) =>
          ariaLabel?.includes("Workspace preview") || text.includes("workspace-preview"),
      ),
      false,
    );
    assert.equal(
      diagnostics.domAccessibility?.labelled?.some(
        ({ ariaLabel }) => ariaLabel === "Message the agent",
      ),
      true,
    );
    assert.equal(existsSync(join(artifactDirectory, result.artifactUrl.split("/").at(-1) ?? "")), true);
    assert.equal(eventStore.list().at(-1)?.kind, "assistant.artifact");
  } finally {
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace preview screenshot shows composer errors above the input", async (context) => {
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-screenshot-error-"));
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
      { type: "fill", selector: "#message", value: "Preview error state" },
      { type: "click", selector: "#send", waitAfterMs: 100 },
      { type: "click", selector: "#error" },
    ] as const;
    const result = await tool.handler(
      { source: "workspace", viewport: "mobile", actions },
      {
        sessionId: "test",
        toolCallId: "call-error",
        toolName: tool.name,
        arguments: { source: "workspace", viewport: "mobile", actions },
      },
    ) as { readonly status: string; readonly artifactUrl?: string };

    assert.equal(result.status, "captured", JSON.stringify(result));
    assert.ok(result.artifactUrl);
    assert.equal(existsSync(join(artifactDirectory, result.artifactUrl.split("/").at(-1) ?? "")), true);
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
    for (const [index, selector] of ["#send", ".chat-entry", "#back-to-chats"].entries()) {
      const actions = [{ type: "click", selector }] as const;
      const result = (await tool.handler(
        { source: "deployed", actions },
        {
          sessionId: "test",
          toolCallId: `call-unsafe-${index}`,
          toolName: tool.name,
          arguments: { source: "deployed", actions },
        },
      )) as { readonly status: string; readonly error?: string };
      assert.equal(result.status, "failed");
      assert.match(
        result.error ?? "",
        new RegExp(selector === "#send" ? "not allowed on #send" : "locked to chat"),
      );
    }
    assert.deepEqual(eventStore.list(), []);
  } finally {
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployed screenshot capture selects only the scoped project chat", async (context) => {
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-screenshot-scope-"));
  const artifactDirectory = join(directory, "artifacts");
  const server = createWorkspacePreviewServer(join(process.cwd(), "public"), {
    multiProject: true,
  });
  const eventStore = new EventStore(directory);
  const eventHub = new SseHub();

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const tool = createScreenshotTool({
      artifactDirectory,
      tailscaleUser: "owner@example.com",
      workspacePublicDirectory: join(process.cwd(), "public"),
      eventStore,
      eventHub,
      chatId: "workspace-preview",
      projectId: "agent-outpost",
      deployedBaseUrl: `http://127.0.0.1:${port}`,
    });
    assert.ok(tool.handler);
    const result = await tool.handler(
      {
        source: "deployed",
        viewport: "mobile",
        actions: [
          { type: "assertScroll", selector: "#timeline", position: "bottom" },
          { type: "scroll", selector: "#timeline", position: "top" },
          { type: "click", selector: "#scroll-to-bottom" },
          { type: "assertScroll", selector: "#timeline", position: "bottom" },
        ],
      },
      {
        sessionId: "test",
        toolCallId: "call-scoped-valid",
        toolName: tool.name,
        arguments: {},
      },
    ) as { readonly status: string; readonly textResultForLlm?: string };
    assert.equal(result.status, "captured");
    assert.equal(result.textResultForLlm?.includes("Other project secret"), false);
    assert.equal(result.textResultForLlm?.includes("other/project"), false);
  } finally {
    eventHub.close();
    eventStore[Symbol.dispose]();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("screenshot limits reject oversized renders and raw PNGs before publication", async (context) => {
  assert.equal(
    validateScreenshotLimits(MAX_SCREENSHOT_WIDTH + 1, 100),
    `Screenshot dimensions ${MAX_SCREENSHOT_WIDTH + 1}x100 exceed the maximum ${MAX_SCREENSHOT_WIDTH}x${MAX_SCREENSHOT_HEIGHT}`,
  );
  assert.equal(validateScreenshotLimits(100, 100, MAX_MODEL_INPUT_IMAGE_BYTES), undefined);
  assert.equal(
    validateScreenshotLimits(100, 100, MAX_MODEL_INPUT_IMAGE_BYTES + 1),
    `Screenshot PNG is ${MAX_MODEL_INPUT_IMAGE_BYTES + 1} bytes; maximum model input image size is ${MAX_MODEL_INPUT_IMAGE_BYTES} bytes`,
  );
  if (!existsSync(chromium.executablePath())) {
    context.skip("Playwright Chromium is not installed in this environment");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-outpost-screenshot-size-"));
  const publicDirectory = join(directory, "public");
  const artifactDirectory = join(directory, "artifacts");
  mkdirSync(publicDirectory);
  writeFileSync(
    join(publicDirectory, "index.html"),
    '<!doctype html><svg width="5000" height="9000" aria-label="oversized render"></svg>',
  );
  const eventStore = new EventStore(directory);
  const eventHub = new SseHub();
  const tool = createScreenshotTool({
    artifactDirectory,
    tailscaleUser: "owner@example.com",
    workspacePublicDirectory: publicDirectory,
    eventStore,
    eventHub,
  });

  try {
    assert.ok(tool.handler);
    const result = await tool.handler(
      { source: "workspace", fullPage: true },
      {
        sessionId: "test",
        toolCallId: "call-size",
        toolName: tool.name,
        arguments: {},
      },
    ) as { readonly status: string; readonly error?: string };
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /exceed the maximum/);
    assert.equal(existsSync(artifactDirectory), true);
    assert.equal(readdirSync(artifactDirectory).length, 0);
    assert.deepEqual(eventStore.list(), []);
  } finally {
    eventHub.close();
    eventStore[Symbol.dispose]();
    rmSync(directory, { recursive: true, force: true });
  }
});
