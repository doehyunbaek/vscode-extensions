const elements = {
  viewport: document.getElementById('viewport'),
  canvas: document.getElementById('page-canvas'),
  message: document.getElementById('message'),
  previous: document.getElementById('previous'),
  next: document.getElementById('next'),
  page: document.getElementById('page'),
  pageCount: document.getElementById('page-count'),
  zoomOut: document.getElementById('zoom-out'),
  zoomIn: document.getElementById('zoom-in'),
  zoomLabel: document.getElementById('zoom-label'),
  rotate: document.getElementById('rotate'),
  reload: document.getElementById('reload'),
  timing: document.getElementById('timing')
};

const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
let pdfjs;
let loadingTask;
let documentHandle;
let renderTask;
let renderSequence = 0;
let dataRequestId = 0;
let pageNumber = Math.max(1, saved.page || 1);
let scale = saved.scale || 'fit';
let lastActualScale = 1;
let rotation = saved.rotation || 0;

async function main() {
  const importStarted = performance.now();
  try {
    setTiming('Loading PDF.js…');
    const [pdfjsModule, workerModule] = await Promise.all([
      import(document.body.dataset.pdfjs),
      import(document.body.dataset.worker)
    ]);
    pdfjs = pdfjsModule;
    // Module workers loaded through VS Code's SSH resource proxy can take 30
    // seconds to fail their startup handshake. Registering the worker handler
    // directly makes PDF.js use its in-process worker path instead.
    globalThis.pdfjsWorker = workerModule;
    const pdfjsMs = performance.now() - importStarted;
    pdfjs.GlobalWorkerOptions.workerSrc = document.body.dataset.worker;
    bindControls();
    await loadDocument(pdfjsMs);
  } catch (error) {
    showError(error);
  }
}

async function loadDocument(pdfjsMs = 0) {
  const started = performance.now();
  let phase = 'document';
  const timer = setInterval(() => {
    const elapsed = performance.now() - started;
    const label = phase === 'document' ? 'Loading PDF' : `Rendering page ${pageNumber}`;
    setTiming(`${label}… ${formatDuration(elapsed)}`);
  }, 100);
  showMessage('Loading PDF…');
  if (renderTask) {
    renderTask.cancel();
  }
  if (loadingTask) {
    await loadingTask.destroy().catch(() => {});
  }

  try {
    const payload = await requestPdfData();
    const transferMs = performance.now() - started;
    const parseStarted = performance.now();
    const data = decodeBase64(payload.base64);
    loadingTask = pdfjs.getDocument({
      data,
      cMapUrl: document.body.dataset.cmaps,
      cMapPacked: true,
      standardFontDataUrl: document.body.dataset.fonts,
      wasmUrl: document.body.dataset.wasm,
      enableScripting: false
    });
    documentHandle = await loadingTask.promise;
    const parseMs = performance.now() - parseStarted;
    pageNumber = Math.min(pageNumber, documentHandle.numPages);
    elements.page.max = String(documentHandle.numPages);
    elements.pageCount.textContent = `/ ${documentHandle.numPages}`;
    phase = 'render';
    const renderStarted = performance.now();
    await renderPage();
    const renderMs = performance.now() - renderStarted;
    const totalMs = performance.now() - started + pdfjsMs;
    const bridgeMs = Math.max(0, transferMs - payload.readMs);
    const details = `Loaded in ${formatDuration(totalMs)} (PDF.js ${formatDuration(pdfjsMs)}, read ${formatDuration(payload.readMs)}, transfer ${formatDuration(bridgeMs)}, parse ${formatDuration(parseMs)}, render ${formatDuration(renderMs)})`;
    setTiming(details);
    vscode.postMessage({ type: 'timing', message: details });
  } finally {
    clearInterval(timer);
  }
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function requestPdfData() {
  const requestId = ++dataRequestId;
  return new Promise((resolve, reject) => {
    const receive = event => {
      const message = event.data;
      if (message?.requestId !== requestId) return;
      if (message.type === 'pdfData') {
        window.removeEventListener('message', receive);
        resolve(message);
      } else if (message.type === 'pdfError') {
        window.removeEventListener('message', receive);
        reject(new Error(message.message));
      }
    };
    window.addEventListener('message', receive);
    vscode.postMessage({ type: 'loadPdf', requestId });
  });
}

async function renderPage() {
  if (!documentHandle) return;
  const sequence = ++renderSequence;
  if (renderTask) {
    renderTask.cancel();
    renderTask = undefined;
  }

  showMessage(`Loading page ${pageNumber}…`);
  const page = await documentHandle.getPage(pageNumber);
  if (sequence !== renderSequence) return;

  const baseViewport = page.getViewport({ scale: 1, rotation });
  const actualScale = scale === 'fit' ? fitScale(baseViewport) : scale;
  lastActualScale = actualScale;
  const viewport = page.getViewport({ scale: actualScale, rotation });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = elements.canvas;
  const context = canvas.getContext('2d', { alpha: false });

  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  renderTask = page.render({
    canvasContext: context,
    viewport,
    transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0]
  });

  try {
    await renderTask.promise;
    if (sequence !== renderSequence) return;
    hideMessage();
    updateControls(actualScale);
    saveState();
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') throw error;
  } finally {
    if (sequence === renderSequence) renderTask = undefined;
  }
}

function fitScale(viewport) {
  const padding = 48;
  const width = Math.max(100, elements.viewport.clientWidth - padding);
  const height = Math.max(100, elements.viewport.clientHeight - padding);
  return Math.min(width / viewport.width, height / viewport.height);
}

function goToPage(value) {
  if (!documentHandle) return;
  const nextPage = Math.max(1, Math.min(documentHandle.numPages, Math.round(value)));
  if (nextPage === pageNumber) {
    elements.page.value = String(pageNumber);
    return;
  }
  pageNumber = nextPage;
  void renderPage().catch(showError);
}

function zoom(direction) {
  if (!documentHandle) return;
  if (scale === 'fit') {
    scale = lastActualScale;
  }
  scale = Math.max(0.25, Math.min(5, scale * (direction > 0 ? 1.2 : 1 / 1.2)));
  void renderPage().catch(showError);
}

function updateControls(actualScale) {
  elements.page.value = String(pageNumber);
  elements.previous.disabled = pageNumber <= 1;
  elements.next.disabled = pageNumber >= documentHandle.numPages;
  elements.zoomLabel.textContent = scale === 'fit' ? 'Fit' : `${Math.round(actualScale * 100)}%`;
}

function saveState() {
  vscode.setState({ page: pageNumber, scale, rotation });
}

function showMessage(text) {
  elements.message.textContent = text;
  elements.message.hidden = false;
}

function hideMessage() {
  elements.message.hidden = true;
}

function showError(error) {
  console.error(error);
  const message = `Unable to display PDF: ${error?.message || String(error)}`;
  showMessage(message);
  setTiming('Load failed');
  vscode.postMessage({ type: 'timing', message });
}

function setTiming(text) {
  elements.timing.textContent = text;
  elements.timing.title = text;
}

function formatDuration(milliseconds) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function bindControls() {
  elements.previous.addEventListener('click', () => goToPage(pageNumber - 1));
  elements.next.addEventListener('click', () => goToPage(pageNumber + 1));
  elements.page.addEventListener('change', () => goToPage(Number(elements.page.value)));
  elements.zoomOut.addEventListener('click', () => zoom(-1));
  elements.zoomIn.addEventListener('click', () => zoom(1));
  elements.zoomLabel.addEventListener('click', () => {
    scale = 'fit';
    void renderPage().catch(showError);
  });
  elements.rotate.addEventListener('click', () => {
    rotation = (rotation + 90) % 360;
    void renderPage().catch(showError);
  });
  elements.reload.addEventListener('click', () => void loadDocument().catch(showError));

  window.addEventListener('keydown', event => {
    if (event.target === elements.page) return;
    if (event.key === 'PageDown' || event.key === 'ArrowRight') goToPage(pageNumber + 1);
    if (event.key === 'PageUp' || event.key === 'ArrowLeft') goToPage(pageNumber - 1);
    if (event.key === 'Home') goToPage(1);
    if (event.key === 'End' && documentHandle) goToPage(documentHandle.numPages);
    if ((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      zoom(1);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === '-') {
      event.preventDefault();
      zoom(-1);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === '0') {
      event.preventDefault();
      scale = 'fit';
      void renderPage().catch(showError);
    }
  });

  elements.viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(event.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  let resizeTimer;
  new ResizeObserver(() => {
    if (scale !== 'fit' || !documentHandle) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void renderPage().catch(showError), 100);
  }).observe(elements.viewport);
}

void main();
