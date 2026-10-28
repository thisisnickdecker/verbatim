/*
 * Whole-site capture, part 3: the folder. One Markdown file per page in
 * folders that mirror the site, media/ shared by all pages, index.md and
 * site.json, links rewritten to the saved copies, and the completeness
 * report.
 */
(function (root) {
  const NS = (root.Verbatim = root.Verbatim || {});
  const site = (NS.site = NS.site || {});

  function slug(s) {
    return decodeURIComponent(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
  }

  // URL -> path of its Markdown file, mirroring the site's paths.
  function pagePath(url) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map(slug);
    if (!parts.length) parts.push('home');
    if (u.search) parts[parts.length - 1] += '-' + site.hash(u.search);
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
      const target = ctx.pageByUrl.get(site.normalizeUrl(url));
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

  Object.assign(site, { pagePath, relative, build });
})(globalThis);
