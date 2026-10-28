/*
 * Fake YouTube watch pages and Spotify episode pages for tests.
 *
 * YouTube reproduces the transcript panel observed on youtube.com (October
 * 2026): a "Show transcript" button in the description that, when clicked,
 * fills an engagement panel with <transcript-segment-view-model> rows and
 * <timeline-chapter-view-model> headings (or the older
 * <ytd-transcript-segment-renderer> rows). Spotify's tabbed layout follows
 * the signed-in episode page (October 2026); the heading layout is an older
 * guess kept as a fallback. Text content is synthetic.
 */
const { JSDOM } = require('jsdom');
const { loadSource } = require('./fake-chatgpt');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function modernRows(segments, chapters) {
  return segments.map((s) => {
    const ch = chapters.find((c) => c.start === s.start);
    const head = ch ? `<yt-item-section-renderer><div id="header"><macro-markers-panel-item-view-model><timeline-chapter-view-model><h3>${esc(ch.title)}</h3></timeline-chapter-view-model></macro-markers-panel-item-view-model></div></yt-item-section-renderer>` : '';
    return `${head}<macro-markers-panel-item-view-model role="button"><timeline-item-view-model><transcript-segment-view-model>
      <div aria-hidden="true" class="ytwTranscriptSegmentViewModelTimestamp">${clock(s.start)}</div>
      <div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">${s.start} seconds</div>
      <span class="ytAttributedStringHost" role="text">${esc(s.text)}</span></transcript-segment-view-model></timeline-item-view-model></macro-markers-panel-item-view-model>`;
  }).join('');
}

function legacyRows(segments) {
  return segments.map((s) => `<ytd-transcript-segment-renderer><div class="segment"><div class="segment-start-offset"><div class="segment-timestamp">${clock(s.start)}</div></div><yt-formatted-string class="segment-text">${esc(s.text)}</yt-formatted-string></div></ytd-transcript-segment-renderer>`).join('');
}

/**
 * opts.segments [{ start, text }]   opts.chapters [{ start, title }]
 * opts.duration seconds shown in the player   opts.legacy older panel markup
 * opts.noTranscript no "Show transcript" button   opts.shownId video the page is showing
 */
function createYouTubePage(opts) {
  const id = opts.id || 'FquRuBqglg4';
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${esc(opts.title || 'Test video')} - YouTube</title></head><body>
      <ytd-app><ytd-watch-flexy video-id="${opts.shownId || id}">
        <div class="ytp-chrome-bottom"><span class="ytp-time-duration">${clock(opts.duration || 0)}</span></div>
        <div id="microformat"><meta itemprop="uploadDate" content="2026-09-07T03:00:14-07:00"><meta itemprop="duration" content="PT${Math.floor((opts.duration || 0) / 60)}M${(opts.duration || 0) % 60}S"></div>
        <ytd-watch-metadata>
          <div id="title"><h1><yt-formatted-string>${esc(opts.title || 'Test video')}</yt-formatted-string></h1></div>
          <div id="owner"><ytd-video-owner-renderer><div id="channel-name"><a href="/@caucus">The Creative Caucus</a></div></ytd-video-owner-renderer></div>
          <div id="description-inline-expander"><yt-attributed-string>A conversation about rebranding. Notes: https://example.com/notes</yt-attributed-string>
            ${opts.noTranscript ? '' : `<ytd-video-description-transcript-section-renderer><div id="button-container"><div id="primary-button"><ytd-button-renderer><yt-button-shape><button aria-label="Show transcript">Show transcript</button></yt-button-shape></ytd-button-renderer></div></div></ytd-video-description-transcript-section-renderer>`}
          </div>
        </ytd-watch-metadata>
        <div id="panels"><ytd-engagement-panel-section-list-renderer target-id="PAmodern_transcript_view" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"><div id="content"></div></ytd-engagement-panel-section-list-renderer></div>
      </ytd-watch-flexy></ytd-app></body></html>`,
    { url: `https://www.youtube.com/watch?v=${id}&pp=abc`, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  const doc = window.document;
  const button = doc.querySelector('button[aria-label="Show transcript"]');
  if (button) {
    button.addEventListener('click', () => {
      const panel = doc.querySelector('ytd-engagement-panel-section-list-renderer');
      panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
      // Rows arrive a moment after the click, as on the real page.
      window.setTimeout(() => {
        panel.querySelector('#content').innerHTML = opts.legacy ? legacyRows(opts.segments) : modernRows(opts.segments, opts.chapters || []);
      }, 5);
    });
  }
  return { window, doc, V: loadSource(window) };
}

function createSpotifyPage(opts) {
  const id = '5H3FXUgGf9hxqb6ZN2mjxu';
  const lines = (opts.segments || []).map((s) => `<div class="x9Ab"><span class="Tq0z">${clock(s.start)}</span><p class="Kd2p">${esc(s.text)}</p></div>`).join('');
  const transcript = opts.segments ? `<section class="r8Lm"><h2 class="e-91">Transcript</h2><div class="Lw2x">${lines}</div><button>Show more</button></section>` : '';
  // Tabbed layout as on the signed-in page (October 2026): Description |
  // Transcript | Chapters tabs with aria-controls; the transcript panel is a
  // flat list of rows: a disclaimer, then per block a row holding the
  // timestamp (a seek button) and speaker, followed by one row per paragraph.
  const blocks = (opts.segments || []).map((s, i) => `<div><div><button><div aria-expanded="false"><span data-encore-id="text">${clock(s.start)}</span></div></button>${s.speaker === null ? '' : `<span data-encore-id="text">${s.speaker || `Speaker ${(i % 2) + 1}`}</span>`}</div></div>${s.text.split(' | ').map((t) => `<div><span data-encore-id="text">${esc(t)}</span></div>`).join('')}`).join('');
  const tabbed = `<div role="tablist" aria-label="Episode information"><button role="tab" id="description-tab" aria-controls="description-panel" aria-selected="true">Description</button><button role="tab" id="transcript-tab" data-testid="transcript-tab" aria-controls="transcript-panel" aria-selected="false">Transcript</button><button role="tab" id="chapters-tab" aria-controls="chapters-panel" aria-selected="false">Chapters</button></div>
    <div role="tabpanel" id="description-panel"><div><div><p>The builders of the internet wanted to be the next Steve Jobs.</p></div><button>… Show more</button></div><a href="/show/x">See all episodes</a><div><span>Comments</span><span>Be the first to leave a comment.</span></div></div>`;
  const player = opts.playing ? `<aside data-testid="now-playing-bar"><div data-testid="now-playing-widget-v2"><a href="/episode/${id}">Everyone sits in the same traffic now</a></div><div data-testid="player-controls"><div data-testid="playback-position"><span>24:45</span></div><div data-testid="playback-duration"><span>${clock(opts.duration)}</span></div></div></aside>` : '';
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Everyone sits in the same traffic now | Listen to the Podcast on Spotify</title></head><body>
      <main><section data-testid="episode"><div data-testid="entity-header"><h1 data-testid="episodeTitle">Everyone sits in the same traffic now</h1><a data-testid="showTitle" href="/show/x">New Creative Era</a></div>
        <div data-testid="action-bar"><button aria-label="Transcript">Transcript</button></div>
        ${opts.tabbed ? tabbed : `<section><h2>Episode Description</h2><p>The builders of the internet wanted to be the next Steve Jobs.</p><button>Show more</button></section>
        ${transcript}`}
      </section></main>${opts.tabbed ? '<aside><h2>Chapters</h2><div><span>0:00</span> The Internet Transformed</div><div><span>12:10</span> Robert Moses</div></aside>' : ''}${player}</body></html>`,
    { url: `https://open.spotify.com/episode/${id}?si=a2c015c5cb444506`, runScripts: 'outside-only' }
  );
  const doc = dom.window.document;
  // "… Show more" unclamps the description and becomes "Show less".
  const descMore = doc.querySelector('#description-panel button');
  if (descMore) {
    descMore.addEventListener('click', () => dom.window.setTimeout(() => {
      descMore.previousElementSibling.insertAdjacentHTML('beforeend', '<p>Buy a ticket to the show <a href="https://example.com/tickets">here</a>.</p>');
      descMore.textContent = 'Show less';
    }, 5));
  }
  const trTab = doc.getElementById('transcript-tab');
  if (trTab) {
    trTab.addEventListener('click', () => {
      doc.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t === trTab)));
      dom.window.setTimeout(() => {
        doc.getElementById('description-panel').outerHTML = `<div role="tabpanel" id="transcript-panel" aria-labelledby="transcript-tab">${opts.segments
          ? `<div><span>This transcript was generated automatically. Its accuracy may vary.</span></div>${blocks}` : ''}</div>`;
      }, 5);
    });
  }
  return { window: dom.window, doc, V: loadSource(dom.window) };
}

const FAST = { poll: 1, stableFor: 2, timeout: 2000 };

async function captureMedia(page) {
  const platform = page.V.findPlatform(page.window.location.href);
  const raw = await platform.collect({
    document: page.doc,
    url: page.window.location.href,
    sleep: (ms) => new Promise((r) => page.window.setTimeout(r, ms)),
    timing: FAST,
  });
  const tr = page.V.normalize(raw, { version: require('../manifest.json').version, capturedAt: '2026-10-28T18:00:00.000Z' });
  return { raw, tr, platform };
}

module.exports = { createYouTubePage, createSpotifyPage, captureMedia };
