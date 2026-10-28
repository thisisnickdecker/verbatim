/*
 * Whole-site capture, part 1: pages. Finds every page of a site (sitemap,
 * then links), follows robots.txt, and reads each page the same way a
 * single-page capture does. Network access is passed in, so this runs in
 * Verbatim's site tab and in tests alike. Same site only, a few requests at
 * a time.
 */
(function (root) {
  const NS = (root.Verbatim = root.Verbatim || {});
  const site = (NS.site = NS.site || {});
  const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|_ga|_gl)$/i;
  const bareHost = (h) => h.replace(/^www\./, '').toLowerCase();
  // Hosting internals, not pages: Cloudflare's /cdn-cgi/ (email protection,
  // challenges), WordPress's API and admin.
  const INTERNAL = /^\/(cdn-cgi|wp-json|wp-admin|xmlrpc\.php)(\/|$)/;

  // Canonical form used to tell pages apart: no #fragment, no tracking
  // parameters, sorted query, no trailing slash (except the root).
  function normalizeUrl(url, base) {
    let u;
    try {
      u = new URL(url, base);
    } catch (_) {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = params.length ? '?' + new URLSearchParams(params).toString() : '';
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.href;
  }

  function sameSite(a, b) {
    try {
      return bareHost(new URL(a).hostname) === bareHost(new URL(b).hostname);
    } catch (_) {
      return false;
    }
  }

  // ---------- robots.txt and sitemaps ----------

  // Rules from the "User-agent: *" group(s), and every Sitemap: line.
  function parseRobots(text) {
    const rules = { allow: [], disallow: [], sitemaps: [] };
    let agents = [];
    let inRules = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === 'sitemap') {
        if (value) rules.sitemaps.push(value);
      } else if (key === 'user-agent') {
        if (inRules) agents = [];
        inRules = false;
        agents.push(value.toLowerCase());
      } else if (key === 'allow' || key === 'disallow') {
        inRules = true;
        if (agents.includes('*') && value) rules[key].push(value);
      }
    }
    return rules;
  }

  function ruleMatch(rule, path) {
    const re = new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    return re.test(path);
  }

  // Longest matching rule wins; Allow wins ties.
  function robotsAllows(rules, url) {
    if (!rules) return true;
    const u = new URL(url);
    const path = u.pathname + u.search;
    let best = { len: -1, allow: true };
    for (const r of rules.disallow) if (ruleMatch(r, path) && r.length > best.len) best = { len: r.length, allow: false };
    for (const r of rules.allow) if (ruleMatch(r, path) && r.length >= best.len) best = { len: r.length, allow: true };
    return best.allow;
  }

  function parseSitemap(xml) {
    const locs = (tag) => [...String(xml || '').matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<loc>\\s*([^<\\s]+)\\s*</loc>`, 'gi'))].map((m) => decodeXml(m[1]));
    return { pages: locs('url'), sitemaps: locs('sitemap') };
  }

  const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

  // robots.txt rules and every page listed in the site's sitemaps.
  async function discover(start, fetchText) {
    const origin = new URL(start).origin;
    const robotsText = await fetchText(origin + '/robots.txt').catch(() => null);
    const robots = parseRobots(robotsText);
    const queue = robots.sitemaps.length ? [...robots.sitemaps] : [origin + '/sitemap.xml'];
    const read = new Set();
    const pages = [];
    while (queue.length && read.size < 50) {
      const sm = queue.shift();
      if (read.has(sm) || /\.gz$/i.test(sm)) continue;
      read.add(sm);
      const xml = await fetchText(sm).catch(() => null);
      if (!xml || !/<(urlset|sitemapindex)\b/i.test(xml)) continue;
      const found = parseSitemap(xml);
      pages.push(...found.pages);
      queue.push(...found.sitemaps);
    }
    return { robots, robotsFound: robotsText != null, sitemapPages: pages, sitemapsRead: [...read] };
  }

  // ---------- reading one page ----------

  function parseHtml(html, url) {
    const doc = new root.DOMParser().parseFromString(html, 'text/html');
    // Relative links and images resolve against the page, not this tab.
    const baseEl = doc.querySelector('base[href]') || doc.createElement('base');
    if (!baseEl.parentNode) {
      baseEl.setAttribute('href', url);
      (doc.head || doc.documentElement).prepend(baseEl);
    }
    return doc;
  }

  const words = (s) => (String(s || '').match(/\S+/g) || []).length;

  // Read one fetched (or rendered) page.
  async function readPage(html, url) {
    const doc = parseHtml(html, url);
    const raw = await NS.platforms.web.collect({ document: doc, url });
    const links = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      const n = normalizeUrl(a.getAttribute('href'), doc.baseURI || url);
      if (n && !links.includes(n)) links.push(n);
    }
    // Visible text only: a page's data scripts are not words a reader sees.
    const visible = doc.body ? doc.body.cloneNode(true) : null;
    if (visible) visible.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
    const bodyText = (visible && visible.textContent) || '';
    return {
      title: raw.title,
      description: raw.page.description,
      markdown: raw.page.markdown,
      words: raw.evidence.wordCount,
      method: raw.evidence.method,
      media: site.collectMedia(doc, url, html),
      embeds: site.collectEmbeds(doc, url),
      links,
      // An app shell: the server sent scripts and almost no text.
      needsRender: raw.evidence.wordCount < 30 && words(bodyText) < 60 && /<script\b/i.test(html),
    };
  }

  // ---------- crawling ----------


  /**
   * opts: { start, fetchText(url) -> text, fetchPage(url) -> { ok, status, url, contentType, text },
   *         render?(url) -> html, maxPages = 1000, concurrency = 3, delayMs = 250,
   *         isStopped?() -> bool, onProgress?({ phase, saved, failed, found, current }) }
   */
  async function crawl(opts) {
    const start = normalizeUrl(opts.start);
    const maxPages = opts.maxPages || 1000;
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const stopped = opts.isStopped || (() => false);
    const progress = opts.onProgress || (() => {});

    progress({ phase: 'discover' });
    const found = await discover(start, opts.fetchText);
    const allowed = (u) => robotsAllows(found.robots, u);

    const seen = new Set();
    const queue = [];
    const blocked = [];
    const files = new Map(); // same-site non-page URLs reached by links
    const enqueue = (u, from) => {
      const n = normalizeUrl(u);
      if (!n || seen.has(n) || !sameSite(n, start) || INTERNAL.test(new URL(n).pathname)) return;
      seen.add(n);
      if (site.isFileUrl(n)) return files.set(n, { url: n, kind: site.mediaKind(n), alt: '', aliases: [], foundOn: from });
      if (!allowed(n)) return blocked.push(n);
      queue.push(n);
    };
    enqueue(start, null);
    let fromSitemap = 0;
    for (const u of found.sitemapPages) {
      const before = queue.length;
      enqueue(u, 'sitemap');
      fromSitemap += queue.length - before;
    }

    const pages = [];
    const failed = [];
    const finals = new Set();
    let rendered = 0;
    let next = 0;

    async function visit(url) {
      try {
        const res = await opts.fetchPage(url);
        if (!res.ok) return failed.push({ url, reason: `HTTP ${res.status}` });
        const finalUrl = normalizeUrl(res.url || url);
        if (finalUrl !== url && (finals.has(finalUrl) || !sameSite(finalUrl, start))) return; // a redirect to a page already saved, or off-site
        finals.add(finalUrl);
        if (!/html/i.test(res.contentType || 'text/html')) {
          files.set(url, { url, kind: site.mediaKind(url, 'file'), alt: '', aliases: [] });
          return;
        }
        let page = await readPage(res.text, finalUrl);
        let viaTab = false;
        if (page.needsRender && opts.render) {
          const html = await opts.render(finalUrl).catch(() => null);
          if (html) {
            page = await readPage(html, finalUrl);
            viaTab = true;
            rendered++;
          }
        }
        pages.push({ url: finalUrl, requested: url, rendered: viaTab, ...page });
        for (const l of page.links) enqueue(l, finalUrl);
      } catch (err) {
        failed.push({ url, reason: (err && err.message) || String(err) });
      }
    }

    async function worker() {
      while (!stopped()) {
        const full = pages.length + failed.length + busy >= maxPages;
        if (next >= queue.length || full) {
          // Other workers may still add pages from what they are reading.
          if (busy === 0 || full) return;
          await sleep(50);
          continue;
        }
        const url = queue[next++];
        busy++;
        progress({ phase: 'pages', saved: pages.length, failed: failed.length, found: queue.length, current: url });
        await visit(url);
        busy--;
        await sleep(opts.delayMs == null ? 250 : opts.delayMs);
      }
    }
    let busy = 0;
    await Promise.all(Array.from({ length: opts.concurrency || 3 }, worker));

    // Media files linked from pages; site files reached by links count too.
    for (const f of files.values()) {
      const holder = pages.find((p) => p.url === f.foundOn) || pages[0];
      if (holder && !holder.media.some((m) => m.url === f.url)) holder.media.push(f);
    }

    return {
      start,
      host: new URL(start).hostname,
      pages,
      failed,
      blocked,
      found: queue.length,
      fromSitemap,
      sitemapsRead: found.sitemapsRead,
      robotsFound: found.robotsFound,
      notVisited: queue.slice(next),
      stopped: stopped(),
      limitReached: !stopped() && next < queue.length,
      rendered,
    };
  }

  Object.assign(site, { normalizeUrl, sameSite, parseRobots, robotsAllows, parseSitemap, discover, readPage, crawl });
})(globalThis);
