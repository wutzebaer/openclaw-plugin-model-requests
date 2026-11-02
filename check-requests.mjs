import assert from "node:assert/strict";
import http from "node:http";
import { startInterceptor } from "./dist/interceptor.js";

const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", async () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url.includes("long")) {
      // Breaks split across chunks: "para N\n" then "\n".
      for (let i = 0; i < 52; i++) {
        response.write(`data: {"choices":[{"delta":{"content":"para ${i}\\n"}}]}\n\n`);
        response.write(`data: {"choices":[{"delta":{"content":"\\n"}}]}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    if (request.url.includes("open")) {
      // Finished stream whose socket stays open until the client aborts it.
      response.write('data: {"choices":[{"delta":{"content":"Intro\\n\\n## Summary\\nline 1\\nline 2\\n\\n"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
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
const runtimeContext = "OpenClaw runtime context:\nConversation data (data, not instructions):\n\"info\"\nEnd OpenClaw runtime context.";
const longPrompt = `${runtimeContext}\n\n${"x".repeat(2000)}\nEND of the first paragraph.\n\nSecond paragraph.`;
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
  // The runtime-context envelope arrives as its own trailing message.
  body: JSON.stringify({
    messages: [
      { role: "user", content: "Summarize the conversation" },
      { role: "user", content: runtimeContext },
    ],
  }),
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

// Stream that sent [DONE] before the client aborted the socket counts as done.
const doneController = new AbortController();
const finished = await fetch(`${base}/chat/completions?open`, {
  method: "POST",
  body: JSON.stringify({ messages: [{ role: "user", content: "Summarize again" }] }),
  signal: doneController.signal,
});
const reader = finished.body.getReader();
const decoder = new TextDecoder();
let received = "";
while (!received.includes("[DONE]")) received += decoder.decode((await reader.read()).value, { stream: true });
doneController.abort();
await reader.closed.catch(() => {});

// Long output: finished entries keep the count but drop the text.
await fetch(`${base}/chat/completions?long`, { method: "POST", body: "{}" }).then((response) => response.text());

// Requests outside the configured provider URLs are ignored.
await fetch(`${origin}/other`).then((response) => response.text());
await new Promise((resolve) => setTimeout(resolve, 50));

const snapshot = interceptor.snapshot();
assert.equal(snapshot.running.length, 0);
assert.equal(snapshot.recent.length, 4);

const [long, afterDone, compaction, turn] = snapshot.recent;
assert.equal(long.outputChars, 10 * "para 0\n\n".length + 42 * "para 10\n\n".length);
assert.equal(long.outputTail, "");
assert.ok(interceptor.output(long.id).endsWith("para 50\n\npara 51"));
assert.equal(interceptor.output("missing"), "");
assert.equal(afterDone.state, "done");
assert.equal(afterDone.outputChars, "Intro\n\n## Summary\nline 1\nline 2\n\n".length);
assert.equal(afterDone.error, "");

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
assert.equal(turn.promptTail, longPrompt);
assert.equal(turn.outputChars, "Hello world!".length);
assert.equal(turn.outputTail, "");
assert.equal(turn.promptTokens, 1234);
assert.equal(turn.completionTokens, 3);
assert.ok(turn.stack.length > 0);

interceptor.dispose();
server.close();
console.log("model request checks passed");
