import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

const text = (maxLength: number) => Type.String({ maxLength });
const number = Type.Number();

const entry = Type.Object(
  {
    id: text(64),
    state: Type.Union([
      Type.Literal("sending"),
      Type.Literal("waiting"),
      Type.Literal("streaming"),
      Type.Literal("done"),
      Type.Literal("error"),
      Type.Literal("aborted"),
    ]),
    kind: Type.Union([
      Type.Literal("agent"),
      Type.Literal("compaction"),
      Type.Literal("memory-flush"),
      Type.Literal("title"),
      Type.Literal("heartbeat"),
      Type.Literal("subagent"),
      Type.Literal("embedding"),
      Type.Literal("other"),
    ]),
    method: text(16),
    url: text(500),
    model: text(200),
    stream: Type.Boolean(),
    maxTokens: number,
    messageCount: number,
    bodyBytes: number,
    promptRole: text(40),
    promptTail: text(400),
    outputPhase: text(40),
    outputTail: text(400),
    outputChars: number,
    promptTokens: number,
    completionTokens: number,
    status: number,
    error: text(300),
    sessionKey: text(300),
    agentId: text(120),
    runId: text(160),
    stack: Type.Array(text(240), { maxItems: 16 }),
    startedAt: number,
    firstByteAt: number,
    endedAt: number,
  },
  { additionalProperties: false },
);

export const contract = defineFeatureContract({
  pluginId: "model-requests",
  operations: {
    list: {
      kind: "query",
      description: "List model provider HTTP requests that are in flight, plus the most recently finished ones.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object(
        {
          now: number,
          targets: Type.Array(text(400), { maxItems: 20 }),
          running: Type.Array(entry, { maxItems: 50 }),
          recent: Type.Array(entry, { maxItems: 100 }),
        },
        { additionalProperties: false },
      ),
    },
  },
  events: {},
});
