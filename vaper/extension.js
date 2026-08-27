const path = require('path');
const vscode = require('vscode');
const {
  ARXIV_USER_AGENT,
  addRecentPaper,
  attachSearchPicker,
  normalizeRecentPapers,
  searchDblpForArxiv
} = require('./paper-search');

const VIEW_TYPE = 'vaper.pdfViewer';
const RECENT_PAPERS_KEY = 'vaper.recentArxivPapers';

class PdfDocument {
  constructor(uri) {
    this.uri = uri;
  }

  dispose() {}
}

class PdfViewerProvider {
  constructor(context, output) {
    this.context = context;
    this.output = output;
  }

  openCustomDocument(uri) {
    return new PdfDocument(uri);
  }

  resolveCustomEditor(document, panel) {
    const webview = panel.webview;
    const extensionUri = this.context.extensionUri;
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
    const pdfjsEntry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjsRoot = vscode.Uri.file(path.resolve(path.dirname(pdfjsEntry), '..', '..'));
    const name = document.uri.path.split('/').pop() || document.uri.toString();

    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, pdfjsRoot]
    };

    webview.onDidReceiveMessage(async message => {
      if (message?.type === 'timing') {
        this.output.appendLine(`[${name}] ${message.message}`);
        return;
      }
      if (message?.type === 'loadPdf') {
        const started = performance.now();
        try {
          const data = await vscode.workspace.fs.readFile(document.uri);
          const readMs = performance.now() - started;
          this.output.appendLine(`[${name}] Read ${formatBytes(data.byteLength)} from extension host in ${formatDuration(readMs)}`);
          const base64 = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
          await webview.postMessage({ type: 'pdfData', requestId: message.requestId, base64, readMs });
        } catch (error) {
          await webview.postMessage({
            type: 'pdfError',
            requestId: message.requestId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    webview.html = this.getHtml(webview, pdfjsRoot);
  }

  getHtml(webview, pdfjsRoot) {
    const nonce = getNonce();
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'viewer.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'viewer.css'));
    const pdfjsUri = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, 'legacy', 'build', 'pdf.mjs'));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs'));
    const cmapsUri = directoryWebviewUri(webview, vscode.Uri.joinPath(pdfjsRoot, 'cmaps'));
    const fontsUri = directoryWebviewUri(webview, vscode.Uri.joinPath(pdfjsRoot, 'standard_fonts'));
    const wasmUri = directoryWebviewUri(webview, vscode.Uri.joinPath(pdfjsRoot, 'wasm'));

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource}; font-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>PDF Viewer</title>
</head>
<body data-pdfjs="${escapeAttribute(pdfjsUri.toString())}"
      data-worker="${escapeAttribute(workerUri.toString())}"
      data-cmaps="${escapeAttribute(cmapsUri)}"
      data-fonts="${escapeAttribute(fontsUri)}"
      data-wasm="${escapeAttribute(wasmUri)}">
  <header class="toolbar" role="toolbar" aria-label="PDF controls">
    <button id="previous" title="Previous page" aria-label="Previous page">‹</button>
    <label class="page-control"><span class="sr-only">Page</span><input id="page" type="number" min="1" value="1" inputmode="numeric"> <span id="page-count">/ –</span></label>
    <button id="next" title="Next page" aria-label="Next page">›</button>
    <span class="separator"></span>
    <button id="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
    <button id="zoom-label" title="Fit page">Fit</button>
    <button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
    <span class="separator"></span>
    <button id="rotate" title="Rotate clockwise" aria-label="Rotate clockwise">↻</button>
    <button id="reload" title="Reload PDF" aria-label="Reload PDF">↺</button>
  </header>
  <div id="find-bar" role="search" hidden>
    <input id="find-input" type="search" placeholder="Find in PDF" aria-label="Find in PDF" autocomplete="off" spellcheck="false">
    <span id="find-count" aria-live="polite"></span>
    <button id="find-previous" title="Previous match" aria-label="Previous match">↑</button>
    <button id="find-next" title="Next match" aria-label="Next match">↓</button>
    <button id="find-close" title="Close search" aria-label="Close search">×</button>
  </div>
  <main id="viewport">
    <div id="message" role="status">Loading PDF…</div>
    <div id="page-container">
      <canvas id="page-canvas" aria-label="PDF page"></canvas>
      <div id="text-layer" class="textLayer"></div>
      <div id="link-layer" aria-label="PDF links"></div>
    </div>
    <div id="citation-tooltip" role="tooltip" hidden></div>
  </main>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function directoryWebviewUri(webview, uri) {
  const value = webview.asWebviewUri(uri).toString();
  return value.endsWith('/') ? value : `${value}/`;
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDuration(milliseconds) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function getNonce() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

async function openArxivPaper(context, paper, signal) {
  const storage = vscode.Uri.joinPath(context.globalStorageUri, 'arxiv');
  const fileName = `${paper.id.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
  const uri = vscode.Uri.joinPath(storage, fileName);

  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const response = await fetch(`https://arxiv.org/pdf/${paper.id}`, {
      signal,
      headers: { 'User-Agent': ARXIV_USER_AGENT, Accept: 'application/pdf' }
    });
    if (!response.ok) throw new Error(`PDF download returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('pdf')) throw new Error('arXiv did not return a PDF');
    await vscode.workspace.fs.createDirectory(storage);
    await vscode.workspace.fs.writeFile(uri, new Uint8Array(await response.arrayBuffer()));
  }

  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

async function runPaperSearch(context, output) {
  const picker = vscode.window.createQuickPick();
  picker.title = 'Search arXiv for Paper';
  const recentPapers = normalizeRecentPapers(context.globalState.get(RECENT_PAPERS_KEY));
  picker.placeholder = recentPapers.length
    ? 'Recently opened papers — type to search arXiv'
    : 'Type a query to search arXiv';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.ignoreFocusOut = true;
  const selected = await attachSearchPicker(
    picker,
    (query, signal) => searchDblpForArxiv(query, {
      signal,
      log: message => output.appendLine(`[arXiv search] ${message}`)
    }),
    { initialPapers: recentPapers }
  );
  if (!selected) return;

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Opening “${selected.title}”…`,
    cancellable: true
  }, async (_progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    await openArxivPaper(context, selected, controller.signal);
  });
  await context.globalState.update(RECENT_PAPERS_KEY, addRecentPaper(recentPapers, selected));
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Vaper');
  const provider = new PdfViewerProvider(context, output);
  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('vaper.openPdf', async () => {
      const selected = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'PDF documents': ['pdf'] },
        openLabel: 'Open PDF'
      });
      if (selected?.[0]) {
        await vscode.commands.executeCommand('vscode.openWith', selected[0], VIEW_TYPE);
      }
    }),
    vscode.commands.registerCommand('vaper.searchArxiv', async () => {
      try {
        await runPaperSearch(context, output);
      } catch (error) {
        if (error?.name !== 'AbortError') {
          void vscode.window.showErrorMessage(`Unable to search arXiv: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
