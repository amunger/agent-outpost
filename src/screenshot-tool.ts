import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { defineTool, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { chromium, type Browser } from "playwright";

import { createWorkspacePreviewServer } from "./http-server.js";

interface ScreenshotAction {
  readonly type: "click" | "fill" | "scroll" | "assertScroll";
  readonly selector: string;
  readonly value?: string;
  readonly position?: "top" | "bottom";
  readonly waitAfterMs?: number;
}

const deployedClickSelectors = new Set([".chat-entry", "#back-to-chats", "#scroll-to-bottom"]);

import type { EventStore } from "./event-store.js";
import type { SseHub } from "./sse-hub.js";

interface ScreenshotArguments {
  readonly viewport?: "mobile" | "desktop";
  readonly fullPage?: boolean;
  readonly source?: "deployed" | "workspace";
  readonly scenario?: "default" | "working" | "completed";
  readonly actions?: readonly ScreenshotAction[];
}

export interface ScreenshotToolOptions {
  readonly artifactDirectory: string;
  readonly tailscaleUser: string;
  readonly publicBaseUrl?: string;
  readonly eventStore: EventStore;
  readonly eventHub: SseHub;
  readonly workspacePublicDirectory: string;
  readonly chatId?: string;
  readonly projectId?: string;
  readonly deployedBaseUrl?: string;
}

export const MAX_SCREENSHOT_WIDTH = 4096;
export const MAX_SCREENSHOT_HEIGHT = 8192;
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export function validateScreenshotLimits(
  width: number,
  height: number,
  bytes?: number,
): string | undefined {
  if (width > MAX_SCREENSHOT_WIDTH || height > MAX_SCREENSHOT_HEIGHT) {
    return (
      `Screenshot dimensions ${width}x${height} exceed the maximum ` +
      `${MAX_SCREENSHOT_WIDTH}x${MAX_SCREENSHOT_HEIGHT}`
    );
  }
  if (bytes !== undefined && bytes > MAX_SCREENSHOT_BYTES) {
    return `Screenshot PNG is ${bytes} bytes; maximum is ${MAX_SCREENSHOT_BYTES} bytes`;
  }
  return undefined;
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
      "perform browser actions before capture. Deployed captures permit only chat navigation " +
      "and timeline scrolling actions. Deployed captures are scoped to the current chat " +
      "before capture. Publishes the screenshot directly into the " +
      "conversation timeline as an image artifact and returns its URL for reference.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        viewport: { type: "string", enum: ["mobile", "desktop"] },
        fullPage: { type: "boolean" },
        source: { type: "string", enum: ["deployed", "workspace"] },
        scenario: {
          type: "string",
          enum: ["default", "working", "completed"],
          description: "Workspace-only structured event fixture to render before capture.",
        },
        actions: {
          type: "array",
          maxItems: 20,
          description:
            "Ordered browser steps. Use scroll and assertScroll with #timeline and top/bottom " +
            "to verify scrolling; click .chat-entry to open a chat. Deployed captures allow " +
            "clicks only on .chat-entry, #back-to-chats, and #scroll-to-bottom.",
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
      try {
        const viewportName = value.viewport ?? "mobile";
        const source = value.source ?? "deployed";
        const scenario = value.scenario ?? "default";
        const actions = value.actions ?? [];
        if (source === "deployed" && scenario !== "default") {
          throw new Error("Workspace scenarios are not available for deployed captures");
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
          if (source === "deployed") {
            if (action.type === "fill") {
              throw new Error("Fill actions are not allowed against the deployed service");
            }
            if (action.type === "click" && [".chat-entry", "#back-to-chats"].includes(action.selector)) {
              throw new Error(`Deployed navigation is locked to chat ${options.chatId ?? "(unknown)"}`);
            }
            if (action.type === "click" && !deployedClickSelectors.has(action.selector)) {
              throw new Error(`Deployed clicks are not allowed on ${action.selector}`);
            }
            if (
              (action.type === "scroll" || action.type === "assertScroll") &&
              action.selector !== "#timeline"
            ) {
              throw new Error(`Deployed scroll actions are not allowed on ${action.selector}`);
            }
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
        const targetUrl =
          preview && scenario !== "default"
            ? `${preview.url}?scenario=${encodeURIComponent(scenario)}`
            : preview?.url ?? options.deployedBaseUrl ?? "http://127.0.0.1:3000/";
        let browser: Browser | undefined;
        let captured = false;
        let diagnostics: Record<string, unknown> | undefined;
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        try {
          browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({
            viewport,
            extraHTTPHeaders: {
              "Tailscale-User-Login": options.tailscaleUser,
            },
          });
          const page = await context.newPage();
          page.on("console", (message) => {
            if (message.type() === "error") {
              consoleErrors.push(message.text());
            }
          });
          page.on("pageerror", (error) => {
            pageErrors.push(error.message);
          });
          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          if (source === "deployed") {
            if (!options.chatId) {
              throw new Error("Deployed capture requires a current chat ID");
            }
            const escapedChatId = options.chatId.replace(/["\\]/g, "\\$&");
            const chatEntry = page.locator(`.chat-entry[data-chat-id="${escapedChatId}"]`);
            await chatEntry.waitFor({ state: "visible", timeout: 15_000 });
            if (options.projectId) {
              const entryProjectId = await chatEntry.getAttribute("data-project-id");
              if (entryProjectId !== options.projectId) {
                throw new Error(
                  `Current chat ${options.chatId} belongs to project ${entryProjectId ?? "(unknown)"}, ` +
                    `not ${options.projectId}`,
                );
              }
            }
            await chatEntry.click();
            const activeChat = page.locator("#chat-view");
            await activeChat.waitFor({ state: "visible", timeout: 15_000 });
            const selected = await activeChat.evaluate((element) => ({
              chatId: element.getAttribute("data-chat-id"),
              projectId: element.getAttribute("data-project-id"),
            }));
            if (
              selected.chatId !== options.chatId ||
              (options.projectId !== undefined && selected.projectId !== options.projectId)
            ) {
              throw new Error(
                `Deployed capture selected chat ${selected.chatId ?? "(unknown)"} ` +
                  `in project ${selected.projectId ?? "(unknown)"}`,
              );
            }
          }
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
          const renderSize = await page.evaluate((fullPage) => {
            const documentLike = globalThis as unknown as {
              readonly document: {
                readonly documentElement: {
                  readonly scrollWidth: number;
                  readonly scrollHeight: number;
                };
                readonly body: {
                  readonly scrollWidth: number;
                  readonly scrollHeight: number;
                };
              };
              readonly innerWidth: number;
              readonly innerHeight: number;
            };
            return {
              width: fullPage
                ? Math.max(
                    documentLike.document.documentElement.scrollWidth,
                    documentLike.document.body.scrollWidth,
                  )
                : documentLike.innerWidth,
              height: fullPage
                ? Math.max(
                    documentLike.document.documentElement.scrollHeight,
                    documentLike.document.body.scrollHeight,
                  )
                : documentLike.innerHeight,
            };
          }, value.fullPage ?? false);
          const dimensionError = validateScreenshotLimits(renderSize.width, renderSize.height);
          if (dimensionError) {
            throw new Error(dimensionError);
          }
          await page.screenshot({
            path: outputPath,
            fullPage: value.fullPage ?? false,
            type: "png",
          });
          const byteError = validateScreenshotLimits(
            renderSize.width,
            renderSize.height,
            lstatSync(outputPath).size,
          );
          if (byteError) {
            throw new Error(byteError);
          }
          diagnostics = await page.evaluate(() => {
            type ElementSummary = {
              readonly tagName: string;
              readonly textContent: string | null;
              readonly parentElement: ElementSummary | null;
              hasAttribute(name: string): boolean;
              getAttribute(name: string): string | null;
              getClientRects(): { readonly length: number };
            };
            const doc = (
              globalThis as unknown as {
                readonly document: {
                  readonly title: string;
                  readonly body: {
                    readonly innerText: string;
                    readonly scrollWidth: number;
                    readonly clientWidth: number;
                    readonly scrollHeight: number;
                    readonly clientHeight: number;
                  };
                  querySelectorAll(selector: string): ArrayLike<ElementSummary>;
                };
              }
            ).document;
            const visibleText = doc.body.innerText.replace(/\s+/g, " ").trim();
            const windowLike = globalThis as unknown as {
              getComputedStyle(element: ElementSummary): {
                readonly display: string;
                readonly visibility: string;
                readonly opacity: string;
              };
            };
            const labelled = Array.from(doc.querySelectorAll("[aria-label], [role]"))
              .filter((element) => {
                if (element.getClientRects().length === 0) {
                  return false;
                }
                for (
                  let current: ElementSummary | null = element;
                  current;
                  current = current.parentElement
                ) {
                  const style = windowLike.getComputedStyle(current);
                  if (
                    current.hasAttribute("hidden") ||
                    current.hasAttribute("inert") ||
                    current.getAttribute("aria-hidden") === "true" ||
                    style.display === "none" ||
                    style.visibility === "hidden" ||
                    style.visibility === "collapse" ||
                    style.opacity === "0"
                  ) {
                    return false;
                  }
                }
                return true;
              })
              .slice(0, 20)
              .map((element) => ({
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute("role"),
                ariaLabel: element.getAttribute("aria-label"),
                text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
              }));
            return {
              title: doc.title,
              visibleText: visibleText.slice(0, 1_000),
              labelled,
              body: {
                scrollWidth: doc.body.scrollWidth,
                clientWidth: doc.body.clientWidth,
                scrollHeight: doc.body.scrollHeight,
                clientHeight: doc.body.clientHeight,
              },
            };
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
        const stored = options.eventStore.append(
          {
            kind: "assistant.artifact",
            payload: {
              caption: `${viewportName === "mobile" ? "Mobile" : "Desktop"} UI screenshot`,
              url,
              kind: "screenshot",
              ...(absoluteUrl ? { absoluteUrl } : {}),
            },
          },
          options.chatId ?? null,
        );
        options.eventHub.publish(stored, options.chatId ?? null);

        const result: ToolResultObject & Record<string, unknown> = {
          textResultForLlm: JSON.stringify({
            status: "captured",
            source,
            viewport: viewportName,
            scenario,
            domAccessibility: diagnostics,
            consoleErrors,
            pageErrors,
          }),
          binaryResultsForLlm: [
            {
              data: (await readFile(outputPath)).toString("base64"),
              mimeType: "image/png",
              type: "image",
              description: `${viewportName} Agent Outpost UI screenshot`,
            },
          ],
          resultType: "success",
          status: "captured",
          artifactUrl: url,
          ...(absoluteUrl ? { absoluteUrl } : {}),
          source,
          viewport: viewportName,
          scenario,
          width: viewport.width,
          height: viewport.height,
          diagnostics,
          consoleErrors,
          pageErrors,
          message:
            "The screenshot was published to the conversation timeline as an inline image. " +
            "Do not repeat the artifact URL as plain text; tell the user the screenshot is shown above.",
        };
        return result;
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          message: "The screenshot was not captured. Report this error instead of retrying unchanged.",
        };
      }
    },
  });
}
