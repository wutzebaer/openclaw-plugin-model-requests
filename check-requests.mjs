import assert from "node:assert/strict";
import http from "node:http";
import { startInterceptor } from "./dist/interceptor.js";

const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", async () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url.includes("slow")) {
      response.write('data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n');
      return;
    }
    for (const text of ["Hello ", "world", "!"]) {
      response.write(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    response.end('data: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
  });
}).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const base = `${origin}/v1`;

const interceptor = startInterceptor({ targets: [base], historySize: 30, captureStack: true });
const spanId = "00f067aa0ba902b7";
interceptor.noteModelCall({ spanId, sessionKey: "agent:main:test", agentId: "main", runId: "run-1" });

// Agent turn: linked to its session through the traceparent span id.
const longPrompt = `${"x".repeat(500)} END of the last prompt: please summarize.`;
await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { traceparent: `00-4bf92f3577b34da6a3ce929d0e0e4736-${spanId}-01` },
  body: JSON.stringify({
    model: "qwen",
    stream: true,
    max_tokens: 16384,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: longPrompt }] },
    ],
  }),
}).then((response) => response.text());

// Compaction: recognised from the prompt, still streaming, then aborted.
interceptor.noteCompaction("agent:main:compacting", true);
const controller = new AbortController();
const aborted = fetch(`${base}/chat/completions?slow`, {
  method: "POST",
  body: JSON.stringify({ messages: [{ role: "user", content: "Summarize the conversation" }] }),
  signal: controller.signal,
})
  .then((response) => response.text())
  .catch((error) => error.name);
await new Promise((resolve) => setTimeout(resolve, 200));
const [live] = interceptor.snapshot().running;
assert.equal(live.state, "streaming");
assert.equal(live.kind, "compaction");
assert.equal(live.outputPhase, "reasoning");
assert.equal(live.outputTail, "thinking...");
controller.abort();
assert.equal(await aborted, "AbortError");

// Requests outside the configured provider URLs are ignored.
await fetch(`${origin}/other`).then((response) => response.text());
await new Promise((resolve) => setTimeout(resolve, 50));

const snapshot = interceptor.snapshot();
assert.equal(snapshot.running.length, 0);
assert.equal(snapshot.recent.length, 2);

const [compaction, turn] = snapshot.recent;
assert.equal(compaction.state, "aborted");
assert.equal(compaction.sessionKey, "agent:main:compacting");
assert.equal(compaction.promptTail, "Summarize the conversation");

assert.equal(turn.state, "done");
assert.equal(turn.kind, "agent");
assert.equal(turn.sessionKey, "agent:main:test");
assert.equal(turn.runId, "run-1");
assert.equal(turn.model, "qwen");
assert.equal(turn.maxTokens, 16384);
assert.equal(turn.messageCount, 2);
assert.equal(turn.promptTail.length, 160);
assert.ok(turn.promptTail.endsWith("END of the last prompt: please summarize."));
assert.equal(turn.outputTail, "Hello world!");
assert.equal(turn.promptTokens, 1234);
assert.equal(turn.completionTokens, 3);
assert.ok(turn.stack.length > 0);

interceptor.dispose();
server.close();
console.log("model request checks passed");
