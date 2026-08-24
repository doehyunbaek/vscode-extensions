const path = require('path');
const vscode = require('vscode');

const VIEW_TYPE = 'vaper.pdfViewer';

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
    const pdfjsEntry = require.resolve('pdfjs-dist/build/pdf.mjs');
    const pdfjsRoot = vscode.Uri.file(path.dirname(path.dirname(pdfjsEntry)));
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
    const pdfjsUri = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, 'build', 'pdf.mjs'));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, 'build', 'pdf.worker.mjs'));
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
    <span id="timing" role="status" title="PDF loading time"></span>
  </header>
  <main id="viewport">
    <div id="message" role="status">Loading PDF…</div>
    <canvas id="page-canvas" aria-label="PDF page"></canvas>
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
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
