import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import { createPiEnvironment, createPiShellArgs } from "./pi.ts";
import { getSessionsRoot } from "./sessionsView.ts";

interface InteractiveSessionPanel {
  panel: vscode.WebviewPanel;
  sessionPath: string;
  piPath: string;
  output: vscode.OutputChannel;
  extensionUri: vscode.Uri;
  bridgeConfig?: { url: string; token: string };
  child?: ChildProcessWithoutNullStreams;
  requestId: number;
  stdoutBuffer: string;
  decoder: StringDecoder;
  messages: InteractiveMessage[];
  streamingText: string;
  status: string;
  modelLabel: string;
  renderTimer?: ReturnType<typeof setTimeout>;
}

type InteractiveMessage = Record<string, unknown>;

const panels = new Map<string, InteractiveSessionPanel>();

export function openInteractiveSession(
  sessionPath: string,
  options: {
    findPiBinary: () => string;
    output: vscode.OutputChannel;
    extensionUri: vscode.Uri;
    bridgeConfig?: { url: string; token: string };
  },
): void {
  const resolvedSessionPath = resolve(sessionPath);
  if (!isPathInsideRoot(getSessionsRoot(), resolvedSessionPath)) return;

  const existing = panels.get(resolvedSessionPath);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const piPath = options.findPiBinary();
  const panel = vscode.window.createWebviewPanel(
    "pi-vscode.interactiveSession",
    `Pi: ${basename(resolvedSessionPath)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: false,
      retainContextWhenHidden: true,
      enableCommandUris: [
        "pi-vscode.interactiveSendMessage",
        "pi-vscode.interactiveAbort",
        "pi-vscode.interactiveRefresh",
        "pi-vscode.previewSessionFile",
        "pi-vscode.openSessionFile",
        "pi-vscode.revealSessionFile",
      ],
    },
  );
  const state: InteractiveSessionPanel = {
    panel,
    sessionPath: resolvedSessionPath,
    piPath,
    output: options.output,
    extensionUri: options.extensionUri,
    bridgeConfig: options.bridgeConfig,
    requestId: 0,
    stdoutBuffer: "",
    decoder: new StringDecoder("utf8"),
    messages: [],
    streamingText: "",
    status: "Starting pi RPC...",
    modelLabel: "",
  };
  panels.set(resolvedSessionPath, state);

  options.output.appendLine(
    `[${new Date().toISOString()}] Opening interactive session panel: ${resolvedSessionPath}`,
  );
  renderInteractivePanel(state);

  panel.onDidDispose(() => {
    options.output.appendLine(
      `[${new Date().toISOString()}] Disposing interactive session: ${resolvedSessionPath}`,
    );
    panels.delete(resolvedSessionPath);
    stopRpc(state);
  });

  void startRpc(state);
}

export async function sendInteractiveSessionMessage(sessionPath: string): Promise<void> {
  const state = findPanel(sessionPath);
  if (!state) return;
  state.panel.reveal(vscode.ViewColumn.Beside);

  const message = await vscode.window.showInputBox({
    title: "Send message to Pi session",
    prompt: "Message",
    ignoreFocusOut: true,
  });
  const trimmed = message?.trim();
  if (!trimmed) return;

  state.status = "Sending prompt...";
  renderInteractivePanel(state);
  sendRpc(state, { type: "prompt", message: trimmed });
}

export function abortInteractiveSession(sessionPath: string): void {
  const state = findPanel(sessionPath);
  if (!state) return;
  state.status = "Aborting...";
  renderInteractivePanel(state);
  sendRpc(state, { type: "abort" });
}

export function refreshInteractiveSession(sessionPath: string): void {
  const state = findPanel(sessionPath);
  if (!state) return;
  state.status = "Refreshing...";
  renderInteractivePanel(state);
  sendRpc(state, { type: "get_state" });
  sendRpc(state, { type: "get_messages" });
}

function findPanel(sessionPath: string): InteractiveSessionPanel | undefined {
  return panels.get(resolve(sessionPath));
}

async function startRpc(state: InteractiveSessionPanel): Promise<void> {
  if (state.child) return;
  state.status = "Starting pi RPC...";
  renderInteractivePanel(state);
  state.output.appendLine(
    `[${new Date().toISOString()}] Starting interactive RPC: ${state.piPath} --mode rpc --session ${state.sessionPath}`,
  );

  const cwd = await readSessionCwd(state.sessionPath);
  const child = spawn(
    state.piPath,
    ["--mode", "rpc", "--session", state.sessionPath, ...createPiShellArgs(state.extensionUri)],
    {
      cwd,
      env: { ...process.env, ...createPiEnvironment(state.bridgeConfig, state.piPath) },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  state.child = child;

  child.stdout.on("data", (chunk: Buffer) => flushRpcLines(state, chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    state.output.appendLine(`[pi rpc stderr] ${text.trimEnd()}`);
    state.status = text.trim() || state.status;
    renderInteractivePanel(state);
  });
  child.on("error", (error) => {
    state.status = `Pi RPC error: ${error.message}`;
    renderInteractivePanel(state);
  });
  child.on("close", (code, signal) => {
    state.child = undefined;
    state.status = `Pi RPC exited (${signal ?? code ?? "unknown"}).`;
    renderInteractivePanel(state);
  });

  sendRpc(state, { type: "get_state" });
  sendRpc(state, { type: "get_messages" });
}

async function readSessionCwd(sessionPath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await openFile(sessionPath, "r");
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    const firstLine = prefix.split(/\r?\n/, 1)[0];
    if (!firstLine) return undefined;
    const header = JSON.parse(firstLine) as unknown;
    if (isRecord(header) && typeof header.cwd === "string" && header.cwd.length > 0) {
      return header.cwd;
    }
  } catch {
  } finally {
    await handle?.close();
  }
  return undefined;
}

function stopRpc(state: InteractiveSessionPanel): void {
  if (state.renderTimer) clearTimeout(state.renderTimer);
  try {
    state.child?.kill();
  } catch {}
  state.child = undefined;
}

function sendRpc(state: InteractiveSessionPanel, command: Record<string, unknown>): void {
  const child = state.child;
  if (!child) {
    state.status = "Pi RPC is not running yet.";
    renderInteractivePanel(state);
    return;
  }
  const id = `vscode-${++state.requestId}`;
  child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
}

function flushRpcLines(state: InteractiveSessionPanel, chunk: Buffer): void {
  state.stdoutBuffer += state.decoder.write(chunk);
  while (true) {
    const newlineIndex = state.stdoutBuffer.indexOf("\n");
    if (newlineIndex === -1) return;
    let line = state.stdoutBuffer.slice(0, newlineIndex);
    state.stdoutBuffer = state.stdoutBuffer.slice(newlineIndex + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      state.output.appendLine(`[pi rpc non-json] ${line}`);
      continue;
    }
    handleRpcEvent(state, event);
  }
}

function handleRpcEvent(state: InteractiveSessionPanel, event: unknown): void {
  if (!isRecord(event)) return;

  if (event.type === "response" && event.command === "get_messages" && isRecord(event.data)) {
    state.messages = Array.isArray(event.data.messages)
      ? (event.data.messages as InteractiveMessage[])
      : [];
    state.streamingText = "";
    state.status = state.modelLabel ? `Ready · ${state.modelLabel}` : "Ready";
    renderInteractivePanel(state);
    return;
  }
  if (event.type === "response" && event.command === "get_state" && isRecord(event.data)) {
    const model = isRecord(event.data.model) ? event.data.model : undefined;
    const provider = typeof model?.provider === "string" ? model.provider : undefined;
    const id = typeof model?.id === "string" ? model.id : undefined;
    state.modelLabel = provider && id ? `${provider}/${id}` : "No model";
    const streaming = event.data.isStreaming === true ? " · streaming" : "";
    state.status = `${state.modelLabel}${streaming}`;
    renderInteractivePanel(state);
    return;
  }
  if (event.type === "response" && event.success === false) {
    state.status = String(event.error ?? `${String(event.command)} failed`);
    renderInteractivePanel(state);
    return;
  }
  if (event.type === "response" && event.command === "prompt" && event.success === true) {
    state.status = "Prompt accepted.";
    renderInteractivePanel(state);
    return;
  }
  if (event.type === "extension_ui_request") {
    const id = typeof event.id === "string" ? event.id : undefined;
    if (id) sendRawRpc(state, { type: "extension_ui_response", id, cancelled: true });
    return;
  }
  if (event.type === "message" && isRecord(event.message)) {
    const role = typeof event.message.role === "string" ? event.message.role : undefined;
    if (role === "assistant") state.streamingText = "";
    state.messages.push(event.message);
    renderInteractivePanel(state);
    return;
  }
  if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" && typeof update.delta === "string") {
      state.streamingText += update.delta;
      state.status = "Streaming...";
      scheduleRender(state);
    }
    return;
  }
  if (event.type === "agent_start") {
    state.status = "Streaming...";
    renderInteractivePanel(state);
    return;
  }
  if (event.type === "agent_end") {
    state.status = state.modelLabel ? `Ready · ${state.modelLabel}` : "Ready";
    if (state.streamingText) {
      state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: state.streamingText }],
      });
      state.streamingText = "";
    }
    renderInteractivePanel(state);
  }
}

function scheduleRender(state: InteractiveSessionPanel): void {
  if (state.renderTimer) return;
  state.renderTimer = setTimeout(() => {
    state.renderTimer = undefined;
    renderInteractivePanel(state);
  }, 250);
}

function sendRawRpc(state: InteractiveSessionPanel, command: Record<string, unknown>): void {
  state.child?.stdin.write(`${JSON.stringify(command)}\n`);
}

function renderInteractivePanel(state: InteractiveSessionPanel): void {
  state.panel.webview.html = getInteractiveSessionHtml(state);
}

function isPathInsideRoot(root: string, path: string): boolean {
  const rootPath = resolve(root);
  const resolvedPath = resolve(path);
  const relativePath = relative(rootPath, resolvedPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getInteractiveSessionHtml(state: InteractiveSessionPanel): string {
  const sendCommand = commandUri("pi-vscode.interactiveSendMessage", state.sessionPath);
  const abortCommand = commandUri("pi-vscode.interactiveAbort", state.sessionPath);
  const refreshCommand = commandUri("pi-vscode.interactiveRefresh", state.sessionPath);
  const previewCommand = commandUri("pi-vscode.previewSessionFile", state.sessionPath);
  const openCommand = commandUri("pi-vscode.openSessionFile", state.sessionPath);
  const revealCommand = commandUri("pi-vscode.revealSessionFile", state.sessionPath);
  const messagesHtml = renderMessages(state.messages, state.streamingText);

  return /* html */ `<!DOCTYPE html>
<html style="height:100%;margin:0;padding:0">
<head><style>
* { box-sizing: border-box; }
body { min-height:100%; margin:0; padding:0; font-family: var(--vscode-font-family); font-size:13px; color:var(--vscode-foreground); background:var(--vscode-editor-background); }
.header { position:sticky; top:0; z-index:1; padding:8px 10px; border-bottom:1px solid var(--vscode-panel-border,transparent); background:var(--vscode-editor-background); }
.title { font-weight:700; margin-bottom:4px; }
.path { font-size:11px; opacity:0.7; word-break:break-all; }
.actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.actions a { padding:4px 10px; border-radius:4px; background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); text-decoration:none; }
.actions a.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.status { padding:6px 10px; font-size:11px; opacity:0.75; border-bottom:1px solid var(--vscode-panel-border,transparent); }
.messages { padding:12px; }
.message { max-width:900px; margin:0 0 12px; padding:10px 12px; border-radius:8px; border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,transparent)); white-space:pre-wrap; line-height:1.45; }
.user { margin-left:auto; background:var(--vscode-input-background); }
.assistant { background:var(--vscode-editor-inactiveSelectionBackground,var(--vscode-editorWidget-background)); }
.tool { opacity:0.85; font-family:var(--vscode-editor-font-family); font-size:12px; }
.event { opacity:0.65; font-size:11px; }
.role { font-size:11px; opacity:0.65; margin-bottom:5px; text-transform:uppercase; letter-spacing:.04em; }
</style></head>
<body>
<div class="header">
  <div class="title">Pi Interactive Session</div>
  <div class="path">${escapeHtml(state.sessionPath)}</div>
  <div class="actions">
    <a class="primary" href="${sendCommand}">Send Message</a>
    <a href="${abortCommand}">Abort</a>
    <a href="${refreshCommand}">Refresh</a>
    <a href="${previewCommand}">Export Preview</a>
    <a href="${openCommand}">Open JSONL</a>
    <a href="${revealCommand}">Reveal</a>
  </div>
</div>
<div class="status">${escapeHtml(state.status)}</div>
<div class="messages">${messagesHtml}</div>
</body></html>`;
}

function renderMessages(messages: InteractiveMessage[], streamingText: string): string {
  const rendered = messages.map((message) => renderMessage(message)).join("");
  const streaming = streamingText
    ? renderMessage({ role: "assistant", content: [{ type: "text", text: streamingText }] }, true)
    : "";
  return rendered || streaming
    ? rendered + streaming
    : `<div class="message event">No messages loaded yet.</div>`;
}

function renderMessage(message: InteractiveMessage, streaming = false): string {
  const role = typeof message.role === "string" ? message.role : "event";
  const cls =
    role === "user"
      ? "user"
      : role === "assistant"
        ? "assistant"
        : role === "toolResult"
          ? "tool"
          : "event";
  const label = streaming ? `${role} · streaming` : role;
  return `<div class="message ${cls}"><div class="role">${escapeHtml(label)}</div>${escapeHtml(messageText(message))}</div>`;
}

function messageText(message: InteractiveMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(message, null, 2);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return JSON.stringify(part, null, 2);
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "thinking")
        return typeof part.thinking === "string" && part.thinking
          ? `[thinking]\n${part.thinking}`
          : "[thinking]";
      if (part.type === "toolCall") {
        const name = typeof part.name === "string" ? part.name : "tool";
        return `[tool call: ${name}]\n${JSON.stringify(part.arguments ?? {}, null, 2)}`;
      }
      if (part.type === "image") return "[image]";
      return JSON.stringify(part, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");
}

function commandUri(command: string, sessionPath: string): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([sessionPath]))}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
