const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createYouTubePage, captureMedia: captureMediaRaw } = require('./fake-media');
const { capture, simpleTurns } = require('./fake-chatgpt');

// Values come from the jsdom realm; compare as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

const RICH_TURNS = [
  {
    key: 'k-0001',
    user: { id: 'u1', text: 'Can you show me a Python example and a shell command?\nKeep it short.' },
    assistant: {
      id: 'a1',
      html: `
        <h2 data-d-component="title">Two snippets</h2>
        <p data-d-component="text">Here is <span data-markdown-copy="inline-code">fib()</span> in Python:</p>
        <div data-code-block="true" data-markdown-copy="code-block">
          <div data-markdown-copy="exclude" contenteditable="false"><svg></svg><div>Python</div>
            <div><div data-code-block-controls="true"><button aria-label="Copy code"></button></div></div></div>
          <div data-code-block-source="true"><code><span>def fib(n):</span>
<span>    return n if n &lt; 2 else fib(n - 1) + fib(n - 2)</span></code></div>
        </div>
        <div data-code-block="true" data-markdown-copy="code-block">
          <div data-markdown-copy="exclude"><div>Plain text</div></div>
          <div data-code-block-source="true"><code>echo "\`backticks\` and \`\`\`fences\`\`\`"</code></div>
        </div>`,
    },
  },
  {
    key: 'k-0002',
    user: { id: 'u2', text: 'Now show every kind of formatting.' },
    assistant: {
      id: 'a2',
      html: `
        <h1>Formatting</h1>
        <p data-d-component="text">Plain, <span data-d-component="text" style="font-weight:700">bold by style</span>, <strong>strong</strong>, <em>em</em>, <del>gone</del>, and a <a href="https://example.com/a(b)">link</a>.</p>
        <ul><li>One<ul><li>One.a</li><li>One.b</li></ul></li><li>Two</li></ul>
        <ol start="3"><li>Third</li><li>Fourth</li></ol>
        <blockquote data-d-component="blockquote"><p>Quoted line</p></blockquote>
        <table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr></tbody></table>
        <div data-d-component="divider"></div>
        <div data-d-component="box"><p data-d-component="text">Inside a card</p>
          <div data-has-label=""><button role="checkbox" aria-checked="true"></button><label><span>Done item</span></label></div>
          <div data-has-label=""><button role="checkbox" aria-checked="false"></button><label><span>Open item</span></label></div>
        </div>
        <p>Source <a data-testid="chatgpt-citation" aria-label="Example Docs: Page, https://docs.example.com/x" href="https://docs.example.com/x"><span><img src="https://favicon.example/ico.png" alt=""></span>Example Docs</a></p>
        <div data-markdown-copy="rich-block" data-markdown-copy-text="# Brief&#10;&#10;- keep this **exact** markdown"><p>rendered brief</p></div>`,
    },
  },
  {
    key: 'k-0003',
    user: {
      id: 'u3',
      text: 'Here are my notebook photos and the PDF.',
      attachments: [
        { type: 'image', url: 'https://files.example/notebook-01.jpg', alt: 'Uploaded image' },
        { type: 'image', url: 'blob:https://chatgpt.com/0b1c2d3e-0000-4000-8000-000000000000', alt: 'User attachment' },
        { type: 'file', name: 'workshop-notes.pdf' },
      ],
    },
    assistant: {
      id: 'a3',
      reasoning: true,
      html: `<p data-d-component="text">Here is a reference image:</p>
        <p>Sources <img src="https://www.google.com/s2/favicons?domain=example.com" alt=""></p>
        <div data-d-component="image"><img alt="Notebook spread" src="https://images.example/spread.png"><div data-d-image-loading=""><div data-d-component="loading-block"></div></div><button aria-label="Open"></button></div>`,
    },
  },
];

test('short conversation: 1 turn, verified, metadata present', async () => {
  const { conv, md } = await capture({ turns: simpleTurns(1), title: 'Short chat' });
  assert.equal(conv.stats.messageCount, 2);
  assert.equal(conv.completeness.status, 'verified');
  assert.equal(conv.title, 'Short chat');
  assert.equal(conv.source.url, 'https://chatgpt.com/c/0a1b2c3d-0000-4000-8000-00000000c0de');
  assert.equal(conv.source.conversationId, '0a1b2c3d-0000-4000-8000-00000000c0de');
  assert.match(conv.capture.capturedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(plain(conv.messages.map((m) => m.role)), ['user', 'assistant']);
  assert.match(md, /^---\ntitle: "Short chat"/);
  assert.match(md, /\n# Short chat\n/);
  assert.match(md, /\*\*Messages:\*\* 2 \(1 from you, 1 from ChatGPT\)/);
});

test('long virtualized conversation with lazy loading: 150 turns stitched in order', async () => {
  const turns = simpleTurns(150);
  const { conv, raw } = await capture({ turns, initiallyLoaded: 12, loadBatch: 20 });
  assert.equal(conv.stats.turnCount, 150);
  assert.equal(conv.stats.messageCount, 300);
  assert.equal(raw.evidence.gapCount, 0);
  assert.equal(conv.completeness.status, 'verified');
  conv.messages.forEach((m, i) => {
    const n = Math.floor(i / 2) + 1;
    assert.equal(m.role, i % 2 ? 'assistant' : 'user');
    assert.equal(m.content.markdown, i % 2 ? `Answer number ${n}` : `Question number ${n}`);
  });
});

test('code blocks: language, exact source, fence escaping, inline code', async () => {
  const { conv } = await capture({ turns: RICH_TURNS.slice(0, 1) });
  const a = conv.messages[1].content.markdown;
  assert.ok(a.includes('## Two snippets'));
  assert.ok(a.includes('Here is `fib()` in Python:'));
  assert.ok(a.includes('```python\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n```'));
  assert.ok(a.includes('````text\necho "`backticks` and ```fences```"\n````'), 'fence longer than any run of backticks');
  assert.ok(!a.includes('Copy code'));
  assert.equal(conv.messages[1].codeBlockCount, 2);
  assert.equal(conv.messages[0].content.markdown, 'Can you show me a Python example and a shell command?\nKeep it short.');
});

test('markdown formatting: headings, emphasis, lists, quotes, tables, checkboxes, citations, writing blocks', async () => {
  const { conv } = await capture({ turns: RICH_TURNS.slice(1, 2) });
  const a = conv.messages[1].content.markdown;
  const expect = [
    '# Formatting',
    'Plain, **bold by style**, **strong**, *em*, ~~gone~~, and a [link](https://example.com/a(b%29).',
    '- One\n  - One.a\n  - One.b\n- Two',
    '3. Third\n4. Fourth',
    '> Quoted line',
    '| Name | Value |\n| --- | --- |\n| a\\|b | 1 |',
    '---',
    'Inside a card',
    '- [x] Done item',
    '- [ ] Open item',
    'Source [Example Docs: Page](https://docs.example.com/x)',
    '# Brief\n\n- keep this **exact** markdown',
  ];
  for (const e of expect) assert.ok(a.includes(e), `missing:\n${e}\n--- in ---\n${a}`);
  assert.ok(!a.includes('rendered brief'), 'writing block uses its Markdown source, not the rendering');
  assert.ok(!a.includes('favicon'), 'citation favicons are not images');
});

test('images and attachments: user uploads, assistant images, scope warnings', async () => {
  const { conv, md } = await capture({ turns: RICH_TURNS.slice(2, 3) });
  const [u, a] = conv.messages;
  assert.deepEqual(plain(u.attachments), [
    { type: 'image', url: 'https://files.example/notebook-01.jpg', alt: 'Uploaded image' },
    { type: 'image', url: null, sessionUrl: 'blob:https://chatgpt.com/0b1c2d3e-0000-4000-8000-000000000000', alt: 'User attachment', note: 'session-only' },
    { type: 'file', name: 'workshop-notes.pdf' },
  ]);
  assert.ok(a.content.markdown.includes('![Notebook spread](https://images.example/spread.png)'));
  assert.ok(!a.content.markdown.includes('favicons'), 'favicons are dropped');
  assert.equal(conv.stats.images, 3);
  assert.ok(md.includes('- Image: User attachment (shown in ChatGPT from a session-only link'));
  assert.ok(conv.completeness.warnings.some((w) => /temporary in-browser links/.test(w)));
  assert.equal(conv.stats.files, 1);
  assert.ok(a.flags.includes('collapsed-reasoning-not-captured'));
  assert.ok(conv.completeness.warnings.some((w) => /URL references only/.test(w)));
  assert.ok(md.includes('- File: workshop-notes.pdf'));
  assert.ok(md.includes('- Image: Uploaded image — <https://files.example/notebook-01.jpg>'));
});

test('many turns mixing every content type keep order and roles', async () => {
  const turns = [];
  for (let i = 0; i < 20; i++) {
    const t = RICH_TURNS[i % 3];
    turns.push({ ...t, key: `mix-${i}`, user: { ...t.user, id: `mu${i}` }, assistant: { ...t.assistant, id: `ma${i}` } });
  }
  const { conv } = await capture({ turns, initiallyLoaded: 5, loadBatch: 4 });
  assert.equal(conv.stats.messageCount, 40);
  assert.deepEqual(plain(conv.messages.map((m) => m.platformMessageId)), turns.flatMap((t) => [t.user.id, t.assistant.id]));
  assert.equal(conv.completeness.status, 'verified');
});

test('edited/regenerated branches are flagged, not hidden', async () => {
  const turns = simpleTurns(3);
  turns[1].user.branch = true;
  const { conv } = await capture({ turns });
  assert.ok(conv.messages[2].flags.includes('has-alternate-branches'));
  assert.ok(conv.completeness.warnings.some((w) => /Only the branch currently shown/.test(w)));
});

test('older reply layout without the "contents" wrapper is still read', async () => {
  const turns = simpleTurns(3);
  turns[1].assistant = { id: 'old', legacyWrapper: true, html: '<h1><span>Old heading</span></h1><p><strong><span>Bold</span></strong> text</p>' };
  const { conv } = await capture({ turns });
  assert.equal(conv.messages[3].content.markdown, '# Old heading\n\n**Bold** text');
  assert.equal(conv.completeness.status, 'verified');
});

test('long user prompts collapsed behind "Show more" are expanded', async () => {
  const turns = simpleTurns(12);
  const long = 'word '.repeat(3000).trim() + ' THE END';
  turns[2].user = { id: 'long', text: long, collapsed: true };
  const { conv, raw } = await capture({ turns });
  assert.equal(conv.messages[4].content.markdown, long);
  assert.ok(raw.evidence.expandedMessages >= 1);
  assert.equal(conv.completeness.status, 'verified');
});

test('hidden view of a previously opened chat is ignored (in-app navigation)', async () => {
  const stale = simpleTurns(4, 'stale').map((t) => ({ ...t, user: { ...t.user, text: 'OLD CHAT ' + t.user.text } }));
  const { conv, raw } = await capture({ turns: simpleTurns(6), staleView: stale });
  assert.equal(conv.stats.messageCount, 12);
  assert.ok(conv.messages.every((m) => !m.content.markdown.includes('OLD CHAT')));
  assert.equal(raw.evidence.hiddenViewsIgnored, 1);
  assert.equal(conv.completeness.status, 'verified');
});

// ---- Failure modes: the export must not claim completeness ----

test('gap between snapshots -> incomplete', async () => {
  const { conv } = await capture({ turns: simpleTurns(30), jumpAt: 5000 });
  assert.equal(conv.completeness.status, 'incomplete');
  assert.equal(conv.completeness.checks.find((c) => c.id === 'continuous_sweep').result, 'fail');
  assert.ok(conv.stats.turnCount < 30);
});

test('older messages never finish loading -> incomplete', async () => {
  const { conv } = await capture({ turns: simpleTurns(30), initiallyLoaded: 10, neverFinishLoading: true, topTimeout: 30 });
  assert.equal(conv.completeness.status, 'incomplete');
  assert.equal(conv.completeness.checks.find((c) => c.id === 'reached_top').result, 'fail');
});

test('unrendered placeholder turn -> incomplete', async () => {
  const turns = simpleTurns(10);
  const { conv } = await capture({ turns, placeholderKeys: [turns[4].key] });
  assert.equal(conv.completeness.checks.find((c) => c.id === 'turns_rendered').result, 'fail');
  assert.equal(conv.completeness.status, 'incomplete');
});

test('collapsed prompt that will not expand -> incomplete', async () => {
  const turns = simpleTurns(4);
  turns[1].user = { id: 'stuck', text: 'x'.repeat(500), collapsed: true };
  const { conv } = await capture({ turns, expandBroken: true });
  assert.ok(conv.messages[2].flags.includes('truncated-not-expanded'));
  assert.equal(conv.completeness.checks.find((c) => c.id === 'no_truncated_messages').result, 'fail');
  assert.equal(conv.completeness.status, 'incomplete');
});

test('messages from another conversation -> incomplete', async () => {
  const { conv } = await capture({ turns: simpleTurns(3), foreignIds: true });
  assert.equal(conv.completeness.checks.find((c) => c.id === 'matches_page').result, 'fail');
  assert.equal(conv.completeness.status, 'incomplete');
});

test('response still streaming -> incomplete', async () => {
  const { conv } = await capture({ turns: simpleTurns(2), streaming: true });
  assert.equal(conv.completeness.status, 'incomplete');
});

test('each URL goes to the right adapter', async () => {
  const { page } = await capture({ turns: simpleTurns(1) });
  const CC = page.CC;
  assert.equal(CC.findPlatform('https://chatgpt.com/').id, 'web', 'ChatGPT home is just a page');
  assert.equal(CC.findPlatform('https://example.com/c/6ae0b249-6f9c').id, 'web');
  assert.equal(CC.findPlatform('https://chatgpt.com/g/g-p-abc/c/0a1b2c3d-0000-4000-8000-00000000c0de').id, 'chatgpt');
  assert.equal(CC.findPlatform('https://claude.ai/chat/0a1b2c3d-0000-4000-8000-00000000c0de').id, 'claude');
  assert.equal(CC.findPlatform('https://claude.ai/recents').id, 'web');
  assert.equal(CC.findPlatform('chrome://extensions'), null);
});

async function captureMedia(page) {
  return Object.assign(await captureMediaRaw(page), { page });
}

test('write example exports', async () => {
  const turns = RICH_TURNS.map((t) => ({ ...t }));
  const { conv, page } = await capture({ turns, title: 'Example: formatting, code and images' });
  const dir = path.join(__dirname, '..', 'examples');
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  for (const f of page.CC.exporters.filesFor(conv)) {
    const base = path.basename(f.filename);
    const name = base.endsWith(' — handoff.md') ? 'example-conversation.handoff.md' : 'example-conversation' + path.extname(base);
    fs.writeFileSync(path.join(dir, name), f.text);
  }
  JSON.parse(fs.readFileSync(path.join(dir, 'example-conversation.json'), 'utf8'));

  const segments = Array.from({ length: 40 }, (_, i) => ({ start: i * 8, text: i % 3 === 2 ? `That is the point we keep coming back to, number ${i + 1}.` : `and the brief changes again when the client sees part ${i + 1}` }));
  const chapters = [{ start: 0, title: 'Chapter 1: Where the idea came from' }, { start: 160, title: 'Chapter 2: Shipping it' }];
  const yt = await captureMedia(createYouTubePage({ segments, chapters, duration: 330, title: 'Example: a video transcript' }));
  for (const f of yt.page.CC.exporters.filesFor(yt.tr)) fs.writeFileSync(path.join(dir, 'example-transcript' + path.extname(f.filename)), f.text);
});
