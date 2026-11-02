import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import { copyFor } from "./i18n.js";
import "./control-ui.css";
const REFRESH_MS = 1000;
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isSnapshot(value) {
    return (isRecord(value) &&
        typeof value.now === "number" &&
        Array.isArray(value.targets) &&
        Array.isArray(value.running) &&
        Array.isArray(value.recent));
}
function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function formatDuration(ms) {
    if (ms < 0)
        ms = 0;
    if (ms < 10_000)
        return `${(ms / 1000).toFixed(1)} s`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60)
        return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")} min`;
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatClock(at, locale) {
    return new Date(at).toLocaleTimeString(locale || undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
export default defineControlUiPlugin({
    id: contract.pluginId,
    activate(host) {
        const feature = createFeatureClient(contract, host);
        const navigation = {
            id: "model-requests",
            label: copyFor(host.locale).title,
            page: { id: "model-requests" },
            icon: "activity",
        };
        const page = {
            id: "model-requests",
            label: navigation.label,
            mount(container, context) {
                const section = element("section", "model-requests-page");
                const heading = element("h1");
                const summary = element("p", "model-requests-muted");
                const runningHeading = element("h2");
                const runningList = element("ul", "model-requests-list");
                const recentHeading = element("h2");
                const recentList = element("ul", "model-requests-list");
                section.append(heading, summary, runningHeading, runningList, recentHeading, recentList);
                container.append(section);
                // The list is rebuilt every second; remember which stacks are expanded.
                const openStacks = new Set();
                let disposed = false;
                let request = 0;
                let last;
                const render = () => {
                    const copy = copyFor(host.locale);
                    heading.textContent = copy.title;
                    runningHeading.textContent = copy.running;
                    recentHeading.textContent = copy.recent;
                    if (!last)
                        return;
                    const { snapshot, clockOffset } = last;
                    const now = Date.now() + clockOffset;
                    const targets = snapshot.targets.length > 0 ? snapshot.targets.join(", ") : copy.allEndpoints;
                    summary.textContent = `${copy.capturing(targets)} · ${copy.summary(snapshot.running.length, snapshot.recent.length)}`;
                    runningList.replaceChildren(...(snapshot.running.length > 0
                        ? snapshot.running.map((entry) => renderEntry(entry, copy, now, false, openStacks, host.locale))
                        : [element("li", "model-requests-muted", copy.noneRunning)]));
                    recentList.replaceChildren(...(snapshot.recent.length > 0
                        ? snapshot.recent.map((entry) => renderEntry(entry, copy, now, true, openStacks, host.locale))
                        : [element("li", "model-requests-muted", copy.noneRecent)]));
                };
                const refresh = async () => {
                    const current = ++request;
                    if (!context.presented || !host.connection.connected)
                        return;
                    try {
                        const report = await feature.invoke("list", {});
                        if (disposed || current !== request || context.signal.aborted)
                            return;
                        if (!isSnapshot(report))
                            throw new Error("invalid response");
                        last = { snapshot: report, clockOffset: report.now - Date.now() };
                        render();
                    }
                    catch {
                        if (disposed || current !== request || context.signal.aborted)
                            return;
                        summary.textContent = copyFor(host.locale).unavailable;
                    }
                };
                const timer = window.setInterval(() => {
                    void refresh();
                }, REFRESH_MS);
                render();
                void refresh();
                return {
                    dispose() {
                        disposed = true;
                        window.clearInterval(timer);
                        section.remove();
                    },
                };
            },
        };
        let seenLocale = host.locale;
        const applyLocale = () => {
            if (host.locale === seenLocale)
                return;
            seenLocale = host.locale;
            navigation.label = copyFor(seenLocale).title;
            page.label = navigation.label;
            host.ui.invalidate();
        };
        host.ui.registerNavigation(navigation);
        host.ui.registerPage(page);
        const stop = host.subscribe(applyLocale);
        host.signal.addEventListener("abort", stop, { once: true });
    },
});
function renderEntry(entry, copy, now, compact, openStacks, locale) {
    const item = element("li", compact ? "model-requests-card model-requests-card--compact" : "model-requests-card");
    const head = element("div", "model-requests-row");
    const badge = element("span", "model-requests-badge", copy.states[entry.state] ?? entry.state);
    badge.dataset.state = entry.state;
    const end = entry.endedAt || now;
    head.append(badge, element("span", "model-requests-kind", copy.kinds[entry.kind] ?? entry.kind), element("span", "model-requests-elapsed", formatDuration(end - entry.startedAt)), element("span", "model-requests-muted", formatClock(entry.startedAt, locale)));
    if (entry.model)
        head.append(element("span", "model-requests-muted", entry.model));
    item.append(head);
    if (entry.sessionKey || entry.agentId) {
        const parts = [entry.sessionKey && `${copy.session} ${entry.sessionKey}`, entry.agentId && `agent ${entry.agentId}`, entry.runId && `run ${entry.runId}`];
        item.append(element("div", "model-requests-meta", parts.filter(Boolean).join(" · ")));
    }
    item.append(element("div", "model-requests-label", `${copy.prompt}${entry.promptRole ? ` · ${entry.promptRole}` : ""}`));
    item.append(element("pre", "model-requests-code", entry.promptTail ? `…${entry.promptTail}` : copy.noPrompt));
    if (entry.outputTail && !compact) {
        item.append(element("div", "model-requests-label", `${copy.output}${entry.outputPhase ? ` · ${entry.outputPhase}` : ""} · ${entry.outputChars} chars`));
        item.append(element("pre", "model-requests-code", `…${entry.outputTail}`));
    }
    const meta = [
        `${entry.method} ${entry.url}`,
        entry.status ? `HTTP ${entry.status}` : "",
        entry.messageCount ? copy.messages(entry.messageCount) : "",
        entry.bodyBytes ? formatBytes(entry.bodyBytes) : "",
        entry.maxTokens ? `max_tokens ${entry.maxTokens}` : "",
        entry.stream ? "stream" : "",
        entry.firstByteAt ? `${copy.firstByte} ${formatDuration(entry.firstByteAt - entry.startedAt)}` : "",
        entry.promptTokens || entry.completionTokens ? `${copy.tokens} ${entry.promptTokens} → ${entry.completionTokens}` : "",
        compact && entry.outputChars ? `${copy.output} ${entry.outputChars} chars` : "",
    ];
    item.append(element("div", "model-requests-meta", meta.filter(Boolean).join(" · ")));
    if (entry.error)
        item.append(element("div", "model-requests-error", entry.error));
    if (entry.stack.length > 0) {
        const details = element("details");
        details.open = openStacks.has(entry.id);
        details.addEventListener("toggle", () => {
            if (details.open)
                openStacks.add(entry.id);
            else
                openStacks.delete(entry.id);
        });
        const list = element("ol");
        for (const frame of entry.stack)
            list.append(element("li", undefined, frame));
        details.append(element("summary", undefined, copy.origin), list);
        item.append(details);
    }
    return item;
}
