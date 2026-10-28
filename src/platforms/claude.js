/*
 * Claude.ai platform adapter.
 *
 * Reads the rendered claude.ai conversation page and returns a raw capture
 * (see core/normalize.js). No network requests, no Claude API calls.
 *
 * Claude virtualizes the transcript: only rows near the viewport are mounted.
 * Unlike ChatGPT, every row carries its position (data-index) and an
 * accessible label "Message N of TOTAL", so we can sweep the list and then
 * check that every index from 0 to TOTAL-1 was read.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  // All selectors in one place so DOM changes are a one-file fix.
  const SEL = {
    convRoot: '[data-conv-id]',
    scroller: '[data-autoscroll-container]',
    row: '[data-testid="transcript-row"]',
    article: '[role="article"]',
    userMessage: '[data-testid="user-message"]',
    // Rows also say who sent them; attachment-only user messages have no user-message element.
    userScope: '[data-user-scope]',
    assistantMessage: '[data-testid="assistant-message"]',
    markdown: '.standard-markdown, .progressive-markdown',
    collapsed: '[data-closed]', // thinking / tool-use blocks shown as a one-line summary
    fileThumb: '[data-testid="file-thumbnail"]',
    fileCard: '[data-testid="file-card-block"]',
    streaming: '[data-is-streaming="true"]',
  };

  const HOSTS = /^claude\.ai$/;
  const CONVERSATION_PATH = /\/chat\/([0-9a-f-]{8,})/i;

  function matches(url) {
    try {
      const u = new URL(url);
      return HOSTS.test(u.hostname) && CONVERSATION_PATH.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function conversationId(url) {
    const m = new URL(url).pathname.match(CONVERSATION_PATH);
    return m ? m[1] : null;
  }

  function title(doc) {
    const t = (doc.title || '').replace(/\s*[-|]\s*Claude\s*$/i, '').trim();
    return t && t !== 'Claude' ? t : 'Untitled Claude conversation';
  }

  const markdownRules = {
    skip(el) {
      return (
        el.matches('[data-find-omitted]') || // "You said:" / "Claude responded:" headings
        (el.classList && el.classList.contains('sr-only'))
      );
    },
  };

  function rowTotal(row) {
    const label = (row.querySelector(SEL.article) || row).getAttribute('aria-label') || '';
    const m = label.match(/(\d+)\s+of\s+(\d+)/i);
    return m ? Number(m[2]) : null;
  }

  function fileName(el) {
    const named = el.querySelector('[aria-label], [title]');
    const label = named && (named.getAttribute('aria-label') || named.getAttribute('title'));
    return (label || el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function extractRow(row, convert) {
    const index = Number(row.getAttribute('data-index'));
    const user = row.querySelector(SEL.userMessage);
    const assistant = row.querySelector(SEL.assistantMessage);
    const sender = row.getAttribute('data-perf-row');
    const isUser = !!user || sender === 'human' || (!assistant && !!row.querySelector(SEL.userScope));
    const role = isUser ? 'user' : assistant || sender === 'assistant' ? 'assistant' : 'unknown';
    const flags = [];
    const attachments = [];
    let markdown = '';
    let text = '';
    let codeBlocks = 0;

    if (isUser) {
      if (user) {
        markdown = convert(user).markdown;
        text = (user.innerText !== undefined ? user.innerText : user.textContent).trim();
      }
      for (const t of row.querySelectorAll(SEL.fileThumb)) {
        const img = t.querySelector('img');
        const name = fileName(t);
        if (img && img.getAttribute('src') && !img.getAttribute('src').startsWith('blob:')) {
          attachments.push({ type: 'image', url: img.getAttribute('src'), alt: img.getAttribute('alt') || name });
        } else if (img) {
          attachments.push({ type: 'image', url: null, sessionUrl: img.getAttribute('src'), alt: img.getAttribute('alt') || name, note: 'session-only' });
        } else {
          attachments.push({ type: 'file', name });
        }
      }
    } else if (assistant) {
      // Text blocks outside the collapsed thinking/tool summaries, in order.
      const blocks = [...assistant.querySelectorAll(SEL.markdown)].filter(
        (b) => !b.closest(SEL.collapsed) && !b.parentElement.closest(SEL.markdown)
      );
      const parts = blocks.map((b) => convert(b));
      markdown = parts.map((p) => p.markdown).filter(Boolean).join('\n\n');
      text = blocks.map((b) => (b.innerText !== undefined ? b.innerText : b.textContent)).join('\n\n').trim();
      for (const p of parts) {
        codeBlocks += p.stats.codeBlocks;
        for (const i of p.stats.images) attachments.push({ type: 'image', url: i.src, alt: i.alt });
      }
      for (const card of assistant.querySelectorAll(SEL.fileCard)) {
        const btn = card.querySelector('button[aria-label^="View "]');
        const name = btn ? btn.getAttribute('aria-label').replace(/^View\s+/, '') : fileName(card);
        attachments.push({ type: 'file', name, note: 'artifact (content not captured)' });
      }
      if (assistant.querySelector(SEL.collapsed)) flags.push('collapsed-reasoning-not-captured');
    }

    return {
      index,
      total: rowTotal(row),
      message: { role, platformMessageId: null, markdown, text, attachments, codeBlocks, flags },
    };
  }

  // Pick the visible view for this URL's conversation; ignore stale ones.
  function findViews(doc, wantedId) {
    const roots = [...doc.querySelectorAll(SEL.convRoot)].filter((el) => el.clientHeight > 0);
    const convRoot = roots.find((el) => el.getAttribute('data-conv-id') === wantedId) || null;
    const scope = convRoot || doc;
    const scroller = [...scope.querySelectorAll(SEL.scroller)].find((el) => el.clientHeight > 0) || null;
    return { convRoot, scroller, ignored: doc.querySelectorAll(SEL.convRoot).length - (convRoot ? 1 : 0) };
  }

  async function collect(opts) {
    const doc = opts.document;
    const timing = Object.assign({ settle: 600, step: 250, renderWait: 400, topTimeout: 60000, maxDuration: 15 * 60000 }, opts.timing);
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const progress = opts.onProgress || (() => {});
    const now = () => Date.now();
    const started = now();
    const convert = NS.htmlToMarkdown.createConverter(markdownRules);
    const wantedId = conversationId(opts.url);

    const { convRoot, scroller, ignored } = findViews(doc, wantedId);
    const scope = convRoot || doc.createElement('div'); // never read another conversation
    const rows = new Map(); // index -> extracted row
    let expectedTotal = null;

    const evidence = {
      layout: 'claude',
      scrollerFound: !!scroller,
      conversationViewFound: !!convRoot,
      hiddenViewsIgnored: ignored,
      foreignMessages: 0,
      reachedTop: false,
      reachedBottom: false,
      snapshots: 0,
      gapCount: 0,
      emptySnapshots: 0,
      olderTurnsAppearedDuringSweep: 0,
      timedOut: false,
      expandedMessages: 0,
      streaming: !!scope.querySelector(SEL.streaming),
      expectedMessages: null,
      missingIndices: [],
    };

    function snapshot() {
      const mounted = [...scope.querySelectorAll(SEL.row)];
      evidence.snapshots++;
      if (!mounted.length) evidence.emptySnapshots++;
      for (const row of mounted) {
        const r = extractRow(row, convert);
        if (Number.isNaN(r.index)) continue;
        if (r.total) expectedTotal = Math.max(expectedTotal || 0, r.total);
        const prev = rows.get(r.index);
        const size = (x) => x.message.markdown.length + x.message.attachments.length;
        if (!prev || size(r) >= size(prev)) rows.set(r.index, r);
      }
    }

    if (scroller) {
      const originalTop = scroller.scrollTop;
      progress({ phase: 'top', pct: 0 });
      const topDeadline = now() + timing.topTimeout;
      let stable = 0;
      let lastSig = '';
      while (now() < topDeadline) {
        scroller.scrollTop = 0;
        await sleep(timing.settle);
        const first = scope.querySelector(SEL.row);
        const sig = (first && first.getAttribute('data-index')) + '|' + scroller.scrollHeight;
        stable = scroller.scrollTop <= 1 && sig === lastSig ? stable + 1 : 0;
        lastSig = sig;
        if (stable >= 2) {
          evidence.reachedTop = true;
          break;
        }
      }
      if (!evidence.reachedTop) evidence.timedOut = true;

      snapshot();
      let bottom = 0;
      while (now() - started < timing.maxDuration) {
        scroller.scrollTop = scroller.scrollTop + Math.max(100, Math.floor(scroller.clientHeight * 0.5));
        await sleep(timing.step);
        await sleep(timing.renderWait);
        snapshot();
        const max = scroller.scrollHeight - scroller.clientHeight;
        progress({ phase: 'sweep', pct: max > 0 ? Math.min(99, Math.round((scroller.scrollTop / max) * 100)) : 99, turns: rows.size });
        if (scroller.scrollTop >= max - 2) {
          if (++bottom >= 3) {
            evidence.reachedBottom = true;
            break;
          }
        } else {
          bottom = 0;
        }
      }
      if (!evidence.reachedBottom) evidence.timedOut = true;
      scroller.scrollTop = originalTop;
    } else {
      snapshot();
    }

    const indices = [...rows.keys()].sort((a, b) => a - b);
    evidence.expectedMessages = expectedTotal;
    if (expectedTotal) {
      for (let i = 0; i < expectedTotal; i++) if (!rows.has(i)) evidence.missingIndices.push(i);
    }
    evidence.durationMs = now() - started;
    progress({ phase: 'done', pct: 100, turns: rows.size });

    // One message per row; group into turns so normalize() can number them.
    const turns = indices.map((i) => ({ key: 'row-' + i, renderState: 'complete', messages: [rows.get(i).message] }));

    return {
      platform: 'claude',
      platformName: 'Claude',
      url: opts.url,
      conversationId: wantedId,
      title: title(doc),
      turns,
      evidence,
    };
  }

  NS.platforms = NS.platforms || {};
  NS.platforms.claude = { id: 'claude', name: 'Claude', matches, collect, selectors: SEL, markdownRules };
})(globalThis);
