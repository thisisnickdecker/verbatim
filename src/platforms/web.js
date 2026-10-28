/*
 * Generic web page adapter: any http(s) page that no conversation adapter
 * claims. Finds the main content with Mozilla Readability (vendored in
 * src/vendor), falls back to the page's <main>/<body>, and converts it to
 * Markdown with the shared converter.
 *
 * Reads the page as currently rendered. It does not scroll, so content a
 * site loads only on scroll may be missing (reported as a scope note).
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const CHROME = 'header, nav, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-modal="true"], [id*="cookie" i], [class*="cookie" i]';

  function matches(url) {
    try {
      return /^https?:$/.test(new URL(url).protocol);
    } catch (_) {
      return false;
    }
  }

  function meta(doc, ...names) {
    for (const n of names) {
      const el = doc.querySelector(`meta[name="${n}"], meta[property="${n}"]`);
      if (el && el.content) return el.content.trim();
    }
    return null;
  }

  const words = (s) => (s.match(/\S+/g) || []).length;

  async function collect(opts) {
    const doc = opts.document;
    const started = Date.now();
    const convert = NS.htmlToMarkdown.createConverter();
    const Readability = root.Readability;

    let method = 'readability';
    let article = null;
    try {
      // keepClasses: code block languages live in class names (language-*).
      article = Readability ? new Readability(doc.cloneNode(true), { charThreshold: 300, keepClasses: true }).parse() : null;
    } catch (_) {
      article = null;
    }

    let markdown = '';
    if (article && article.content) {
      const parsed = new DOMParser().parseFromString(article.content, 'text/html');
      markdown = convert(parsed.body).markdown;
    }
    // Listing/index pages often defeat Readability; use the main area instead.
    if (words(markdown) < 150) {
      const clone = doc.cloneNode(true);
      clone.querySelectorAll(CHROME).forEach((n) => n.remove());
      const main = clone.querySelector('main, [role="main"], article') || clone.body;
      const full = main ? convert(main).markdown : '';
      if (words(full) > words(markdown)) {
        markdown = full;
        method = 'main-content';
      }
    }

    const title = (article && article.title) || meta(doc, 'og:title') || doc.title || opts.url;
    const description = meta(doc, 'description', 'og:description') || (article && article.excerpt) || null;
    const host = new URL(opts.url).hostname.replace(/^www\./, '');

    return {
      kind: 'page',
      platform: 'web',
      platformName: (article && article.siteName) || meta(doc, 'og:site_name') || host,
      url: opts.url,
      conversationId: null,
      title: title.trim(),
      page: {
        markdown,
        text: (article && article.textContent ? article.textContent : '').replace(/\s+\n/g, '\n').trim(),
        description,
        byline: (article && article.byline) || meta(doc, 'author') || null,
        publishedTime: (article && article.publishedTime) || meta(doc, 'article:published_time') || null,
        language: doc.documentElement.getAttribute('lang') || null,
        host,
      },
      turns: [],
      evidence: { layout: 'page', method, wordCount: words(markdown), durationMs: Date.now() - started },
    };
  }

  NS.platforms = NS.platforms || {};
  NS.platforms.web = { id: 'web', name: 'Web page', matches, collect, fallback: true };
})(globalThis);
