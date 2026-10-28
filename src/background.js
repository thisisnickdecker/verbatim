/*
 * Background service worker.
 *  - On toolbar click, injects the capture scripts into the active tab
 *    (activeTab grant: only that tab, only on click).
 *  - Receives the normalized capture and saves its files with chrome.downloads.
 *    Nothing is sent anywhere else.
 */
importScripts('core/enrich.js', 'core/exporters.js');

const CC = globalThis.ConversationCapture;

// Order matters: shared core first, then platform adapters, then the entry point.
const CONTENT_FILES = [
  'src/vendor/Readability.js',
  'src/core/html-to-markdown.js',
  'src/core/enrich.js',
  'src/core/completeness.js',
  'src/core/normalize.js',
  'src/platforms/chatgpt.js',
  'src/platforms/claude.js',
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
  try {
    for (const f of CC.exporters.filesFor(capture)) await download(f.filename, f.mime, f.text);
    badge(tabId, ...(STATUS_BADGE[capture.completeness.status] || ['?', '#b45309']));
  } catch (err) {
    badge(tabId, 'ERR', '#b91c1c');
    await notifyInPage(tabId, 'Verbatim could not save files:\n' + err.message, 'error');
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
