const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ArxivHttpError,
  addRecentPaper,
  attachSearchPicker,
  normalizeRecentPapers,
  parseArxivFeed,
  searchArxiv,
  searchDblp,
  searchDblpForArxiv
} = require('../paper-search');

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2501.01234v2</id>
    <updated>2025-01-03T00:00:00Z</updated>
    <published>2025-01-02T00:00:00Z</published>
    <title>WASM-R3: Repairing WebAssembly</title>
    <summary>A &amp; B &lt;test&gt;.</summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Example</name></author>
  </entry>
</feed>`;

function atomResponse(status, body = '', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    text: async () => body
  };
}

test('parseArxivFeed extracts paper metadata and decodes XML', () => {
  assert.deepEqual(parseArxivFeed(FEED), [{
    id: '2501.01234v2',
    title: 'WASM-R3: Repairing WebAssembly',
    summary: 'A & B <test>.',
    published: '2025-01-02T00:00:00Z',
    authors: ['Alice Example', 'Bob Example']
  }]);
});

test('searchArxiv encodes the query and returns parsed results', async () => {
  let requestedUrl;
  const papers = await searchArxiv('wasm-r3', {
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      assert.equal(options.headers.Accept, 'application/atom+xml');
      return atomResponse(200, FEED);
    },
    sleep: async () => {}
  });

  assert.equal(requestedUrl.searchParams.get('search_query'), 'all:wasm-r3');
  assert.equal(requestedUrl.searchParams.get('max_results'), '20');
  assert.equal(papers[0].id, '2501.01234v2');
});

test('searchArxiv retries HTTP 429 using Retry-After', async () => {
  const waits = [];
  let requests = 0;
  const papers = await searchArxiv('wasm-r3', {
    fetchImpl: async () => {
      requests += 1;
      return requests === 1
        ? atomResponse(429, '', { 'retry-after': '2' })
        : atomResponse(200, FEED);
    },
    sleep: async milliseconds => waits.push(milliseconds)
  });

  assert.equal(requests, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(papers.length, 1);
});

test('searchArxiv reports a useful error after repeated rate limits', async () => {
  await assert.rejects(
    searchArxiv('wasm-r3', {
      fetchImpl: async () => atomResponse(429),
      sleep: async () => {},
      maxAttempts: 2
    }),
    error => error instanceof ArxivHttpError &&
      error.status === 429 &&
      /rate limit/i.test(error.message) &&
      /try again/i.test(error.message)
  );
});

const RESULT = {
  result: {
    hits: {
      '@total': '2',
      hit: [
        {
          info: {
            authors: { author: [{ text: 'Doehyun Baek' }, { text: 'Jakob Getz' }] },
            title: 'Wasm-R3: Record-Reduce-Replay for Realistic and Standalone WebAssembly Benchmarks.',
            venue: 'CoRR',
            volume: 'abs/2409.00708',
            year: '2024',
            type: 'Informal and Other Publications',
            doi: '10.48550/ARXIV.2409.00708',
            ee: 'https://doi.org/10.48550/arXiv.2409.00708',
            url: 'https://dblp.org/rec/journals/corr/abs-2409-00708'
          }
        },
        {
          info: {
            authors: { author: 'Ada Lovelace' },
            title: 'A Publisher Paper.',
            venue: 'ICSE',
            year: '2025',
            doi: '10.1145/example',
            url: 'https://dblp.org/rec/conf/icse/example'
          }
        }
      ]
    }
  }
};

function dblpResponse(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

test('searchDblp queries the fast endpoint and maps wasm-r3 to an arXiv PDF', async () => {
  let requestedUrl;
  const papers = await searchDblp('wasm-r3', {
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      assert.equal(options.headers.Accept, 'application/json');
      return dblpResponse(200, RESULT);
    }
  });

  assert.equal(requestedUrl.origin, 'https://dblp.org');
  assert.equal(requestedUrl.searchParams.get('q'), 'wasm-r3');
  assert.equal(requestedUrl.searchParams.get('format'), 'json');
  assert.equal(requestedUrl.searchParams.get('h'), '20');
  assert.deepEqual(papers[0], {
    id: '2409.00708',
    title: 'Wasm-R3: Record-Reduce-Replay for Realistic and Standalone WebAssembly Benchmarks.',
    authors: ['Doehyun Baek', 'Jakob Getz'],
    venue: 'CoRR',
    year: '2024',
    type: 'Informal and Other Publications',
    doi: '10.48550/ARXIV.2409.00708',
    url: 'https://dblp.org/rec/journals/corr/abs-2409-00708',
    pdfUrl: 'https://arxiv.org/pdf/2409.00708'
  });
});

test('searchDblpForArxiv restricts the DBLP query to CoRR and filters defensively', async () => {
  const messages = [];
  let requestedUrl;
  const papers = await searchDblpForArxiv('wasm-r3', {
    fetchImpl: async url => {
      requestedUrl = new URL(url);
      return dblpResponse(200, RESULT);
    },
    log: message => messages.push(message)
  });

  assert.equal(requestedUrl.searchParams.get('q'), 'wasm-r3 venue:CoRR:');

  assert.equal(papers.length, 1);
  assert.equal(papers[0].id, '2409.00708');
  assert.ok(papers.every(paper => paper.pdfUrl));
  assert.equal(messages.at(-1), 'Showing 1 arXiv paper(s)');
});

test('searchDblp handles a single author and publications without direct PDFs', async () => {
  const papers = await searchDblp('publisher', {
    fetchImpl: async () => dblpResponse(200, RESULT)
  });

  assert.deepEqual(papers[1].authors, ['Ada Lovelace']);
  assert.equal(papers[1].id, undefined);
  assert.equal(papers[1].pdfUrl, undefined);
  assert.equal(papers[1].url, 'https://dblp.org/rec/conf/icse/example');
});

test('searchDblp falls back when dblp.org fails', async () => {
  const origins = [];
  const papers = await searchDblp('wasm-r3', {
    fetchImpl: async url => {
      origins.push(new URL(url).origin);
      return origins.length === 1 ? dblpResponse(503) : dblpResponse(200, RESULT);
    }
  });

  assert.deepEqual(origins, ['https://dblp.org', 'https://dblp.uni-trier.de']);
  assert.equal(papers.length, 2);
});

test('searchDblp treats a zero-match response without hit as valid', async () => {
  const messages = [];
  const papers = await searchDblp('no-such-paper', {
    fetchImpl: async () => dblpResponse(200, {
      result: { hits: { '@total': '0' } }
    }),
    log: message => messages.push(message)
  });

  assert.deepEqual(papers, []);
  assert.match(messages[0], /^Requesting https:\/\/dblp\.org\/search\/publ\/api/);
  assert.match(messages[1], /^Response HTTP 200 in \d+ ms/);
  assert.equal(messages[2], 'Found 0 publication(s) (0 total DBLP matches)');
});

test('searchDblp logs endpoint failure before using the fallback', async () => {
  const messages = [];
  let requests = 0;
  await searchDblp('wasm-r3', {
    fetchImpl: async () => ++requests === 1 ? dblpResponse(503) : dblpResponse(200, RESULT),
    log: message => messages.push(message)
  });

  assert.ok(messages.some(message => /Response HTTP 503 in \d+ ms/.test(message)));
  assert.ok(messages.some(message => /Endpoint failed:.*HTTP 503/.test(message)));
  assert.ok(messages.some(message => /dblp\.uni-trier\.de/.test(message)));
  assert.ok(messages.some(message => /Found 2 publication\(s\)/.test(message)));
});

test('searchDblp rejects malformed API results', async () => {
  await assert.rejects(
    searchDblp('wasm-r3', { fetchImpl: async () => dblpResponse(200, { result: {} }) }),
    /invalid response/i
  );
});

const wasm = {
  id: '2409.00708',
  title: 'Wasm-R3',
  authors: ['Doehyun Baek'],
  venue: 'CoRR',
  year: '2024',
  type: 'Informal and Other Publications',
  pdfUrl: 'https://arxiv.org/pdf/2409.00708'
};

test('addRecentPaper puts the newest paper first and removes duplicates', () => {
  const older = { ...wasm, id: '2501.00001', title: 'Older paper', pdfUrl: 'https://arxiv.org/pdf/2501.00001' };
  assert.deepEqual(addRecentPaper([wasm, older], older).map(paper => paper.id), [older.id, wasm.id]);
});

test('recent paper history is bounded', () => {
  let papers = [];
  for (let index = 0; index < 25; index += 1) {
    papers = addRecentPaper(papers, {
      ...wasm,
      id: `2501.${String(index).padStart(5, '0')}`,
      pdfUrl: `https://arxiv.org/pdf/2501.${String(index).padStart(5, '0')}`
    });
  }
  assert.equal(papers.length, 10);
  assert.equal(papers[0].id, '2501.00024');
});

test('normalizeRecentPapers discards malformed stored entries', () => {
  assert.deepEqual(normalizeRecentPapers([wasm, null, { title: 'Missing ID' }, { id: 'bad', title: '' }]), [wasm]);
});

function fakePicker() {
  const handlers = { change: [], accept: [], hide: [] };
  return {
    value: '',
    items: [],
    selectedItems: [],
    busy: false,
    placeholder: '',
    visible: false,
    disposed: false,
    onDidChangeValue(handler) { handlers.change.push(handler); return { dispose() {} }; },
    onDidAccept(handler) { handlers.accept.push(handler); return { dispose() {} }; },
    onDidHide(handler) { handlers.hide.push(handler); return { dispose() {} }; },
    show() { this.visible = true; },
    hide() { this.visible = false; handlers.hide.forEach(handler => handler()); },
    dispose() { this.disposed = true; },
    change(value) { this.value = value; handlers.change.forEach(handler => handler(value)); },
    accept(item) { this.selectedItems = item ? [item] : []; handlers.accept.forEach(handler => handler()); }
  };
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 5));
}

test('recent papers are shown initially and restored when the query is cleared', async () => {
  const picker = fakePicker();
  const recent = { title: 'Recently opened', id: '2409.00708', authors: [] };
  attachSearchPicker(picker, async () => [], { delay: 0, initialPapers: [recent] });

  assert.equal(picker.items[0].label, 'Recently opened');
  assert.equal(picker.items[0].description, 'Recently opened');
  picker.change('query');
  await flush();
  picker.change('');
  assert.equal(picker.items[0].paper, recent);
  picker.hide();
});

test('search results update in the same visible picker', async () => {
  const picker = fakePicker();
  const paper = { title: 'Wasm-R3' };
  const selected = attachSearchPicker(picker, async query => {
    assert.equal(query, 'wasm-r3');
    return [paper];
  }, { delay: 0 });

  picker.show();
  picker.change('wasm-r3');
  await flush();
  await flush();

  assert.equal(picker.visible, true);
  assert.equal(picker.busy, false);
  assert.equal(picker.items[0].paper, paper);
  picker.accept(picker.items[0]);
  assert.equal(await selected, paper);
  assert.equal(picker.visible, false);
});

test('a newer query replaces an older search without closing the picker', async () => {
  const picker = fakePicker();
  const pending = new Map();
  attachSearchPicker(picker, (query, signal) => new Promise(resolve => {
    pending.set(query, { resolve, signal });
  }), { delay: 0 });

  picker.show();
  picker.change('wasm');
  await flush();
  picker.change('wasm-r3');
  await flush();

  assert.equal(pending.get('wasm').signal.aborted, true);
  pending.get('wasm-r3').resolve([{ title: 'Wasm-R3' }]);
  await flush();
  assert.equal(picker.visible, true);
  assert.equal(picker.items[0].label, 'Wasm-R3');
  picker.hide();
});
