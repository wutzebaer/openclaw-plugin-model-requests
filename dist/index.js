import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";
import { startInterceptor } from "./interceptor.js";
function record(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
function providerBaseUrls(config) {
    const providers = record(record(record(config)?.models)?.providers);
    if (!providers)
        return [];
    return Object.values(providers)
        .map((provider) => text(record(provider)?.baseUrl))
        .filter((url) => /^https?:\/\//.test(url));
}
function sessionKeyOf(event, context) {
    const payload = record(event);
    const ctx = record(context);
    return text(payload?.sessionKey) || text(ctx?.sessionKey) || text(payload?.sessionId) || text(ctx?.sessionId);
}
export default defineFeaturePlugin({
    contract,
    name: "Model Requests",
    description: "Lists every HTTP request OpenClaw sends to a model provider, including compaction and memory flush.",
    setup(rawApi) {
        const api = rawApi;
        // defineFeaturePlugin publishes an empty config schema, so there are no
        // plugin settings: capture every configured provider baseUrl.
        const interceptor = startInterceptor({
            targets: providerBaseUrls(api.config),
            historySize: 30,
            captureStack: true,
        });
        // Agent-runner requests carry a traceparent whose span id matches
        // ctx.trace.spanId here; that links an HTTP request to its session.
        api.on("model_call_started", (event, context) => {
            const payload = record(event);
            const ctx = record(context);
            const trace = record(ctx?.trace);
            interceptor.noteModelCall({
                spanId: text(trace?.spanId),
                sessionKey: sessionKeyOf(event, context),
                agentId: text(ctx?.agentId),
                runId: text(payload?.runId) || text(ctx?.runId),
            });
        });
        api.on("before_compaction", (event, context) => {
            interceptor.noteCompaction(sessionKeyOf(event, context), true);
        });
        api.on("after_compaction", (event, context) => {
            interceptor.noteCompaction(sessionKeyOf(event, context), false);
        });
        return {
            list: () => interceptor.snapshot(),
            busy: () => ({ running: interceptor.runningCount() }),
            output: ({ id }) => ({ id, text: interceptor.output(id) }),
        };
    },
});
