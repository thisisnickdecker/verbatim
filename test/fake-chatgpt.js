/*
 * A fake ChatGPT conversation page for tests. Reproduces the DOM structure
 * observed on chatgpt.com (October 2026) and its behaviour:
 *   - only turns near the viewport are mounted (virtualization)
 *   - older turns lazy-load when scrolled to the top ("Loading older messages…")
 * Text content is synthetic.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = [
  'src/vendor/Readability.js',
  'src/core/html-to-markdown.js',
  'src/core/enrich.js',
  'src/core/transcript.js',
  'src/core/completeness.js',
  'src/core/normalize.js',
  'src/platforms/chatgpt.js',
  'src/platforms/claude.js',
  'src/platforms/youtube.js',
  'src/platforms/spotify.js',
  'src/platforms/web.js',
  'src/platforms/registry.js',
  'src/core/exporters.js',
  'src/site/media.js',
  'src/site/crawl.js',
  'src/site/output.js',
  'src/site/zip.js',
];

// Load the extension source into a jsdom window, as the content scripts run.
function loadSource(window) {
  // jsdom lacks TextEncoder (used by the .zip writer); Chrome has it.
  if (!window.TextEncoder) window.TextEncoder = TextEncoder;
  for (const f of SRC) window.eval(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  return window.Verbatim;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let CONV = 'conv';

function userUnit(msg, expanded) {
  const collapsed = msg.collapsed && !expanded;
  const shown = collapsed ? msg.text.slice(0, 40) : msg.text;
  const attachments = (msg.attachments || [])
    .map((a) => (a.type === 'image'
      ? `<div class="att"><img src="${a.url}" alt="${esc(a.alt || '')}"></div>`
      : `<div class="att"><div class="file-tile"><div>${esc(a.name)}</div><div>PDF</div></div></div>`))
    .join('');
  return `
  <div data-chatgpt-search-unit-key="u-${msg.id}" data-chatgpt-search-message-ids="${msg.id}">
    <h4 class="sr-only">You said:</h4>
    <div data-content-search-unit-key="u-${msg.id}">
      ${attachments}
      <div><div data-user-message-bubble="true"><div><div><div data-search-result-target=""><div><div dir="auto">${esc(shown)}</div></div></div></div></div></div></div>
      ${msg.collapsed ? `<button aria-expanded="${collapsed ? 'false' : 'true'}" data-expand="${msg.id}" data-markdown-copy="exclude">${collapsed ? 'Show more' : 'Show less'}</button>` : ''}
      <div><span data-state="closed"><button aria-label="Copy message"><svg></svg></button></span></div>
      ${msg.branch ? '<div><button aria-label="Previous response"></button><div>2/2</div></div>' : ''}
    </div>
  </div>`;
}

function assistantUnit(msg) {
  if (msg.legacyWrapper) {
    // Older reply layout: no data-markdown-copy="contents" wrapper.
    return `
  <div data-content-search-unit-key="a-${msg.id}" data-chatgpt-search-unit-key="a-${msg.id}" data-chatgpt-search-message-ids="${msg.id}">
    <h4 class="sr-only" data-conversation-role="assistant">ChatGPT said:</h4>
    <div><div data-chatgpt-selection-conversation-id="${CONV}" data-chatgpt-selection-message-id="${msg.id}"><div data-markdown-text-style="assistant-message">${msg.html}</div></div></div>
  </div>`;
  }
  return `
  <div data-content-search-unit-key="a-${msg.id}" data-chatgpt-search-unit-key="a-${msg.id}" data-chatgpt-search-message-ids="${msg.id}">
    <h4 class="sr-only" data-conversation-role="assistant">ChatGPT said:</h4>
    <div>
      ${msg.reasoning ? '<button aria-expanded="false"><span>Thought for 12s</span></button>' : ''}
      <div data-chatgpt-selection-conversation-id="${CONV}" data-chatgpt-selection-message-id="${msg.id}">
        <div data-markdown-text-style="assistant-message">
          <div data-dil-source-message-id="${msg.id}" data-markdown-copy="contents">
            <div><div data-theme="dark"><div data-d-inline-reveal="">${msg.html}</div></div></div>
          </div>
          <div data-markdown-copy="exclude"><button aria-label="Copy"><svg></svg></button></div>
        </div>
      </div>
    </div>
  </div>`;
}

function turnHtml(turn, state, expanded) {
  return `<div data-turn-key="${turn.key}"><div data-content-search-turn-key="${turn.key}"><div><div data-talvt-turn-state="${state || 'complete'}"><div><div>
    ${userUnit(turn.user, expanded && expanded.has(turn.user.id))}</div><div>${turn.assistant ? assistantUnit(turn.assistant) : ''}
  </div></div></div></div></div></div>`;
}

/**
 * opts:
 *   turns           array of { key, user:{id,text,attachments}, assistant:{id,html} }
 *   initiallyLoaded number of most-recent turns loaded before lazy loading (default all)
 *   loadBatch       turns loaded per "Loading older messages" (default 10)
 *   neverFinishLoading  keep showing the loading indicator forever
 *   jumpAt          scrollTop at which the page jumps forward (simulates a gap)
 *   placeholderKeys turn keys that never finish rendering
 *   streaming       show a stop button
 */
function createPage(opts) {
  const H = 1000; // px per turn
  const conversationId = opts.conversationId || '0a1b2c3d-0000-4000-8000-00000000c0de';
  const VIEW = 800;
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${esc(opts.title || 'Test conversation')}</title></head><body><main>
      ${opts.staleView ? `<div data-app-action-timeline-scroll="" class="stale"><div class="list">${(CONV = 'other-conversation-id', opts.staleView.map((t) => turnHtml(t, 'complete')).join(''))}</div></div>` : ''}
      <div data-app-action-timeline-scroll="" style="overflow-y:auto"><div class="older"></div><div class="list"></div></div>
      ${opts.streaming ? '<button data-testid="stop-button"></button>' : ''}
    </main></body></html>`,
    { url: 'https://chatgpt.com/c/' + conversationId, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  CONV = opts.foreignIds ? 'foreign-conversation-id' : conversationId;
  const doc = window.document;
  const scroller = doc.querySelector('[data-app-action-timeline-scroll]:not(.stale)');
  const list = scroller.querySelector('.list');
  const older = scroller.querySelector('.older');

  const total = opts.turns.length;
  let loaded = Math.min(total, opts.initiallyLoaded || total);
  let top = (loaded * H) - VIEW; // start at the bottom like ChatGPT does
  let pendingLoad = false;
  let jumped = false;
  // Expansion state is lost when a turn unmounts, like the real page.
  let expanded = new Set();

  const firstLoaded = () => total - loaded;
  const height = () => loaded * H;

  function render() {
    list.innerHTML = '';
    const from = Math.max(0, Math.floor((top - H) / H));
    const to = Math.min(loaded - 1, Math.floor((top + VIEW + H) / H));
    let html = '';
    for (let i = from; i <= to; i++) {
      const t = opts.turns[firstLoaded() + i];
      html += turnHtml(t, (opts.placeholderKeys || []).includes(t.key) ? 'pending' : 'complete', expanded);
    }
    list.innerHTML = html;
    older.innerHTML = pendingLoad || opts.neverFinishLoading ? '<span class="sr-only">Loading older messages…</span>' : '';
  }

  Object.defineProperty(scroller, 'clientHeight', { get: () => VIEW });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => height() });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v) => {
      top = Math.max(0, Math.min(height() - VIEW, v));
      if (opts.jumpAt != null && !jumped && top >= opts.jumpAt) {
        jumped = true;
        top = Math.min(height() - VIEW, top + 4 * H);
      }
      if (top === 0 && loaded < total) pendingLoad = true;
      render();
    },
  });

  // The adapter's sleep() is where "time passes": finish any lazy load.
  function sleep() {
    if (pendingLoad) {
      const add = Math.min(opts.loadBatch || 10, total - loaded);
      loaded += add;
      top += add * H; // keep the same content in view, like a real chat app
      pendingLoad = false;
      render();
    }
    return Promise.resolve();
  }

  doc.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-expand]');
    if (b && !opts.expandBroken) {
      expanded.add(b.getAttribute('data-expand'));
      render();
    }
  });

  render();
  return { window, doc, sleep, V: loadSource(window) };
}

async function capture(opts) {
  const page = createPage(opts);
  const platform = page.V.findPlatform(page.window.location.href);
  const raw = await platform.collect({
    document: page.doc,
    url: page.window.location.href,
    sleep: page.sleep,
    timing: { expandWait: 0, settle: 0, step: 0, renderWait: 0, topTimeout: opts.topTimeout || 5000, maxDuration: 60000 },
  });
  const conv = page.V.normalize(raw, { version: require('../manifest.json').version, capturedAt: '2026-10-27T18:00:00.000Z' });
  return { page, raw, conv, md: page.V.exporters.toMarkdown(conv), json: page.V.exporters.toJSON(conv) };
}

function simpleTurns(n, prefix) {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix || 'turn'}-${String(i + 1).padStart(4, '0')}`,
    user: { id: `u${i + 1}`, text: `Question number ${i + 1}` },
    assistant: { id: `a${i + 1}`, html: `<p data-d-component="text">Answer number ${i + 1}</p>` },
  }));
}

module.exports = { createPage, capture, simpleTurns, loadSource };
