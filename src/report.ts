export type RequestState = "sending" | "waiting" | "streaming" | "done" | "error" | "aborted";

export type RequestKind = "agent" | "compaction" | "memory-flush" | "title" | "heartbeat" | "subagent" | "embedding" | "other";

export type RequestEntry = {
  id: string;
  state: RequestState;
  kind: RequestKind;
  method: string;
  url: string;
  model: string;
  stream: boolean;
  maxTokens: number;
  messageCount: number;
  bodyBytes: number;
  promptRole: string;
  promptTail: string;
  outputPhase: string;
  outputTail: string;
  outputChars: number;
  promptTokens: number;
  completionTokens: number;
  status: number;
  error: string;
  sessionKey: string;
  agentId: string;
  runId: string;
  stack: string[];
  startedAt: number;
  firstByteAt: number;
  endedAt: number;
};

export type RequestSnapshot = {
  now: number;
  targets: string[];
  running: RequestEntry[];
  recent: RequestEntry[];
};
