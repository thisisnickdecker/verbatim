/*
 * Background service worker.
 *  - On toolbar click, injects the capture scripts into the active tab
 *    (activeTab grant: only that tab, only on click).
 *  - Receives the normalized capture and saves its files into the folder chosen
 *    in settings, or with chrome.downloads to Downloads/Verbatim.
 *    Nothing is sent anywhere else.
 */
importScripts('core/enrich.js', 'core/transcript.js', 'core/exporters.js', 'settings/folder.js');

const CC = globalThis.ConversationCapture;

// Order matters: shared core first, then platform adapters, then the entry point.
const CONTENT_FILES = [
  'src/vendor/Readability.js',
  'src/core/html-to-markdown.js',
  'src/core/enrich.js',
  'src/core/transcript.js',
  'src/core/completeness.js',
  'src/core/normalize.js',
  'src/platforms/chatgpt.js',
  'src/platforms/claude.js',
  'src/platforms/youtube.js',
  'src/platforms/spotify.js',
  'src/platforms/web.js',
  'src/platforms/registry.js',
  'src/content/run-capture.js',
];

function badge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!/^https?:/.test(tab.url || '')) {
    // Chrome's own pages (chrome://, the Web Store) can't be read by extensions.
    badge(tab.id, '—', '#6b7280');
    return;
  }
  badge(tab.id, '…', '#4b5563');
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (meta) => globalThis.ConversationCapture.start(meta),
      args: [{ version: chrome.runtime.getManifest().version }],
    });
  } catch (err) {
    badge(tab.id, 'ERR', '#b91c1c');
    console.error('Verbatim: could not start', err);
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId || sender.id !== chrome.runtime.id) return;
  if (msg.type === 'cc-progress') badge(tabId, `${msg.pct}%`, '#4b5563');
  if (msg.type === 'cc-result') saveResult(tabId, msg.result);
});

const STATUS_BADGE = {
  verified: ['OK', '#047857'],
  captured: ['OK', '#047857'],
  unverified: ['?', '#b45309'],
  incomplete: ['!', '#b91c1c'],
};

async function saveResult(tabId, result) {
  if (!result || result.error) {
    badge(tabId, 'ERR', '#b91c1c');
    await notifyInPage(tabId, 'Verbatim could not export:\n' + ((result && result.error) || 'unknown error').split('\n')[0], 'error');
    return;
  }
  const capture = result.capture;
  const files = CC.exporters.filesFor(capture);
  let where;
  try {
    where = await saveWithHelper(files);
    if (!where.saved) {
      const helperReason = where.reason;
      where = await saveToChosenFolder(files);
      if (!where.saved && !where.reason) where.reason = helperReason;
    }
    if (!where.saved) {
      for (const f of files) await download(f.filename, f.mime, f.text);
      where.label = 'Downloads/Verbatim' + (where.reason ? `\n${where.reason}` : '');
    }
  } catch (err) {
    badge(tabId, 'ERR', '#b91c1c');
    await notifyInPage(tabId, 'Verbatim could not save files:\n' + err.message, 'error');
    return;
  }
  const c = capture.completeness;
  badge(tabId, ...(STATUS_BADGE[c.status] || ['?', '#b45309']));
  const what = CC.exporters.savedLine(capture);
  const tone = c.status === 'verified' || c.status === 'captured' ? 'ok' : c.status === 'unverified' ? 'warn' : 'error';
  await notifyInPage(tabId, `Verbatim — ${c.status.toUpperCase()}\n${what}\n${c.summary}\nSaved to ${where.label}`, tone);
}

// Save through the optional local helper (native/install.sh), which writes
// straight into a folder such as an Obsidian vault. Not installed -> skip.
const HELPER = 'com.thestudiolo.verbatim';

function saveWithHelper(files) {
  return new Promise((resolve) => {
    let replied = false;
    try {
      chrome.runtime.sendNativeMessage(HELPER, { type: 'save', files: files.map((f) => ({ filename: f.filename, text: f.text })) }, (res) => {
        replied = true;
        const err = chrome.runtime.lastError;
        if (err || !res) return resolve({ saved: false, helperMissing: true });
        if (!res.ok) return resolve({ saved: false, reason: `(The save helper couldn't write: ${res.error})` });
        resolve({ saved: true, label: `“${res.folder}” › ${res.subfolder}` });
      });
    } catch (_) {
      if (!replied) resolve({ saved: false, helperMissing: true });
    }
  });
}

// Save into the folder chosen in settings, if there is one and Chrome still
// allows access. Otherwise report why, so the caller falls back to Downloads.
async function saveToChosenFolder(files) {
  let handle;
  try {
    handle = await CC.saveFolder.getFolder();
  } catch (_) {
    return { saved: false };
  }
  if (!handle) return { saved: false };
  if ((await CC.saveFolder.permission(handle)) !== 'granted') {
    // Only a page can ask Chrome for access again, so open Options for a one-click fix.
    chrome.runtime.openOptionsPage();
    return { saved: false, reason: `(“${handle.name}” needs your OK again. Verbatim opened its Options tab: click “Allow access again” and choose “Allow on every visit”.)` };
  }
  try {
    const out = await CC.saveFolder.writeFiles(handle, files);
    return { saved: true, label: `“${out.folder}” › ${out.subfolder}` };
  } catch (err) {
    return { saved: false, reason: `(Couldn't write to “${handle.name}”: ${err.message})` };
  }
}

function download(filename, mime, text) {
  // Service workers have no URL.createObjectURL, so use a data: URL.
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  return chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
}

function notifyInPage(tabId, text, tone) {
  return chrome.scripting
    .executeScript({ target: { tabId }, func: (t, k) => globalThis.ConversationCapture.showPanel(t, k, 12000), args: [text, tone] })
    .catch(() => {});
}
