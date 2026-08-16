import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { defineTool, type Tool } from "@github/copilot-sdk";
import { chromium, type Browser } from "playwright";

import { createWorkspacePreviewServer } from "./http-server.js";

interface ScreenshotAction {
  readonly type: "click" | "fill" | "scroll" | "assertScroll";
  readonly selector: string;
  readonly value?: string;
  readonly position?: "top" | "bottom";
  readonly waitAfterMs?: number;
}

import type { EventStore } from "./event-store.js";
import type { SseHub } from "./sse-hub.js";

interface ScreenshotArguments {
  readonly viewport?: "mobile" | "desktop";
  readonly fullPage?: boolean;
  readonly source?: "deployed" | "workspace";
  readonly actions?: readonly ScreenshotAction[];
}

export interface ScreenshotToolOptions {
  readonly artifactDirectory: string;
  readonly tailscaleUser: string;
  readonly publicBaseUrl?: string;
  readonly eventStore: EventStore;
  readonly eventHub: SseHub;
  readonly workspacePublicDirectory: string;
}

function cleanOldScreenshots(artifactDirectory: string): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const screenshots = readdirSync(artifactDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^screenshot-[0-9]+-[0-9a-f-]{36}\.png$/.test(entry.name),
    )
    .map((entry) => {
      const path = join(artifactDirectory, entry.name);
      return { path, modifiedAt: lstatSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  for (const [index, screenshot] of screenshots.entries()) {
    if (index >= 19 || screenshot.modifiedAt < cutoff) {
      rmSync(screenshot.path, { force: true });
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startWorkspacePreview(publicDirectory: string): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  await access(publicDirectory);
  const server = createWorkspacePreviewServer(publicDirectory);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (server.listening) {
      await closeServer(server);
    }
    throw error;
  }
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

export function createScreenshotTool(
  options: ScreenshotToolOptions,
): Tool<ScreenshotArguments> {
  return defineTool<ScreenshotArguments>("capture_agent_outpost_screenshot", {
    description:
      "Capture either the deployed Agent Outpost UI or an isolated, read-only preview of the " +
      "current workspace UI. Workspace previews use the unpublished files in public/ and may " +
      "perform browser actions before capture. Publishes the screenshot directly into the " +
      "conversation timeline as an image artifact and returns its URL for reference.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        viewport: { type: "string", enum: ["mobile", "desktop"] },
        fullPage: { type: "boolean" },
        source: { type: "string", enum: ["deployed", "workspace"] },
        actions: {
          type: "array",
          maxItems: 20,
          description:
            "Ordered browser steps. Use scroll and assertScroll with #timeline and top/bottom " +
            "to verify scrolling; click .chat-entry to open the preview chat.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "selector"],
            properties: {
              type: { type: "string", enum: ["click", "fill", "scroll", "assertScroll"] },
              selector: { type: "string", minLength: 1, maxLength: 500 },
              value: { type: "string", maxLength: 20_000 },
              position: { type: "string", enum: ["top", "bottom"] },
              waitAfterMs: { type: "number", minimum: 0, maximum: 5_000 },
            },
          },
        },
      },
    },
    defer: "never",
    skipPermission: true,
    handler: async (value: ScreenshotArguments) => {
      const viewportName = value.viewport ?? "mobile";
      const source = value.source ?? "deployed";
      const actions = value.actions ?? [];
      if (source === "deployed" && actions.length > 0) {
        throw new Error("Screenshot actions are allowed only in the read-only workspace preview");
      }
      for (const action of actions) {
        if (action.type === "fill" && action.value === undefined) {
          throw new Error(`Fill action for ${action.selector} requires a value`);
        }
        if (
          (action.type === "scroll" || action.type === "assertScroll") &&
          action.position === undefined
        ) {
          throw new Error(`${action.type} action for ${action.selector} requires a position`);
        }
      }
      const viewport =
        viewportName === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
      mkdirSync(options.artifactDirectory, { recursive: true, mode: 0o700 });
      cleanOldScreenshots(options.artifactDirectory);
      const filename = `screenshot-${Date.now()}-${randomUUID()}.png`;
      const outputPath = join(options.artifactDirectory, filename);
      const preview =
        source === "workspace"
          ? await startWorkspacePreview(options.workspacePublicDirectory)
          : undefined;
      const targetUrl = preview?.url ?? "http://127.0.0.1:3000/";
      let browser: Browser | undefined;
      let captured = false;
      try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          viewport,
          extraHTTPHeaders: {
            "Tailscale-User-Login": options.tailscaleUser,
          },
        });
        const page = await context.newPage();
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        for (const action of actions) {
          const locator = page.locator(action.selector);
          await locator.waitFor({ state: "visible", timeout: 15_000 });
          switch (action.type) {
            case "click":
              await locator.click();
              break;
            case "fill":
              await locator.fill(action.value ?? "");
              break;
            case "scroll":
              await locator.evaluate((element, position) => {
                element.scrollTo({
                  top: position === "top" ? 0 : element.scrollHeight,
                });
              }, action.position);
              break;
            case "assertScroll":
              await locator.evaluate(async (element, position) => {
                for (let attempt = 0; attempt < 60; attempt += 1) {
                  const distanceFromBottom =
                    element.scrollHeight - element.clientHeight - element.scrollTop;
                  const matches =
                    position === "top" ? element.scrollTop <= 1 : distanceFromBottom <= 1;
                  if (element.clientHeight > 0 && matches) {
                    return;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 16));
                }
                const distanceFromBottom =
                  element.scrollHeight - element.clientHeight - element.scrollTop;
                throw new Error(
                  `Expected ${position}; scrollTop=${element.scrollTop}, ` +
                    `clientHeight=${element.clientHeight}, distanceFromBottom=${distanceFromBottom}`,
                );
              }, action.position);
              break;
          }
          if (action.waitAfterMs) {
            await page.waitForTimeout(action.waitAfterMs);
          }
        }
        await page.screenshot({
          path: outputPath,
          fullPage: value.fullPage ?? false,
          type: "png",
        });
        captured = true;
      } finally {
        try {
          if (browser) {
            await browser.close();
          }
        } finally {
          if (preview) {
            await closeServer(preview.server);
          }
          if (!captured) {
            rmSync(outputPath, { force: true });
          }
        }
      }

      const url = `/api/artifacts/${filename}`;
      const absoluteUrl = options.publicBaseUrl ? `${options.publicBaseUrl}${url}` : undefined;
      const stored = options.eventStore.append({
        kind: "assistant.artifact",
        payload: {
          caption: `${viewportName === "mobile" ? "Mobile" : "Desktop"} UI screenshot`,
          url,
          kind: "screenshot",
          ...(absoluteUrl ? { absoluteUrl } : {}),
        },
      });
      options.eventHub.publish(stored);

      return {
        status: "captured",
        artifactUrl: url,
        ...(absoluteUrl ? { absoluteUrl } : {}),
        source,
        viewport: viewportName,
        width: viewport.width,
        height: viewport.height,
        message:
          "The screenshot was published to the conversation timeline as an inline image. " +
          "Do not repeat the artifact URL as plain text; tell the user the screenshot is shown above.",
      };
    },
  });
}
