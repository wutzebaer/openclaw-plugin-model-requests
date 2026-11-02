import type { RequestKind, RequestState } from "./report.js";

export type Copy = {
  title: string;
  running: string;
  recent: string;
  noneRunning: string;
  noneRecent: string;
  unavailable: string;
  capturing: (targets: string) => string;
  allEndpoints: string;
  summary: (running: number, recent: number) => string;
  states: Record<RequestState, string>;
  kinds: Record<RequestKind, string>;
  prompt: string;
  output: string;
  chars: string;
  loading: string;
  origin: string;
  session: string;
  messages: (count: number) => string;
  firstByte: string;
  tokens: string;
  noPrompt: string;
};

const english: Copy = {
  title: "Model requests",
  running: "Running now",
  recent: "Recently finished",
  noneRunning: "No model request in flight.",
  noneRecent: "Nothing finished yet since the gateway started.",
  unavailable: "Model requests unavailable",
  capturing: (targets) => `Capturing ${targets}`,
  allEndpoints: "all LLM endpoints",
  summary: (running, recent) => `${running} running · ${recent} finished shown`,
  states: {
    sending: "sending",
    waiting: "waiting for model",
    streaming: "streaming",
    done: "done",
    error: "error",
    aborted: "aborted",
  },
  kinds: {
    agent: "agent turn",
    compaction: "compaction",
    "memory-flush": "memory flush",
    title: "title",
    heartbeat: "heartbeat",
    subagent: "subagent",
    embedding: "embedding",
    other: "other",
  },
  prompt: "Prompt, last message",
  output: "Output",
  chars: "chars",
  loading: "Loading…",
  origin: "Origin (call stack)",
  session: "Session",
  messages: (count) => (count === 1 ? "1 message" : `${count} messages`),
  firstByte: "first byte",
  tokens: "tokens",
  noPrompt: "(no prompt text found)",
};

const german: Copy = {
  title: "Modellanfragen",
  running: "Läuft gerade",
  recent: "Zuletzt beendet",
  noneRunning: "Keine Modellanfrage läuft.",
  noneRecent: "Seit dem Gateway-Start ist noch nichts beendet.",
  unavailable: "Modellanfragen nicht verfügbar",
  capturing: (targets) => `Erfasst ${targets}`,
  allEndpoints: "alle LLM-Endpunkte",
  summary: (running, recent) => `${running} laufen · ${recent} beendete angezeigt`,
  states: {
    sending: "sendet",
    waiting: "wartet aufs Modell",
    streaming: "streamt",
    done: "fertig",
    error: "Fehler",
    aborted: "abgebrochen",
  },
  kinds: {
    agent: "Agent-Turn",
    compaction: "Compaction",
    "memory-flush": "Memory-Flush",
    title: "Titel",
    heartbeat: "Heartbeat",
    subagent: "Subagent",
    embedding: "Embedding",
    other: "Sonstiges",
  },
  prompt: "Prompt, letzte Nachricht",
  output: "Ausgabe",
  chars: "Zeichen",
  loading: "Wird geladen…",
  origin: "Herkunft (Aufrufstapel)",
  session: "Session",
  messages: (count) => (count === 1 ? "1 Nachricht" : `${count} Nachrichten`),
  firstByte: "erstes Byte",
  tokens: "Tokens",
  noPrompt: "(kein Prompt-Text gefunden)",
};

export function copyFor(locale: string): Copy {
  return locale.toLowerCase().startsWith("de") ? german : english;
}
