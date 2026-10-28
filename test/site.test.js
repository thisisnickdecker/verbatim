/*
 * Whole-site capture: crawl, media, folder layout, completeness, .zip.
 * The site is fake (served from a map); the code is the extension's own.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const { loadSource } = require('./fake-chatgpt');

const ORIGIN = 'https://www.example.org';
const plain = (v) => JSON.parse(JSON.stringify(v));

function card(slug, name, badge) {
  return `<a href="/startups/${slug}"><img src="https://icons.example.net/${slug}.png" alt=""><div><h3><span>${name}</span>${badge ? '<span>equity</span>' : ''}</h3><p>${name} builds things.</p><p>Robotics</p></div></a>`;
}

function page(title, body) {
  return `<!doctype html><html><head><title>${title} · Example</title><meta property="og:title" content="Example · the index"></head><body><header><nav><a href="/">Home</a><a href="/about">About</a></nav></header><main><h1>${title}</h1>${body}</main><footer><a href="/admin/secret">Admin</a></footer></body></html>`;
}

function fakeSite(extra) {
  const pages = {
    '/': page('Example', `<p>An index of companies, with enough words to read as the main content of this page for the reader.</p>${card('acme', 'Acme', true)}${card('bolt', 'Bolt', false)}<a href="/report.pdf">Annual report</a>`),
    '/about': page('About', '<p>About this index. We list companies that build hard things, and we explain why each one is here.</p><picture><source srcset="/img/team.avif 1x" type="image/avif"><img src="/img/team.jpg" srcset="/img/team.jpg 1x, /img/team@2x.jpg 2x" alt="The team"></picture>'),
    '/startups/acme': page('Acme', '<p>Acme builds rockets. They are reusable and they land on their own, which saves a great deal of money.</p><dl><div><dt>Sector</dt><dd>Space</dd></div><div><dt>Team</dt><dd>50 people</dd></div></dl><iframe src="https://www.youtube-nocookie.com/embed/abc123XYZ" title="Video about Acme"></iframe><video src="/media/launch.mp4" poster="/img/poster.jpg"></video><a href="/startups/bolt">Next: Bolt</a>'),
    '/startups/bolt': page('Bolt', '<p>Bolt builds batteries for cars and grids, made from sodium rather than lithium, and cheaper for it.</p><img src="https://cdn.example.net/missing.png" alt="Gone">'),
    '/startups/hidden': page('Hidden', '<p>Only linked from the sitemap.</p>'),
    ...(extra || {}),
  };
  const files = {
    '/robots.txt': 'User-agent: *\nDisallow: /admin\n\nSitemap: https://www.example.org/sitemap.xml\n',
    '/sitemap.xml': `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/startups/acme</loc></url><url><loc>${ORIGIN}/startups/hidden</loc></url><url><loc>${ORIGIN}/admin/panel</loc></url></urlset>`,
  };
  const bytes = (s) => new Uint8Array(Buffer.from(s));
  const media = {
    'https://icons.example.net/acme.png': ['image/png', bytes('PNG-acme')],
    'https://icons.example.net/bolt.png': ['image/png', bytes('PNG-bolt')],
    [`${ORIGIN}/img/team@2x.jpg`]: ['image/jpeg', bytes('JPG-team')],
    [`${ORIGIN}/img/poster.jpg`]: ['image/jpeg', bytes('JPG-poster')],
    [`${ORIGIN}/media/launch.mp4`]: ['video/mp4', bytes('MP4-launch')],
    [`${ORIGIN}/report.pdf`]: ['application/pdf', bytes('PDF-report')],
  };
  const requested = [];
  return {
    requested,
    fetchText: async (url) => {
      const p = new URL(url).pathname;
      if (!(p in files)) throw new Error('HTTP 404');
      return files[p];
    },
    fetchPage: async (url) => {
      requested.push(url);
      const p = new URL(url).pathname;
      if (p.endsWith('.pdf')) return { ok: true, status: 200, url, contentType: 'application/pdf', text: '' };
      if (!(p in pages)) return { ok: false, status: 404, url, contentType: 'text/html', text: '' };
      return { ok: true, status: 200, url, contentType: 'text/html; charset=utf-8', text: pages[p] };
    },
    fetchBinary: async (url) => (media[url] ? { ok: true, status: 200, contentType: media[url][0], bytes: media[url][1] } : { ok: false, status: 404 }),
  };
}

function setup() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'chrome-extension://verbatim/src/site/site.html', runScripts: 'outside-only' });
  return loadSource(dom.window);
}

async function capture(site, opts) {
  const V = setup();
  const result = await V.site.crawl({ start: `${ORIGIN}/?utm_source=x`, delayMs: 0, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...site, ...opts });
  const media = await V.site.downloadMedia(result, { ...site, maxBytes: 1e6 });
  const out = V.site.build(result, media, { capturedAt: '2026-10-28T18:00:00.000Z', version: '0.6.0' });
  const file = (p) => out.files.find((f) => f.path === p);
  return { V, result, media, out, file };
}

test('site: crawls the sitemap and links, follows robots.txt, mirrors paths', async () => {
  const site = fakeSite();
  const { result, out, file } = await capture(site);
  const paths = out.files.map((f) => f.path).sort();
  for (const p of ['index.md', 'home.md', 'about.md', 'startups/acme.md', 'startups/bolt.md', 'startups/hidden.md', 'site.json']) assert.ok(paths.includes(p), p);
  // Disallowed by robots.txt: never requested, reported.
  assert.ok(!site.requested.some((u) => u.includes('/admin')));
  assert.deepEqual(plain(result.blocked).sort(), [`${ORIGIN}/admin/panel`, `${ORIGIN}/admin/secret`]);
  // The tracking parameter on the start URL is dropped; each page is read once.
  assert.equal(site.requested.filter((u) => u === `${ORIGIN}/`).length, 1);
  assert.equal(result.pages.length, 5);
  assert.match(out.folder, /^2026-10-28 \d{2}-\d{2} example\.org — whole site$/);
  assert.match(file('startups/acme.md').text, /^title: "Acme"$/m); // the page's own heading, not the site-wide og:title
});

test('site: images, videos and files are saved locally and linked; embeds are linked', async () => {
  const { media, file } = await capture(fakeSite());
  const acme = file('startups/acme.md').text;
  assert.match(acme, /- \*\*Sector:\*\* Space/);
  assert.match(acme, /\[▶ Video about Acme\]\(https:\/\/www\.youtube\.com\/watch\?v=abc123XYZ\)/);
  assert.match(acme, /\[▶ Video\]\(\.\.\/media\/launch-\w+\.mp4\)/);
  assert.match(acme, /!\[Video poster\]\(\.\.\/media\/poster-\w+\.jpg\)/);
  assert.match(acme, /\[Next: Bolt\]\(bolt\.md\)/); // link between captured pages becomes relative
  const home = file('home.md').text;
  assert.match(home, /### \[Acme equity\]\(startups\/acme\.md\)/); // card heading linked, badge spaced
  assert.match(home, /!\[\]\(media\/acme-\w+\.png\)/);
  assert.match(home, /\[Annual report\]\(media\/report-\w+\.pdf\)/);
  // A <picture>: the largest <img> candidate, once; not every format.
  const about = file('about.md').text;
  assert.match(about, /!\[The team\]\(media\/team-2x-\w+\.jpg\)/);
  assert.ok(![...media.keys()].some((u) => u.endsWith('.avif')));
  // Bytes are written as-is.
  const mp4 = [...media.values()].find((m) => m.url.endsWith('launch.mp4'));
  assert.equal(Buffer.from(file(mp4.path).bytes).toString(), 'MP4-launch');
});

test('site: what could not be saved is named, and the capture is incomplete', async () => {
  const { out, file } = await capture(fakeSite());
  const c = out.completeness;
  assert.equal(c.status, 'incomplete');
  const mediaCheck = c.checks.find((k) => k.id === 'media_saved');
  assert.equal(mediaCheck.result, 'fail');
  assert.match(mediaCheck.detail, /missing\.png \(HTTP 404\)/);
  assert.match(file('startups/bolt.md').text, /image not saved \(HTTP 404\): https:\/\/cdn\.example\.net\/missing\.png/);
  assert.match(file('index.md').text, /robots\.txt asks crawlers not to visit them/);
});

test('site: a complete capture is CAPTURED; the index lists every page', async () => {
  const site = fakeSite();
  const fetchBinary = async (url) => (await site.fetchBinary(url)).ok ? site.fetchBinary(url) : { ok: true, status: 200, contentType: 'image/png', bytes: new Uint8Array([1]) };
  const { out, file } = await capture({ ...site, fetchBinary });
  assert.equal(out.completeness.status, 'captured');
  const index = file('index.md').text;
  assert.match(index, /### startups \(3\)/);
  assert.match(index, /- \[Acme\]\(startups\/acme\.md\)/);
  assert.match(index, /## Embedded videos \(linked\)/);
  const json = JSON.parse(file('site.json').text);
  assert.equal(json.stats.pages, 5);
  assert.ok(json.media.every((m) => !('bytes' in m)));
});

test('site: the page limit stops the crawl and says how much is left', async () => {
  const { result, out } = await capture(fakeSite(), { maxPages: 2 });
  assert.equal(result.pages.length, 2);
  assert.equal(result.limitReached, true);
  const whole = out.completeness.checks.find((k) => k.id === 'whole_site');
  assert.equal(whole.result, 'fail');
  assert.match(whole.detail, /page limit: \d+ more pages/);
});

test('site: Stop keeps what was read', async () => {
  let stop = false;
  const site = fakeSite();
  const fetchPage = async (url) => {
    const res = await site.fetchPage(url);
    stop = true; // stop after the first page
    return res;
  };
  const { result, out } = await capture({ ...site, fetchPage }, { isStopped: () => stop, concurrency: 1 });
  assert.equal(result.pages.length, 1);
  assert.equal(result.stopped, true);
  assert.match(out.completeness.checks.find((k) => k.id === 'whole_site').detail, /Stopped before the end/);
});

test('site: an app-shell page is opened in a tab to render', async () => {
  const shell = '<!doctype html><html><head><title>App</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
  const site = fakeSite({ '/app': shell });
  site.fetchText = async (url) => {
    if (url.endsWith('/robots.txt')) return 'User-agent: *\nAllow: /\n';
    throw new Error('HTTP 404');
  };
  const rendered = [];
  const render = async (url) => {
    rendered.push(url);
    return page('App', '<p>Rendered by JavaScript into a full page of text that a reader can now see and save.</p>');
  };
  const { result } = await capture(site, { start: `${ORIGIN}/app`, render, maxPages: 1 });
  assert.deepEqual(rendered, [`${ORIGIN}/app`]);
  assert.equal(result.pages[0].rendered, true);
  assert.match(result.pages[0].markdown, /Rendered by JavaScript/);
});

test('site: URLs, robots rules, file paths', () => {
  const { site } = setup();
  assert.equal(site.normalizeUrl('https://x.org/a/?utm_source=t&b=2&a=1#top'), 'https://x.org/a?a=1&b=2');
  assert.equal(site.normalizeUrl('mailto:a@b.c'), null);
  assert.ok(site.sameSite('https://www.x.org/a', 'https://x.org/b'));
  const rules = site.parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/ok\n');
  assert.equal(site.robotsAllows(rules, 'https://x.org/'), true);
  assert.equal(site.robotsAllows(rules, 'https://x.org/private/a'), false);
  assert.equal(site.robotsAllows(rules, 'https://x.org/private/ok'), true);
  assert.equal(site.pagePath('https://x.org/'), 'home.md');
  assert.equal(site.pagePath('https://x.org/blog/post.html'), 'blog/post.md');
  assert.equal(site.pagePath('https://x.org/index'), 'index-page.md');
  assert.match(site.pagePath('https://x.org/search?q=a'), /^search-\w+\.md$/);
  assert.equal(site.relative('startups/a.md', 'media/x.png'), '../media/x.png');
  assert.equal(site.relative('a.md', 'startups/b.md'), 'startups/b.md');
  assert.match(site.mediaPath('https://www.google.com/s2/favicons?domain=alice-bob.com&sz=128', 'image/png'), /^media\/alice-bob\.com-\w+\.png$/);
});

test('zip: a valid archive with folders and binary files', { skip: !hasUnzip() }, () => {
  const { zip } = setup();
  const parts = zip.zip([
    { path: 'site/index.md', text: '# Héllo\n' },
    { path: 'site/media/a.bin', bytes: new Uint8Array([0, 1, 2, 255]) },
  ]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-zip-')), 't.zip');
  fs.writeFileSync(file, Buffer.concat(parts.map((p) => Buffer.from(p))));
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', file, 'site/index.md']).toString(), '# Héllo\n');
  assert.deepEqual([...execFileSync('unzip', ['-p', file, 'site/media/a.bin'])], [0, 1, 2, 255]);
});

function hasUnzip() {
  try {
    execFileSync('unzip', ['-v']);
    return true;
  } catch (_) {
    return false;
  }
}

test('page: This page / Whole site choice', async () => {
  const dom = new JSDOM('<!doctype html><html><body><p>Hi</p></body></html>', { url: 'https://www.example.org/', runScripts: 'outside-only' });
  const V = loadSource(dom.window);
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'src/content/run-capture.js'), 'utf8'));
  const choice = V.chooseScope();
  const buttons = [...dom.window.document.querySelectorAll('#verbatim-capture-panel-choice button')];
  assert.deepEqual(buttons.map((b) => b.textContent.split('Every')[0].split('The text')[0]), ['This page', 'Whole site', 'Cancel']);
  assert.match(buttons[1].textContent, /Every page on example\.org/);
  buttons[1].click();
  assert.equal(await choice, 'site');
  assert.equal(dom.window.document.getElementById('verbatim-capture-panel-choice'), null);
});

test('page: a card link Readability turned into <div href> stays a link', () => {
  const V = setup();
  const doc = new JSDOM('<div id="r"><div href="https://x.org/startups/acme"><div><p><img src="https://x.org/a.png" alt=""></p></div><div><h3><span>Acme</span><span>equity</span></h3><p>Rockets.</p></div></div></div>', { url: 'https://x.org/' }).window.document;
  const md = V.htmlToMarkdown.createConverter()(doc.getElementById('r')).markdown;
  assert.match(md, /### \[Acme equity\]\(https:\/\/x\.org\/startups\/acme\)/);
  assert.match(md, /^Rockets\.$/m);
});

test('media: originals instead of resized copies', () => {
  const { site } = setup();
  const o = site.original;
  assert.equal(o('https://dia.imgix.net/media/1/Clip.mp4?video-thumbnail=0&w=1200&h=630'), 'https://dia.imgix.net/media/1/Clip.mp4');
  assert.equal(o('https://x.org/_next/image?url=%2Fimg%2Fa.jpg&w=640&q=75'), 'https://x.org/img/a.jpg');
  assert.equal(o('https://x.org/wp-content/uploads/2026/01/photo-1024x683.jpg'), 'https://x.org/wp-content/uploads/2026/01/photo.jpg');
  assert.equal(o('https://cdn.shopify.com/s/files/1/a/products/shoe_600x.jpg?v=1&width=600'), 'https://cdn.shopify.com/s/files/1/a/products/shoe.jpg?v=1');
  assert.equal(o('https://res.cloudinary.com/demo/image/upload/w_400,c_fill/v123/sample.jpg'), 'https://res.cloudinary.com/demo/image/upload/v123/sample.jpg');
  assert.equal(o('https://cdn.prod.website-files.com/abc/img-p-500.jpeg'), 'https://cdn.prod.website-files.com/abc/img.jpeg');
  assert.equal(o('https://example.org/a.jpg?w=300'), 'https://example.org/a.jpg?w=300'); // unknown hosts are left alone
});

test('media: found in the page data; only the largest of a list of sizes', () => {
  const { site } = setup();
  const html = '<script>const data={media:[{kind:"video",urlHighQuality:"https:\\/\\/cdn.x.net\\/media\\/1\\/Booklet.mp4"},{srcset:"https://cdn.x.net/i/a_1.webp 600w, https://cdn.x.net/i/a_2.webp 1200w, https://cdn.x.net/i/a_3.webp 3000w"}]}</script>';
  assert.deepEqual(plain(site.scanSource(html)).sort(), ['https://cdn.x.net/i/a_3.webp', 'https://cdn.x.net/media/1/Booklet.mp4']);
});

test('media: a JavaScript-built page gets its media from its data, named by what the server sends', async () => {
  const shellish = '<!doctype html><html><head><title>Clip · Studio</title><meta property="og:image" content="https://studio.imgix.net/media/9/Reel.mp4?video-thumbnail=0&amp;w=1200&amp;h=630"></head><body><header><a href="/">Studio</a></header><main><h1>Clip</h1></main><script>window.__data={items:[{kind:"video",urlHighQuality:"https://cdn.studio.net/media/9/Reel_1.mp4"},{srcset:"https://cdn.studio.net/i/still_small.webp 800w, https://cdn.studio.net/i/still_big.webp 3000w"}]}</script></body></html>';
  const site = fakeSite({ '/work/clip': shellish });
  site.fetchText = async (url) => (url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /\n' : Promise.reject(new Error('404')));
  const served = {
    // The original of the og thumbnail is the video itself.
    'https://studio.imgix.net/media/9/Reel.mp4': ['video/mp4', 'MP4-reel'],
    'https://cdn.studio.net/media/9/Reel_1.mp4': ['video/mp4', 'MP4-reel-hq'],
    'https://cdn.studio.net/i/still_big.webp': ['image/webp', 'WEBP-big'],
  };
  const fetchBinary = async (url) => (served[url] ? { ok: true, status: 200, contentType: served[url][0], bytes: new Uint8Array(Buffer.from(served[url][1])) } : { ok: false, status: 404 });
  const rendered = [];
  const { media, file } = await capture({ ...site, fetchBinary }, { start: 'https://www.example.org/work/clip', maxPages: 1, render: async (u) => { rendered.push(u); return null; } });
  assert.deepEqual(rendered, ['https://www.example.org/work/clip']); // too little visible text: tried in a tab
  const saved = [...media.values()].filter((m) => m.status === 'saved').map((m) => m.path).sort();
  assert.equal(saved.length, 3);
  assert.ok(saved.some((p) => /^media\/Reel_1-\w+\.mp4$/.test(p)));
  assert.ok(saved.some((p) => /^media\/still_big-\w+\.webp$/.test(p)));
  assert.ok(![...media.keys()].some((u) => u.includes('still_small')));
  assert.match(file('work/clip.md').text, /- \[▶ Reel_1-\w+\.mp4\]\(\.\.\/media\/Reel_1-\w+\.mp4\)/);
});

test('media: an image served from a .mp4 address is saved as an image', () => {
  const { site } = setup();
  assert.match(site.mediaPath('https://dia.imgix.net/media/1/Clip.mp4?video-thumbnail=0', 'image/jpeg'), /^media\/Clip-\w+\.jpg$/);
  assert.match(site.mediaPath('https://x.org/a.jpeg', 'image/jpeg'), /^media\/a-\w+\.jpeg$/);
  assert.match(site.mediaPath('https://x.org/a', 'image/png'), /^media\/a-\w+\.png$/);
});

test('media: falls back to the resized copy; video files can be turned off', async () => {
  const site = fakeSite({ '/p': page('P', '<p>A page with one resized image and a video file on it, for the reader.</p><img src="https://img.example.imgix.net/a.jpg?w=300" alt="A"><video src="/media/launch.mp4"></video>') });
  site.fetchText = async (url) => (url.endsWith('/robots.txt') ? '' : Promise.reject(new Error('404')));
  const fetchBinary = async (url) => (url === 'https://img.example.imgix.net/a.jpg?w=300' ? { ok: true, status: 200, contentType: 'image/jpeg', bytes: new Uint8Array([1]) } : { ok: false, status: 403 });
  const { media, out } = await capture({ ...site, fetchBinary }, { start: 'https://www.example.org/p', maxPages: 1 });
  const V = setup();
  const media2 = await V.site.downloadMedia({ pages: [{ media: [{ url: 'https://www.example.org/media/launch.mp4', kind: 'video', aliases: [] }] }] }, { fetchBinary, includeVideo: false });
  assert.equal(media.get('https://img.example.imgix.net/a.jpg').status, 'saved'); // the original 403'd; the copy saved
  assert.equal(media2.get('https://www.example.org/media/launch.mp4').status, 'skipped');
  assert.ok(out.files.some((f) => /^media\/a-\w+\.jpg$/.test(f.path)));
});

test('zip: Blob entries with a CRC worked out in pieces', { skip: !hasUnzip() }, async () => {
  const { zip } = setup();
  const a = Buffer.from('hello '), b = Buffer.from('world');
  const crc = zip.crc32(b, zip.crc32(a));
  assert.equal(crc, zip.crc32(Buffer.concat([a, b])));
  const parts = zip.zip([{ path: 'v/clip.mp4', blob: new Blob([a, b]), size: 11, crc }, { path: 'v/i.md', text: 'x' }]);
  const bufs = await Promise.all(parts.map(async (p) => (p instanceof Blob ? Buffer.from(await p.arrayBuffer()) : Buffer.from(p))));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-zip-')), 'b.zip');
  fs.writeFileSync(file, Buffer.concat(bufs));
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', file, 'v/clip.mp4']).toString(), 'hello world');
});

test('page: Cloudflare-protected emails are decoded; /cdn-cgi/ is not crawled', async () => {
  const V = setup();
  const doc = new JSDOM('<div id="r"><p>Write to <a href="/cdn-cgi/l/email-protection#422a272e2e2d02273a232f322e276c2d3025">[email&#160;protected]</a> or <span class="__cf_email__" data-cfemail="5a323f3636351a3f223b372a363f7435283d">[email&#160;protected]</span>.</p></div>', { url: 'https://x.org/' }).window.document;
  const md = V.htmlToMarkdown.createConverter()(doc.getElementById('r')).markdown;
  assert.equal(md, 'Write to [hello@example.org](mailto:hello@example.org) or hello@example.org.');
  const site = fakeSite({ '/contact': page('Contact', '<p>Contact us by email, any time, about anything at all that you would like to ask.</p><a href="/cdn-cgi/l/email-protection#bbd5d2">x</a>') });
  site.fetchText = async () => Promise.reject(new Error('404'));
  await capture(site, { start: 'https://www.example.org/contact', maxPages: 3 });
  assert.ok(!site.requested.some((u) => u.includes('/cdn-cgi/')));
});
