/*
 * Shared helpers for transcript adapters (YouTube, Spotify) and the
 * transcript exporter: clock parsing/formatting and waiting for a lazily
 * rendered list to stop growing.
 *
 * Raw transcript shape (produced by transcript adapters):
 *   { kind: 'transcript', platform, platformName, url, mediaId, title,
 *     media: { type, show, publishedTime, durationSec, description, timeLink },
 *     chapters: [{ start, title }],
 *     segments: [{ start, text, speaker }],
 *     evidence: { panelFound, idMatches, settled, durationMs, ... } }
 * start values are seconds (or null when the page shows no timestamps).
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const CLOCK = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;

  // "1:02:03" / "12:43" / "0:09" -> seconds; anything else -> null.
  function parseClock(s) {
    const m = String(s || '').trim().match(CLOCK);
    return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : null;
  }

  // ISO 8601 durations as used in page metadata ("PT58M53S").
  function parseIsoDuration(s) {
    const m = String(s || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
    return m && s !== 'P' && s !== 'PT' ? ((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + ((+m[3] || 0) * 60) + Math.round(+m[4] || 0) : null;
  }

  function clock(sec) {
    if (sec == null) return '';
    const s = Math.max(0, Math.floor(sec));
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    return h ? `${h}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
  }

  const sleeper = (opts) => opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // Poll count() until it is non-zero and unchanged for `stableFor` polls.
  async function settle(count, opts) {
    const sleep = sleeper(opts);
    const t = Object.assign({ poll: 300, stableFor: 3, timeout: 15000 }, opts.timing);
    const until = Date.now() + t.timeout;
    let last = -1;
    let same = 0;
    for (;;) {
      const n = count();
      same = n > 0 && n === last ? same + 1 : 0;
      last = n;
      if (same >= t.stableFor) return { count: n, settled: true };
      if (Date.now() > until) return { count: n, settled: false };
      await sleep(t.poll);
    }
  }

  async function waitFor(fn, opts, timeout) {
    const sleep = sleeper(opts);
    const until = Date.now() + Math.min(timeout || 10000, (opts.timing && opts.timing.timeout) || Infinity);
    for (;;) {
      const v = fn();
      if (v || Date.now() > until) return v || null;
      await sleep((opts.timing && opts.timing.poll) || 300);
    }
  }

  const cleanText = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  NS.transcript = { parseClock, parseIsoDuration, clock, settle, waitFor, cleanText };
})(globalThis);
