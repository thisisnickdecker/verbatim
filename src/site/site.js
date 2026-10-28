/*
 * Verbatim's whole-site capture tab. Opened by the in-page panel's
 * "Whole site" button with ?url=<page the user was on>.
 *
 * Start asks Chrome for access to websites (an optional permission, needed
 * to read the site's pages and to download images hosted elsewhere), then
 * crawls, downloads media, and saves: through the save helper, into the
 * chosen folder, or as one .zip in Downloads/Verbatim.
 */
(function () {
  const CC = globalThis.ConversationCapture;
  const $ = (id) => document.getElementById(id);

  const MAX_MEDIA_BYTES = 250e6;
  const HELPER = 'com.thestudiolo.verbatim';
  const startUrl = new URL(location.href).searchParams.get('url');
  let stopRequested = false;

  if (!startUrl || !/^https?:/.test(startUrl)) {
    $('intro').innerHTML = '<p class="error">No site to capture. Open a web page and use Verbatim\'s “Whole site” button.</p>';
    return;
  }
  const host = new URL(startUrl).hostname;
  document.title = `Verbatim — ${host}`;
  $('title').textContent = `Capture ${host.replace(/^www\./, '')}`;
  $('host').textContent = host.replace(/^www\./, '');

  // ---------- network ----------

  const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'include', signal: timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  async function fetchPage(url) {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow', signal: timeout(30000) });
    const contentType = res.headers.get('content-type') || '';
    const isHtml = /html/i.test(contentType) || !contentType;
    const text = res.ok && isHtml ? await res.text() : '';
    if (!isHtml && res.body) res.body.cancel().catch(() => {});
    return { ok: res.ok, status: res.status, url: res.url, contentType, text };
  }

  async function fetchBinary(url) {
    const res = await fetch(url, { credentials: 'omit', signal: timeout(180000) });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, status: res.status };
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > MAX_MEDIA_BYTES) {
      res.body && res.body.cancel().catch(() => {});
      return { tooLarge: true, size: declared };
    }
    // Kept as a Blob (Chrome moves large ones to disk), with its checksum
    // for the .zip worked out on the way in.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    let crc = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_MEDIA_BYTES) {
        reader.cancel().catch(() => {});
        return { tooLarge: true, size };
      }
      crc = CC.zip.crc32(value, crc);
      chunks.push(value);
    }
    return { ok: true, status: res.status, contentType, blob: new Blob(chunks, { type: contentType }), size, crc };
  }

  // Pages the server sends as an empty app shell: open them in a background
  // tab, let them build, and read the result.
  async function render(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    try {
      await new Promise((resolve) => {
        const done = (id, info) => {
          if (id === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(done);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(done);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }, 20000);
      });
      await new Promise((r) => setTimeout(r, 1500));
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.outerHTML });
      return res && res.result;
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  // ---------- progress ----------

  function show(section) {
    for (const id of ['intro', 'running', 'done']) $(id).hidden = id !== section;
  }

  function progress(p) {
    if (p.phase === 'discover') {
      $('phase').textContent = 'Reading the sitemap…';
    } else if (p.phase === 'pages') {
      const total = Math.max(p.found, 1);
      $('phase').textContent = 'Reading pages…';
      $('bar').style.width = `${Math.min(100, ((p.saved + p.failed) / total) * 100)}%`;
      $('stats').textContent = `${p.saved.toLocaleString()} pages saved of ${p.found.toLocaleString()} found` + (p.failed ? ` · ${p.failed} failed` : '');
      $('current').textContent = p.current || '';
    } else if (p.phase === 'media') {
      $('phase').textContent = 'Downloading images, videos and files…';
      $('bar').style.width = `${(p.done / Math.max(p.total, 1)) * 100}%`;
      $('stats').textContent = `${p.done.toLocaleString()} of ${p.total.toLocaleString()} media files · ${megabytes(p.bytes || 0)}`;
      $('current').textContent = p.current || '';
    } else if (p.phase === 'save') {
      $('phase').textContent = 'Saving…';
      $('bar').style.width = `${(p.done / Math.max(p.total, 1)) * 100}%`;
      $('stats').textContent = p.text || '';
      $('current').textContent = '';
    }
  }

  const megabytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

  // ---------- run ----------

  $('start').addEventListener('click', async () => {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    if (!granted) {
      $('permissionNote').textContent = 'Verbatim needs access to websites to read this site\'s pages and download its images. Click Start again and choose Allow.';
      return;
    }
    run(Math.max(1, Number($('max').value) || 1000), $('video').checked);
  });

  $('stop').addEventListener('click', () => {
    stopRequested = true;
    $('stop').disabled = true;
    $('stop').textContent = 'Stopping…';
  });

  window.addEventListener('beforeunload', (e) => {
    if (!$('running').hidden) e.preventDefault();
  });

  async function run(maxPages, includeVideo) {
    show('running');
    const capturedAt = new Date().toISOString();
    try {
      const result = await CC.site.crawl({
        start: startUrl,
        maxPages,
        fetchText,
        fetchPage,
        render,
        isStopped: () => stopRequested,
        onProgress: progress,
      });
      const media = await CC.site.downloadMedia(result, {
        fetchBinary,
        maxBytes: MAX_MEDIA_BYTES,
        includeVideo,
        isStopped: () => stopRequested,
        onProgress: progress,
      });
      const out = CC.site.build(result, media, { capturedAt, version: chrome.runtime.getManifest().version });
      await save(out);
    } catch (err) {
      show('done');
      $('dot').className = 'dot err';
      $('statusLine').textContent = 'Verbatim could not capture this site';
      $('where').textContent = (err && err.message) || String(err);
      console.error(err);
    }
  }

  // ---------- saving ----------

  async function save(out) {
    progress({ phase: 'save', done: 0, total: 1, text: `${out.files.length.toLocaleString()} files` });
    let where = await saveWithHelper(out).catch(() => null);
    if (!where) {
      const handle = await CC.saveFolder.getFolder().catch(() => null);
      if (handle && (await CC.saveFolder.permission(handle)) === 'granted') {
        where = await saveToFolder(handle, out).catch((err) => {
          console.error(err);
          return null;
        });
      } else if (handle) {
        // Chrome wants a click before it allows the folder again.
        return finish(out, null, [
          button(`Save to “${handle.name}”`, true, async () => {
            if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
            finish(out, await saveToFolder(handle, out));
          }),
          button('Download a .zip instead', false, async () => finish(out, await saveZip(out))),
        ]);
      }
    }
    if (!where) where = await saveZip(out);
    finish(out, where);
  }

  async function saveToFolder(handle, out) {
    show('running');
    const res = await CC.saveFolder.writeTree(handle, out.folder, out.files, (done, total) =>
      progress({ phase: 'save', done, total, text: `${done.toLocaleString()} of ${total.toLocaleString()} files written` }));
    return { label: `“${res.folder}” › ${res.subfolder}` };
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function nativeSave(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(HELPER, msg, (res) => resolve(chrome.runtime.lastError ? null : res));
    });
  }

  // The save helper, in parts of ~24 MB (native messages are limited in size).
  async function saveWithHelper(out) {
    const ping = await nativeSave({ type: 'ping' });
    if (!ping || !ping.ok) return null;
    let into = null;
    let folder = null;
    let batch = [];
    let size = 0;
    const flush = async () => {
      const res = await nativeSave({ type: 'save-tree', ...(into ? { into } : { name: out.folder }), files: batch });
      if (!res || !res.ok) throw new Error((res && res.error) || 'the save helper did not answer');
      into = res.subfolder;
      folder = res.folder;
      batch = [];
      size = 0;
    };
    for (let i = 0; i < out.files.length; i++) {
      const f = out.files[i];
      const bytes = f.blob ? new Uint8Array(await f.blob.arrayBuffer()) : f.bytes;
      const entry = bytes ? { path: f.path, base64: toBase64(bytes) } : { path: f.path, text: f.text };
      batch.push(entry);
      size += (entry.base64 || entry.text).length;
      if (size > 24e6) await flush();
      progress({ phase: 'save', done: i + 1, total: out.files.length, text: `${i + 1} of ${out.files.length} files written` });
    }
    if (batch.length || !into) await flush();
    return { label: `“${folder}” › ${into}` };
  }

  // One .zip, or several "part N of M" when it would pass ~2 GB (unzip them
  // all into the same place: they share the top folder).
  async function saveZip(out) {
    progress({ phase: 'save', done: 0, total: 1, text: 'Building the .zip…' });
    const LIMIT = 2e9;
    const groups = [[]];
    let size = 0;
    for (const f of out.files) {
      const n = f.size || (f.bytes ? f.bytes.length : (f.text || '').length * 3);
      if (size + n > LIMIT && groups[groups.length - 1].length) {
        groups.push([]);
        size = 0;
      }
      groups[groups.length - 1].push({ ...f, path: `${out.folder}/${f.path}` });
      size += n;
    }
    let first = null;
    let total = 0;
    for (let i = 0; i < groups.length; i++) {
      const blob = new Blob(CC.zip.zip(groups[i]), { type: 'application/zip' });
      total += blob.size;
      const name = groups.length > 1 ? `${out.folder} (part ${i + 1} of ${groups.length}).zip` : `${out.folder}.zip`;
      const url = URL.createObjectURL(blob);
      const id = await chrome.downloads.download({ url, filename: `Verbatim/${name}`, conflictAction: 'uniquify', saveAs: false });
      if (first == null) first = id;
      chrome.downloads.onChanged.addListener(function done(d) {
        if (d.id === id && d.state && d.state.current !== 'in_progress') {
          chrome.downloads.onChanged.removeListener(done);
          URL.revokeObjectURL(url);
        }
      });
    }
    const what = groups.length > 1 ? `${groups.length} .zip parts named “${out.folder} (part N of ${groups.length})”` : `${out.folder}.zip`;
    return { label: `Downloads/Verbatim: ${what} (${megabytes(total)}). Unzip ${groups.length > 1 ? 'them all into one place' : 'it'} to get the folder.`, downloadId: first };
  }

  function button(text, primary, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    if (primary) b.className = 'primary';
    b.addEventListener('click', onClick);
    return b;
  }

  function finish(out, where, buttons) {
    show('done');
    const c = out.completeness;
    $('dot').className = 'dot ' + (c.status === 'captured' ? 'ok' : 'warn');
    $('statusLine').textContent = `${c.status.toUpperCase()} — ${c.summary}`;
    $('where').textContent = where ? `Saved to ${where.label}` : 'Choose where to save:';
    const row = $('saveButtons');
    row.replaceChildren(...(buttons || []));
    if (where && where.downloadId != null) row.append(button('Show in Finder', false, () => chrome.downloads.show(where.downloadId)));
    $('checks').replaceChildren(...c.checks.map((k) => {
      const tr = document.createElement('tr');
      for (const [text, cls] of [[k.label, ''], [k.result.toUpperCase(), 'r'], [k.detail, '']]) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.append(td);
      }
      return tr;
    }));
    $('notes').replaceChildren(...c.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  }
})();
