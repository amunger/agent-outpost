import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { defineTool, type Tool } from "@github/copilot-sdk";
import { chromium } from "playwright";

interface ScreenshotArguments {
  readonly viewport?: "mobile" | "desktop";
  readonly fullPage?: boolean;
}

export interface ScreenshotToolOptions {
  readonly artifactDirectory: string;
  readonly tailscaleUser: string;
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

export function createScreenshotTool(
  options: ScreenshotToolOptions,
): Tool<ScreenshotArguments> {
  return defineTool<ScreenshotArguments>("capture_agent_outpost_screenshot", {
    description:
      "Capture the live Agent Outpost UI at its fixed loopback endpoint. " +
      "Returns an authenticated artifact URL that can be shared in chat.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        viewport: { type: "string", enum: ["mobile", "desktop"] },
        fullPage: { type: "boolean" },
      },
    },
    defer: "never",
    skipPermission: true,
    handler: async (value: ScreenshotArguments) => {
      const viewportName = value.viewport ?? "mobile";
      const viewport =
        viewportName === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
      mkdirSync(options.artifactDirectory, { recursive: true, mode: 0o700 });
      cleanOldScreenshots(options.artifactDirectory);
      const filename = `screenshot-${Date.now()}-${randomUUID()}.png`;
      const outputPath = join(options.artifactDirectory, filename);
      const browser = await chromium.launch({ headless: true });
      let captured = false;
      try {
        const context = await browser.newContext({
          viewport,
          extraHTTPHeaders: {
            "Tailscale-User-Login": options.tailscaleUser,
          },
        });
        const page = await context.newPage();
        await page.goto("http://127.0.0.1:3000/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.locator("#composer").waitFor({ state: "visible", timeout: 15_000 });
        await page.screenshot({
          path: outputPath,
          fullPage: value.fullPage ?? false,
          type: "png",
        });
        captured = true;
      } finally {
        await browser.close();
        if (!captured) {
          rmSync(outputPath, { force: true });
        }
      }

      return {
        status: "captured",
        artifactUrl: `/api/artifacts/${filename}`,
        viewport: viewportName,
        width: viewport.width,
        height: viewport.height,
      };
    },
  });
}
