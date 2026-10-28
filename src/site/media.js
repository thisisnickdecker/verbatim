/*
 * Whole-site capture, part 2: media. Finds every image, video, audio file
 * and document a page shows (in its markup and in the data JavaScript-built
 * sites keep in scripts), prefers full-size originals over resized copies,
 * and downloads each once, named by what the server actually sent.
 */
(function (root) {
  const NS = (root.Verbatim = root.Verbatim || {});
  const site = (NS.site = NS.site || {});
  const FILE_EXT = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|key|pages|numbers|epub|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp4|m4v|mov|webm|ogv|mkv|avi|mp3|m4a|wav|ogg|oga|flac|aac)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv|mkv|avi)$/i;
  const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|oga|flac|aac)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic)$/i;
  const TRACKERS = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.com|simpleanalyticscdn\.com|plausible\.io|scorecardresearch\.com|quantserve\.com|hotjar\.com|segment\.io|bat\.bing\.com|linkedin\.com|t\.co|analytics\.[\w.]+)$/i;


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
      if (!site.sameSite(href, pageUrl) && !VIDEO_EXT.test(path) && !AUDIO_EXT.test(path)) continue;
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

  const isFileUrl = (url) => FILE_EXT.test(new URL(url).pathname);

  Object.assign(site, { original, scanSource, mediaKind, isFileUrl, collectMedia, collectEmbeds, hash, mediaPath, downloadMedia });
})(globalThis);
