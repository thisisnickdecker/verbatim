const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { capture, simpleTurns, loadSource } = require('./fake-chatgpt');
const { captureClaude } = require('./fake-claude');

const plain = (v) => JSON.parse(JSON.stringify(v));

function claudeMessages(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', text: `Prompt ${i + 1}. What should we try next?` });
    out.push({ role: 'assistant', html: `<h2>Reply ${i + 1}</h2><p>First idea for ${i + 1}. More detail follows.</p><ul><li>one</li><li>two</li></ul>` });
  }
  return out;
}

// ---------- Claude.ai ----------

test('claude: virtualized transcript is captured in order and count-verified', async () => {
  const { conv, raw } = await captureClaude({ messages: claudeMessages(15), title: 'Claude long chat' });
  assert.equal(conv.stats.messageCount, 30);
  assert.equal(raw.evidence.expectedMessages, 30);
  assert.deepEqual(plain(raw.evidence.missingIndices), []);
  assert.equal(conv.completeness.checks.find((c) => c.id === 'count_matches').result, 'pass');
  assert.equal(conv.completeness.status, 'verified');
  assert.equal(conv.title, 'Claude long chat');
  assert.equal(conv.messages[0].role, 'user');
  assert.equal(conv.messages[29].content.markdown, '## Reply 15\n\nFirst idea for 15. More detail follows.\n\n- one\n- two');
  assert.equal(conv.source.platformName, 'Claude');
});

test('claude: thinking is excluded, files and artifacts are listed', async () => {
  const messages = [
    { role: 'user', text: 'Here are my notes.\n\nPlease review.', files: ['Pasted text.txt'] },
    { role: 'assistant', thinking: 'Planning a review', html: '<p>Done. See the spec.</p><pre><code>npm test</code></pre>', artifacts: ['Spec'] },
  ];
  const { conv } = await captureClaude({ messages });
  const [u, a] = conv.messages;
  assert.equal(u.content.markdown, 'Here are my notes.\n\nPlease review.');
  assert.deepEqual(plain(u.attachments), [{ type: 'file', name: 'Pasted text.txt' }]);
  assert.ok(!a.content.markdown.includes('HIDDEN REASONING'));
  assert.ok(a.content.markdown.includes('```\nnpm test\n```'));
  assert.ok(a.flags.includes('collapsed-reasoning-not-captured'));
  assert.deepEqual(plain(a.attachments), [{ type: 'file', name: 'Spec', note: 'artifact (content not captured)' }]);
});

test('claude: a message that is only an attachment is still yours', async () => {
  const messages = [
    { role: 'user', text: 'Read this.' },
    { role: 'assistant', html: '<p>Send it over.</p>' },
    { role: 'user', text: '', files: ['Pasted text.txt'] },
    { role: 'assistant', html: '<p>Got it.</p>' },
  ];
  const { conv } = await captureClaude({ messages });
  assert.equal(conv.messages[2].role, 'user');
  assert.deepEqual(plain(conv.messages[2].attachments), [{ type: 'file', name: 'Pasted text.txt' }]);
  assert.equal(conv.completeness.status, 'verified');
});

test('claude: a message that never renders -> incomplete via the count check', async () => {
  const { conv } = await captureClaude({ messages: claudeMessages(6), dropIndex: 5 });
  const check = conv.completeness.checks.find((c) => c.id === 'count_matches');
  assert.equal(check.result, 'fail');
  assert.match(check.detail, /positions 6/);
  assert.equal(conv.completeness.status, 'incomplete');
});

test('claude: a hidden view of another chat is ignored', async () => {
  const { conv } = await captureClaude({ messages: claudeMessages(2), stale: true });
  assert.equal(conv.stats.messageCount, 4);
  assert.ok(conv.messages.every((m) => !m.content.markdown.includes('STALE')));
});

// ---------- any web page ----------

function webPage(html, url) {
  const dom = new JSDOM(html, { url: url || 'https://example.com/journal/grid-systems', runScripts: 'outside-only' });
  return { window: dom.window, doc: dom.window.document, CC: loadSource(dom.window) };
}

const ARTICLE = `<!doctype html><html lang="en"><head><title>On the Grid | Example Journal</title>
  <meta name="description" content="A short history of the grid."><meta name="author" content="A. Writer"></head><body>
  <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
  <div class="cookie-banner">We use cookies. Accept?</div>
  <main><article><h1>On the Grid</h1>
    ${Array.from({ length: 6 }, (_, i) => `<h2>Part ${i + 1}</h2><p>The grid organizes the page into a rhythm the reader can feel. Paragraph ${i + 1} explains why designers from Müller-Brockmann onward relied on it, and why spreadsheets inherited the same logic decades later.</p>`).join('')}
    <p>Read <a href="https://example.org/source">the original essay</a>.</p>
    <pre><code class="language-css">.grid { display: grid; }</code></pre>
  </article></main>
  <footer>© Example Journal · <a href="/privacy">Privacy</a></footer></body></html>`;

test('web: article content becomes Markdown without navigation, banners or footer', async () => {
  const { doc, window, CC } = webPage(ARTICLE);
  assert.equal(CC.findPlatform(window.location.href).id, 'web');
  const raw = await CC.platforms.web.collect({ document: doc, url: window.location.href });
  const page = CC.normalize(raw, { capturedAt: '2026-10-27T18:00:00.000Z' });
  const md = page.content.markdown;
  assert.equal(page.kind, 'page');
  assert.ok(md.includes('## Part 3'));
  assert.ok(md.includes('[the original essay](https://example.org/source)'));
  assert.ok(md.includes('```css\n.grid { display: grid; }\n```'));
  for (const junk of ['Home', 'cookies', 'Privacy']) assert.ok(!md.includes(junk), `should not contain ${junk}`);
  assert.equal(page.completeness.status, 'captured');
  assert.equal(page.source.byline, 'A. Writer');
  assert.equal(page.source.description, 'A short history of the grid.');
  assert.ok(page.enrichment.outline.some((o) => o.text === 'Part 6'));
  const out = CC.exporters.toMarkdown(page);
  assert.match(out, /^---\ntitle: /);
  assert.match(out, /kind: "page"/);
});

test('web: an empty page is reported, not claimed', async () => {
  const { doc, window, CC } = webPage('<!doctype html><html><head><title>Empty</title></head><body><nav>Menu</nav></body></html>');
  const page = CC.normalize(await CC.platforms.web.collect({ document: doc, url: window.location.href }));
  assert.equal(page.completeness.status, 'incomplete');
});

// ---------- enrichment, handoff, files ----------

const ENRICH_TURNS = [
  {
    key: 't1',
    user: { id: 'u1', text: 'I read https://example.com/essay today. How do grids relate to spreadsheets? Also, which books cover this?' },
    assistant: { id: 'a1', html: '<p>Grids and tables share a lineage. See <a href="https://example.org/history">this history</a>.</p><p>Second paragraph that should be condensed away. It is long.</p><ul><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li></ul>' },
  },
  {
    key: 't2',
    user: { id: 'u2', text: 'Great, make a plan.' },
    assistant: { id: 'a2', html: '<h2>Plan</h2><p>Step one. Step two.</p>' },
  },
];

test('enrichment: outline, word split, questions and links', async () => {
  const { conv } = await capture({ turns: ENRICH_TURNS });
  const e = conv.enrichment;
  assert.deepEqual(plain(e.outline.map((o) => o.messageIndex)), [1, 3]);
  assert.equal(e.outline[1].text, 'Great, make a plan.');
  assert.deepEqual(plain(e.questions.map((q) => q.text)), ['How do grids relate to spreadsheets?', 'Also, which books cover this?']);
  assert.deepEqual(plain(e.links.map((l) => l.url)), ['https://example.com/essay', 'https://example.org/history']);
  assert.ok(e.contributions.userWords > 0 && e.contributions.assistantWords > 0);
  assert.ok(e.contributions.userShare > 0 && e.contributions.userShare < 100);
});

test('handoff: instructions, my words verbatim, condensed replies, last reply in full', async () => {
  const { conv, page } = await capture({ turns: ENRICH_TURNS, title: 'Grids' });
  const h = page.CC.exporters.toHandoff(conv);
  assert.match(h, /## Instructions for the assistant/);
  assert.ok(h.includes(ENRICH_TURNS[0].user.text), 'user text is verbatim');
  assert.match(h, /### 2\. ChatGPT \(condensed from \d+ words\)/);
  assert.ok(h.includes('Second paragraph that should be condensed away.'), 'first sentence of each paragraph kept');
  assert.ok(!h.includes('It is long.'), 'later sentences dropped');
  assert.ok(h.includes('- d\n- …'), 'long lists are shortened');
  assert.match(h, /### 4\. ChatGPT \(latest reply, in full\)\n\n## Plan\n\nStep one\. Step two\./);
  assert.match(h, /\*\*Questions I raised:\*\*/);
});

test('files: local-time folder, title-based names, three files per conversation', async () => {
  const { conv, page } = await capture({ turns: simpleTurns(1), title: 'Spreadsheet: Art/Books?' });
  const files = page.CC.exporters.filesFor(conv);
  assert.equal(files.length, 3);
  const d = new Date('2026-10-27T18:00:00.000Z');
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  assert.equal(files[0].filename, `Verbatim/${stamp} ChatGPT — Spreadsheet Art Books/Spreadsheet Art Books.md`);
  assert.ok(files[2].filename.endsWith('Spreadsheet Art Books — handoff.md'));
  for (const f of files) assert.ok(!/[:*?"<>|]/.test(f.filename), 'no characters Chrome rejects');
});
