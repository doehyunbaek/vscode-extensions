const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
const ARXIV_USER_AGENT = 'vaper-vscode/0.1 (https://github.com/doehyunbaek/vscode-extensions)';
const DEFAULT_RETRY_DELAY_MS = 3000;

class ArxivHttpError extends Error {
  constructor(status) {
    const message = status === 429
      ? 'arXiv rate limit reached. Please wait a moment and try again.'
      : `arXiv search returned HTTP ${status}`;
    super(message);
    this.name = 'ArxivHttpError';
    this.status = status;
  }
}

async function searchArxiv(query, options = {}) {
  const {
    signal,
    fetchImpl = fetch,
    sleep = wait,
    maxAttempts = 3
  } = options;
  const url = new URL(ARXIV_API_URL);
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', '20');
  url.searchParams.set('sortBy', 'relevance');
  url.searchParams.set('sortOrder', 'descending');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': ARXIV_USER_AGENT, Accept: 'application/atom+xml' }
    });
    if (response.ok) return parseArxivFeed(await response.text());
    if (response.status !== 429 || attempt === maxAttempts) {
      throw new ArxivHttpError(response.status);
    }

    const retryDelay = parseRetryAfter(response.headers.get('retry-after')) ??
      DEFAULT_RETRY_DELAY_MS * attempt;
    await sleep(retryDelay, signal);
  }

  return [];
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function parseArxivFeed(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => {
    const entry = match[1];
    const idUrl = xmlText(entry, 'id');
    const id = idUrl.match(/\/abs\/([^?#]+)/)?.[1] || idUrl;
    return {
      id,
      title: xmlText(entry, 'title'),
      summary: xmlText(entry, 'summary'),
      published: xmlText(entry, 'published'),
      authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
        .map(author => cleanXmlText(author[1]))
    };
  }).filter(paper => paper.id && paper.title);
}

function xmlText(xml, tag) {
  return cleanXmlText(xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '');
}

function cleanXmlText(value) {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeXmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] || entity;
    const number = code[1].toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
  });
}

const DBLP_SEARCH_ENDPOINTS = [
  'https://dblp.org/search/publ/api',
  'https://dblp.uni-trier.de/search/publ/api'
];

async function searchDblp(query, options = {}) {
  const { signal, fetchImpl = fetch, limit = 20, log = () => {} } = options;
  let lastError;

  for (const endpoint of DBLP_SEARCH_ENDPOINTS) {
    const url = new URL(endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('h', String(limit));
    url.searchParams.set('f', '0');
    url.searchParams.set('c', '0');
    const started = performance.now();
    log(`Requesting ${url}`);

    try {
      const response = await fetchImpl(url, {
        signal,
        headers: { Accept: 'application/json' }
      });
      log(`Response HTTP ${response.status} in ${formatDuration(performance.now() - started)} from ${url.origin}`);
      if (!response.ok) throw new Error(`DBLP request returned HTTP ${response.status}`);

      const data = await response.json();
      const hitsContainer = data?.result?.hits;
      const totalMatches = Number.parseInt(hitsContainer?.['@total'], 10);
      if (!hitsContainer || !Number.isFinite(totalMatches)) {
        throw new Error('DBLP returned an invalid response');
      }
      const rawHits = hitsContainer.hit == null
        ? totalMatches === 0 ? [] : undefined
        : Array.isArray(hitsContainer.hit) ? hitsContainer.hit : [hitsContainer.hit];
      if (!rawHits) throw new Error('DBLP returned an invalid response');

      const papers = rawHits.map(mapDblpHit).filter(paper => paper.title);
      log(`Found ${papers.length} publication(s) (${totalMatches} total DBLP matches)`);
      return papers;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        log(`Request cancelled after ${formatDuration(performance.now() - started)}`);
        throw error;
      }
      lastError = error;
      log(`Endpoint failed: ${url.origin} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw lastError || new Error('DBLP search is unavailable');
}

function formatDuration(milliseconds) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

async function searchDblpForArxiv(query, options = {}) {
  const papers = await searchDblp(`${query} venue:CoRR:`, options);
  const arxivPapers = papers.filter(paper => paper.id && paper.pdfUrl);
  options.log?.(`Showing ${arxivPapers.length} arXiv paper(s)`);
  return arxivPapers;
}

function mapDblpHit(hit) {
  const info = hit?.info || {};
  const id = extractArxivId(info);
  return {
    id,
    title: cleanText(info.title),
    authors: getAuthors(info.authors),
    venue: cleanText(info.venue),
    year: cleanText(info.year),
    type: cleanText(info.type),
    doi: cleanText(info.doi),
    url: normalizeHttpUrl(info.url),
    pdfUrl: id ? `https://arxiv.org/pdf/${id}` : undefined
  };
}

function extractArxivId(info) {
  const values = [info.doi, info.ee, info.volume, info.url].map(value => String(value || ''));
  for (const value of values) {
    const match = value.match(/(?:arxiv[.:/]?|abs[/-])([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i);
    if (match) return match[1];
  }
  return undefined;
}

function getAuthors(authors) {
  const values = authors?.author == null ? [] : [].concat(authors.author);
  return values
    .map(author => cleanText(typeof author === 'string' ? author : author?.text))
    .filter(Boolean);
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const MAX_RECENT_PAPERS = 10;

function normalizeRecentPapers(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(paper =>
    paper &&
    typeof paper.id === 'string' && paper.id &&
    typeof paper.title === 'string' && paper.title &&
    typeof paper.pdfUrl === 'string' && paper.pdfUrl
  ).slice(0, MAX_RECENT_PAPERS);
}

function addRecentPaper(value, paper) {
  const papers = normalizeRecentPapers(value);
  return [paper, ...papers.filter(item => item.id !== paper.id)].slice(0, MAX_RECENT_PAPERS);
}

function paperItem(paper, recent = false) {
  return {
    label: paper.title,
    description: recent ? 'Recently opened' : paper.authors?.join(', ') || 'Unknown authors',
    detail: [paper.venue, paper.year, paper.type, paper.id ? `arXiv:${paper.id} · PDF available` : '']
      .filter(Boolean).join(' · '),
    paper
  };
}

function attachSearchPicker(picker, search, options = {}) {
  const toItem = options.toItem || paperItem;
  const initialPapers = options.initialPapers || [];
  const initialItems = initialPapers.map(paper => toItem(paper, true));
  picker.items = initialItems;
  let controller;
  let requestId = 0;
  let completedQuery;
  let selectedPaper;
  let settled = false;

  const result = new Promise(resolve => {
    const finish = paper => {
      if (settled) return;
      settled = true;
      controller?.abort();
      resolve(paper);
    };

    picker.onDidChangeValue(value => {
      controller?.abort();
      ++requestId;
      completedQuery = undefined;
      picker.busy = false;
      const query = value.trim();
      if (!query) {
        picker.items = initialItems;
        picker.placeholder = initialItems.length
          ? 'Recently opened papers — type a query and press Enter to search arXiv'
          : 'Type a query and press Enter to search arXiv';
        return;
      }
      picker.placeholder = 'Press Enter to search arXiv';
    });

    picker.onDidAccept(() => {
      const query = picker.value.trim();
      if (query && query !== completedQuery) {
        const currentRequest = ++requestId;
        controller?.abort();
        controller = new AbortController();
        picker.busy = true;
        picker.placeholder = 'Searching arXiv…';
        void (async () => {
          try {
            const papers = await search(query, controller.signal);
            if (currentRequest !== requestId) return;
            papers.sort((left, right) => Number(Boolean(right.pdfUrl)) - Number(Boolean(left.pdfUrl)));
            picker.items = papers.length
              ? papers.map(toItem)
              : [{ label: 'No arXiv papers found', alwaysShow: true }];
            completedQuery = query;
            picker.placeholder = papers.length ? 'Select a publication to open' : 'Edit the query and press Enter';
          } catch (error) {
            if (error?.name === 'AbortError' || currentRequest !== requestId) return;
            picker.items = [{
              label: '$(error) arXiv search failed',
              detail: error instanceof Error ? error.message : String(error),
              alwaysShow: true
            }];
            picker.placeholder = 'Press Enter to try again';
          } finally {
            if (currentRequest === requestId) picker.busy = false;
          }
        })();
        return;
      }

      const item = picker.selectedItems[0];
      if (!item?.paper) return;
      selectedPaper = item.paper;
      picker.hide();
    });
    picker.onDidHide(() => finish(selectedPaper));
  });

  picker.show();
  return result.finally(() => picker.dispose());
}

module.exports = {
  ARXIV_USER_AGENT,
  ArxivHttpError,
  DBLP_SEARCH_ENDPOINTS,
  MAX_RECENT_PAPERS,
  addRecentPaper,
  attachSearchPicker,
  extractArxivId,
  mapDblpHit,
  normalizeRecentPapers,
  paperItem,
  parseArxivFeed,
  parseRetryAfter,
  searchArxiv,
  searchDblp,
  searchDblpForArxiv
};
