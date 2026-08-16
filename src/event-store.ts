import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentState,
  OutpostEvent,
  OutpostEventKind,
  StoredEventInput,
} from "./domain.js";

interface EventRow {
  readonly id: number;
  readonly kind: string;
  readonly created_at: string;
  readonly payload: string;
}

interface ChatRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly repository: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
}

export interface StoredChat {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly repository: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface ChatStatistics {
  readonly messageCount: number;
  readonly estimatedTokens: number;
  readonly aicUsage: number;
  readonly firstMessageAt: string | null;
}

const storedKinds = new Set<OutpostEventKind>([
  "user.message",
  "assistant.message",
  "assistant.artifact",
  "session.state",
  "session.error",
  "system.notice",
]);

function isStoredKind(value: string): value is Exclude<OutpostEventKind, "assistant.delta"> {
  return storedKinds.has(value as OutpostEventKind);
}

function stringProperty(value: object, property: string): string | undefined {
  if (!(property in value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function isAgentState(value: string): value is AgentState {
  return ["starting", "idle", "running", "cancelling", "failed"].includes(value);
}

function parseRow(row: EventRow): OutpostEvent {
  if (!isStoredKind(row.kind)) {
    throw new Error(`Database contains unsupported event kind: ${row.kind}`);
  }

  const payload: unknown = JSON.parse(row.payload);
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Database contains invalid payload for event ${row.id}`);
  }

  switch (row.kind) {
    case "user.message":
    case "assistant.message": {
      const content = stringProperty(payload, "content");
      if (content === undefined) {
        break;
      }
      return { id: row.id, kind: row.kind, createdAt: row.created_at, payload: { content } };
    }
    case "session.state": {
      const state = stringProperty(payload, "state");
      if (state !== undefined && isAgentState(state)) {
        return {
          id: row.id,
          kind: row.kind,
          createdAt: row.created_at,
          payload: { state },
        };
      }
      break;
    }
    case "session.error": {
      const message = stringProperty(payload, "message");
      if (message === undefined) {
        break;
      }
      return { id: row.id, kind: row.kind, createdAt: row.created_at, payload: { message } };
    }
    case "system.notice": {
      const message = stringProperty(payload, "message");
      if (message === undefined) {
        break;
      }
      return { id: row.id, kind: row.kind, createdAt: row.created_at, payload: { message } };
    }
    case "assistant.artifact": {
      const caption = stringProperty(payload, "caption");
      const url = stringProperty(payload, "url");
      const artifactKind = stringProperty(payload, "kind");
      if (caption === undefined || url === undefined || artifactKind !== "screenshot") {
        break;
      }
      const absoluteUrl = stringProperty(payload, "absoluteUrl");
      return {
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at,
        payload: { caption, url, kind: "screenshot", ...(absoluteUrl ? { absoluteUrl } : {}) },
      };
    }
  }

  throw new Error(`Database contains invalid payload for event ${row.id} (${row.kind})`);
}

export class EventStore implements Disposable {
  readonly #database: DatabaseSync;

  public constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(join(dataDirectory, "outpost.db"));
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        repository TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS chats_last_used_at
        ON chats(last_used_at DESC);
    `);
  }

  public ensureChat(
    chat: Omit<StoredChat, "createdAt"> & { readonly createdAt?: string },
  ): StoredChat {
    const createdAt = chat.createdAt ?? new Date().toISOString();
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO chats
          (id, project_id, name, repository, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chat.id,
        chat.projectId,
        chat.name,
        chat.repository,
        createdAt,
        chat.lastUsedAt,
      );
    const stored = this.#getChat(chat.id);
    if (!stored) {
      throw new Error(`SQLite did not persist chat ${chat.id}`);
    }
    return stored;
  }

  public createChat(chat: {
    readonly id: string;
    readonly projectId: string;
    readonly name: string;
    readonly repository: string;
  }): StoredChat {
    const createdAt = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO chats
          (id, project_id, name, repository, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(chat.id, chat.projectId, chat.name, chat.repository, createdAt, createdAt);
    const stored = this.#getChat(chat.id);
    if (!stored) {
      throw new Error(`SQLite did not persist chat ${chat.id}`);
    }
    return stored;
  }

  public listChats(): StoredChat[] {
    const rows = this.#database
      .prepare(
        `SELECT id, project_id, name, repository, created_at, last_used_at
        FROM chats
        ORDER BY COALESCE(last_used_at, created_at) DESC, id ASC`,
      )
      .all() as unknown as ChatRow[];
    return rows.map((row) => this.#parseChat(row));
  }

  public deleteChat(id: string): boolean {
    const result = this.#database.prepare("DELETE FROM chats WHERE id = ?").run(id);
    return result.changes > 0;
  }

  public chatStatistics(): ChatStatistics {
    const rows = this.#database
      .prepare(
        `SELECT kind, created_at, payload FROM events
        WHERE kind IN ('user.message', 'assistant.message')
        ORDER BY id ASC`,
      )
      .all() as unknown as Array<Omit<EventRow, "id">>;
    let characters = 0;
    for (const row of rows) {
      const payload: unknown = JSON.parse(row.payload);
      const content =
        typeof payload === "object" && payload !== null ? stringProperty(payload, "content") : undefined;
      characters += content?.length ?? 0;
    }
    const userMessages = rows.filter((row) => row.kind === "user.message").length;
    return {
      messageCount: rows.length,
      estimatedTokens: Math.ceil(characters / 4),
      aicUsage: userMessages,
      firstMessageAt: rows[0]?.created_at ?? null,
    };
  }

  public touchChat(id: string): StoredChat | undefined {
    const lastUsedAt = new Date().toISOString();
    const result = this.#database
      .prepare("UPDATE chats SET last_used_at = ? WHERE id = ?")
      .run(lastUsedAt, id);
    return result.changes === 0 ? undefined : this.#getChat(id);
  }

  public append<K extends Exclude<OutpostEventKind, "assistant.delta">>(
    input: StoredEventInput<K>,
  ): OutpostEvent<K> {
    const createdAt = new Date().toISOString();
    const result = this.#database
      .prepare("INSERT INTO events (kind, created_at, payload) VALUES (?, ?, ?)")
      .run(input.kind, createdAt, JSON.stringify(input.payload));

    if (typeof result.lastInsertRowid !== "number") {
      throw new Error("SQLite did not return a numeric event identifier");
    }

    return {
      id: result.lastInsertRowid,
      kind: input.kind,
      createdAt,
      payload: input.payload,
    };
  }

  public list(options: { readonly after?: number; readonly limit?: number } = {}): OutpostEvent[] {
    const after = options.after ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2_000);
    const rows = this.#database
      .prepare(
        "SELECT id, kind, created_at, payload FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
      )
      .all(after, limit) as unknown as EventRow[];
    return rows.map(parseRow);
  }

  #getChat(id: string): StoredChat | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, project_id, name, repository, created_at, last_used_at
        FROM chats
        WHERE id = ?`,
      )
      .get(id) as ChatRow | undefined;
    return row ? this.#parseChat(row) : undefined;
  }

  #parseChat(row: ChatRow): StoredChat {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      repository: row.repository,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }

  public [Symbol.dispose](): void {
    this.#database.close();
  }
}
