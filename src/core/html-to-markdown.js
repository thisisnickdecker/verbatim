/*
 * Generic DOM -> Markdown converter.
 *
 * Platform-neutral. Platform adapters customise behaviour through `rules`:
 *   rules.skip(el)            -> true to drop an element (and its subtree)
 *   rules.override(el, api)   -> a Markdown string to use instead of the default
 *                                rendering, or undefined to fall through.
 *                                `api` exposes { render, renderChildren, inline, block }.
 *
 * Runs in a page (content-script isolated world) or in jsdom for tests.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'DD', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
    'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
    'TABLE', 'UL',
  ]);
  const ALWAYS_SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA',
    'SELECT', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
  ]);

  // Placeholders so that block separators survive whitespace collapsing.
  const BR = '\u0000BR\u0000';

  function isBlock(el) {
    return BLOCK_TAGS.has(el.tagName);
  }

  function block(s) {
    s = (s || '').replace(/^\n+|\n+$/g, '');
    return s.trim() ? '\n\n' + s + '\n\n' : '';
  }

  function fence(code, lang) {
    const longest = Math.max(2, ...(code.match(/`+/g) || []).map((m) => m.length));
    const ticks = '`'.repeat(longest + 1);
    return ticks + (lang || '') + '\n' + code.replace(/\n$/, '') + '\n' + ticks;
  }

  function inlineCode(text) {
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map((m) => m.length));
    const ticks = '`'.repeat(longest + 1);
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return ticks + pad + text + pad + ticks;
  }

  function wrapInline(content, marker) {
    const m = content.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m[2]) return content;
    return m[1] + marker + m[2] + marker + m[3];
  }

  function indent(text, prefix) {
    return text
      .split('\n')
      .map((line, i) => (i === 0 || !line ? line : prefix + line))
      .join('\n');
  }

  function absoluteUrl(url, base) {
    if (!url) return '';
    try {
      return new URL(url, base).href;
    } catch (_) {
      return url;
    }
  }

  function createConverter(rules) {
    rules = rules || {};
    const skip = rules.skip || (() => false);
    const override = rules.override || (() => undefined);

    function render(node, ctx) {
      if (node.nodeType === 3) {
        if (ctx.pre) return node.nodeValue;
        return node.nodeValue.replace(/[\t\n\r ]+/g, ' ');
      }
      if (node.nodeType !== 1) return '';
      const el = node;
      if (ALWAYS_SKIP.has(el.tagName.toUpperCase())) return '';
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return '';
      if (skip(el)) return '';

      const api = { render: (n) => render(n, ctx), renderChildren: (n, c) => children(n, c || ctx), inline: inlineCode, block, fence, ctx };
      const custom = override(el, api);
      if (custom !== undefined) return custom;

      const tag = el.tagName.toUpperCase();
      const base = el.ownerDocument && el.ownerDocument.baseURI;

      switch (tag) {
        case 'BR':
          return ctx.pre ? '\n' : BR;
        case 'HR':
          return block('---');
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
          const text = flatten(children(el, ctx)).replace(/\n+/g, ' ').trim();
          return text ? block('#'.repeat(Number(tag[1])) + ' ' + text) : '';
        }
        case 'P':
          return block(children(el, ctx));
        case 'STRONG': case 'B':
          return wrapInline(children(el, ctx), '**');
        case 'EM': case 'I':
          return wrapInline(children(el, ctx), '*');
        case 'DEL': case 'S': case 'STRIKE':
          return wrapInline(children(el, ctx), '~~');
        case 'CODE': {
          if (ctx.pre) return el.textContent;
          return inlineCode(el.textContent);
        }
        case 'PRE': {
          const codeEl = el.querySelector('code');
          const cls = ((codeEl && codeEl.className) || '') + ' ' + (el.className || '');
          const m = String(cls).match(/language-([\w+#.-]+)/);
          const code = (codeEl || el).textContent;
          ctx.stats.codeBlocks++;
          return block(fence(code, m ? m[1] : ''));
        }
        case 'A': {
          const href = absoluteUrl(el.getAttribute('href'), base);
          const text = children(el, ctx).trim();
          if (!href || href.startsWith('javascript:')) return text;
          ctx.stats.links++;
          return '[' + (text || href) + '](' + href.replace(/\)/g, '%29') + ')';
        }
        case 'IMG': {
          const src = absoluteUrl(el.getAttribute('src'), base);
          if (!src) return '';
          ctx.stats.images.push({ src, alt: el.getAttribute('alt') || '' });
          return '![' + (el.getAttribute('alt') || '').replace(/[[\]]/g, '') + '](' + src + ')';
        }
        case 'UL': case 'OL':
          return block(list(el, ctx, tag === 'OL'));
        case 'LI':
          // Stray <li> outside a list.
          return block('- ' + children(el, ctx).trim());
        case 'BLOCKQUOTE': {
          const inner = clean(children(el, ctx));
          return block(inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'));
        }
        case 'TABLE':
          return block(table(el, ctx));
        default:
          return isBlock(el) ? block(children(el, ctx)) : children(el, ctx);
      }
    }

    function children(el, ctx) {
      let out = '';
      for (const child of el.childNodes) out += render(child, ctx);
      return out;
    }

    function list(el, ctx, ordered) {
      const start = Number(el.getAttribute('start')) || 1;
      const items = [];
      let n = start;
      for (const li of el.children) {
        if (li.tagName.toUpperCase() !== 'LI') continue;
        const marker = ordered ? n++ + '. ' : '- ';
        // Keep a nested list tight against its parent item's text.
        const body = clean(children(li, ctx)).replace(/\n\n+(?=(?:[-*]|\d+\.) )/g, '\n');
        items.push(marker + indent(body, ' '.repeat(marker.length)));
      }
      // Loose list if any item spans several blocks.
      const loose = items.some((i) => /\n\s*\n/.test(i));
      return items.join(loose ? '\n\n' : '\n');
    }

    function table(el, ctx) {
      const rows = [...el.querySelectorAll('tr')].map((tr) =>
        [...tr.children]
          .filter((c) => /^T[HD]$/i.test(c.tagName))
          .map((c) => flatten(clean(children(c, ctx))).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim())
      );
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r) => r.concat(Array(width - r.length).fill(''));
      const lines = [pad(rows[0]), Array(width).fill('---'), ...rows.slice(1).map(pad)];
      return lines.map((r) => '| ' + r.join(' | ') + ' |').join('\n');
    }

    function flatten(s) {
      return s.split(BR).join(' ');
    }

    function clean(md) {
      return md
        .split(BR).join('  \n')
        .split('\n')
        .map((l) => l.replace(/[ \t]+$/g, (m) => (m === '  ' ? m : '')))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+|\n+$/g, '');
    }

    return function convert(rootEl) {
      const ctx = { pre: false, stats: { codeBlocks: 0, links: 0, images: [] } };
      const markdown = clean(render(rootEl, ctx))
        .split('\n')
        .map((l) => (/^\s+$/.test(l) ? '' : l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { markdown, stats: ctx.stats };
    };
  }

  NS.htmlToMarkdown = { createConverter, fence, inlineCode, block, isBlock };
})(globalThis);
