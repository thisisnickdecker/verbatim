/*
 * A fake claude.ai conversation page for tests, reproducing the DOM structure
 * observed on claude.ai (October 2026): one virtualized row per message, each
 * labelled "Message N of TOTAL". Text content is synthetic.
 */
const { JSDOM } = require('jsdom');
const { loadSource } = require('./fake-chatgpt');

const CONV = '0a1b2c3d-0000-4000-8000-00000000c1a0';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function rowHtml(m, i, total) {
  const head = `<div data-index="${i}" data-rs-index="${i}" data-testid="transcript-row" data-perf-row="${m.role === 'user' ? 'human' : 'assistant'}">
    <div role="article" aria-label="Message ${i + 1} of ${total}"><div data-mini-claude-message=""><div data-transcript-row="">`;
  const tail = `</div></div></div></div>`;
  if (m.role === 'user') {
    const files = (m.files || []).map((f) => `<div data-testid="file-thumbnail"><span role="button" aria-label="${esc(f)}"></span><div>${esc(f)}</div></div>`).join('');
    return `${head}<h3 data-find-omitted="">You said: ${esc((m.text || '').slice(0, 20))}</h3><div data-user-scope=""><div>${files}</div>
      ${m.text ? `<div data-testid="user-message">${m.text.split('\n\n').map((p) => `<p>${esc(p)}</p>`).join('')}</div>` : ''}
      <div data-testid="user-message-actions"><button aria-label="Edit"></button></div></div>${tail}`;
  }
  const thinking = m.thinking ? `<div data-closed="" data-state="closed"><span role="status">${esc(m.thinking)}</span><div class="standard-markdown"><p>HIDDEN REASONING</p></div></div>` : '';
  const cards = (m.artifacts || []).map((a) => `<div data-testid="file-card-block"><button aria-label="View ${esc(a)}"></button><button aria-label="Download ${esc(a)}"></button>${esc(a)}Document·MD</div>`).join('');
  return `${head}<h3 data-find-omitted="">Claude responded: x</h3><div data-reply-scope=""><div data-testid="assistant-message">
    ${thinking}<div data-transcript-engine-root=""><div class="prose"><div data-perf-reply-text="" class="standard-markdown">${m.html}</div></div></div>
    ${cards}<div data-testid="message-actions"><button aria-label="Copy"></button></div></div></div>${tail}`;
}

/**
 * opts.messages  [{ role: 'user'|'assistant', text | html, files, thinking, artifacts }]
 * opts.dropIndex a row index that never renders (simulates a gap)
 * opts.stale     render a hidden view of another conversation first
 */
function createClaudePage(opts) {
  const H = 600;
  const VIEW = 800;
  const total = opts.messages.length;
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${esc(opts.title || 'Claude test')} - Claude</title></head><body>
      ${opts.stale ? `<div data-conv-id="someone-else" class="stale"><div data-autoscroll-container=""><div data-testid="transcript-list">${rowHtml({ role: 'user', text: 'STALE CHAT' }, 0, 1)}</div></div></div>` : ''}
      <div data-conv-id="${CONV}" class="live"><div data-autoscroll-container=""><div data-testid="transcript-list"></div></div></div>
    </body></html>`,
    { url: `https://claude.ai/chat/${CONV}`, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  const doc = window.document;
  const live = doc.querySelector('.live');
  const scroller = live.querySelector('[data-autoscroll-container]');
  const list = live.querySelector('[data-testid="transcript-list"]');
  let top = total * H - VIEW;

  function render() {
    const from = Math.max(0, Math.floor(top / H) - 1);
    const to = Math.min(total - 1, Math.floor((top + VIEW) / H) + 1);
    let html = '';
    for (let i = from; i <= to; i++) if (i !== opts.dropIndex) html += rowHtml(opts.messages[i], i, total);
    list.innerHTML = html;
  }
  Object.defineProperty(live, 'clientHeight', { get: () => VIEW });
  Object.defineProperty(scroller, 'clientHeight', { get: () => VIEW });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => total * H });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v) => {
      top = Math.max(0, Math.min(total * H - VIEW, v));
      render();
    },
  });
  render();
  return { window, doc, V: loadSource(window) };
}

async function captureClaude(opts) {
  const page = createClaudePage(opts);
  const raw = await page.V.findPlatform(page.window.location.href).collect({
    document: page.doc,
    url: page.window.location.href,
    sleep: () => Promise.resolve(),
    timing: { settle: 0, step: 0, renderWait: 0, topTimeout: 5000, maxDuration: 60000 },
  });
  const conv = page.V.normalize(raw, { version: 'test', capturedAt: '2026-10-27T18:00:00.000Z' });
  return { page, raw, conv };
}

module.exports = { createClaudePage, captureClaude, CONV };
