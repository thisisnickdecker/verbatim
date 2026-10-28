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
  const NS = (root.Verbatim = root.Verbatim || {});

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'DD', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
    'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
    'TABLE', 'UL',
  ]);
  const ALWAYS_SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA',
    'SELECT', 'CANVAS',
  ]);

  // Cloudflare email obfuscation: the first byte is the key for the rest.
  function cfEmail(hex) {
    if (!/^([0-9a-f]{2})+$/i.test(hex || '')) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return /^[^@\s]+@[^@\s]+$/.test(out) ? out : null;
  }

  const BLOCK_SELECTOR = [...BLOCK_TAGS].map((t) => t.toLowerCase()).join(',');

  // YouTube / Vimeo / Loom / Wistia players -> a watchable page URL.
  function embedUrl(src) {
    let u;
    try {
      u = new URL(src);
    } catch (_) {
      return null;
    }
    const host = u.hostname.replace(/^www\./, '');
    let m;
    if (/^youtube(-nocookie)?\.com$/.test(host) && (m = u.pathname.match(/^\/embed\/([\w-]{6,})/))) return `https://www.youtube.com/watch?v=${m[1]}`;
    if (host === 'player.vimeo.com' && (m = u.pathname.match(/^\/video\/(\d+)/))) return `https://vimeo.com/${m[1]}`;
    if (host === 'loom.com' && (m = u.pathname.match(/^\/embed\/(\w+)/))) return `https://www.loom.com/share/${m[1]}`;
    if (/(^|\.)(wistia\.(com|net)|dailymotion\.com|spotify\.com|soundcloud\.com)$/.test(host)) return u.href;
    return null;
  }

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
      if (el.hasAttribute('data-cfemail')) return cfEmail(el.getAttribute('data-cfemail')) || '';

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
        case 'A':
          return link(el, ctx, base);
        case 'IMG': {
          const src = absoluteUrl(el.getAttribute('src'), base);
          if (!src) return '';
          ctx.stats.images.push({ src, alt: el.getAttribute('alt') || '' });
          return '![' + (el.getAttribute('alt') || '').replace(/[[\]]/g, '') + '](' + src + ')';
        }
        case 'IFRAME': {
          // Embedded players become links (they can't be saved as files).
          const video = embedUrl(absoluteUrl(el.getAttribute('src'), base));
          if (!video) return '';
          ctx.stats.embeds.push({ url: video, title: el.getAttribute('title') || '' });
          return block('[▶ ' + ((el.getAttribute('title') || 'Embedded video').replace(/[[\]]/g, '')) + '](' + video + ')');
        }
        case 'VIDEO': case 'AUDIO': {
          const srcEl = el.getAttribute('src') ? el : el.querySelector('source[src]');
          const src = srcEl && absoluteUrl(srcEl.getAttribute('src'), base);
          if (!src || /^(blob|data):/.test(src)) return '';
          const kind = tag === 'VIDEO' ? 'Video' : 'Audio';
          ctx.stats.media.push({ src, kind: kind.toLowerCase(), poster: absoluteUrl(el.getAttribute('poster'), base) || null });
          return block('[▶ ' + kind + '](' + src.replace(/\)/g, '%29') + ')');
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
        case 'DL':
          return block(definitions(el, ctx));
        default:
          if (el.hasAttribute('href') && (tag === 'DIV' || tag === 'SECTION' || tag === 'SPAN')) return link(el, ctx, base);
          return isBlock(el) ? block(children(el, ctx)) : children(el, ctx);
      }
    }

    // Readability can turn a link into <div href> (when it wraps the
    // content it keeps); treat that the same way.
    function link(el, ctx, base) {
      // Cloudflare hides email addresses behind /cdn-cgi/l/email-protection#<hex>.
      const cf = (el.getAttribute('href') || '').match(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i);
      if (cf) {
        const email = cfEmail(cf[1]);
        const text = children(el, ctx).trim();
        return email ? `[${/email.protected/i.test(text) || !text ? email : text}](mailto:${email})` : text;
      }
      const href = absoluteUrl(el.getAttribute('href'), base);
      if (!href || href.startsWith('javascript:')) return children(el, ctx).trim();
      ctx.stats.links++;
      const target = '(' + href.replace(/\)/g, '%29') + ')';
      // A card: a link wrapping blocks (image, heading, text). Keep the
      // blocks and link the heading, or else the first line of text.
      if (el.querySelector(BLOCK_SELECTOR)) return block(linkCard(clean(children(el, ctx)), target));
      const text = children(el, ctx).trim();
      return '[' + (text || href) + ']' + target;
    }

    // Sibling inline elements with no space between them render apart on
    // screen (badges, labels: "Alice & Bob" + "equity"); keep a space.
    function children(el, ctx) {
      let out = '';
      let prevEl = false;
      for (const child of el.childNodes) {
        const part = render(child, ctx);
        const isEl = child.nodeType === 1;
        if (part && isEl && prevEl && !ctx.pre && /[\p{L}\p{N})]$/u.test(out) && /^[\p{L}\p{N}(]/u.test(part) && !isBlock(child)) out += ' ';
        out += part;
        if (isEl && part) prevEl = true;
        else if (child.nodeType === 3 && child.nodeValue.trim()) prevEl = false;
      }
      return out;
    }

    function linkCard(md, target) {
      const lines = md.split('\n');
      let i = lines.findIndex((l) => /^#{1,6} \S/.test(l));
      if (i >= 0) {
        lines[i] = lines[i].replace(/^(#{1,6}) (.*)$/, (m, h, t) => `${h} [${t}]${target}`);
        return lines.join('\n');
      }
      i = lines.findIndex((l) => l.trim() && !/^!\[/.test(l.trim()));
      if (i < 0) return md + '\n\n[Link]' + target;
      lines[i] = '[' + lines[i].trim() + ']' + target;
      return lines.join('\n');
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

    // <dl> -> "- **Term:** definition" (terms may sit in wrapper <div>s).
    function definitions(el, ctx) {
      const out = [];
      let term = null;
      const one = (n) => flatten(clean(children(n, ctx))).replace(/\n+/g, ' ').trim();
      for (const n of el.querySelectorAll('dt, dd')) {
        if (n.closest('dl') !== el) continue;
        if (n.tagName.toUpperCase() === 'DT') {
          if (term) out.push(`- **${term}**`);
          term = one(n);
        } else {
          out.push(term ? `- **${term}:** ${one(n)}` : `- ${one(n)}`);
          term = null;
        }
      }
      if (term) out.push(`- **${term}**`);
      return out.join('\n');
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
      const ctx = { pre: false, stats: { codeBlocks: 0, links: 0, images: [], media: [], embeds: [] } };
      const markdown = clean(render(rootEl, ctx))
        .split('\n')
        .map((l) => (/^\s+$/.test(l) ? '' : l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { markdown, stats: ctx.stats };
    };
  }

  NS.htmlToMarkdown = { createConverter, fence, inlineCode, block, isBlock, embedUrl };
})(globalThis);
