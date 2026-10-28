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

  NS.run = async function run(meta) {
    if (NS._running) return { error: 'A capture is already running in this tab.' };
    NS._running = true;
    try {
      const platform = NS.findPlatform(location.href);
      if (!platform) {
        return { error: 'Verbatim can only capture regular web pages (http or https).' };
      }
      const isPage = !!platform.fallback;
      NS.showPanel(isPage ? 'Verbatim\nReading this page…' : 'Verbatim\nScrolling to the start of the conversation…\nPlease keep this tab open and in front.');
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
      const what = capture.kind === 'page' ? `Page saved (${capture.stats.words} words).` : `${capture.stats.messageCount} messages saved, plus a handoff file.`;
      NS.showPanel(
        `Verbatim — ${c.status.toUpperCase()}\n${what}\n${c.summary}`,
        c.status === 'verified' || c.status === 'captured' ? 'ok' : c.status === 'unverified' ? 'warn' : 'error',
        12000
      );
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
      .then((result) => send({ type: 'cc-result', result }))
      .finally(() => clearInterval(heartbeat));
    return 'started';
  };
})(globalThis);
