import diagnostics from "node:diagnostics_channel";
// OpenClaw sends provider requests through undici with its own dispatcher, so
// patching globalThis.fetch misses them. undici publishes every request on
// these diagnostics channels regardless of dispatcher or which undici copy
// made it, which is what lets this plugin see agent turns, compaction, memory
// flush and anything else alike.
const CHANNELS = {
    create: "undici:request:create",
    bodyChunkSent: "undici:request:bodyChunkSent",
    bodySent: "undici:request:bodySent",
    headers: "undici:request:headers",
    bodyChunkReceived: "undici:request:bodyChunkReceived",
    trailers: "undici:request:trailers",
    error: "undici:request:error",
};
const TAIL_CHARS = 160;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RUNNING = 50;
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
const MODEL_CALL_TTL_MS = 30 * 60 * 1000;
const STACK_FRAMES = 14;
const GLOBAL_KEY = Symbol.for("openclaw.model-requests.interceptor");
// Frames from the HTTP/SDK layer say nothing about why a request was made.
const TRANSPORT_FRAME = /runtime-fetch|fetch-guard|effect-authority|provider-transport-fetch|openai-completions-transport|[\\/]client\.mjs|fetchWith|doneDetectingFetch|makeRequest/;
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function str(value) {
    return typeof value === "string" ? value : "";
}
function clip(value, max) {
    return value.length > max ? value.slice(0, max) : value;
}
function tail(value, max = TAIL_CHARS) {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(-max) : flat;
}
function normalizeTarget(target) {
    try {
        const url = new URL(target);
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }
    catch {
        return target.replace(/\/+$/, "");
    }
}
function headerValue(headers, name) {
    const wanted = name.toLowerCase();
    if (typeof headers === "string") {
        for (const line of headers.split("\r\n")) {
            const index = line.indexOf(":");
            if (index > 0 && line.slice(0, index).trim().toLowerCase() === wanted)
                return line.slice(index + 1).trim();
        }
        return "";
    }
    if (!Array.isArray(headers))
        return "";
    // undici uses a flat [name, value, name, value] list; older callers pass pairs.
    if (headers.length > 0 && Array.isArray(headers[0])) {
        for (const pair of headers) {
            if (Array.isArray(pair) && String(pair[0]).toLowerCase() === wanted)
                return String(pair[1]);
        }
        return "";
    }
    for (let index = 0; index + 1 < headers.length; index += 2) {
        if (String(headers[index]).toLowerCase() === wanted)
            return String(headers[index + 1]);
    }
    return "";
}
function spanIdFromTraceparent(traceparent) {
    const parts = traceparent.split("-");
    return parts.length >= 4 ? parts[2].toLowerCase() : "";
}
function toBytes(chunk) {
    if (chunk instanceof Uint8Array)
        return chunk;
    if (typeof chunk === "string")
        return new TextEncoder().encode(chunk);
    if (chunk instanceof ArrayBuffer)
        return new Uint8Array(chunk);
    return undefined;
}
function concat(chunks) {
    let size = 0;
    for (const chunk of chunks)
        size += chunk.byteLength;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
function contentText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (!isRecord(part))
                return "";
            if (typeof part.text === "string")
                return part.text;
            if (typeof part.content === "string")
                return part.content;
            if (Array.isArray(part.content))
                return contentText(part.content);
            const type = str(part.type);
            if (type.includes("image"))
                return "[image]";
            if (type.includes("audio"))
                return "[audio]";
            return "";
        })
            .filter(Boolean)
            .join(" ");
    }
    if (isRecord(content) && typeof content.text === "string")
        return content.text;
    return "";
}
function toolCallNames(message) {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const names = calls
        .map((call) => (isRecord(call) && isRecord(call.function) ? str(call.function.name) : ""))
        .filter(Boolean);
    return names.length > 0 ? `[tool_calls: ${names.join(", ")}]` : "";
}
function describePrompt(body) {
    const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : undefined;
    if (list) {
        const last = list[list.length - 1];
        if (!isRecord(last))
            return { role: "", text: "", count: list.length };
        const role = str(last.role) || str(last.type);
        const text = contentText(last.content) ||
            contentText(last.output) ||
            str(last.arguments) ||
            toolCallNames(last) ||
            "";
        return { role, text, count: list.length };
    }
    if (typeof body.prompt === "string")
        return { role: "prompt", text: body.prompt, count: 1 };
    if (typeof body.input === "string")
        return { role: "input", text: body.input, count: 1 };
    return { role: "", text: "", count: 0 };
}
// OpenClaw's compaction summarizer ends its instructions with this sentence
// (DEFAULT_COMPACTION_INSTRUCTIONS); it does not run through the agent runner,
// so there is no model_call hook to attribute it.
function classifyPrompt(text) {
    if (/required summary structure and section headers|summarize the conversation/i.test(text))
        return "compaction";
    return undefined;
}
function classifyStack(frames) {
    const joined = frames.join("\n").toLowerCase();
    if (/compact/.test(joined))
        return "compaction";
    if (/memory-?flush|memoryflush/.test(joined))
        return "memory-flush";
    if (/heartbeat/.test(joined))
        return "heartbeat";
    if (/subagent/.test(joined))
        return "subagent";
    if (/embedding/.test(joined))
        return "embedding";
    if (/title/.test(joined))
        return "title";
    return undefined;
}
function captureFrames(selfFile) {
    const holder = Error;
    const previous = holder.stackTraceLimit;
    holder.stackTraceLimit = 80;
    const stack = new Error().stack ?? "";
    holder.stackTraceLimit = previous;
    const frames = [];
    for (const raw of stack.split("\n").slice(1)) {
        const line = raw.trim();
        if (!line.startsWith("at "))
            continue;
        if (/node:|undici|diagnostics_channel|new Promise|<anonymous>/.test(line) || TRANSPORT_FRAME.test(line))
            continue;
        if (selfFile && line.includes(selfFile))
            continue;
        const match = /^at (?:async )?(?:(.*?) \()?(.*?):(\d+):\d+\)?$/.exec(line);
        if (!match)
            continue;
        const fn = match[1] || "<module>";
        const file = match[2].split(/[\\/]/).pop() ?? match[2];
        const label = `${line.startsWith("at async") ? "async " : ""}${fn} (${file}:${match[3]})`;
        if (frames[frames.length - 1] !== label)
            frames.push(clip(label, 240));
        if (frames.length >= STACK_FRAMES)
            break;
    }
    return frames;
}
function errorText(error) {
    if (error instanceof Error)
        return clip(`${error.name}: ${error.message}`, 300);
    return clip(String(error), 300);
}
function isAbort(error) {
    if (!isRecord(error))
        return false;
    const name = str(error.name);
    const code = str(error.code);
    return name === "AbortError" || name === "RequestAbortedError" || code === "UND_ERR_ABORTED" || code === "ABORT_ERR";
}
export function startInterceptor(initial) {
    const store = globalThis;
    // A plugin reload runs setup again in the same process; drop the old
    // subscriptions so every request is not counted twice.
    store[GLOBAL_KEY]?.dispose();
    const options = { ...initial, targets: initial.targets.map(normalizeTarget).filter(Boolean) };
    const selfFile = (() => {
        try {
            return new URL(import.meta.url).pathname.split("/").slice(-3).join("/");
        }
        catch {
            return "";
        }
    })();
    const byRequest = new WeakMap();
    const running = new Map();
    const recent = [];
    const modelCalls = new Map();
    const compactions = new Map();
    let sequence = 0;
    const matches = (url) => {
        if (options.targets.length === 0)
            return /\/(chat\/completions|completions|responses|messages|embeddings)(\?|$)/.test(url);
        return options.targets.some((target) => url === target || url.startsWith(`${target}/`) || url.startsWith(`${target}?`));
    };
    const prune = (now) => {
        for (const [id, item] of running) {
            if (now - item.startedAt > MAX_AGE_MS)
                running.delete(id);
        }
        for (const [spanId, call] of modelCalls) {
            if (now - call.at > MODEL_CALL_TTL_MS)
                modelCalls.delete(spanId);
        }
        for (const [sessionKey, at] of compactions) {
            if (now - at > MODEL_CALL_TTL_MS)
                compactions.delete(sessionKey);
        }
    };
    const parseBody = (item) => {
        if (item.bodyParsed)
            return;
        item.bodyParsed = true;
        let bytes;
        if (item.bodyChunks.length > 0)
            bytes = concat(item.bodyChunks);
        else
            bytes = toBytes(item.initialBody);
        item.bodyChunks = [];
        item.initialBody = undefined;
        if (!bytes || bytes.byteLength === 0)
            return;
        if (item.bodyBytes === 0)
            item.bodyBytes = bytes.byteLength;
        if (bytes.byteLength >= MAX_BODY_BYTES) {
            item.promptTail = "(body too large to inspect)";
            return;
        }
        let body;
        try {
            body = JSON.parse(new TextDecoder().decode(bytes));
        }
        catch {
            item.promptTail = tail(new TextDecoder().decode(bytes.slice(-4096)));
            return;
        }
        if (!isRecord(body))
            return;
        item.model = clip(str(body.model), 200);
        item.stream = body.stream === true;
        const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
        item.maxTokens = typeof maxTokens === "number" ? maxTokens : 0;
        const prompt = describePrompt(body);
        item.messageCount = prompt.count;
        item.promptRole = clip(prompt.role, 40);
        item.promptTail = tail(prompt.text);
        item.promptKind = classifyPrompt(prompt.text.slice(-2000));
    };
    const appendOutput = (item, phase, text) => {
        if (!text)
            return;
        item.outputPhase = phase;
        item.outputChars += text.length;
        item.outputTail = (item.outputTail + text).slice(-TAIL_CHARS * 2);
    };
    const readUsage = (item, usage) => {
        if (!isRecord(usage))
            return;
        const prompt = usage.prompt_tokens ?? usage.input_tokens;
        const completion = usage.completion_tokens ?? usage.output_tokens;
        if (typeof prompt === "number")
            item.promptTokens = prompt;
        if (typeof completion === "number")
            item.completionTokens = completion;
    };
    const readEvent = (item, event) => {
        readUsage(item, event.usage);
        if (isRecord(event.response))
            readUsage(item, event.response.usage);
        if (Array.isArray(event.choices)) {
            for (const choice of event.choices) {
                if (!isRecord(choice))
                    continue;
                const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : undefined;
                if (delta) {
                    appendOutput(item, "reasoning", str(delta.reasoning_content) || str(delta.reasoning));
                    appendOutput(item, "text", contentText(delta.content));
                    if (Array.isArray(delta.tool_calls)) {
                        for (const call of delta.tool_calls) {
                            if (!isRecord(call) || !isRecord(call.function))
                                continue;
                            const name = str(call.function.name);
                            appendOutput(item, "tool", `${name ? `⟨${name}⟩ ` : ""}${str(call.function.arguments)}`);
                        }
                    }
                }
                if (typeof choice.text === "string")
                    appendOutput(item, "text", choice.text);
            }
            return;
        }
        // OpenAI Responses and Anthropic Messages stream shapes.
        const type = str(event.type);
        if (type.endsWith(".delta") && typeof event.delta === "string") {
            appendOutput(item, type.includes("reasoning") ? "reasoning" : type.includes("arguments") ? "tool" : "text", event.delta);
        }
        else if (isRecord(event.delta)) {
            appendOutput(item, "text", str(event.delta.text));
            appendOutput(item, "reasoning", str(event.delta.thinking));
            appendOutput(item, "tool", str(event.delta.partial_json));
        }
        if (isRecord(event.message))
            readUsage(item, event.message.usage);
    };
    const readSseText = (item, text) => {
        const lines = (item.sseLine + text).split("\n");
        item.sseLine = lines.pop() ?? "";
        for (const raw of lines) {
            const line = raw.trimEnd();
            if (!line.startsWith("data:"))
                continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]")
                continue;
            try {
                const event = JSON.parse(data);
                if (isRecord(event))
                    readEvent(item, event);
            }
            catch {
                // Partial or non-JSON data line; ignore.
            }
        }
    };
    const finish = (item, state) => {
        if (item.endedAt)
            return;
        if (!item.sse && item.jsonChunks.length > 0) {
            try {
                const event = JSON.parse(new TextDecoder().decode(concat(item.jsonChunks)));
                if (isRecord(event))
                    readEvent(item, event);
            }
            catch {
                // Not JSON; leave output empty.
            }
        }
        item.jsonChunks = [];
        if (item.sse && item.sseLine)
            readSseText(item, "\n");
        parseBody(item);
        item.state = state;
        item.endedAt = Date.now();
        running.delete(item.id);
        if (options.historySize > 0) {
            recent.unshift(item);
            if (recent.length > options.historySize)
                recent.length = options.historySize;
        }
    };
    const onCreate = (message) => {
        if (!isRecord(message) || !isRecord(message.request))
            return;
        const request = message.request;
        const url = `${str(request.origin).replace(/\/+$/, "")}${str(request.path)}`;
        if (!matches(url))
            return;
        const now = Date.now();
        prune(now);
        const stack = options.captureStack ? captureFrames(selfFile) : [];
        const activeCompaction = [...compactions.keys()];
        const item = {
            id: `${now.toString(36)}-${(sequence += 1).toString(36)}`,
            state: "sending",
            method: clip(str(request.method) || "GET", 16),
            url: clip(url, 500),
            traceSpanId: spanIdFromTraceparent(headerValue(request.headers, "traceparent")),
            stackKind: classifyStack(stack),
            stack,
            bodyChunks: [],
            bodyBytes: 0,
            bodyParsed: false,
            initialBody: request.body,
            model: "",
            stream: false,
            maxTokens: 0,
            messageCount: 0,
            promptRole: "",
            promptTail: "",
            promptKind: undefined,
            compactionSessionKey: activeCompaction.length === 1 ? activeCompaction[0] : "",
            decoder: undefined,
            sseLine: "",
            sse: false,
            jsonChunks: [],
            jsonBytes: 0,
            outputPhase: "",
            outputTail: "",
            outputChars: 0,
            promptTokens: 0,
            completionTokens: 0,
            status: 0,
            error: "",
            startedAt: now,
            firstByteAt: 0,
            endedAt: 0,
        };
        byRequest.set(request, item);
        running.set(item.id, item);
        if (running.size > MAX_RUNNING) {
            const oldest = running.keys().next().value;
            if (oldest !== undefined)
                running.delete(oldest);
        }
    };
    const tracked = (message) => isRecord(message) && isRecord(message.request) ? byRequest.get(message.request) : undefined;
    const onBodyChunkSent = (message) => {
        const item = tracked(message);
        if (!item || item.bodyParsed || !isRecord(message))
            return;
        const bytes = toBytes(message.chunk);
        if (!bytes)
            return;
        item.bodyBytes += bytes.byteLength;
        if (item.bodyBytes <= MAX_BODY_BYTES)
            item.bodyChunks.push(bytes);
    };
    const onBodySent = (message) => {
        const item = tracked(message);
        if (!item)
            return;
        parseBody(item);
        if (item.state === "sending")
            item.state = "waiting";
    };
    const onHeaders = (message) => {
        const item = tracked(message);
        if (!item || !isRecord(message) || !isRecord(message.response))
            return;
        parseBody(item);
        item.status = typeof message.response.statusCode === "number" ? message.response.statusCode : 0;
        item.firstByteAt = Date.now();
        item.state = "streaming";
        item.sse = /text\/event-stream/i.test(headerValue(message.response.headers, "content-type"));
        item.decoder = new TextDecoder();
    };
    const onBodyChunkReceived = (message) => {
        const item = tracked(message);
        if (!item || !isRecord(message))
            return;
        const bytes = toBytes(message.chunk);
        if (!bytes)
            return;
        if (item.sse) {
            readSseText(item, (item.decoder ?? new TextDecoder()).decode(bytes, { stream: true }));
        }
        else if (item.jsonBytes + bytes.byteLength <= MAX_JSON_RESPONSE_BYTES) {
            item.jsonBytes += bytes.byteLength;
            item.jsonChunks.push(bytes);
        }
    };
    const onTrailers = (message) => {
        const item = tracked(message);
        if (!item)
            return;
        finish(item, item.status >= 400 ? "error" : "done");
    };
    const onError = (message) => {
        const item = tracked(message);
        if (!item || !isRecord(message))
            return;
        item.error = errorText(message.error);
        finish(item, isAbort(message.error) ? "aborted" : "error");
    };
    const listeners = [
        [CHANNELS.create, onCreate],
        [CHANNELS.bodyChunkSent, onBodyChunkSent],
        [CHANNELS.bodySent, onBodySent],
        [CHANNELS.headers, onHeaders],
        [CHANNELS.bodyChunkReceived, onBodyChunkReceived],
        [CHANNELS.trailers, onTrailers],
        [CHANNELS.error, onError],
    ];
    // A throwing subscriber would surface inside undici; never let one escape.
    const safe = listeners.map(([name, listener]) => {
        const wrapped = (message) => {
            try {
                listener(message);
            }
            catch {
                // Observation only.
            }
        };
        return [name, wrapped];
    });
    for (const [name, listener] of safe)
        diagnostics.subscribe(name, listener);
    const toEntry = (item) => {
        if (item.state !== "sending")
            parseBody(item);
        const call = item.traceSpanId ? modelCalls.get(item.traceSpanId) : undefined;
        const kind = item.stackKind ?? item.promptKind ?? (call ? "agent" : item.compactionSessionKey ? "compaction" : "other");
        return {
            id: item.id,
            state: item.state,
            kind,
            method: item.method,
            url: item.url,
            model: item.model,
            stream: item.stream,
            maxTokens: item.maxTokens,
            messageCount: item.messageCount,
            bodyBytes: item.bodyBytes,
            promptRole: item.promptRole,
            promptTail: clip(item.promptTail, 400),
            outputPhase: clip(item.outputPhase, 40),
            outputTail: tail(item.outputTail),
            outputChars: item.outputChars,
            promptTokens: item.promptTokens,
            completionTokens: item.completionTokens,
            status: item.status,
            error: item.error,
            sessionKey: clip(call?.sessionKey || item.compactionSessionKey, 300),
            agentId: clip(call?.agentId ?? "", 120),
            runId: clip(call?.runId ?? "", 160),
            stack: item.stack,
            startedAt: item.startedAt,
            firstByteAt: item.firstByteAt,
            endedAt: item.endedAt,
        };
    };
    const interceptor = {
        snapshot() {
            const now = Date.now();
            prune(now);
            return {
                now,
                targets: options.targets.slice(0, 20).map((target) => clip(target, 400)),
                running: [...running.values()].map(toEntry),
                recent: recent.map(toEntry),
            };
        },
        noteModelCall(note) {
            if (!note.spanId)
                return;
            modelCalls.set(note.spanId.toLowerCase(), { ...note, at: Date.now() });
        },
        noteCompaction(sessionKey, active) {
            const key = sessionKey || "(unknown session)";
            if (active)
                compactions.set(key, Date.now());
            else
                compactions.delete(key);
        },
        dispose() {
            for (const [name, listener] of safe)
                diagnostics.unsubscribe(name, listener);
            running.clear();
            recent.length = 0;
            if (store[GLOBAL_KEY] === interceptor)
                store[GLOBAL_KEY] = undefined;
        },
    };
    store[GLOBAL_KEY] = interceptor;
    return interceptor;
}
