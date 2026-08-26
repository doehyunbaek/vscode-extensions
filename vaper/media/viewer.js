const elements = {
  viewport: document.getElementById('viewport'),
  pageContainer: document.getElementById('page-container'),
  canvas: document.getElementById('page-canvas'),
  textLayer: document.getElementById('text-layer'),
  linkLayer: document.getElementById('link-layer'),
  citationTooltip: document.getElementById('citation-tooltip'),
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
  findBar: document.getElementById('find-bar'),
  findInput: document.getElementById('find-input'),
  findCount: document.getElementById('find-count'),
  findPrevious: document.getElementById('find-previous'),
  findNext: document.getElementById('find-next'),
  findClose: document.getElementById('find-close')
};

const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
let pdfjs;
let loadingTask;
let documentHandle;
let renderTask;
let textLayer;
let renderSequence = 0;
const citationCache = new Map();
const pageTextCache = new Map();
let findResults = [];
let findIndex = -1;
let findRequest = 0;
let findTimer;
let dataRequestId = 0;
let pageNumber = Math.max(1, saved.page || 1);
let scale = saved.scale || 'fit';
let lastActualScale = 1;
let rotation = saved.rotation || 0;
const backHistory = [];
const forwardHistory = [];

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
    pageTextCache.clear();
    findResults = [];
    findIndex = -1;
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
  if (textLayer) {
    textLayer.cancel();
    textLayer = undefined;
  }
  hideCitationTooltip();

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
  const cssWidth = Math.floor(viewport.width);
  const cssHeight = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  elements.pageContainer.style.width = `${cssWidth}px`;
  elements.pageContainer.style.height = `${cssHeight}px`;
  elements.pageContainer.style.setProperty('--total-scale-factor', actualScale);
  elements.pageContainer.style.setProperty('--scale-round-x', '1px');
  elements.pageContainer.style.setProperty('--scale-round-y', '1px');
  elements.textLayer.replaceChildren();
  elements.linkLayer.replaceChildren();

  renderTask = page.render({
    canvasContext: context,
    viewport,
    transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0]
  });

  try {
    await renderTask.promise;
    if (sequence !== renderSequence) return;
    await renderInteractiveLayers(page, viewport, sequence);
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

async function renderInteractiveLayers(page, viewport, sequence) {
  const [textContent, annotations] = await Promise.all([
    page.getTextContent(),
    page.getAnnotations({ intent: 'display' })
  ]);
  if (sequence !== renderSequence) return;

  textLayer = new pdfjs.TextLayer({
    textContentSource: textContent,
    container: elements.textLayer,
    viewport
  });
  await textLayer.render();
  if (sequence !== renderSequence) return;
  highlightFindMatches();

  pdfjs.setLayerDimensions(elements.linkLayer, viewport);
  for (const annotation of mergeCitationLinks(annotations)) {
    if (annotation.subtype !== 'Link') continue;
    const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
    const rect = [x1, y1, x2, y2];
    const link = document.createElement('a');
    link.className = 'pdf-link';
    link.style.left = `${Math.min(rect[0], rect[2])}px`;
    link.style.top = `${Math.min(rect[1], rect[3])}px`;
    link.style.width = `${Math.abs(rect[2] - rect[0])}px`;
    link.style.height = `${Math.abs(rect[3] - rect[1])}px`;

    if (annotation.dest) {
      link.href = '#';
      link.dataset.destination = typeof annotation.dest === 'string' ? annotation.dest : '';
      link.addEventListener('click', event => {
        event.preventDefault();
        void navigateToDestination(annotation.dest);
      });
      if (typeof annotation.dest === 'string' && annotation.dest.startsWith('cite.')) {
        link.classList.add('citation-link');
        link.setAttribute('aria-describedby', 'citation-tooltip');
        link.addEventListener('mouseenter', event => void showCitationTooltip(annotation.dest, event.currentTarget));
        link.addEventListener('focus', event => void showCitationTooltip(annotation.dest, event.currentTarget));
        link.addEventListener('mouseleave', hideCitationTooltip);
        link.addEventListener('blur', hideCitationTooltip);
      }
    } else if (annotation.url) {
      link.href = annotation.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
    } else {
      continue;
    }
    elements.linkLayer.append(link);
  }
}

function mergeCitationLinks(annotations) {
  const merged = [];
  for (const annotation of annotations) {
    const previous = merged.at(-1);
    const sameCitation = typeof annotation.dest === 'string' &&
      annotation.dest.startsWith('cite.') &&
      previous?.dest === annotation.dest;
    const sameLine = sameCitation &&
      Math.min(previous.rect[3], annotation.rect[3]) >= Math.max(previous.rect[1], annotation.rect[1]) - 1;
    const horizontalGap = sameLine
      ? Math.max(annotation.rect[0] - previous.rect[2], previous.rect[0] - annotation.rect[2], 0)
      : Infinity;

    if (horizontalGap <= 12) {
      previous.rect = [
        Math.min(previous.rect[0], annotation.rect[0]),
        Math.min(previous.rect[1], annotation.rect[1]),
        Math.max(previous.rect[2], annotation.rect[2]),
        Math.max(previous.rect[3], annotation.rect[3])
      ];
    } else {
      merged.push({ ...annotation, rect: [...annotation.rect] });
    }
  }
  return merged;
}

async function navigateToDestination(destination) {
  const explicit = typeof destination === 'string' ? await documentHandle.getDestination(destination) : destination;
  if (!explicit) return;
  const target = await documentHandle.getPageIndex(explicit[0]) + 1;
  if (target !== pageNumber) {
    backHistory.push(pageNumber);
    forwardHistory.length = 0;
  }
  goToPage(target);
}

function navigateHistory(direction) {
  const source = direction < 0 ? backHistory : forwardHistory;
  const destination = source.pop();
  if (!destination) return;
  const target = direction < 0 ? forwardHistory : backHistory;
  target.push(pageNumber);
  goToPage(destination);
}

async function showCitationTooltip(destination, anchor) {
  const tooltip = elements.citationTooltip;
  tooltip.textContent = 'Loading reference…';
  tooltip.hidden = false;
  positionTooltip(anchor);
  try {
    const citation = await getCitation(destination);
    if (anchor.matches(':hover, :focus')) {
      tooltip.textContent = citation || destination.slice(5);
      positionTooltip(anchor);
    }
  } catch (error) {
    console.warn('Unable to load citation', error);
    tooltip.textContent = destination.slice(5);
  }
}

function hideCitationTooltip() {
  elements.citationTooltip.hidden = true;
}

function positionTooltip(anchor) {
  const viewportRect = elements.viewport.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const tooltip = elements.citationTooltip;
  const margin = 8;
  let left = anchorRect.left - viewportRect.left;
  let top = anchorRect.bottom - viewportRect.top + margin;
  left = Math.max(margin, Math.min(left, elements.viewport.clientWidth - tooltip.offsetWidth - margin));
  if (top + tooltip.offsetHeight > elements.viewport.clientHeight - margin) {
    top = anchorRect.top - viewportRect.top - tooltip.offsetHeight - margin;
  }
  tooltip.style.left = `${left + elements.viewport.scrollLeft}px`;
  tooltip.style.top = `${Math.max(margin, top) + elements.viewport.scrollTop}px`;
}

async function getCitation(destination) {
  if (!citationCache.has(destination)) {
    citationCache.set(destination, extractCitation(destination));
  }
  return citationCache.get(destination);
}

async function extractCitation(destination) {
  const explicit = await documentHandle.getDestination(destination);
  if (!explicit) return '';
  const pageIndex = await documentHandle.getPageIndex(explicit[0]);
  const page = await documentHandle.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  const targetX = Number(explicit[2]) || 0;
  const targetY = Number(explicit[3]) || 0;
  const items = content.items.filter(item => item.str?.trim()).map(item => ({
    text: item.str.trim(),
    x: item.transform[4],
    y: item.transform[5]
  }));
  if (!items.length) return '';

  // LaTeX bibliography destinations sit just above the first reference line.
  // Prefer the closest text below that point so the preceding entry is omitted.
  const belowDestination = items.filter(item => item.y <= targetY + 1);
  const candidates = belowDestination.length ? belowDestination : items;
  const start = candidates.reduce((best, item) => {
    const score = Math.abs(item.y - targetY) * 8 + Math.abs(item.x - targetX);
    return !best || score < best.score ? { item, score } : best;
  }, null).item;
  const columnLeft = start.x < page.view[2] / 2 ? 0 : page.view[2] / 2;
  const columnRight = columnLeft + page.view[2] / 2;
  const lines = new Map();
  for (const item of items) {
    if (item.x < columnLeft || item.x >= columnRight || item.y > start.y + 3 || item.y < start.y - 48) continue;
    const key = Math.round(item.y);
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(item);
  }
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, line]) => line.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))
    .join(' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/-\s+/g, '')
    .trim();
}

function openFind() {
  elements.findBar.hidden = false;
  elements.findInput.focus();
  elements.findInput.select();
}

function closeFind() {
  elements.findBar.hidden = true;
  elements.findInput.blur();
  clearFindHighlights();
}

async function runFind() {
  const request = ++findRequest;
  const query = elements.findInput.value.trim().toLocaleLowerCase();
  findResults = [];
  findIndex = -1;
  if (!query || !documentHandle) {
    updateFindCount();
    clearFindHighlights();
    return;
  }

  elements.findCount.textContent = 'Searching…';
  for (let number = 1; number <= documentHandle.numPages; number += 1) {
    const text = await getPageText(number);
    if (request !== findRequest) return;
    let offset = 0;
    while ((offset = text.indexOf(query, offset)) !== -1) {
      findResults.push({ page: number, offset });
      offset += Math.max(1, query.length);
    }
  }
  if (request !== findRequest) return;
  findIndex = findResults.findIndex(result => result.page >= pageNumber);
  if (findIndex < 0 && findResults.length) findIndex = 0;
  updateFindCount();
  if (findIndex >= 0) goToPage(findResults[findIndex].page);
  highlightFindMatches();
}

async function getPageText(number) {
  if (!pageTextCache.has(number)) {
    pageTextCache.set(number, (async () => {
      const page = await documentHandle.getPage(number);
      const content = await page.getTextContent();
      return content.items.map(item => item.str || '').join(' ').toLocaleLowerCase();
    })());
  }
  return pageTextCache.get(number);
}

function moveFind(direction) {
  if (!findResults.length) return;
  findIndex = (findIndex + direction + findResults.length) % findResults.length;
  updateFindCount();
  const result = findResults[findIndex];
  if (result.page !== pageNumber) goToPage(result.page);
  else highlightFindMatches();
}

function updateFindCount() {
  elements.findCount.textContent = !elements.findInput.value.trim()
    ? ''
    : findResults.length ? `${findIndex + 1} / ${findResults.length}` : 'No results';
  elements.findPrevious.disabled = !findResults.length;
  elements.findNext.disabled = !findResults.length;
}

function clearFindHighlights() {
  for (const span of elements.textLayer.querySelectorAll('.find-match, .find-current')) {
    span.classList.remove('find-match', 'find-current');
  }
}

function highlightFindMatches() {
  clearFindHighlights();
  if (elements.findBar.hidden) return;
  const query = elements.findInput.value.trim().toLocaleLowerCase();
  if (!query || !textLayer) return;
  const spans = [...elements.textLayer.querySelectorAll('span')];
  const matching = spans.filter(span => span.textContent.toLocaleLowerCase().includes(query));
  for (const span of matching) span.classList.add('find-match');
  if (findIndex >= 0 && findResults[findIndex]?.page === pageNumber) {
    const pageResults = findResults.slice(0, findIndex + 1).filter(result => result.page === pageNumber);
    matching[Math.max(0, pageResults.length - 1)]?.classList.add('find-current');
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

function setTiming(_text) {}

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
  elements.findInput.addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => void runFind().catch(showError), 200);
  });
  elements.findInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      moveFind(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
  elements.findPrevious.addEventListener('click', () => moveFind(-1));
  elements.findNext.addEventListener('click', () => moveFind(1));
  elements.findClose.addEventListener('click', closeFind);

  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      openFind();
      return;
    }
    if (event.key === 'Escape' && !elements.findBar.hidden) {
      event.preventDefault();
      closeFind();
      return;
    }
    if (event.target === elements.page || event.target === elements.findInput) return;
    const historyModifier = event.metaKey || event.altKey;
    if (historyModifier && event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      navigateHistory(-1);
      return;
    }
    if (historyModifier && event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      navigateHistory(1);
      return;
    }
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
