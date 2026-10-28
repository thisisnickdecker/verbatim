/*
 * ChatGPT platform adapter.
 *
 * Responsibility: read the ChatGPT conversation page and return a *raw capture*
 * (platform-shaped turns + evidence about how the capture went). It knows
 * nothing about export formats; normalization happens in core/normalize.js.
 *
 * Only the rendered page (DOM) is read. No network requests are made and no
 * ChatGPT endpoints are called.
 *
 * ChatGPT virtualizes long conversations: only a handful of turns are mounted
 * at once. We therefore sweep the scroll container from top to bottom in
 * overlapping steps and stitch turns together by their stable turn key.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  // All selectors in one place so DOM changes are a one-file fix.
  const SEL = {
    scroller: '[data-app-action-timeline-scroll]',
    turn: '[data-turn-key]',
    turnState: '[data-talvt-turn-state]',
    unit: '[data-chatgpt-search-unit-key]',
    userBubble: '[data-user-message-bubble]',
    userText: '[data-search-result-target]',
    assistantRole: '[data-conversation-role]',
    messageId: '[data-chatgpt-selection-message-id]',
    // Whole rendered reply. Newer replies also mark pieces with
    // data-markdown-copy="contents"; older ones don't, so prefer the wrapper.
    assistantContent: '[data-markdown-text-style]',
    assistantContentAlt: '[data-markdown-copy="contents"]',
    showMore: 'button[aria-expanded="false"]',
    stopButton: '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]',
    // Legacy layout (2023–2025), kept as a fallback.
    legacyTurn: '[data-testid^="conversation-turn-"]',
    legacyMessage: '[data-message-author-role]',
    legacyMarkdown: '.markdown',
  };

  const ATTR_CONV_ID = 'data-chatgpt-selection-conversation-id';
  const HOSTS = /^(chatgpt\.com|chat\.openai\.com)$/;
  const CONVERSATION_PATH = /\/c\/([0-9a-zA-Z-]{8,})/;

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
    const t = (doc.title || '').replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim();
    return t && t !== 'ChatGPT' ? t : 'Untitled ChatGPT conversation';
  }

  // ---------- Markdown rules specific to ChatGPT's renderer ----------

  // Source favicons next to citations are decoration, not content.
  function isFavicon(src) {
    return /\/s2\/favicons|favicon/i.test(src || '');
  }

  function styleOf(el) {
    const view = el.ownerDocument.defaultView;
    return view && view.getComputedStyle ? view.getComputedStyle(el) : null;
  }

  function isBold(el) {
    const s = styleOf(el);
    return !!s && (parseInt(s.fontWeight, 10) >= 600 || s.fontWeight === 'bold');
  }

  function isItalic(el) {
    const s = styleOf(el);
    return !!s && s.fontStyle === 'italic';
  }

  function emphasis(el, content) {
    // ChatGPT's component renderer expresses emphasis through styles rather
    // than <strong>/<em>. Only mark where the style *changes* from the parent.
    const parent = el.parentElement;
    let out = content;
    if (isBold(el) && !(parent && isBold(parent))) out = wrap(out, '**');
    if (isItalic(el) && !(parent && isItalic(parent))) out = wrap(out, '*');
    return out;
  }

  function wrap(content, marker) {
    const m = content.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m[2] || /\n/.test(m[2])) return content;
    return m[1] + marker + m[2] + marker + m[3];
  }

  function codeLanguage(label) {
    const l = (label || '').trim().toLowerCase();
    if (!l || l === 'plain text' || l === 'text') return 'text';
    return l.replace(/\s+/g, '-');
  }

  const markdownRules = {
    skip(el) {
      return (
        el.getAttribute('data-markdown-copy') === 'exclude' ||
        el.hasAttribute('data-code-block-controls') ||
        el.getAttribute('data-d-component') === 'loading-block' ||
        (el.tagName === 'IMG' && isFavicon(el.getAttribute('src'))) ||
        (el.classList && el.classList.contains('sr-only'))
      );
    },
    override(el, api) {
      const copy = el.getAttribute('data-markdown-copy');
      const comp = el.getAttribute('data-d-component');

      // Writing blocks (documents/briefs) carry their own Markdown source.
      if (copy === 'rich-block' && el.hasAttribute('data-markdown-copy-text')) {
        return api.block(el.getAttribute('data-markdown-copy-text'));
      }
      if (copy === 'code-block' || el.hasAttribute('data-code-block')) {
        const header = el.querySelector('[data-markdown-copy="exclude"]');
        const source = el.querySelector('[data-code-block-source]') || el.querySelector('code') || el;
        api.ctx.stats.codeBlocks++;
        return api.block(api.fence(source.textContent, codeLanguage(header && header.textContent)));
      }
      if (copy === 'inline-code') return api.inline(el.textContent);

      if (el.tagName === 'A' && el.getAttribute('data-testid') === 'chatgpt-citation') {
        const href = el.getAttribute('href') || '';
        const label = (el.getAttribute('aria-label') || el.textContent || href).split(/,\s*https?:\/\//)[0].trim();
        api.ctx.stats.links++;
        const prev = el.previousSibling;
        const space = prev && /\S$/.test(prev.textContent || '') ? ' ' : '';
        return space + '[' + label.replace(/[[\]]/g, '') + '](' + href.replace(/\)/g, '%29') + ')';
      }

      if (el.hasAttribute('data-has-label')) {
        const control = el.querySelector('[role="checkbox"], [role="radio"]');
        const label = el.querySelector('label');
        const text = (label ? label.textContent : el.textContent).trim();
        if (control && control.getAttribute('role') === 'radio') {
          return api.block((control.getAttribute('aria-checked') === 'true' ? '(•) ' : '( ) ') + text);
        }
        const checked = control && control.getAttribute('aria-checked') === 'true';
        return api.block('- [' + (checked ? 'x' : ' ') + '] ' + text);
      }
      if (comp === 'divider') return api.block('---');

      if (comp === 'text' || comp === 'caption') {
        const inner = api.renderChildren(el);
        const styled = emphasis(el, inner);
        return el.tagName === 'P' || el.tagName === 'DIV' ? api.block(styled) : styled;
      }
      return undefined;
    },
  };

  // ---------- Per-turn extraction ----------

  function topLevel(container, selector) {
    return [...container.querySelectorAll(selector)].filter(
      (el) => !el.parentElement.closest(selector) || !container.contains(el.parentElement.closest(selector))
    );
  }

  function attachmentsIn(unit, excludeRoot) {
    const out = [];
    for (const img of unit.querySelectorAll('img')) {
      if (excludeRoot && excludeRoot.contains(img)) continue;
      if (img.closest('[data-testid="chatgpt-citation"]')) continue;
      const src = img.getAttribute('src') || '';
      if (!src || isFavicon(src)) continue;
      if (src.startsWith('blob:')) {
        // Uploaded images are shown from in-memory blob: URLs that die with the tab.
        out.push({ type: 'image', url: null, sessionUrl: src, alt: img.getAttribute('alt') || '', note: 'session-only' });
      } else {
        out.push({ type: 'image', url: src, alt: img.getAttribute('alt') || '' });
      }
    }
    // File tiles: any non-button element outside the message text whose text
    // looks like a filename. Best-effort; reported as references only.
    const seen = new Set();
    for (const el of unit.querySelectorAll('[title], div, span')) {
      if (excludeRoot && excludeRoot.contains(el)) continue;
      if (el.children.length) continue;
      const name = (el.getAttribute('title') || el.textContent || '').trim();
      if (/^[^\n/\\]{1,180}\.[a-z0-9]{2,5}$/i.test(name) && !seen.has(name)) {
        seen.add(name);
        out.push({ type: 'file', name });
      }
    }
    return out;
  }

  // "Show more" toggles that collapse long user prompts (text truncated in the DOM).
  function collapsedToggles(scope) {
    return [...scope.querySelectorAll(SEL.showMore)].filter(
      (b) => b.closest(SEL.unit) && b.closest(SEL.unit).querySelector(SEL.userBubble) && /^show more$/i.test(b.textContent.trim())
    );
  }

  function flagsFor(unit, contentRoots) {
    const flags = [];
    // Only look at page chrome, not the message itself ("1/2" in a table is not a branch switcher).
    const leaves = [...unit.querySelectorAll('span, div')].filter(
      (e) => !e.children.length && !contentRoots.some((r) => r.contains(e))
    );
    if (leaves.some((e) => /^\s*\d+\s*\/\s*\d+\s*$/.test(e.textContent))) flags.push('has-alternate-branches');
    if (unit.querySelector('button[aria-label*="Previous response" i], button[aria-label*="Next response" i]')) {
      if (!flags.includes('has-alternate-branches')) flags.push('has-alternate-branches');
    }
    if (leaves.some((e) => /^(Thought for|Reasoned for|Thinking)\b/i.test(e.textContent.trim()))) {
      flags.push('collapsed-reasoning-not-captured');
    }
    return flags;
  }

  function extractUnit(unit, convert) {
    const bubble = unit.querySelector(SEL.userBubble);
    const roleEl = unit.querySelector(SEL.assistantRole);
    const role = bubble ? 'user' : roleEl ? roleEl.getAttribute('data-conversation-role') : 'unknown';
    const idEl = unit.querySelector(SEL.messageId);
    const ids = (unit.getAttribute('data-chatgpt-search-message-ids') || '').split(',').filter(Boolean);
    const platformMessageId = (idEl && idEl.getAttribute('data-chatgpt-selection-message-id')) || ids[0] || null;
    const convIdEl = unit.querySelector(`[${ATTR_CONV_ID}]`);
    const conversationId = convIdEl ? convIdEl.getAttribute(ATTR_CONV_ID) : null;

    let markdown = '';
    let text = '';
    let stats = { codeBlocks: 0, links: 0, images: [] };
    let contentRoot = null;
    let roots = [];

    if (role === 'user') {
      contentRoot = bubble;
      const target = bubble.querySelector(SEL.userText) || bubble;
      text = (target.innerText !== undefined ? target.innerText : target.textContent).replace(/\r/g, '').trim();
      markdown = text;
      roots = [bubble];
    } else {
      roots = topLevel(unit, SEL.assistantContent);
      if (!roots.length) roots = topLevel(unit, SEL.assistantContentAlt);
      contentRoot = roots[0] || null;
      const parts = roots.map((r) => convert(r));
      markdown = parts.map((p) => p.markdown).filter(Boolean).join('\n\n');
      for (const p of parts) {
        stats.codeBlocks += p.stats.codeBlocks;
        stats.links += p.stats.links;
        stats.images.push(...p.stats.images);
      }
      text = roots.map((r) => (r.innerText !== undefined ? r.innerText : r.textContent)).join('\n\n').trim();
    }

    const flags = flagsFor(unit, roots);
    if (role === 'user' && collapsedToggles(unit).length) flags.push('truncated-not-expanded');

    const attachments =
      role === 'user'
        ? attachmentsIn(unit, bubble.querySelector(SEL.userText))
        : stats.images.map((i) => ({ type: 'image', url: i.src, alt: i.alt }));

    return { role, platformMessageId, conversationId, markdown, text, attachments, codeBlocks: stats.codeBlocks, flags };
  }

  function extractTurn(turn, convert) {
    const stateEl = turn.querySelector(SEL.turnState);
    const units = topLevel(turn, SEL.unit);
    const messages = units.map((u) => extractUnit(u, convert));
    return {
      key: turn.getAttribute('data-turn-key'),
      renderState: stateEl ? stateEl.getAttribute('data-talvt-turn-state') : 'unknown',
      messages,
    };
  }

  function extractLegacyTurns(doc, convert) {
    const nodes = [...doc.querySelectorAll(SEL.legacyMessage)];
    return nodes.map((m, i) => {
      const role = m.getAttribute('data-message-author-role');
      const md = m.querySelector(SEL.legacyMarkdown);
      const text = (m.innerText !== undefined ? m.innerText : m.textContent).trim();
      const conv = md ? convert(md) : { markdown: text, stats: { codeBlocks: 0, images: [] } };
      return {
        key: m.getAttribute('data-message-id') || 'legacy-' + i,
        renderState: 'unknown',
        messages: [{
          role, platformMessageId: m.getAttribute('data-message-id'), markdown: role === 'user' ? text : conv.markdown,
          text, attachments: conv.stats.images.map((x) => ({ type: 'image', url: x.src, alt: x.alt })),
          codeBlocks: conv.stats.codeBlocks, flags: [],
        }],
      };
    });
  }

  // ---------- Scroll sweep ----------

  // ChatGPT keeps previously opened conversations in the page as hidden
  // (zero-height) views after in-app navigation, often *before* the visible
  // one. Pick the visible view, preferring the one for this URL's conversation.
  function findScroller(doc, wantedId) {
    const candidates = [...doc.querySelectorAll(SEL.scroller)];
    const visible = candidates.filter((el) => el.clientHeight > 0);
    const owns = (el) => !wantedId || !!el.querySelector(`[${ATTR_CONV_ID}="${wantedId}"]`) || !el.querySelector(`[${ATTR_CONV_ID}]`);
    const explicit = visible.find(owns) || visible[0];
    if (explicit) return explicit;
    if (candidates.length) return null; // only hidden views: refuse to read a stale conversation
    let el = doc.querySelector(SEL.turn) || doc.querySelector(SEL.legacyTurn) || doc.querySelector(SEL.legacyMessage);
    const view = doc.defaultView;
    while (el && el !== doc.body) {
      const oy = view.getComputedStyle(el).overflowY;
      if (/(auto|scroll)/.test(oy) && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return null;
  }

  function loadingOlder(scroller) {
    return /Loading older messages/i.test(scroller.textContent || '');
  }

  async function collect(opts) {
    const doc = opts.document;
    const timing = Object.assign({ settle: 700, step: 300, renderWait: 1500, expandWait: 400, topTimeout: 90000, maxDuration: 15 * 60000 }, opts.timing);
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const progress = opts.onProgress || (() => {});
    const now = () => Date.now();
    const started = now();
    const convert = NS.htmlToMarkdown.createConverter(markdownRules);

    const evidence = {
      layout: 'current',
      scrollerFound: false,
      reachedTop: false,
      reachedBottom: false,
      snapshots: 0,
      gapCount: 0,
      emptySnapshots: 0,
      olderTurnsAppearedDuringSweep: 0,
      timedOut: false,
      expandedMessages: 0,
      hiddenViewsIgnored: 0,
      foreignMessages: 0,
      streaming: !!doc.querySelector(SEL.stopButton),
    };

    const wantedId = conversationId(opts.url);
    const scroller = findScroller(doc, wantedId);
    evidence.scrollerFound = !!scroller;
    evidence.hiddenViewsIgnored = [...doc.querySelectorAll(SEL.scroller)].filter((el) => el.clientHeight === 0).length;
    // Everything below reads only inside the visible conversation view.
    // If the page only has hidden views, read nothing rather than a stale chat.
    const root = scroller || (doc.querySelector(SEL.scroller) ? doc.createElement('div') : doc);

    if (!root.querySelector(SEL.turn)) {
      evidence.layout = doc.querySelector(SEL.legacyMessage) ? 'legacy' : 'none';
    }

    const order = [];            // turn keys in conversation order
    const turns = new Map();     // key -> extracted turn

    const better = (a, b) => {
      // Keep the most complete extraction we have seen for a turn.
      if (!a) return b;
      if (a.renderState !== 'complete' && b.renderState === 'complete') return b;
      if (b.renderState !== 'complete' && a.renderState === 'complete') return a;
      const len = (t) => t.messages.reduce((n, m) => n + m.markdown.length + m.attachments.length, 0);
      return len(b) >= len(a) ? b : a;
    };

    async function expandCollapsed() {
      const toggles = collapsedToggles(root);
      if (!toggles.length) return;
      toggles.forEach((b) => b.click());
      evidence.expandedMessages += toggles.length;
      await sleep(timing.expandWait);
    }

    async function snapshot() {
      await expandCollapsed();
      const mounted = [...root.querySelectorAll(SEL.turn)].map((t) => extractTurn(t, convert));
      evidence.snapshots++;
      if (!mounted.length) {
        evidence.emptySnapshots++;
        return mounted;
      }
      // Stitch: insert unseen keys after the last already-known key.
      let anchor = -1;
      let overlap = false;
      for (const t of mounted) {
        const idx = order.indexOf(t.key);
        if (idx >= 0) {
          anchor = idx;
          overlap = true;
        } else {
          if (anchor === -1 && order.length && sweeping) evidence.olderTurnsAppearedDuringSweep++;
          order.splice(anchor + 1, 0, t.key);
          anchor++;
        }
        turns.set(t.key, better(turns.get(t.key), t));
      }
      if (!overlap && order.length > mounted.length) evidence.gapCount++;
      return mounted;
    }

    async function waitForRender() {
      const deadline = now() + timing.renderWait;
      while (now() < deadline) {
        const states = [...root.querySelectorAll(SEL.turnState)].map((e) => e.getAttribute('data-talvt-turn-state'));
        if (states.every((s) => s === 'complete')) return;
        await sleep(100);
      }
    }

    let sweeping = false;

    if (evidence.layout === 'legacy') {
      const legacy = extractLegacyTurns(doc, convert);
      legacy.forEach((t) => { order.push(t.key); turns.set(t.key, t); });
      evidence.reachedTop = evidence.reachedBottom = null; // not verified for legacy layout
    } else if (scroller) {
      const originalTop = scroller.scrollTop;

      // 1. Scroll to the top until nothing older loads.
      progress({ phase: 'top', pct: 0 });
      const topDeadline = now() + timing.topTimeout;
      let stableChecks = 0;
      let lastSig = '';
      while (now() < topDeadline) {
        scroller.scrollTop = 0;
        await sleep(timing.settle);
        const first = root.querySelector(SEL.turn);
        const sig = (first && first.getAttribute('data-turn-key')) + '|' + scroller.scrollHeight;
        const atTop = scroller.scrollTop <= 1 && !loadingOlder(scroller);
        stableChecks = atTop && sig === lastSig ? stableChecks + 1 : 0;
        lastSig = sig;
        if (stableChecks >= 2) {
          evidence.reachedTop = true;
          break;
        }
      }
      if (!evidence.reachedTop) evidence.timedOut = true;

      // 2. Sweep down in half-viewport steps so consecutive snapshots overlap.
      sweeping = true;
      await waitForRender();
      await snapshot();
      let bottomChecks = 0;
      while (now() - started < timing.maxDuration) {
        const step = Math.max(100, Math.floor(scroller.clientHeight * 0.5));
        scroller.scrollTop = scroller.scrollTop + step;
        await sleep(timing.step);
        await waitForRender();
        await snapshot();
        const max = scroller.scrollHeight - scroller.clientHeight;
        progress({ phase: 'sweep', pct: max > 0 ? Math.min(99, Math.round((scroller.scrollTop / max) * 100)) : 99, turns: order.length });
        if (scroller.scrollTop >= max - 2) {
          bottomChecks++;
          if (bottomChecks >= 3) {
            evidence.reachedBottom = true;
            break;
          }
        } else {
          bottomChecks = 0;
        }
      }
      if (!evidence.reachedBottom) evidence.timedOut = true;
      sweeping = false;

      // 3. Put the reader back where they were.
      scroller.scrollTop = originalTop;
    } else {
      // No scroll container: capture what is mounted, completeness unknown.
      await snapshot();
    }

    evidence.foreignMessages = order
      .map((k) => turns.get(k))
      .reduce((n, t) => n + t.messages.filter((m) => m.conversationId && wantedId && m.conversationId !== wantedId).length, 0);

    progress({ phase: 'done', pct: 100, turns: order.length });

    return {
      platform: 'chatgpt',
      platformName: 'ChatGPT',
      url: opts.url,
      conversationId: conversationId(opts.url),
      title: title(doc),
      turns: order.map((k) => turns.get(k)),
      evidence: Object.assign(evidence, { durationMs: now() - started }),
    };
  }

  NS.platforms = NS.platforms || {};
  NS.platforms.chatgpt = { id: 'chatgpt', name: 'ChatGPT', matches, collect, selectors: SEL, markdownRules };
})(globalThis);
