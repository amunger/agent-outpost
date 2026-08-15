import { statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";

import type { ResourceSnapshot } from "./domain.js";

interface CpuTotals {
  readonly idle: number;
  readonly total: number;
}

function cpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function percentage(used: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((used / total) * 1_000) / 10;
}

export class ResourceMonitor implements Disposable {
  #previousCpu = cpuTotals();
  #cpuUsagePercent = 0;
  readonly #timer: NodeJS.Timeout;

  public constructor() {
    this.#timer = setInterval(() => {
      const current = cpuTotals();
      const totalDelta = current.total - this.#previousCpu.total;
      const idleDelta = current.idle - this.#previousCpu.idle;
      this.#cpuUsagePercent = percentage(totalDelta - idleDelta, totalDelta);
      this.#previousCpu = current;
    }, 1_000);
    this.#timer.unref();
  }

  public async snapshot(path: string): Promise<ResourceSnapshot> {
    const memoryTotal = totalmem();
    const memoryUsed = memoryTotal - freemem();
    const disk = await statfs(path, { bigint: true });
    const diskTotal = Number(disk.blocks * disk.bsize);
    const diskAvailable = Number(disk.bavail * disk.bsize);
    const diskUsed = diskTotal - diskAvailable;
    const averages = loadavg();

    return {
      capturedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor(uptime()),
      loadAverage: [averages[0] ?? 0, averages[1] ?? 0, averages[2] ?? 0],
      cpu: {
        logicalProcessors: cpus().length,
        usagePercent: this.#cpuUsagePercent,
      },
      memory: {
        totalBytes: memoryTotal,
        usedBytes: memoryUsed,
        usagePercent: percentage(memoryUsed, memoryTotal),
      },
      disk: {
        totalBytes: diskTotal,
        usedBytes: diskUsed,
        usagePercent: percentage(diskUsed, diskTotal),
      },
    };
  }

  public [Symbol.dispose](): void {
    clearInterval(this.#timer);
  }
}
