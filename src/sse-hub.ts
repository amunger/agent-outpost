import type { ServerResponse } from "node:http";

import type { OutpostEvent } from "./domain.js";

export class SseHub {
  readonly #clients = new Map<ServerResponse, string | null>();

  /**
   * Registers a client for a specific chat. `chatId` should be the chat the
   * requesting connection is actually viewing (null for legacy/global
   * subscribers). Events published for a different chat are never delivered
   * to this client, preventing cross-chat leakage between concurrent tabs.
   */
  public add(
    response: ServerResponse,
    initialEvents: readonly OutpostEvent[] = [],
    chatId: string | null = null,
  ): () => void {
    this.#clients.set(response, chatId);
    response.write(": connected\n\n");
    for (const event of initialEvents) {
      response.write(this.#frame(event));
    }

    return () => {
      this.#clients.delete(response);
    };
  }

  /**
   * Publishes an event. `chatId` identifies which chat the event belongs to;
   * pass null for events that are not chat-scoped (e.g. deployment
   * candidates) so they reach every subscriber. Chat-scoped events are only
   * delivered to clients registered for that same chat.
   */
  public publish(event: OutpostEvent, chatId: string | null = null): void {
    const frame = this.#frame(event);
    for (const [client, clientChatId] of this.#clients) {
      if (chatId !== null && clientChatId !== null && clientChatId !== chatId) {
        continue;
      }
      client.write(frame);
    }
  }

  public close(): void {
    for (const client of this.#clients.keys()) {
      client.end();
    }
    this.#clients.clear();
  }

  #frame(event: OutpostEvent): string {
    const identifier = event.id > 0 ? `id: ${event.id}\n` : "";
    return `${identifier}event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}
