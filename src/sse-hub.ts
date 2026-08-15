import type { ServerResponse } from "node:http";

import type { OutpostEvent } from "./domain.js";

export class SseHub {
  readonly #clients = new Set<ServerResponse>();

  public add(response: ServerResponse, initialEvents: readonly OutpostEvent[] = []): () => void {
    this.#clients.add(response);
    response.write(": connected\n\n");
    for (const event of initialEvents) {
      response.write(this.#frame(event));
    }

    return () => {
      this.#clients.delete(response);
    };
  }

  public publish(event: OutpostEvent): void {
    const frame = this.#frame(event);
    for (const client of this.#clients) {
      client.write(frame);
    }
  }

  public close(): void {
    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
  }

  #frame(event: OutpostEvent): string {
    const identifier = event.id > 0 ? `id: ${event.id}\n` : "";
    return `${identifier}event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}
