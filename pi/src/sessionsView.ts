import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, open as openFile, readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { toErrorMessage } from "./bridge/utils.ts";
import { createPiEnvironment } from "./pi.ts";

const MAX_SESSIONS = 500;
const SESSION_PREVIEW_BYTES = 64 * 1024;
const METADATA_CONCURRENCY = 16;

interface SessionFileInfo {
  path: string;
  relativePath: string;
  modifiedAt: string;
  mtimeMs: number;
  size: number;
}

interface SessionMetadata {
  id?: string;
  cwd?: string;
  startedAt?: string;
  firstUserMessage?: string;
  latestAssistantMessage?: string;
}

interface SessionSummary extends SessionFileInfo, SessionMetadata {
  workspace: string;
}

interface SessionGroup {
  key: string;
  label: string;
  subtitle: string;
  newestMtimeMs: number;
  totalSize: number;
  sessions: SessionSummary[];
}

export function getSessionsRoot(): string {
  return resolve(homedir(), ".pi", "agent", "sessions");
}

export function createSessionsViewProvider(
  output: vscode.OutputChannel,
  findPiBinary: () => string,
  onDidResolveView?: (view: vscode.WebviewView) => void,
): vscode.WebviewViewProvider {
  const sessionsRoot = getSessionsRoot();
  const log = (message: string) => {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  };

  return {
    resolveWebviewView(webviewView: vscode.WebviewView) {
      log("Resolving Sessions webview.");
      onDidResolveView?.(webviewView);
      webviewView.onDidChangeVisibility(() => {
        log(`Sessions webview visibility changed: ${webviewView.visible ? "visible" : "hidden"}.`);
      });
      webviewView.onDidDispose(() => {
        log("Sessions webview disposed.");
      });
      const reportProgress = (message: string) => {
        log(message);
        webviewView.webview.postMessage({ type: "progress", message });
      };

      let refreshInFlight = false;
      let readyReceived = false;
      const refreshSessions = async () => {
        if (refreshInFlight) return;
        refreshInFlight = true;
        webviewView.webview.postMessage({ type: "loading", loading: true });
        try {
          const sessions = await readPiSessions(sessionsRoot, reportProgress);
          log(`Rendering ${sessions.length} sessions into Sessions webview HTML.`);
          webviewView.webview.html = getSessionsHtml({
            root: sessionsRoot,
            sessions,
            autoRefresh: false,
          });
          log(`Rendered ${sessions.length} sessions into Sessions webview HTML.`);
        } catch (error) {
          const message = toErrorMessage(error);
          log(`Sessions load failed: ${message}`);
          webviewView.webview.postMessage({ type: "error", message });
        } finally {
          refreshInFlight = false;
          webviewView.webview.postMessage({ type: "loading", loading: false });
        }
      };

      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        if (!isRecord(message)) return;
        if (message.type === "ready") {
          readyReceived = true;
          log("Sessions webview ready.");
          void refreshSessions();
          return;
        }
        if (message.type === "refresh") {
          log("Sessions refresh requested.");
          void refreshSessions();
          return;
        }
        if (message.type === "rendered") {
          log(`Sessions webview rendered ${String(message.count)} sessions.`);
          return;
        }
        if (message.type === "webviewError") {
          log(
            `Sessions webview error: ${String(message.message)} at ${String(message.source ?? "")} ${String(message.lineno ?? "")}:${String(message.colno ?? "")} ${String(message.stack ?? "")}`,
          );
          return;
        }
        if (message.type === "interactive" && typeof message.path === "string") {
          log(`Opening interactive session: ${message.path}`);
          void vscode.commands.executeCommand("pi-vscode.openInteractiveSession", message.path);
          return;
        }
        if (message.type === "preview" && typeof message.path === "string") {
          log(`Previewing session file: ${message.path}`);
          void previewSessionFile(message.path, findPiBinary, output);
          return;
        }
        if (message.type === "open" && typeof message.path === "string") {
          log(`Opening session file: ${message.path}`);
          void openSessionFile(message.path);
          return;
        }
        if (message.type === "reveal" && typeof message.path === "string") {
          log(`Revealing session file: ${message.path}`);
          void revealSessionFile(message.path);
        }
      });

      webviewView.webview.options = {
        enableScripts: true,
        enableCommandUris: [
          "pi-vscode.openInteractiveSession",
          "pi-vscode.previewSessionFile",
          "pi-vscode.openSessionFile",
          "pi-vscode.revealSessionFile",
        ],
      };
      webviewView.webview.html = getSessionsHtml({ autoRefresh: true });
      setTimeout(() => {
        if (readyReceived) return;
        log("Sessions webview did not send ready; starting fallback refresh.");
        void refreshSessions();
      }, 1000);
    },
  };
}

export async function previewSessionFile(
  sessionPath: string,
  findPiBinary: () => string,
  output?: vscode.OutputChannel,
): Promise<void> {
  if (!isPathInsideRoot(getSessionsRoot(), sessionPath)) return;

  const tempDir = await mkdtemp(join(tmpdir(), "pi-vscode-session-"));
  const outputPath = join(tempDir, `${basename(sessionPath, ".jsonl")}.html`);
  const piPath = findPiBinary();
  output?.appendLine(
    `[${new Date().toISOString()}] Exporting session preview with: ${piPath} --export ${sessionPath} ${outputPath}`,
  );
  await execFilePromise(piPath, ["--export", sessionPath, outputPath], {
    env: { ...process.env, ...createPiEnvironment(undefined, piPath) },
  });

  const html = await readFile(outputPath, "utf8");
  const panel = vscode.window.createWebviewPanel(
    "pi-vscode.sessionPreview",
    `Pi Session: ${basename(sessionPath)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = html;
}

export async function openSessionFile(sessionPath: string): Promise<void> {
  if (!isPathInsideRoot(getSessionsRoot(), sessionPath)) return;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sessionPath));
  await vscode.window.showTextDocument(document, { preview: true });
}

export async function revealSessionFile(sessionPath: string): Promise<void> {
  if (!isPathInsideRoot(getSessionsRoot(), sessionPath)) return;
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(sessionPath));
}

async function execFilePromise(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(file, args, options, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolvePromise();
      }
    });
  });
}

async function readPiSessions(
  sessionsRoot: string,
  log: (message: string) => void,
): Promise<SessionSummary[]> {
  const startedAt = Date.now();
  log(`Loading sessions from ${sessionsRoot}`);
  try {
    await access(sessionsRoot, constants.R_OK);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      log("Sessions directory does not exist.");
      return [];
    }
    throw error;
  }

  const scanStartedAt = Date.now();
  const allSessionFiles = await listSessionFiles(sessionsRoot);
  log(`Found ${allSessionFiles.length} session files in ${Date.now() - scanStartedAt}ms.`);

  const sessionFiles = allSessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSIONS);
  log(
    `Reading metadata for ${sessionFiles.length} newest sessions (${SESSION_PREVIEW_BYTES} byte preview, concurrency ${METADATA_CONCURRENCY}).`,
  );

  const sessions = await mapLimit(
    sessionFiles,
    METADATA_CONCURRENCY,
    (file) => readSessionSummary(sessionsRoot, file),
    (completed, total) => log(`Read metadata for ${completed}/${total} sessions.`),
  );
  log(`Loaded ${sessions.length} session summaries in ${Date.now() - startedAt}ms.`);
  return sessions;
}

async function listSessionFiles(root: string, dir = root): Promise<SessionFileInfo[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: SessionFileInfo[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listSessionFiles(root, fullPath)));
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;

      try {
        const info = await stat(fullPath);
        files.push({
          path: fullPath,
          relativePath: relative(root, fullPath),
          modifiedAt: info.mtime.toISOString(),
          mtimeMs: info.mtimeMs,
          size: info.size,
        });
      } catch {}
    }),
  );
  return files;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let nextIndex = 0;
  let completed = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await mapper(item);
      completed++;
      if (completed === items.length || completed % 50 === 0) onProgress?.(completed, items.length);
    }
  });

  await Promise.all(workers);
  return results;
}

async function readSessionSummary(
  sessionsRoot: string,
  file: SessionFileInfo,
): Promise<SessionSummary> {
  let metadata: SessionMetadata = {};
  try {
    metadata = parseSessionPrefix(await readFilePrefix(file.path, file.size));
  } catch {}

  return {
    ...file,
    ...metadata,
    workspace: metadata.cwd ?? inferWorkspaceFromPath(sessionsRoot, file.path),
  };
}

async function readFilePrefix(filePath: string, fileSize: number): Promise<string> {
  const handle = await openFile(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(fileSize, SESSION_PREVIEW_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseSessionPrefix(prefix: string): SessionMetadata {
  const metadata: SessionMetadata = {};
  for (const line of prefix.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    if (event.type === "session") {
      metadata.id = getString(event.id) ?? metadata.id;
      metadata.startedAt = getString(event.timestamp) ?? metadata.startedAt;
      metadata.cwd = getString(event.cwd) ?? metadata.cwd;
      continue;
    }

    if (event.type !== "message" || !isRecord(event.message)) continue;
    const role = getString(event.message.role);
    const text = extractMessageText(event.message.content);
    if (!text) continue;
    if (role === "user" && !metadata.firstUserMessage) metadata.firstUserMessage = text;
    if (role === "assistant") metadata.latestAssistantMessage = text;
  }
  return metadata;
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return normalizePreview(content);
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return normalizePreview(parts.join("\n"));
}

function normalizePreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function inferWorkspaceFromPath(sessionsRoot: string, sessionPath: string): string {
  const relativePath = relative(sessionsRoot, sessionPath);
  const directory = getSessionDirectory(relativePath);
  if (!directory) return "Unknown workspace";
  return decodeSessionDirectoryName(directory) ?? directory;
}

function getSessionDirectory(relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]/);
  return parts.length > 1 ? parts[0] : undefined;
}

function decodeSessionDirectoryName(directory: string): string | undefined {
  if (!directory.startsWith("--") || !directory.endsWith("--")) return undefined;
  const decoded = directory.slice(2, -2).split("-").filter(Boolean).join("/");
  return decoded ? `/${decoded}` : undefined;
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

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const directory = getSessionDirectory(session.relativePath);
    const key = directory ?? "__root__";
    const label = directory
      ? (decodeSessionDirectoryName(directory) ?? directory)
      : "Uncategorized";
    const subtitle = directory ?? "Sessions stored directly in ~/.pi/agent/sessions";
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(session);
      existing.newestMtimeMs = Math.max(existing.newestMtimeMs, session.mtimeMs);
      existing.totalSize += session.size;
    } else {
      groups.set(key, {
        key,
        label,
        subtitle,
        newestMtimeMs: session.mtimeMs,
        totalSize: session.size,
        sessions: [session],
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: group.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs),
    }))
    .sort((a, b) => b.newestMtimeMs - a.newestMtimeMs);
}

function renderSessionGroups(sessions: SessionSummary[]): string {
  return groupSessions(sessions)
    .map((group) => renderSessionGroup(group))
    .join("");
}

function renderSessionGroup(group: SessionGroup): string {
  const cards = group.sessions
    .map((session, index) => renderSessionCard(session, `${group.key}:${index}`))
    .join("");
  return `<details class="session-group" open data-group-key="${escapeHtml(group.key)}">
    <summary>
      <span class="group-title">${escapeHtml(group.label)}</span>
      <span class="group-count">${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"}</span>
    </summary>
    <div class="group-subtitle">${escapeHtml(group.subtitle)} · newest ${escapeHtml(formatDate(new Date(group.newestMtimeMs).toISOString()))} · ${escapeHtml(formatSize(group.totalSize))}</div>
    <div class="group-sessions">${cards}</div>
  </details>`;
}

function renderSessionCards(sessions: SessionSummary[]): string {
  return renderSessionGroups(sessions);
}

function renderSessionCard(session: SessionSummary, index: string): string {
  const title = session.firstUserMessage || session.cwd || session.id || basename(session.path);
  const started = session.startedAt ? formatDate(session.startedAt) : "Unknown start";
  const modified = session.modifiedAt ? formatDate(session.modifiedAt) : "Unknown modified";
  const assistant = session.latestAssistantMessage
    ? `<div class="session-preview"><strong>Latest assistant:</strong> ${escapeHtml(session.latestAssistantMessage)}</div>`
    : "";
  const interactiveCommand = commandUri("pi-vscode.openInteractiveSession", session.path);
  const previewCommand = commandUri("pi-vscode.previewSessionFile", session.path);
  const openCommand = commandUri("pi-vscode.openSessionFile", session.path);
  const revealCommand = commandUri("pi-vscode.revealSessionFile", session.path);
  return `<div class="session-card" data-index="${escapeHtml(index)}">
    <div class="session-title">${escapeHtml(title)}</div>
    <div class="session-meta">Started: ${escapeHtml(started)} · Modified: ${escapeHtml(modified)} · ${escapeHtml(formatSize(session.size))}</div>
    <div class="session-meta">Workspace: ${escapeHtml(session.workspace || "Unknown workspace")}</div>
    <div class="session-path"><code>${escapeHtml(session.relativePath || session.path)}</code></div>
    ${assistant}
    <div class="session-actions">
      <a href="${interactiveCommand}">Interactive</a>
      <a href="${previewCommand}">Preview</a>
      <a href="${openCommand}">Open JSONL</a>
      <a href="${revealCommand}">Reveal</a>
    </div>
  </div>`;
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

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function getSessionsHtml(state: {
  root?: string;
  sessions?: SessionSummary[];
  autoRefresh: boolean;
}): string {
  const sessions = state.sessions ?? [];
  const root = state.root ?? "";
  const initialStateJson = JSON.stringify({
    root,
    sessions,
    autoRefresh: state.autoRefresh,
  }).replaceAll("</", "<\\/");
  const countText = sessions.length
    ? `${sessions.length} of ${sessions.length} sessions`
    : state.autoRefresh
      ? "Loading sessions..."
      : "No sessions found";
  const statusText = sessions.length ? "" : state.autoRefresh ? "Loading..." : "No sessions found";

  return /* html */ `<!DOCTYPE html>
<html style="height:100%;margin:0;padding:0">
<head><style>
* { box-sizing: border-box; }
body { height:100%; margin:0; padding:0; font-family: var(--vscode-font-family); font-size:13px; color:var(--vscode-foreground); display:flex; flex-direction:column; overflow:hidden; }
.toolbar { padding:8px; display:flex; gap:4px; flex-shrink:0; }
.toolbar input { flex:1; min-width:0; padding:4px 8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,transparent); border-radius:4px; font-size:12px; outline:none; }
.toolbar button, .session-actions button, .session-actions a { padding:4px 10px; cursor:pointer; background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); border:none; border-radius:4px; font-size:12px; white-space:nowrap; text-decoration:none; }
.toolbar button:hover, .session-actions button:hover, .session-actions a:hover { background:var(--vscode-button-secondaryHoverBackground); }
.summary { padding:0 8px 8px; font-size:11px; opacity:0.7; border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border,transparent)); flex-shrink:0; }
.summary code { font-size:10px; word-break:break-all; }
.status { padding:16px 12px; text-align:center; opacity:0.7; }
.session-list { flex:1; overflow-y:auto; padding:8px; }
.session-group { margin-bottom:10px; border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,transparent)); border-radius:6px; background:var(--vscode-sideBarSectionHeader-background,transparent); overflow:hidden; }
.session-group summary { cursor:pointer; padding:8px 10px; user-select:none; display:flex; align-items:center; gap:8px; }
.group-title { font-weight:700; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.group-count { font-size:11px; opacity:0.7; white-space:nowrap; }
.group-subtitle { padding:0 10px 8px 24px; font-size:11px; opacity:0.65; word-break:break-word; }
.group-sessions { padding:0 8px 8px; }
.session-card { padding:10px; margin-bottom:8px; background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,transparent)); border-radius:6px; }
.session-title { font-weight:600; margin-bottom:6px; line-height:1.35; }
.session-meta, .session-path, .session-preview { font-size:11px; opacity:0.75; margin-bottom:5px; word-break:break-word; }
.session-path code { font-size:10px; }
.session-preview { opacity:0.85; }
.session-preview strong { opacity:0.8; }
.session-actions { display:flex; gap:4px; justify-content:flex-end; margin-top:8px; }
.hidden { display:none; }
</style></head>
<body>
<div class="toolbar">
  <input id="filter" type="text" placeholder="Filter sessions..." />
  <button id="refresh">Refresh</button>
</div>
<div class="summary">
  <div><span id="count">${escapeHtml(countText)}</span></div>
  <div>Root: <code id="root-path">${escapeHtml(root)}</code></div>
</div>
<div id="status" class="status${sessions.length ? " hidden" : ""}">${escapeHtml(statusText)}</div>
<div id="list" class="session-list">${renderSessionCards(sessions)}</div>
<script>
const vscode = acquireVsCodeApi();
window.onerror = (message, source, lineno, colno, error) => {
  vscode.postMessage({ type: 'webviewError', message: String(message), source, lineno, colno, stack: error && error.stack });
};
window.addEventListener('unhandledrejection', (event) => {
  vscode.postMessage({ type: 'webviewError', message: String(event.reason), stack: event.reason && event.reason.stack });
});
const filter = document.getElementById('filter');
const refresh = document.getElementById('refresh');
const list = document.getElementById('list');
const status = document.getElementById('status');
const count = document.getElementById('count');
const rootPath = document.getElementById('root-path');
const initialState = ${initialStateJson};
let sessions = Array.isArray(initialState.sessions) ? initialState.sessions : [];
let visibleSessions = [];
if (initialState.root) rootPath.textContent = initialState.root;

function render() {
  const query = filter.value.trim().toLowerCase();
  visibleSessions = query
    ? sessions.filter((session) => searchableText(session).includes(query))
    : sessions;
  count.textContent = visibleSessions.length + ' of ' + sessions.length + ' sessions';

  if (!visibleSessions.length) {
    status.textContent = sessions.length ? 'No matching sessions' : 'No sessions found';
    status.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }

  status.classList.add('hidden');
  list.innerHTML = renderGroups(visibleSessions);
}

function renderGroups(items) {
  const groups = new Map();
  items.forEach((session, index) => {
    const directory = sessionDirectory(session.relativePath || '');
    const key = directory || '__root__';
    const label = directory ? (decodeSessionDirectory(directory) || directory) : 'Uncategorized';
    const subtitle = directory || 'Sessions stored directly in ~/.pi/agent/sessions';
    const existing = groups.get(key);
    if (existing) {
      existing.items.push({ session, index });
      existing.newestMtimeMs = Math.max(existing.newestMtimeMs, Number(session.mtimeMs || 0));
      existing.totalSize += Number(session.size || 0);
    } else {
      groups.set(key, { key, label, subtitle, newestMtimeMs: Number(session.mtimeMs || 0), totalSize: Number(session.size || 0), items: [{ session, index }] });
    }
  });
  return Array.from(groups.values())
    .sort((a, b) => b.newestMtimeMs - a.newestMtimeMs)
    .map((group) => renderGroup(group))
    .join('');
}

function renderGroup(group) {
  return '<details class="session-group" open>' +
    '<summary><span class="group-title">' + esc(group.label) + '</span><span class="group-count">' + group.items.length + ' session' + (group.items.length === 1 ? '' : 's') + '</span></summary>' +
    '<div class="group-subtitle">' + esc(group.subtitle) + ' · newest ' + esc(fmtDate(new Date(group.newestMtimeMs).toISOString())) + ' · ' + esc(fmtSize(group.totalSize)) + '</div>' +
    '<div class="group-sessions">' + group.items.map(({ session, index }) => renderSession(session, index)).join('') + '</div>' +
  '</details>';
}

function renderSession(session, index) {
  const title = session.firstUserMessage || session.cwd || session.id || fileName(session.path);
  const started = session.startedAt ? fmtDate(session.startedAt) : 'Unknown start';
  const modified = session.modifiedAt ? fmtDate(session.modifiedAt) : 'Unknown modified';
  const assistant = session.latestAssistantMessage
    ? '<div class="session-preview"><strong>Latest assistant:</strong> ' + esc(session.latestAssistantMessage) + '</div>'
    : '';
  return '<div class="session-card">' +
    '<div class="session-title">' + esc(title) + '</div>' +
    '<div class="session-meta">Started: ' + esc(started) + ' · Modified: ' + esc(modified) + ' · ' + esc(fmtSize(session.size)) + '</div>' +
    '<div class="session-meta">Workspace: ' + esc(session.workspace || 'Unknown workspace') + '</div>' +
    '<div class="session-path"><code>' + esc(session.relativePath || session.path) + '</code></div>' +
    assistant +
    '<div class="session-actions">' +
      '<button data-action="interactive" data-index="' + index + '">Interactive</button>' +
      '<button data-action="preview" data-index="' + index + '">Preview</button>' +
      '<button data-action="open" data-index="' + index + '">Open JSONL</button>' +
      '<button data-action="reveal" data-index="' + index + '">Reveal</button>' +
    '</div>' +
  '</div>';
}

function sessionDirectory(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/);
  return parts.length > 1 ? parts[0] : '';
}

function decodeSessionDirectory(directory) {
  if (!directory.startsWith('--') || !directory.endsWith('--')) return '';
  const decoded = directory.slice(2, -2).split('-').filter(Boolean).join('/');
  return decoded ? '/' + decoded : '';
}

function searchableText(session) {
  return [session.path, session.relativePath, session.id, session.cwd, session.workspace, session.firstUserMessage, session.latestAssistantMessage]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function fileName(path) {
  return String(path || '').split(/[\\/]/).pop() || 'Session';
}

function fmtDate(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value || '');
  }
}

function fmtSize(size) {
  const value = Number(size || 0);
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1024 / 1024).toFixed(1) + ' MB';
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = String(value || '');
  return div.innerHTML;
}

refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
filter.addEventListener('input', render);
list.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const session = visibleSessions[Number(button.dataset.index)];
  if (!session) return;
  vscode.postMessage({ type: button.dataset.action, path: session.path });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'loading') {
    if (message.loading && !sessions.length) {
      status.textContent = 'Loading...';
      status.classList.remove('hidden');
    }
    return;
  }
  if (message.type === 'progress') {
    status.textContent = message.message || 'Loading...';
    status.classList.remove('hidden');
    return;
  }
  if (message.type === 'sessions') {
    rootPath.textContent = message.root || '';
    sessions = Array.isArray(message.sessions) ? message.sessions : [];
    status.textContent = 'Rendering ' + sessions.length + ' sessions...';
    requestAnimationFrame(() => render());
    vscode.postMessage({ type: 'rendered', count: sessions.length });
    return;
  }
  if (message.type === 'error') {
    status.textContent = message.message || 'Failed to load sessions';
    status.classList.remove('hidden');
  }
});

if (sessions.length) {
  render();
  vscode.postMessage({ type: 'rendered', count: sessions.length });
} else if (initialState.autoRefresh) {
  vscode.postMessage({ type: 'ready' });
} else {
  render();
}
</script>
</body></html>`;
}
