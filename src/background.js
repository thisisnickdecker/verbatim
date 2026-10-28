/*
 * Background service worker.
 *  - Enables the toolbar button only on supported conversation pages.
 *  - On click, injects the capture scripts into the active tab (activeTab grant).
 *  - Receives the normalized conversation and saves conversation.md + .json
 *    with chrome.downloads. Nothing is sent anywhere else.
 */
importScripts('core/exporters.js');

const CC = globalThis.ConversationCapture;

// Order matters: shared core first, then platform adapters, then the entry point.
const CONTENT_FILES = [
  'src/core/html-to-markdown.js',
  'src/core/completeness.js',
  'src/core/normalize.js',
  'src/platforms/chatgpt.js',
  'src/platforms/registry.js',
  'src/content/run-capture.js',
];

const SUPPORTED_PAGES = [
  // ChatGPT conversation URLs, including those inside GPTs and projects (/g/…/c/<id>).
  { hostEquals: 'chatgpt.com', pathContains: '/c/' },
  { hostEquals: 'chat.openai.com', pathContains: '/c/' },
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: SUPPORTED_PAGES.map((pageUrl) => new chrome.declarativeContent.PageStateMatcher({ pageUrl })),
        actions: [new chrome.declarativeContent.ShowAction()],
      },
    ]);
  });
});

function badge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
}

chrome.action.onClicked.addListener(async (tab) => {
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
    console.error('Conversation Capture: could not start', err);
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId || sender.id !== chrome.runtime.id) return;
  if (msg.type === 'cc-progress') badge(tabId, `${msg.pct}%`, '#4b5563');
  if (msg.type === 'cc-result') saveResult(tabId, msg.result);
});

async function saveResult(tabId, result) {
  if (!result || result.error) {
    badge(tabId, 'ERR', '#b91c1c');
    await notifyInPage(tabId, 'Conversation Capture could not export:\n' + ((result && result.error) || 'unknown error').split('\n')[0], 'error');
    return;
  }
  const conv = result.conversation;
  const folder = CC.exporters.folderName(conv);
  try {
    await download(`${folder}/conversation.md`, 'text/markdown', CC.exporters.toMarkdown(conv));
    await download(`${folder}/conversation.json`, 'application/json', CC.exporters.toJSON(conv));
    const s = conv.completeness.status;
    badge(tabId, s === 'verified' ? 'OK' : s === 'unverified' ? '?' : '!', s === 'verified' ? '#047857' : s === 'unverified' ? '#b45309' : '#b91c1c');
  } catch (err) {
    badge(tabId, 'ERR', '#b91c1c');
    await notifyInPage(tabId, 'Conversation Capture could not save files:\n' + err.message, 'error');
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
