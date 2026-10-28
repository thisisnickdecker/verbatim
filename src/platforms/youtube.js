/*
 * YouTube transcript adapter.
 *
 * Opens the video's own "Show transcript" panel (the button in the
 * description) and reads the segments YouTube renders there. No network
 * requests, no YouTube API calls.
 *
 * Two panel layouts are handled (observed October 2026):
 *   modern  <transcript-segment-view-model> rows, chapters as
 *           <timeline-chapter-view-model> headings
 *   legacy  <ytd-transcript-segment-renderer> rows, chapters as
 *           <ytd-transcript-section-header-renderer>
 * The panel renders every segment at once, so there is no scroll sweep;
 * completeness is judged by the last timestamp against the video length.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  // All selectors in one place so DOM changes are a one-file fix.
  const SEL = {
    watch: 'ytd-watch-flexy',
    openButton: 'ytd-video-description-transcript-section-renderer button, button[aria-label="Show transcript"]',
    item: 'transcript-segment-view-model, ytd-transcript-segment-renderer, timeline-chapter-view-model, ytd-transcript-section-header-renderer',
    segment: 'transcript-segment-view-model, ytd-transcript-segment-renderer',
    chapter: 'timeline-chapter-view-model, ytd-transcript-section-header-renderer',
    stamp: '.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp',
    text: '[role="text"], .ytAttributedStringHost, .segment-text',
    title: 'ytd-watch-metadata h1',
    channel: 'ytd-watch-metadata #owner #channel-name a, ytd-video-owner-renderer #channel-name a',
    // Expanded text when the description is open, the snippet (full text, clamped by CSS) when not.
    description: 'ytd-watch-metadata #description-inline-expander :is(#expanded yt-attributed-string, #attributed-snippet-text, yt-attributed-string)',
    playerDuration: '.ytp-time-duration',
  };

  const HOSTS = /^(www\.|m\.)?youtube\.com$/;
  const ID = /^[\w-]{11}$/;

  function videoId(url) {
    try {
      const u = new URL(url);
      if (!HOSTS.test(u.hostname)) return null;
      const v = u.pathname === '/watch' ? u.searchParams.get('v') : (u.pathname.match(/^\/live\/([\w-]{11})/) || [])[1];
      return v && ID.test(v) ? v : null;
    } catch (_) {
      return null;
    }
  }

  const matches = (url) => !!videoId(url);

  function meta(doc, sel) {
    const el = doc.querySelector(sel);
    return el && el.content ? el.content.trim() : null;
  }

  function readItems(doc) {
    const T = NS.transcript;
    const chapters = [];
    const segments = [];
    let pendingChapter = null;
    for (const el of doc.querySelectorAll(SEL.item)) {
      if (el.matches(SEL.chapter)) {
        pendingChapter = T.cleanText(el.textContent);
        continue;
      }
      const stampEl = el.querySelector(SEL.stamp);
      const textEl = el.querySelector(SEL.text);
      const start = T.parseClock(stampEl && stampEl.textContent);
      const text = T.cleanText(textEl ? textEl.textContent : el.textContent);
      if (!text) continue;
      if (pendingChapter) {
        chapters.push({ start, title: pendingChapter });
        pendingChapter = null;
      }
      segments.push({ start, text, speaker: null });
    }
    return { chapters, segments };
  }

  function durationSec(doc) {
    const T = NS.transcript;
    const player = doc.querySelector(SEL.playerDuration);
    return T.parseClock(player && player.textContent) || T.parseIsoDuration(meta(doc, 'meta[itemprop="duration"]'));
  }

  async function collect(opts) {
    const doc = opts.document;
    const T = NS.transcript;
    const started = Date.now();
    const id = videoId(opts.url);
    const evidence = { layout: 'transcript', panelFound: false, panelOpened: false, idMatches: null, settled: false };

    // YouTube is a single-page app: wait until the watch page shows this video.
    const flexy = await T.waitFor(() => {
      const f = doc.querySelector(SEL.watch);
      return f && f.getAttribute('video-id') === id ? f : null;
    }, opts, 10000);
    const shownId = (doc.querySelector(SEL.watch) || { getAttribute: () => null }).getAttribute('video-id');
    evidence.idMatches = shownId ? shownId === id : null;

    const count = () => doc.querySelectorAll(SEL.segment).length;
    if (!count()) {
      const button = await T.waitFor(() => doc.querySelector(SEL.openButton), opts, flexy ? 8000 : 3000);
      evidence.panelFound = !!button;
      if (button) {
        button.click();
        evidence.panelOpened = true;
      }
    } else {
      evidence.panelFound = evidence.panelOpened = true;
    }

    let settled = { count: 0, settled: false };
    if (evidence.panelFound) settled = await T.settle(count, opts);
    evidence.settled = settled.settled;

    const { chapters, segments } = readItems(doc);
    const titleEl = doc.querySelector(SEL.title);
    const title = T.cleanText(titleEl && titleEl.textContent) || (doc.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim() || 'Untitled YouTube video';
    const channelEl = doc.querySelector(SEL.channel);
    const description = [...doc.querySelectorAll(SEL.description)]
      .map((el) => (el.innerText || el.textContent || '').trim())
      .reduce((a, b) => (b.length > a.length ? b : a), '');
    const dur = durationSec(doc);

    Object.assign(evidence, {
      segmentCount: segments.length,
      firstSegmentSec: segments.length ? segments[0].start : null,
      lastSegmentSec: segments.length ? segments[segments.length - 1].start : null,
      durationSec: dur,
      timestamped: segments.length > 0 && segments.every((s) => s.start != null),
      durationMs: Date.now() - started,
    });

    return {
      kind: 'transcript',
      platform: 'youtube',
      platformName: 'YouTube',
      url: `https://www.youtube.com/watch?v=${id}`,
      mediaId: id,
      title,
      media: {
        type: 'video',
        show: channelEl ? T.cleanText(channelEl.textContent) : null,
        showLabel: 'Channel',
        publishedTime: meta(doc, 'meta[itemprop="uploadDate"]') || meta(doc, 'meta[itemprop="datePublished"]'),
        durationSec: dur,
        description: description || null,
        // Each timestamp in the export links back to that moment in the video.
        timeLink: `https://www.youtube.com/watch?v=${id}&t={s}s`,
      },
      chapters,
      segments,
      evidence,
    };
  }

  NS.platforms = NS.platforms || {};
  NS.platforms.youtube = { id: 'youtube', name: 'YouTube', kind: 'transcript', matches, collect };
})(globalThis);
