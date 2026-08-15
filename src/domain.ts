export type AgentState = "starting" | "idle" | "running" | "cancelling" | "failed";

export type OutpostEventKind =
  | "user.message"
  | "assistant.message"
  | "assistant.delta"
  | "session.state"
  | "session.error"
  | "system.notice";

export interface OutpostEventPayloads {
  readonly "user.message": {
    readonly content: string;
  };
  readonly "assistant.message": {
    readonly content: string;
  };
  readonly "assistant.delta": {
    readonly content: string;
  };
  readonly "session.state": {
    readonly state: AgentState;
  };
  readonly "session.error": {
    readonly message: string;
  };
  readonly "system.notice": {
    readonly message: string;
  };
}

export interface OutpostEvent<K extends OutpostEventKind = OutpostEventKind> {
  readonly id: number;
  readonly kind: K;
  readonly createdAt: string;
  readonly payload: OutpostEventPayloads[K];
}

export interface StoredEventInput<K extends Exclude<OutpostEventKind, "assistant.delta">> {
  readonly kind: K;
  readonly payload: OutpostEventPayloads[K];
}

export interface ResourceSnapshot {
  readonly capturedAt: string;
  readonly uptimeSeconds: number;
  readonly loadAverage: readonly [number, number, number];
  readonly cpu: {
    readonly logicalProcessors: number;
    readonly usagePercent: number;
  };
  readonly memory: {
    readonly totalBytes: number;
    readonly usedBytes: number;
    readonly usagePercent: number;
  };
  readonly disk: {
    readonly totalBytes: number;
    readonly usedBytes: number;
    readonly usagePercent: number;
  };
}

export interface SessionSnapshot {
  readonly state: AgentState;
  readonly events: readonly OutpostEvent[];
}
