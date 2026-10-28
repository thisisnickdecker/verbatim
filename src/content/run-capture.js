/*
 * Entry point injected into the page (isolated world) when the toolbar button
 * is clicked. Picks the platform adapter, runs it, normalizes the result, and
 * shows a small progress panel. Returns the normalized conversation to the
 * background worker, which writes the files.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const PANEL_ID = 'verbatim-capture-panel';

  function panel(text, tone) {
    let el = document.getElementById(PANEL_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = PANEL_ID;
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647', 'max-width:360px',
        'padding:12px 14px', 'border-radius:10px', 'font:13px/1.45 system-ui,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.25)', 'white-space:pre-line', 'pointer-events:none',
      ].join(';');
      document.documentElement.appendChild(el);
    }
    const tones = { info: ['#1f2937', '#f9fafb'], ok: ['#064e3b', '#ecfdf5'], warn: ['#78350f', '#fffbeb'], error: ['#7f1d1d', '#fef2f2'] };
    const [bg, fg] = tones[tone || 'info'];
    el.style.background = bg;
    el.style.color = fg;
    el.textContent = text;
    return el;
  }

  NS.showPanel = function (text, tone, hideAfterMs) {
    const el = panel(text, tone);
    clearTimeout(NS._panelTimer);
    if (hideAfterMs) NS._panelTimer = setTimeout(() => el.remove(), hideAfterMs);
  };

  // On an ordinary web page: capture just this page, or the whole site?
  // Resolves 'page', 'site', or null (closed).
  NS.chooseScope = function chooseScope() {
    return new Promise((resolve) => {
      document.getElementById(PANEL_ID + '-choice')?.remove();
      const box = document.createElement('div');
      box.id = PANEL_ID + '-choice';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Verbatim');
      box.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647', 'width:300px',
        'padding:14px', 'border-radius:10px', 'font:13px/1.45 system-ui,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.25)', 'background:#1f2937', 'color:#f9fafb',
      ].join(';');
      const host = location.hostname.replace(/^www\./, '');
      const title = document.createElement('div');
      title.textContent = 'Verbatim — capture…';
      title.style.cssText = 'font-weight:600;margin-bottom:10px';
      const option = (label, sub, value) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.cssText = 'display:block;width:100%;text-align:left;margin:0 0 8px;padding:9px 11px;border-radius:8px;border:1px solid #4b5563;background:#111827;color:#f9fafb;font:inherit;cursor:pointer';
        const strong = document.createElement('div');
        strong.textContent = label;
        strong.style.fontWeight = '600';
        const small = document.createElement('div');
        small.textContent = sub;
        small.style.cssText = 'color:#9ca3af;font-size:12px';
        b.append(strong, small);
        b.addEventListener('click', () => close(value));
        return b;
      };
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.style.cssText = 'background:none;border:0;color:#9ca3af;font:inherit;cursor:pointer;padding:2px 0';
      cancel.addEventListener('click', () => close(null));
      const onKey = (e) => {
        if (e.key === 'Escape') close(null);
      };
      function close(value) {
        document.removeEventListener('keydown', onKey, true);
        box.remove();
        resolve(value);
      }
      document.addEventListener('keydown', onKey, true);
      box.append(title, option('This page', 'The text of this page as Markdown.', 'page'),
        option('Whole site', `Every page on ${host}, with its images, videos and files, in folders.`, 'site'), cancel);
      document.documentElement.appendChild(box);
      box.querySelector('button').focus();
    });
  };

  NS.run = async function run(meta) {
    if (NS._running) return { error: 'A capture is already running in this tab.' };
    NS._running = true;
    try {
      const platform = NS.findPlatform(location.href);
      if (!platform) {
        return { error: 'Verbatim can only capture regular web pages (http or https).' };
      }
      if (platform.fallback) {
        const scope = await NS.chooseScope();
        if (scope === null) return { site: true }; // cancelled: nothing to save
        if (scope === 'site') {
          NS.showPanel('Verbatim\nOpening the whole-site capture in a new tab…', 'info', 4000);
          return { site: true, url: location.href };
        }
      }
      NS.showPanel(platform.fallback ? 'Verbatim\nReading this page…'
        : platform.kind === 'transcript' ? `Verbatim\nOpening the ${platform.name} transcript…`
        : 'Verbatim\nScrolling to the start of the conversation…\nPlease keep this tab open and in front.');
      const raw = await platform.collect({
        document,
        url: location.href,
        onProgress(p) {
          try { chrome.runtime.sendMessage({ type: 'cc-progress', pct: p.pct }); } catch (_) { /* ignore */ }
          if (p.phase === 'sweep') NS.showPanel(`Verbatim\nReading ${platform.name}… ${p.pct}%  (${p.turns} so far)\nPlease don't scroll this tab.`);
        },
      });
      const capture = NS.normalize(raw, meta);
      const c = capture.completeness;
      const what = capture.kind === 'page' ? `Page read (${capture.stats.words} words).`
        : capture.kind === 'transcript' ? `Transcript read (${capture.stats.segments} segments).`
        : `${capture.stats.messageCount} messages read.`;
      // The background worker replaces this with the final message once the files are saved.
      NS.showPanel(`Verbatim\n${what}\nSaving…`);
      return { capture };
    } catch (err) {
      NS.showPanel('Verbatim failed:\n' + (err && err.message), 'error', 12000);
      return { error: String((err && err.stack) || err) };
    } finally {
      NS._running = false;
    }
  };

  // Called by the background worker. The result travels back as a runtime
  // message rather than as executeScript's return value, so a capture that
  // takes minutes survives the service worker being suspended and restarted.
  NS.start = function start(meta) {
    const send = (msg) => { try { chrome.runtime.sendMessage(msg); } catch (_) { /* extension reloaded */ } };
    const heartbeat = setInterval(() => send({ type: 'cc-heartbeat' }), 10000);
    NS.run(meta)
      .then((result) => {
        if (result && result.site && result.url) send({ type: 'cc-site', url: result.url });
        send({ type: 'cc-result', result });
      })
      .finally(() => clearInterval(heartbeat));
    return 'started';
  };
})(globalThis);
