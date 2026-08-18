export type AgentState = "starting" | "idle" | "running" | "cancelling" | "failed";

export type OutpostEventKind =
  | "user.message"
  | "assistant.message"
  | "assistant.delta"
  | "assistant.artifact"
  | "session.state"
  | "session.error"
  | "deployment.candidate"
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
  readonly "assistant.artifact": {
    readonly caption: string;
    readonly url: string;
    readonly absoluteUrl?: string;
    readonly kind: "screenshot";
  };
  readonly "session.state": {
    readonly state: AgentState;
  };
  readonly "session.error": {
    readonly message: string;
  };
  readonly "deployment.candidate": {
    readonly candidateId: string;
    readonly projectId?: string;
    readonly projectName?: string;
    readonly targetId?: string;
    readonly integrationBranch?: string;
    readonly chatId?: string;
    readonly commitSha: string;
    readonly description: string;
    readonly files: readonly {
      readonly path: string;
      readonly added: number;
      readonly removed: number;
    }[];
    readonly diffUrl: string;
    readonly status: "pending" | "approved" | "rejected";
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
