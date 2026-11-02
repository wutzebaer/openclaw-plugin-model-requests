# Model Requests

An OpenClaw plugin that adds a **Model requests** page to the Control UI sidebar. It lists every HTTP request OpenClaw is sending to a model provider right now, plus the 30 most recently finished ones. That covers agent turns, compaction, memory flush, subagents, and anything else that talks to the model.

It answers "why is my local model busy?" when the activity view shows nothing.

For each request the page shows:

- **State and elapsed time:** `sending`, `waiting for model` (prefill or the server's own queue), `streaming`, `done`, `error`, or `aborted`.
- **Kind:** agent turn, compaction, memory flush, subagent, and so on.
- **Session, agent, and run,** when the request comes from the agent runner.
- **The last 160 characters of the prompt,** meaning the final message in the request.
- **The tail of the streamed output** (reasoning, text, or tool call), plus token usage once the server reports it.
- **Request details:** body size, message count, `max_tokens`, and time to first byte.
- **Origin:** the OpenClaw call stack that issued the request.

The page is localized in English and German.

## How it works

OpenClaw sends provider requests through `undici` with its own dispatcher, not through `globalThis.fetch`, so patching `fetch` misses them. This plugin subscribes to undici's `node:diagnostics_channel` channels (`undici:request:*`) instead. undici publishes every request in the Gateway process on those channels, no matter which code started it. The plugin only reads request bodies and response chunks as they pass. It never modifies a request.

The plugin captures URLs under the `baseUrl` of each entry in `models.providers`, for example `http://127.0.0.1:8000/v1` for a local vLLM. Requests to other hosts, such as channels or web search, are ignored.

Requests are attributed as follows:

- **Agent turns:** the request's `traceparent` header carries the same span id as `ctx.trace` in the `model_call_started` hook.
- **Compaction:** the prompt ends with OpenClaw's fixed compaction instructions. If exactly one compaction is running (between `before_compaction` and `after_compaction`), its session is shown.
- **Everything else:** keywords in the call stack.

History is kept in memory only and is cleared when the Gateway restarts or the plugin reloads. The plugin has no settings.

## Privacy

The page shows prompt and output excerpts to anyone with `operator.read` access to the Gateway. Nothing is written to disk or sent anywhere.

## Requirements

- OpenClaw `>= 2026.10.5`
- `gateway.controlUi.experimental.customPlugins: true`

## Build and install

```sh
npm install
npm run build
npm run validate
npm run check
openclaw plugins install --link .
```

Reload the browser tab afterwards.

After backend changes, rebuild and run `openclaw plugins reload model-requests --wait`. After UI-only changes, `openclaw gateway call plugins.controlUi.reload --json --params '{"pluginId":"model-requests"}'` is enough.

If the page stays on loading placeholders after a Gateway restart, the tab has lost its Gateway connection. Restart the browser or hard-reload the tab.

## License

MIT
