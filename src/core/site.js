/*
 * Whole-site capture: find every page of a site, read each one like a single
 * page capture, collect its images, videos and files, and lay the result out
 * as a folder (one Markdown file per page, mirroring the site's paths, plus a
 * shared media/ folder and an index).
 *
 * Network access is passed in (fetchPage, fetchText, fetchBinary, render),
 * so this runs in Verbatim's site-capture tab and in tests alike.
 *
 * Polite by design: same site only, robots.txt rules for all crawlers are
 * followed, a few requests at a time with a pause between them.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|_ga|_gl)$/i;
  const FILE_EXT = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|key|pages|numbers|epub|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp4|m4v|mov|webm|ogv|mkv|avi|mp3|m4a|wav|ogg|oga|flac|aac)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv|mkv|avi)$/i;
  const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|oga|flac|aac)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic)$/i;
  const TRACKERS = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.com|simpleanalyticscdn\.com|plausible\.io|scorecardresearch\.com|quantserve\.com|hotjar\.com|segment\.io|bat\.bing\.com|linkedin\.com|t\.co|analytics\.[\w.]+)$/i;

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

  function largestFromSrcset(srcset) {
    let best = null;
    for (const part of String(srcset || '').split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      const size = parseFloat(d) || 1;
      if (!best || size > best.size) best = { url: u, size };
    }
    return best && best.url;
  }

  function mediaKind(url, fallback) {
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch (_) {
        return '';
      }
    })();
    if (VIDEO_EXT.test(path)) return 'video';
    if (AUDIO_EXT.test(path)) return 'audio';
    if (IMAGE_EXT.test(path)) return 'image';
    return fallback || 'file';
  }

  function isTracker(url) {
    try {
      const u = new URL(url);
      return TRACKERS.test(u.hostname) || /\/(pixel|beacon|collect|noscript)\.(gif|png)$/i.test(u.pathname);
    } catch (_) {
      return true;
    }
  }

  // The full-size original behind a resized copy on common image services.
  // Falls back to the copy (see downloadMedia) if the original won't load.
  function original(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return url;
    }
    const host = u.hostname;
    const dropQuery = () => {
      u.search = '';
      return u.href;
    };
    if (/\/_next\/image\/?$/.test(u.pathname) && u.searchParams.get('url')) {
      try {
        return new URL(u.searchParams.get('url'), u.origin).href;
      } catch (_) {
        return url;
      }
    }
    if (/\.imgix\.net$|(^|\.)cdn\.sanity\.io$|(^|\.)framerusercontent\.com$|(^|\.)images\.ctfassets\.net$|(^|\.)images\.squarespace-cdn\.com$|(^|\.)static1\.squarespace\.com$/.test(host)) return dropQuery();
    if (/(^|\.)cdn\.shopify\.com$/.test(host) || /\/cdn\/shop\//.test(u.pathname)) {
      for (const k of ['width', 'height', 'crop']) u.searchParams.delete(k);
      u.pathname = u.pathname.replace(/_(\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande)(@\dx)?(?=\.\w+$)/, '');
      return u.href;
    }
    if (/\/wp-content\/uploads\//.test(u.pathname)) {
      u.pathname = u.pathname.replace(/-\d+x\d+(?=\.\w+$)/, '').replace(/-scaled(?=\.\w+$)/, '');
      return u.href;
    }
    if (/(^|\.)website-files\.com$|(^|\.)webflow\.com$/.test(host)) {
      u.pathname = u.pathname.replace(/-p-\d+(?=\.\w+$)/, '');
      return u.href;
    }
    if (/(^|\.)res\.cloudinary\.com$/.test(host)) {
      u.pathname = u.pathname.replace(/\/(image|video)\/upload\/(?:[^/]*[_,][^/]*\/)+(?=(v\d+\/)?[^/]+$|v\d+\/)/, '/$1/upload/');
      return u.href;
    }
    return url;
  }

  const SOURCE_MEDIA = /https?:\/\/[^\s"'<>()\\,]+?\.(?:jpe?g|png|gif|webp|avif|mp4|m4v|mov|webm|mp3|m4a|wav|pdf)(?:\?[^\s"'<>()\\,]*)?(?=[\s"'<>()\\,]|$)/gi;
  const SRCSET_LIST = /(?:https?:\/\/[^\s"'<>,]+\s+\d+(?:\.\d+)?[wx]\s*,\s*)+https?:\/\/[^\s"'<>,]+\s+\d+(?:\.\d+)?[wx]/g;

  // Media named only in the page's data (sites that build their pages with
  // JavaScript list images and videos in a script). Of each list of sizes,
  // only the largest.
  function scanSource(html) {
    const text = String(html || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const smaller = new Set();
    for (const list of text.match(SRCSET_LIST) || []) {
      const items = list.split(/\s*,\s*/).map((p) => p.trim().split(/\s+/)).map(([u, d]) => ({ u, size: parseFloat(d) || 0 }));
      items.sort((a, b) => b.size - a.size);
      for (const it of items.slice(1)) smaller.add(it.u);
    }
    const out = new Set();
    for (const m of text.matchAll(SOURCE_MEDIA)) if (!smaller.has(m[0])) out.add(m[0]);
    return [...out];
  }

  // Every image, video, audio and file on the page (not only in the main
  // content). `aliases` are the other URLs the page uses for the same item
  // (the plain src when a larger srcset candidate is downloaded).
  function collectMedia(doc, pageUrl, html) {
    const found = new Map();
    const add = (raw, kind, alt, alias) => {
      if (!raw || /^(data|blob|javascript):/i.test(raw)) return;
      let seen;
      try {
        seen = new URL(raw, doc.baseURI || pageUrl).href;
      } catch (_) {
        return;
      }
      if (isTracker(seen)) return;
      const url = original(seen);
      const item = found.get(url) || { url, kind, alt: alt || '', aliases: [] };
      if (url !== seen && !item.fallback) item.fallback = seen;
      for (const a of [seen, alias]) if (a && a !== url && !item.aliases.includes(a)) item.aliases.push(a);
      if (!item.alt && alt) item.alt = alt;
      found.set(url, item);
    };
    const abs = (u) => {
      try {
        return new URL(u, doc.baseURI || pageUrl).href;
      } catch (_) {
        return null;
      }
    };
    for (const img of doc.querySelectorAll('img')) {
      if (img.closest('noscript')) continue;
      if (img.getAttribute('width') === '1' && img.getAttribute('height') === '1') continue;
      const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      const big = largestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
      add(big || src, 'image', img.getAttribute('alt'), src && abs(src));
    }
    // A <picture> offers one image in several formats; its <img> (above) is
    // enough, unless it has none.
    for (const pic of doc.querySelectorAll('picture')) {
      if (pic.querySelector('img[src], img[srcset]')) continue;
      const s = pic.querySelector('source[srcset]');
      if (s) add(largestFromSrcset(s.getAttribute('srcset')), 'image');
    }
    for (const v of doc.querySelectorAll('video, audio')) {
      const kind = v.tagName.toLowerCase();
      add(v.getAttribute('src'), kind);
      for (const s of v.querySelectorAll('source[src]')) add(s.getAttribute('src'), kind);
      if (v.getAttribute('poster')) add(v.getAttribute('poster'), 'image', 'Video poster');
    }
    const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (og && og.content) add(og.content, 'image', 'Preview image');
    // Links straight to files (PDFs, images, videos) on this site, and to
    // video or audio files anywhere.
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = abs(a.getAttribute('href'));
      if (!href) continue;
      const path = new URL(href).pathname;
      if (!FILE_EXT.test(path)) continue;
      if (!sameSite(href, pageUrl) && !VIDEO_EXT.test(path) && !AUDIO_EXT.test(path)) continue;
      add(href, mediaKind(href), (a.textContent || '').replace(/\s+/g, ' ').trim());
    }
    for (const u of scanSource(html)) add(u, mediaKind(u, 'image'));
    return [...found.values()];
  }

  function collectEmbeds(doc, pageUrl) {
    const out = [];
    for (const f of doc.querySelectorAll('iframe[src]')) {
      let src;
      try {
        src = new URL(f.getAttribute('src'), doc.baseURI || pageUrl).href;
      } catch (_) {
        continue;
      }
      const url = NS.htmlToMarkdown.embedUrl(src);
      if (url && !out.some((e) => e.url === url)) out.push({ url, title: f.getAttribute('title') || '' });
    }
    return out;
  }

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
      media: collectMedia(doc, url, html),
      embeds: collectEmbeds(doc, url),
      links,
      // An app shell: the server sent scripts and almost no text.
      needsRender: raw.evidence.wordCount < 30 && words(bodyText) < 60 && /<script\b/i.test(html),
    };
  }

  // ---------- crawling ----------

  const isFileUrl = (url) => FILE_EXT.test(new URL(url).pathname);

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
      if (isFileUrl(n)) return files.set(n, { url: n, kind: mediaKind(n), alt: '', aliases: [], foundOn: from });
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
          files.set(url, { url, kind: mediaKind(url, 'file'), alt: '', aliases: [] });
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

  // ---------- media ----------

  const EXT_FOR_TYPE = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'video/mp4': 'mp4',
    'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
    'audio/ogg': 'ogg', 'application/pdf': 'pdf',
  };

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36).slice(0, 6);
  }

  const kindOfType = (type) => (/^image\//.test(type) ? 'image' : /^video\//.test(type) ? 'video' : /^audio\//.test(type) ? 'audio' : type ? 'file' : null);

  // media/<readable name>-<hash>.<ext>: readable, unique, no spaces. The
  // extension follows what the server sent: an image served from an
  // address ending in .mp4 (a video thumbnail) is saved as an image.
  function mediaPath(url, contentType) {
    const u = new URL(url);
    const last = (() => {
      try {
        return decodeURIComponent(u.pathname.split('/').pop() || '');
      } catch (_) {
        return u.pathname.split('/').pop() || '';
      }
    })() || u.hostname;
    const m = last.match(/^(.*?)(?:\.([a-z0-9]{2,5}))?$/i);
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const fromUrl = m[2] && m[2].toLowerCase();
    const fromType = EXT_FOR_TYPE[type];
    const agree = fromUrl && (!fromType || mediaKind('x.' + fromUrl) === kindOfType(type) || (fromType === 'jpg' && fromUrl === 'jpeg'));
    const ext = (agree ? fromUrl : fromType || fromUrl || 'bin');
    // Query-addressed images (favicons?domain=x) take the query's value as their name.
    const fromQuery = [...u.searchParams.values()].find((v) => /^[\w.-]{3,60}$/.test(v) && /[a-z]/i.test(v));
    const stem = (m[1] && m[1] !== 'favicons' ? m[1] : fromQuery || m[1] || 'file')
      .replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
    return `media/${stem}-${hash(url)}.${ext}`;
  }

  /**
   * Download every media item once.
   * fetchBinary(url) -> { ok, status, contentType, bytes } or { ok, status, contentType, blob, size, crc }
   *                     or { tooLarge, size }.
   * opts: { fetchBinary, maxBytes, includeVideo = true, concurrency, isStopped, onProgress }
   * Returns Map url -> { url, kind, path, status: 'saved'|'failed'|'too-large'|'skipped', bytes|blob, size, reason }.
   */
  async function downloadMedia(result, opts) {
    const items = new Map();
    for (const p of result.pages) for (const m of p.media) if (!items.has(m.url)) items.set(m.url, m);
    const list = [...items.values()];
    const out = new Map();
    const stopped = opts.isStopped || (() => false);
    const progress = opts.onProgress || (() => {});
    let next = 0;
    let done = 0;
    let bytes = 0;
    async function get(url) {
      const res = await opts.fetchBinary(url);
      if (res.tooLarge) return { status: 'too-large', size: res.size, reason: `larger than ${Math.round(opts.maxBytes / 1e6)} MB` };
      if (!res.ok) return { status: 'failed', reason: `HTTP ${res.status}` };
      if (/text\/html/i.test(res.contentType || '')) return { status: 'failed', reason: 'the site sent a web page instead, so the file is probably missing from the site' };
      const type = String(res.contentType || '').split(';')[0].trim().toLowerCase();
      const size = res.bytes ? res.bytes.length : res.size;
      return { status: 'saved', bytes: res.bytes, blob: res.blob, crc: res.crc, size, contentType: type, path: mediaPath(url, type), typeKind: kindOfType(type) };
    }
    async function worker() {
      while (next < list.length && !stopped()) {
        const m = list[next++];
        let rec;
        if (m.kind === 'video' && opts.includeVideo === false) {
          rec = { status: 'skipped', reason: 'video files turned off' };
        } else {
          try {
            rec = await get(m.url);
            // The original wouldn't load: take the copy the page showed.
            if (rec.status === 'failed' && m.fallback) {
              const alt = await get(m.fallback).catch(() => null);
              if (alt && alt.status === 'saved') rec = alt;
            }
          } catch (err) {
            rec = { status: 'failed', reason: (err && err.message) || String(err) };
          }
        }
        const { typeKind, ...fields } = rec;
        if (rec.status === 'saved') bytes += rec.size || 0;
        out.set(m.url, { url: m.url, kind: (typeKind && typeKind !== 'file' ? typeKind : null) || m.kind, ...fields });
        progress({ phase: 'media', done: ++done, total: list.length, bytes, current: m.url });
      }
    }
    await Promise.all(Array.from({ length: opts.concurrency || 4 }, worker));
    for (const m of list) if (!out.has(m.url)) out.set(m.url, { url: m.url, kind: m.kind, status: 'failed', reason: 'stopped before download' });
    return out;
  }

  // ---------- laying out the folder ----------

  function slug(s) {
    return decodeURIComponent(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
  }

  // URL -> path of its Markdown file, mirroring the site's paths.
  function pagePath(url) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map(slug);
    if (!parts.length) parts.push('home');
    if (u.search) parts[parts.length - 1] += '-' + hash(u.search);
    let file = parts.join('/');
    if (file === 'index' || file === 'site') file += '-page'; // index.md and site.json are Verbatim's
    if (file === 'media' || file.startsWith('media/')) file = 'pages/' + file;
    return file.replace(/\.(html?|php|aspx?)$/i, '') + '.md';
  }

  function relative(from, to) {
    const a = from.split('/').slice(0, -1);
    const b = to.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return '../'.repeat(a.length - i) + b.slice(i).join('/');
  }

  const LINK = /(!?\[[^\]]*\]\()([^)\s]+)(\))/g;

  const yaml = (v) => JSON.stringify(v == null ? '' : String(v));

  function pageMarkdown(page, ctx) {
    const here = page.path;
    const local = new Map(); // remote URL -> local path, for this page
    for (const m of page.media) {
      const rec = ctx.media.get(m.url);
      if (rec && rec.status === 'saved') for (const u of [m.url, ...(m.aliases || [])]) local.set(u, rec.path);
    }
    const used = new Set();
    const body = (page.markdown || '').replace(LINK, (all, open, url, close) => {
      const media = local.get(url);
      if (media) {
        used.add(media);
        return open + relative(here, media) + close;
      }
      const target = ctx.pageByUrl.get(normalizeUrl(url));
      return target ? open + relative(here, target.path) + close : all;
    })
      // Sites often include an image twice (desktop and mobile versions); show it once.
      .replace(/(!\[[^\]]*\]\([^)]+\))(\s*\n\s*\1)+/g, '$1');

    const out = [
      '---',
      `title: ${yaml(page.title)}`,
      `source: ${yaml(page.url)}`,
      `site: ${yaml(ctx.host)}`,
      'kind: "page"',
      `captured: ${yaml(ctx.capturedAt)}`,
      `words: ${page.words}`,
      'tags:',
      '  - "verbatim"',
      '  - "web"',
      `  - ${yaml(ctx.host.replace(/^www\./, ''))}`,
      '---',
      '',
      `# ${page.title}`,
      '',
      `- **Source:** ${page.url}`,
      `- **Site capture:** [${ctx.host}](${relative(here, 'index.md')})`,
    ];
    if (page.description) out.push('', `> ${page.description.replace(/\n+/g, ' ')}`);
    out.push('', '---', '', body || '_(no readable content)_', '');

    // Everything on the page that the main text doesn't already show.
    const extra = [];
    for (const m of page.media) {
      const rec = ctx.media.get(m.url);
      if (!rec) continue;
      if (rec.status !== 'saved') {
        extra.push(`- ${rec.kind} not saved (${rec.reason}): ${m.url}`);
        continue;
      }
      if (used.has(rec.path) || ctx.siteWide.has(m.url)) continue; // site-wide ones are listed once, in index.md
      used.add(rec.path);
      const p = relative(here, rec.path);
      const name = (m.alt || rec.path.split('/').pop()).replace(/[[\]]/g, '');
      extra.push(rec.kind === 'image' ? `![${name}](${p})` : `- [${rec.kind === 'video' ? '▶ ' : rec.kind === 'audio' ? '♪ ' : ''}${name}](${p})`);
    }
    for (const e of page.embeds) if (!body.includes(e.url)) extra.push(`- [▶ ${(e.title || 'Embedded video').replace(/[[\]]/g, '')}](${e.url}) (embedded player, linked)`);
    if (extra.length) out.push('---', '', '## Media on this page', '', ...extra, '');
    return out.join('\n');
  }

  function assess(result, media) {
    const checks = [];
    const total = result.pages.length + result.failed.length;
    checks.push({
      id: 'pages_found',
      label: 'Pages found',
      result: result.pages.length ? 'pass' : 'fail',
      detail: `${result.found} pages found (${result.fromSitemap} from the sitemap, the rest by following links).`,
    });
    checks.push({
      id: 'pages_saved',
      label: 'Every page visited was saved',
      result: result.failed.length ? 'fail' : 'pass',
      detail: result.failed.length
        ? `${result.pages.length} of ${total} saved; ${result.failed.length} failed: ${result.failed.slice(0, 5).map((f) => `${f.url} (${f.reason})`).join('; ')}${result.failed.length > 5 ? '…' : ''}`
        : `${result.pages.length} of ${total} saved.`,
    });
    checks.push({
      id: 'whole_site',
      label: 'Whole site covered',
      result: result.stopped || result.limitReached ? 'fail' : 'pass',
      detail: result.stopped ? `Stopped before the end: ${result.notVisited.length} pages found but not visited.`
        : result.limitReached ? `Stopped at the page limit: ${result.notVisited.length} more pages were found but not visited. Raise the limit and capture again.`
        : 'Every page found was visited.',
    });
    const all = [...media.values()].filter((m) => m.status !== 'skipped');
    const skipped = media.size - all.length;
    const bad = all.filter((m) => m.status !== 'saved');
    checks.push({
      id: 'media_saved',
      label: 'Images, videos and files saved',
      result: !all.length ? 'unknown' : bad.length ? 'fail' : 'pass',
      detail: !all.length ? 'No images, videos or files found.'
        : bad.length ? `${all.length - bad.length} of ${all.length} saved; ${bad.length} not: ${bad.slice(0, 4).map((m) => `${m.url} (${m.reason})`).join('; ')}${bad.length > 4 ? '…' : ''}`
        : `${all.length} of ${all.length} saved.`,
    });
    const notes = [
      'Pages are read as the site serves them, the same way a single page capture reads one page. Text that only appears after clicking (tabs, "load more") may be missing.',
      'Embedded players (YouTube, Vimeo, Spotify…) are linked, not downloaded.',
    ];
    if (skipped) notes.push(`${skipped} video files were not downloaded (video files were turned off); they are listed on their pages.`);
    if (result.blocked.length) notes.push(`${result.blocked.length} pages were skipped because the site's robots.txt asks crawlers not to visit them.`);
    if (result.rendered) notes.push(`${result.rendered} pages had to be opened in a background tab, because the site builds them with JavaScript.`);
    const ok = checks.every((c) => c.result !== 'fail');
    return {
      status: ok ? 'captured' : 'incomplete',
      summary: ok ? `Captured the whole site: ${result.pages.length} pages and ${all.length} media files.`
        : `Partly captured: ${result.pages.length} pages and ${all.length - bad.length} media files saved. See the checks for what is missing.`,
      checks,
      warnings: notes,
    };
  }

  function stamp(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  }

  /**
   * The capture as files: [{ path, text }] and [{ path, bytes, mime }] under
   * one folder name. meta: { capturedAt, version }.
   */
  function build(result, media, meta) {
    const host = result.host;
    const folder = `${stamp(meta.capturedAt)} ${host.replace(/^www\./, '')} — whole site`;
    const pageByUrl = new Map();
    const usedPaths = new Set();
    for (const p of result.pages) {
      let path = pagePath(p.url);
      for (let n = 2; usedPaths.has(path); n++) path = path.replace(/(-\d+)?\.md$/, `-${n}.md`);
      usedPaths.add(path);
      p.path = path;
      pageByUrl.set(p.url, p);
      if (p.requested) pageByUrl.set(p.requested, p);
    }
    const completeness = assess(result, media);
    // Images on most pages (logo, share image) are site chrome, not content.
    const seenOn = new Map();
    for (const p of result.pages) for (const m of p.media) seenOn.set(m.url, (seenOn.get(m.url) || 0) + 1);
    const siteWide = new Set([...seenOn].filter(([, n]) => n >= Math.max(5, result.pages.length / 2)).map(([u]) => u));
    const ctx = { host, capturedAt: meta.capturedAt, media, pageByUrl, siteWide };
    const files = result.pages.map((p) => ({ path: p.path, mime: 'text/markdown', text: pageMarkdown(p, ctx) }));
    const usedMedia = new Set();
    for (const m of media.values()) {
      if (m.status !== 'saved' || usedMedia.has(m.path)) continue;
      usedMedia.add(m.path);
      files.push({ path: m.path, mime: m.contentType || 'application/octet-stream', bytes: m.bytes, blob: m.blob, crc: m.crc, size: m.size });
    }
    files.unshift({ path: 'index.md', mime: 'text/markdown', text: indexMarkdown(result, media, completeness, meta, siteWide) });
    files.push({ path: 'site.json', mime: 'application/json', text: siteJson(result, media, completeness, meta) });
    return { folder, files, completeness };
  }

  function indexMarkdown(result, media, c, meta, siteWide) {
    const host = result.host.replace(/^www\./, '');
    const all = [...media.values()];
    const out = [
      '---',
      `title: ${yaml(host + ' — whole site')}`,
      `source: ${yaml(result.start)}`,
      'kind: "site"',
      `captured: ${yaml(meta.capturedAt)}`,
      `pages: ${result.pages.length}`,
      `status: ${yaml(c.status)}`,
      'tags:',
      '  - "verbatim"',
      '  - "site"',
      `  - ${yaml(host.replace(/^www\./, ''))}`,
      '---',
      '',
      `# ${host} — whole site`,
      '',
      `- **Source:** ${result.start}`,
      `- **Captured:** ${meta.capturedAt}`,
      `- **Pages:** ${result.pages.length.toLocaleString('en-US')} (${result.pages.reduce((n, p) => n + p.words, 0).toLocaleString('en-US')} words)`,
      `- **Media:** ${all.filter((m) => m.status === 'saved').length} files saved in media/ (${['image', 'video', 'audio', 'file'].map((k) => `${all.filter((m) => m.kind === k && m.status === 'saved').length} ${k === 'audio' ? 'audio' : k + 's'}`).join(', ')})`,
      `- **Completeness:** ${c.status.toUpperCase()} — ${c.summary}`,
      '',
      '## Pages',
      '',
    ];
    // Grouped by the first part of the path ("startups/…").
    const groups = new Map();
    for (const p of [...result.pages].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const g = p.path.includes('/') ? p.path.split('/')[0] : '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    for (const [g, list] of [...groups].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : 1))) {
      if (g) out.push('', `### ${g} (${list.length})`, '');
      for (const p of list) out.push(`- [${p.title.replace(/[[\]]/g, '')}](${p.path})`);
    }
    const shared = [...siteWide].map((u) => media.get(u)).filter((m) => m && m.status === 'saved');
    if (shared.length) {
      out.push('', '## On every page', '', 'Images the site shows on most pages (logo, share image), saved once:', '');
      for (const m of shared) out.push(m.kind === 'image' ? `![](${m.path})` : `- [${m.path.split('/').pop()}](${m.path})`);
    }
    const embeds = [];
    for (const p of result.pages) for (const e of p.embeds) if (!embeds.some((x) => x.url === e.url)) embeds.push({ ...e, page: p });
    if (embeds.length) {
      out.push('', '## Embedded videos (linked)', '');
      for (const e of embeds) out.push(`- [${(e.title || e.url).replace(/[[\]]/g, '')}](${e.url}) — on [${e.page.title.replace(/[[\]]/g, '')}](${e.page.path})`);
    }
    out.push('', '---', '', '## Completeness report', '', `**Status: ${c.status.toUpperCase()}** — ${c.summary}`, '', '| Check | Result | Detail |', '| --- | --- | --- |');
    for (const k of c.checks) out.push(`| ${k.label} | ${k.result.toUpperCase()} | ${k.detail.replace(/\|/g, '\\|')} |`);
    out.push('', '**Scope notes**', '', ...c.warnings.map((w) => `- ${w}`), '');
    return out.join('\n');
  }

  function siteJson(result, media, c, meta) {
    return JSON.stringify({
      schema: 'verbatim/site-v1',
      kind: 'site',
      source: { url: result.start, host: result.host },
      capture: { capturedAt: meta.capturedAt, tool: 'Verbatim', toolVersion: meta.version, method: 'site crawl (sitemap + links), pages read like single page captures' },
      stats: { pages: result.pages.length, words: result.pages.reduce((n, p) => n + p.words, 0), media: media.size },
      completeness: c,
      pages: result.pages.map((p) => ({ url: p.url, path: p.path, title: p.title, words: p.words, method: p.method, rendered: p.rendered, media: p.media.map((m) => m.url), embeds: p.embeds })),
      media: [...media.values()].map(({ bytes, blob, crc, ...m }) => m),
      failed: result.failed,
      blockedByRobots: result.blocked,
      notVisited: result.notVisited,
    }, null, 2);
  }

  NS.site = { original, scanSource, normalizeUrl, sameSite, parseRobots, robotsAllows, parseSitemap, discover, readPage, collectMedia, crawl, downloadMedia, mediaPath, pagePath, relative, build };
})(globalThis);
