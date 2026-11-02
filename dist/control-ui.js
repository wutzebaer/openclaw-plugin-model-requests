import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import { copyFor } from "./i18n.js";
import "./control-ui.css";
const REFRESH_MS = 1000;
const BUSY_REFRESH_MS = 2000;
const BUSY_ATTRIBUTE = "data-model-requests-busy";
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
function keyed(node, key) {
    node.dataset.key = key;
    return node;
}
// Bring `from` in line with `to`, touching only what differs. Our cards hold
// either text or elements, never both, and listeners stay on kept nodes.
function patch(from, to) {
    for (const { name } of [...from.attributes])
        if (!to.hasAttribute(name))
            from.removeAttribute(name);
    for (const { name, value } of [...to.attributes])
        if (from.getAttribute(name) !== value)
            from.setAttribute(name, value);
    if (from instanceof HTMLDetailsElement && to instanceof HTMLDetailsElement)
        from.open = to.open;
    const next = [...to.children];
    if (next.length === 0) {
        if (from.children.length > 0 || from.textContent !== to.textContent)
            from.textContent = to.textContent;
        return;
    }
    const current = [...from.children];
    if (current.length === 0)
        from.textContent = "";
    next.forEach((child, index) => {
        const old = current[index];
        if (old && old.tagName === child.tagName)
            patch(old, child);
        else if (old)
            old.replaceWith(child);
        else
            from.append(child);
    });
    for (const extra of current.slice(next.length))
        extra.remove();
}
// Keyed list update: reuse the card with the same data-key, insert new ones in order.
function patchList(list, items) {
    const existing = new Map();
    for (const child of list.children) {
        if (child instanceof HTMLElement && child.dataset.key)
            existing.set(child.dataset.key, child);
    }
    items.forEach((item, index) => {
        const old = existing.get(item.dataset.key ?? "");
        let node = item;
        if (old && old.tagName === item.tagName) {
            patch(old, item);
            node = old;
            existing.delete(item.dataset.key ?? "");
        }
        const at = list.children[index];
        if (at !== node)
            list.insertBefore(node, at ?? null);
    });
    for (const stale of existing.values())
        stale.remove();
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
// Navigation items have no busy state, so show a spinner on the sidebar entry with a
// stylesheet keyed to this page's link while any request is in flight.
function watchBusy(host, feature) {
    const root = document.documentElement;
    const href = JSON.stringify(host.navigation.pageHref({ id: "model-requests" }));
    const style = document.createElement("style");
    // Same ring as the sidebar's running-session spinner (.session-run-spinner),
    // placed at the end of the entry so the icon stays untouched.
    style.textContent = `
:root[${BUSY_ATTRIBUTE}] [href=${href}] { display: flex; align-items: center; }
:root[${BUSY_ATTRIBUTE}] [href=${href}]::after {
  content: "";
  flex: none;
  width: 12px;
  height: 12px;
  margin-inline-start: auto;
  box-sizing: border-box;
  border: 1.5px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-top-color: var(--accent);
  border-radius: var(--radius-full, 999px);
  pointer-events: none;
  animation: model-requests-spin 1.6s linear infinite;
}
@keyframes model-requests-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  :root[${BUSY_ATTRIBUTE}] [href=${href}]::after { border-color: var(--accent); animation: none; }
}`;
    document.head.append(style);
    let stopped = false;
    const poll = async () => {
        if (stopped || !host.connection.connected)
            return;
        try {
            const report = await feature.invoke("busy", {});
            const running = isRecord(report) && typeof report.running === "number" ? report.running : 0;
            if (!stopped)
                root.toggleAttribute(BUSY_ATTRIBUTE, running > 0);
        }
        catch {
            if (!stopped)
                root.removeAttribute(BUSY_ATTRIBUTE);
        }
    };
    const timer = window.setInterval(() => {
        void poll();
    }, BUSY_REFRESH_MS);
    void poll();
    return () => {
        stopped = true;
        window.clearInterval(timer);
        root.removeAttribute(BUSY_ATTRIBUTE);
        style.remove();
    };
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
                // The list is refreshed every second; remember which stacks are expanded
                // and whether each output box still follows the stream.
                const openStacks = new Set();
                const scrollStates = new WeakMap();
                const drawers = {
                    open: new Set(),
                    texts: new Map(),
                    toggle(id, open) {
                        if (!open) {
                            drawers.open.delete(id);
                            return;
                        }
                        drawers.open.add(id);
                        if (drawers.texts.has(id))
                            return;
                        void feature
                            .invoke("output", { id })
                            .then((report) => {
                            if (disposed)
                                return;
                            drawers.texts.set(id, isRecord(report) && typeof report.text === "string" ? report.text : "");
                            render();
                        })
                            .catch(() => {
                            if (!disposed)
                                drawers.open.delete(id);
                        });
                    },
                };
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
                    // Patch the existing cards instead of replacing them, so unchanged
                    // text keeps its selection and scroll position across refreshes.
                    patchList(runningList, snapshot.running.length > 0
                        ? snapshot.running.map((entry) => renderEntry(entry, copy, now, false, openStacks, drawers, host.locale))
                        : [keyed(element("li", "model-requests-muted", copy.noneRunning), "none")]);
                    patchList(recentList, snapshot.recent.length > 0
                        ? snapshot.recent.map((entry) => renderEntry(entry, copy, now, true, openStacks, drawers, host.locale))
                        : [keyed(element("li", "model-requests-muted", copy.noneRecent), "none")]);
                    const known = new Set([...snapshot.running, ...snapshot.recent].map((entry) => entry.id));
                    for (const id of drawers.texts.keys())
                        if (!known.has(id))
                            drawers.texts.delete(id);
                    for (const id of drawers.open)
                        if (!known.has(id))
                            drawers.open.delete(id);
                    // Running output follows the stream until the user scrolls away from
                    // the bottom; finished output starts at the top. Only user input
                    // counts, so scroll events from layout never unpin a box.
                    for (const output of section.querySelectorAll("[data-output-id]")) {
                        const follow = output.dataset.follow === "true";
                        let state = scrollStates.get(output);
                        if (!state) {
                            const fresh = { pinned: false, user: false };
                            state = fresh;
                            scrollStates.set(output, fresh);
                            const markUser = () => {
                                fresh.user = true;
                            };
                            for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
                                output.addEventListener(type, markUser, { passive: true });
                            }
                            output.addEventListener("scroll", () => {
                                if (!fresh.user)
                                    return;
                                fresh.pinned = !(follow && output.scrollTop + output.clientHeight >= output.scrollHeight - 4);
                            });
                            if (!follow)
                                output.scrollTop = 0;
                        }
                        if (follow && !state.pinned) {
                            output.scrollTop = output.scrollHeight;
                            requestAnimationFrame(() => {
                                if (!state.pinned)
                                    output.scrollTop = output.scrollHeight;
                            });
                        }
                    }
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
        const stopBusy = watchBusy(host, feature);
        host.signal.addEventListener("abort", () => {
            stop();
            stopBusy();
        }, { once: true });
    },
});
function renderEntry(entry, copy, now, compact, openStacks, drawers, locale) {
    const item = keyed(element("li", compact ? "model-requests-card model-requests-card--compact" : "model-requests-card"), entry.id);
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
    item.append(element("pre", "model-requests-code model-requests-output", entry.promptTail || copy.noPrompt));
    const outputLabel = `${copy.output}${entry.outputPhase ? ` · ${entry.outputPhase}` : ""} · ${entry.outputChars} ${copy.chars}`;
    // Running entries always reserve the box so the card does not jump when output starts.
    if (!compact) {
        item.append(element("div", "model-requests-label", outputLabel));
        const output = element("pre", "model-requests-code model-requests-output", entry.outputTail);
        output.dataset.outputId = entry.id;
        output.dataset.follow = "true";
        item.append(output);
    }
    else if (compact && entry.outputChars > 0) {
        const details = element("details", "model-requests-output-drawer");
        details.open = drawers.open.has(entry.id);
        details.addEventListener("toggle", () => drawers.toggle(entry.id, details.open));
        details.append(element("summary", "model-requests-label", outputLabel));
        const text = drawers.texts.get(entry.id);
        if (text === undefined) {
            details.append(element("div", "model-requests-muted", copy.loading));
        }
        else {
            const output = element("pre", "model-requests-code model-requests-output", text);
            output.dataset.outputId = entry.id;
            details.append(output);
        }
        item.append(details);
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
