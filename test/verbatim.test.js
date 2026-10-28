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
  return { window: dom.window, doc: dom.window.document, V: loadSource(dom.window) };
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
  const { doc, window, V } = webPage(ARTICLE);
  assert.equal(V.findPlatform(window.location.href).id, 'web');
  const raw = await V.platforms.web.collect({ document: doc, url: window.location.href });
  const page = V.normalize(raw, { capturedAt: '2026-10-27T18:00:00.000Z' });
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
  const out = V.exporters.toMarkdown(page);
  assert.match(out, /^---\ntitle: /);
  assert.match(out, /kind: "page"/);
});

test('web: an empty page is reported, not claimed', async () => {
  const { doc, window, V } = webPage('<!doctype html><html><head><title>Empty</title></head><body><nav>Menu</nav></body></html>');
  const page = V.normalize(await V.platforms.web.collect({ document: doc, url: window.location.href }));
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
  const h = page.V.exporters.toHandoff(conv);
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
  const files = page.V.exporters.filesFor(conv);
  assert.equal(files.length, 3);
  const d = new Date('2026-10-27T18:00:00.000Z');
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  assert.equal(files[0].filename, `Verbatim/${stamp} ChatGPT — Spreadsheet Art Books/Spreadsheet Art Books.md`);
  assert.ok(files[2].filename.endsWith('Spreadsheet Art Books — handoff.md'));
  for (const f of files) assert.ok(!/[:*?"<>|]/.test(f.filename), 'no characters Chrome rejects');
});

// ---------- save folder ----------

// Minimal in-memory stand-in for a FileSystemDirectoryHandle.
function memoryFolder(name) {
  const entries = new Map();
  return {
    name,
    entries,
    async getDirectoryHandle(n, opts) {
      if (!entries.has(n)) {
        if (!opts || !opts.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        entries.set(n, memoryFolder(n));
      }
      return entries.get(n);
    },
    async getFileHandle(n) {
      return {
        async createWritable() {
          let text = '';
          return { async write(t) { text += t; }, async close() { entries.set(n, text); } };
        },
      };
    },
  };
}

test('save folder: files land in a dated subfolder, never overwriting', async () => {
  const { conv, page } = await capture({ turns: simpleTurns(1), title: 'Folder test' });
  page.window.eval(require('fs').readFileSync(require('path').join(__dirname, '..', 'src/settings/folder.js'), 'utf8'));
  const F = page.V.saveFolder;
  const files = page.V.exporters.filesFor(conv);
  const vault = memoryFolder('Conversation Capture');

  const first = await F.writeFiles(vault, files);
  const sub = files[0].filename.split('/')[1];
  assert.equal(first.folder, 'Conversation Capture');
  assert.equal(first.subfolder, sub);
  assert.deepEqual([...vault.entries.get(sub).entries.keys()], ['Folder test.md', 'Folder test.json', 'Folder test — handoff.md']);
  assert.equal(vault.entries.get(sub).entries.get('Folder test.md'), files[0].text);

  const second = await F.writeFiles(vault, files);
  assert.equal(second.subfolder, `${sub} (2)`, 'a second capture in the same minute gets its own folder');
});

// ---------- local save helper (native messaging host) ----------

test('save helper: writes into the configured folder, never overwrites, refuses escapes', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-'));
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ saveFolder: vault }));
  const call = (msg) => {
    const body = Buffer.from(JSON.stringify(msg));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length);
    const out = execFileSync(path.join(__dirname, '..', 'native', 'verbatim_host.py'), {
      input: Buffer.concat([len, body]),
      env: { ...process.env, VERBATIM_CONFIG: path.join(tmp, 'config.json') },
    });
    return JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString());
  };
  const files = [{ filename: 'Verbatim/2026-10-28 00-01 Claude — T/T.md', text: '# T' }];
  assert.equal(call({ type: 'save', files }).subfolder, '2026-10-28 00-01 Claude — T');
  assert.equal(call({ type: 'save', files }).subfolder, '2026-10-28 00-01 Claude — T (2)');
  assert.equal(fs.readFileSync(path.join(vault, '2026-10-28 00-01 Claude — T', 'T.md'), 'utf8'), '# T');
  assert.equal(call({ type: 'save', files: [{ filename: 'Verbatim/../x/y.md', text: '' }] }).ok, false);
  assert.ok(!fs.existsSync(path.join(tmp, 'x')));
  fs.rmSync(tmp, { recursive: true });
});

// ---------- transcripts: YouTube and Spotify ----------

const { createYouTubePage, createSpotifyPage, captureMedia } = require('./fake-media');

function speech(n, every) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push({ start: i * (every || 9), text: i % 4 === 3 ? `Line ${i + 1} ends a thought.` : `line ${i + 1} keeps going and` });
  return lines;
}

test('youtube: opens "Show transcript", reads every segment, chapters and metadata', async () => {
  const segments = speech(400); // 0:00 .. 59:51
  const chapters = [{ start: 0, title: 'Chapter 1: Why the dog became the mascot' }, { start: 9 * 200, title: 'Chapter 2: The rebrand' }];
  const page = createYouTubePage({ segments, chapters, duration: 3600, title: 'Alli Peters: Dragging the Democrats Into a New Creative Era' });
  const { tr, raw, platform } = await captureMedia(page);
  assert.equal(platform.id, 'youtube');
  assert.equal(raw.evidence.panelOpened, true);
  assert.equal(tr.kind, 'transcript');
  assert.equal(tr.stats.segments, 400);
  assert.equal(tr.segments[399].start, 3591);
  assert.equal(tr.title, 'Alli Peters: Dragging the Democrats Into a New Creative Era');
  assert.equal(tr.source.show, 'The Creative Caucus');
  assert.equal(tr.source.url, 'https://www.youtube.com/watch?v=FquRuBqglg4');
  assert.equal(tr.source.durationSec, 3600);
  assert.deepEqual(plain(tr.chapters.map((c) => c.start)), [0, 1800]);
  assert.equal(tr.completeness.status, 'verified');

  const md = page.V.exporters.toMarkdown(tr);
  assert.match(md, /^---\ntitle: "Alli Peters/);
  assert.match(md, /channel: "The Creative Caucus"/);
  assert.match(md, /duration: "1:00:00"/);
  assert.match(md, /## Chapters\n\n- \[0:00\]\(https:\/\/www\.youtube\.com\/watch\?v=FquRuBqglg4&t=0s\) Chapter 1/);
  assert.match(md, /### Chapter 2: The rebrand\n\n\*\*\[30:00\]\(https:\/\/www\.youtube\.com\/watch\?v=FquRuBqglg4&t=1800s\)\*\* line 201/);
  assert.match(md, /## Links in the description\n\n- \[https:\/\/example\.com\/notes\]/);
  // Paragraphs, not one line per caption.
  const paras = page.V.exporters.paragraphs(tr);
  assert.ok(paras.length > 30 && paras.length < 100, `${paras.length} paragraphs`);
  assert.ok(paras.every((p) => p.count >= 1));

  const files = page.V.exporters.filesFor(tr);
  assert.deepEqual(plain(files.map((f) => f.filename.split('/').pop())), [
    'Alli Peters Dragging the Democrats Into a New Creative Era.md',
    'Alli Peters Dragging the Democrats Into a New Creative Era.json',
  ]);
  assert.match(files[0].filename, /^Verbatim\/\d{4}-\d\d-\d\d \d\d-\d\d YouTube — /);
  assert.equal(page.V.exporters.savedLine(tr), `Transcript saved (${tr.stats.words.toLocaleString('en-US')} words, 400 segments).`);
});

test('youtube: the older transcript panel layout is read too', async () => {
  const page = createYouTubePage({ segments: speech(50, 10), duration: 500, legacy: true });
  const { tr } = await captureMedia(page);
  assert.equal(tr.stats.segments, 50);
  assert.equal(tr.segments[1].text, 'line 2 keeps going and');
  assert.equal(tr.completeness.status, 'verified');
});

test('youtube: a transcript that stops early is incomplete', async () => {
  const page = createYouTubePage({ segments: speech(100), duration: 3600 }); // ends at 14:51
  const { tr } = await captureMedia(page);
  const end = tr.completeness.checks.find((c) => c.id === 'covers_end');
  assert.equal(end.result, 'fail');
  assert.match(end.detail, /Last line is at 14:51 but the video runs 1:00:00/);
  assert.equal(tr.completeness.status, 'incomplete');
});

test('youtube: no transcript is reported, not claimed', async () => {
  const page = createYouTubePage({ segments: [], duration: 300, noTranscript: true });
  const { tr } = await captureMedia(page);
  assert.equal(tr.stats.segments, 0);
  assert.equal(tr.completeness.checks[0].result, 'fail');
  assert.equal(tr.completeness.status, 'incomplete');
  assert.match(page.V.exporters.toMarkdown(tr), /_\(no transcript captured\)_/);
});

test('youtube: the page showing another video is caught', async () => {
  const page = createYouTubePage({ segments: speech(10), duration: 90, shownId: 'zzzzzzzzzzz' });
  const { tr } = await captureMedia(page);
  assert.equal(tr.completeness.checks.find((c) => c.id === 'matches_page').result, 'fail');
  assert.equal(tr.completeness.status, 'incomplete');
});

test('spotify: reads the Transcript section under its heading, with show and description', async () => {
  const page = createSpotifyPage({ segments: speech(120, 15), playing: true, duration: 1800 });
  const { tr, platform } = await captureMedia(page);
  assert.equal(platform.id, 'spotify');
  assert.equal(tr.stats.segments, 120);
  assert.equal(tr.segments[0].text, 'line 1 keeps going and');
  assert.equal(tr.title, 'Everyone sits in the same traffic now');
  assert.equal(tr.source.show, 'New Creative Era');
  assert.equal(tr.source.url, 'https://open.spotify.com/episode/5H3FXUgGf9hxqb6ZN2mjxu');
  assert.match(tr.source.description, /next Steve Jobs/);
  assert.equal(tr.completeness.status, 'verified');
  const md = page.V.exporters.toMarkdown(tr);
  assert.match(md, /show: "New Creative Era"/);
  assert.match(md, /\*\*0:00\*\* line 1 keeps going and/);
  assert.ok(!md.includes('Show more'));
});

test('spotify: tabbed layout: opens the Transcript tab, keeps speakers and every paragraph', async () => {
  const segments = [
    { start: 0, text: 'Welcome to new creative era. | I\'m Joshua, joined as always by Yancey. | Yancey, it\'s good to see you again.' },
    { start: 21, text: 'Good to be here. | We\'ve been away for a few months.', speaker: 'Speaker 2' },
    { start: 35, text: 'Still me talking.', speaker: null },
    { start: 3830, text: 'Thanks for listening.', speaker: 'Speaker 1' },
  ];
  const page = createSpotifyPage({ tabbed: true, segments, playing: true, duration: 3837 });
  const { tr, raw } = await captureMedia(page);
  assert.equal(raw.evidence.tabFound, true);
  assert.equal(tr.stats.segments, 4);
  // A timestamp row without a label continues the previous speaker.
  assert.deepEqual(plain(tr.segments.map((s) => s.speaker)), ['Speaker 1', 'Speaker 2', 'Speaker 2', 'Speaker 1']);
  // The whole description (after "Show more"), with its links, and not the comments below it.
  assert.equal(tr.source.description, 'The builders of the internet wanted to be the next Steve Jobs.\n\nBuy a ticket to the show here (https://example.com/tickets).');
  assert.equal(tr.segments[0].text, "Welcome to new creative era. I'm Joshua, joined as always by Yancey. Yancey, it's good to see you again.");
  assert.ok(!tr.segments.some((s) => /generated automatically/.test(s.text)));
  assert.equal(tr.completeness.status, 'verified');
  assert.match(tr.completeness.warnings.join(' '), /Speaker labels are Spotify's guesses/);
  const md = page.V.exporters.toMarkdown(tr);
  assert.match(md, /\*\*0:00 Speaker 1:\*\* Welcome to new creative era\./);
  assert.match(md, /\*\*0:21 Speaker 2:\*\* Good to be here\./);
  assert.match(md, /\*\*1:03:50 Speaker 1:\*\* Thanks for listening\./);
});

test('spotify: without the episode playing, the end cannot be checked', async () => {
  const page = createSpotifyPage({ segments: speech(20, 15) });
  const { tr } = await captureMedia(page);
  assert.equal(tr.completeness.checks.find((c) => c.id === 'covers_end').result, 'unknown');
  assert.equal(tr.completeness.status, 'unverified');
});

test('spotify: signed out (no transcript) says why', async () => {
  const page = createSpotifyPage({});
  const { tr } = await captureMedia(page);
  assert.equal(tr.completeness.status, 'incomplete');
  assert.match(tr.completeness.checks[0].detail, /signed-in listeners/);
});

test('transcripts: each URL goes to the right adapter', () => {
  const { V } = createSpotifyPage({});
  assert.equal(V.findPlatform('https://www.youtube.com/watch?v=FquRuBqglg4&pp=x').id, 'youtube');
  assert.equal(V.findPlatform('https://m.youtube.com/watch?v=FquRuBqglg4').id, 'youtube');
  assert.equal(V.findPlatform('https://www.youtube.com/live/FquRuBqglg4').id, 'youtube');
  assert.equal(V.findPlatform('https://www.youtube.com/results?search_query=x').id, 'web');
  assert.equal(V.findPlatform('https://open.spotify.com/episode/5H3FXUgGf9hxqb6ZN2mjxu?si=a2c').id, 'spotify');
  assert.equal(V.findPlatform('https://open.spotify.com/intl-de/episode/5H3FXUgGf9hxqb6ZN2mjxu').id, 'spotify');
  assert.equal(V.findPlatform('https://open.spotify.com/show/5H3FXUgGf9hxqb6ZN2mjxu').id, 'web');
  assert.equal(V.transcript.clock(3725), '1:02:05');
  assert.equal(V.transcript.parseClock('1:02:05'), 3725);
  assert.equal(V.transcript.parseIsoDuration('PT58M53S'), 3533);
});
