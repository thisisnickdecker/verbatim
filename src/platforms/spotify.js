/*
 * Spotify episode transcript adapter (open.spotify.com/episode/...).
 *
 * Spotify shows a "Transcript" section on episode pages to signed-in
 * listeners, for episodes that have one. This adapter finds that section by
 * its heading, expands it ("Show more"), and reads each timestamped line.
 * No network requests, no Spotify API calls.
 *
 * Episode metadata uses the data-testids observed on the signed-out episode
 * page (October 2026). The transcript section is located by its visible
 * heading and timestamp pattern rather than class names, which Spotify
 * obfuscates and changes often.
 */
(function (root) {
  const NS = (root.Verbatim = root.Verbatim || {});

  const SEL = {
    title: '[data-testid="episodeTitle"], [data-testid="entityTitle"]',
    show: '[data-testid="showTitle"], [data-testid="entityAuthor"]',
    heading: 'h1, h2, h3, h4, [role="heading"]',
    mainView: 'main, [data-testid="main-view"]',
    tab: '[role="tab"], button, [role="button"]',
    transcriptHint: '[data-testid*="transcript" i], [aria-label*="transcript" i]',
    player: 'footer, [data-testid="now-playing-bar"], [data-testid="now-playing-widget"], [data-testid*="playback"], [role="slider"]',
    playerBar: '[data-testid="now-playing-bar"], footer',
    nowPlaying: '[data-testid="now-playing-widget"], [data-testid="now-playing-bar"], footer',
    playbackDuration: '[data-testid="playback-duration"]',
  };

  const HOSTS = /^open\.spotify\.com$/;
  const EPISODE_PATH = /^\/(?:intl-[a-z-]+\/)?episode\/([A-Za-z0-9]{22})/;
  const MORE = /^(show|see|read) (more|all|full transcript)$/i;

  function episodeId(url) {
    try {
      const u = new URL(url);
      const m = HOSTS.test(u.hostname) && u.pathname.match(EPISODE_PATH);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  const matches = (url) => !!episodeId(url);

  // Timestamps are matched on text, not elements: Spotify makes them
  // clickable (seek), so they may sit inside buttons. The player bar's own
  // clocks are left out.
  function stampNodes(scope) {
    const out = [];
    const walker = scope.ownerDocument.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (NS.transcript.parseClock(node.textContent) != null && !node.parentElement.closest(SEL.player)) out.push(node);
    }
    return out;
  }

  function commonBox(nodes, limit) {
    let box = nodes[0].parentElement;
    while (box && box !== limit && !nodes.every((n) => box.contains(n))) box = box.parentElement;
    return box;
  }

  // The transcript section: an element labelled "transcript", the nearest
  // ancestor of a "Transcript" heading that also holds timestamps, or (the
  // tabbed layout: Description | Transcript | Chapters) the panel after the
  // Transcript tab: its aria-controls target, else the smallest element
  // holding the timestamps that follow the tab.
  function findSection(doc) {
    const T = NS.transcript;
    const hasStamps = (el) => stampNodes(el).length > 0;
    for (const el of doc.querySelectorAll(SEL.transcriptHint)) {
      if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'tab' && hasStamps(el)) return el;
    }
    for (const h of doc.querySelectorAll(SEL.heading)) {
      if (!/^transcript$/i.test(T.cleanText(h.textContent))) continue;
      for (let el = h.parentElement; el && el !== doc.body; el = el.parentElement) {
        if (hasStamps(el)) return el;
      }
    }
    const tab = transcriptTab(doc);
    const scope = doc.querySelector(SEL.mainView) || doc.body;
    if (!tab) {
      const stamps = stampNodes(scope);
      return stamps.length >= 2 ? commonBox(stamps, scope) : null;
    }
    const panel = tab.getAttribute('aria-controls') && doc.getElementById(tab.getAttribute('aria-controls'));
    if (panel && stampNodes(panel).length >= 2) return panel;
    // The first ancestor of the tab holding timestamps after it holds the
    // panel, and not yet the sidebar's chapter list further on.
    for (let el = tab.parentElement; el && el !== doc.body; el = el.parentElement) {
      const after = stampNodes(el).filter((n) => tab.compareDocumentPosition(n) & 4 /* FOLLOWING */);
      if (after.length >= 2) return commonBox(after, el);
    }
    return null;
  }

  // A real tab first; a button labelled "Transcript" only if there is none.
  function transcriptTab(doc) {
    const named = (sel) => [...doc.querySelectorAll(sel)].find((b) => /^transcript$/i.test(NS.transcript.cleanText(b.textContent)));
    return named('[role="tab"]') || named(SEL.tab) || null;
  }

  function transcriptTabSelected(tab) {
    return ['aria-selected', 'aria-pressed', 'aria-checked'].some((a) => tab.getAttribute(a) === 'true');
  }

  // Each timestamp starts a segment; the text after it, up to the next
  // timestamp, is that segment's words. Text sharing the timestamp's row
  // ("0:00 Speaker 1") is the speaker label.
  function readSegments(section) {
    const T = NS.transcript;
    const stamps = new Set(stampNodes(section));
    const segments = [];
    let current = null;
    let row = null;
    const walker = section.ownerDocument.createTreeWalker(section, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = T.cleanText(node.textContent);
      if (!text || MORE.test(text)) continue;
      if (stamps.has(node)) {
        current = { start: T.parseClock(text), parts: [] };
        // The row is the first ancestor holding more than the timestamp.
        row = node.parentElement;
        while (row.parentElement && row.parentElement !== section && T.cleanText(row.textContent) === text) row = row.parentElement;
        segments.push(current);
      } else if (current) {
        current.parts.push({ text, inRow: row.contains(node) });
      }
    }
    // A label only counts as the speaker when the words themselves sit
    // outside the timestamp's row; otherwise the row is the whole line.
    // A timestamp row with no label continues the previous speaker (Spotify
    // only names the speaker when it changes).
    let speaker = null;
    return segments
      .map((s) => {
        const first = s.parts[0];
        const labelled = first && first.inRow && first.text.length <= 40 && s.parts.slice(1).some((p) => !p.inRow);
        if (labelled) speaker = first.text;
        else if (!first || first.inRow) speaker = null;
        const words = labelled ? s.parts.slice(1) : s.parts;
        return { start: s.start, speaker, text: words.map((p) => p.text).join(' ') };
      })
      .filter((s) => s.text);
  }

  function expand(section) {
    let n = 0;
    for (const b of section.querySelectorAll('button')) {
      if (MORE.test(NS.transcript.cleanText(b.textContent)) && b.getAttribute('aria-expanded') !== 'true') {
        b.click();
        n++;
      }
    }
    return n;
  }

  // The player's duration is only trusted when the player holds this
  // episode: a link to it, or its title, in the now-playing area.
  function durationSec(doc, id, title) {
    const T = NS.transcript;
    const np = doc.querySelector(SEL.nowPlaying);
    if (!np) return null;
    const ours = np.querySelector(`a[href*="${id}"]`) || (title && T.cleanText(np.textContent).includes(title));
    if (!ours) return null;
    const el = doc.querySelector(SEL.playbackDuration);
    if (el && T.parseClock(el.textContent) != null) return T.parseClock(el.textContent);
    // Otherwise the longest clock in the player bar (position and length sit side by side).
    const bar = doc.querySelector(SEL.playerBar) || np;
    const clocks = [...bar.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => T.parseClock(e.textContent)).filter((n) => n != null);
    return clocks.length ? Math.max(...clocks) : null;
  }

  async function collect(opts) {
    const doc = opts.document;
    const T = NS.transcript;
    const started = Date.now();
    const id = episodeId(opts.url);
    const evidence = { layout: 'transcript', panelFound: false, panelOpened: false, idMatches: null, settled: false, expanded: 0 };

    await T.waitFor(() => doc.querySelector(SEL.title), opts, 10000);
    // Tabbed layout: the transcript is only rendered once its tab is selected.
    const tab = await T.waitFor(() => transcriptTab(doc), opts, 3000);
    // Read the description first: its tab panel goes away once Transcript is selected.
    const description = await readDescription(doc, opts);
    if (tab && !transcriptTabSelected(tab)) tab.click();
    evidence.tabFound = !!tab;
    let section = await T.waitFor(() => findSection(doc), opts, 6000);
    evidence.panelFound = !!section;
    if (section) {
      evidence.panelOpened = true;
      evidence.expanded = expand(section);
      const settled = await T.settle(() => {
        section = findSection(doc) || section;
        return readSegments(section).length;
      }, opts);
      evidence.settled = settled.settled;
    }

    const segments = section ? readSegments(section) : [];
    const titleEl = doc.querySelector(SEL.title);
    const showEl = doc.querySelector(SEL.show);
    const title = T.cleanText(titleEl && titleEl.textContent) || (doc.title || '').replace(/\s*\|.*$/, '').trim() || 'Untitled Spotify episode';
    const dur = durationSec(doc, id, title);
    // If nothing was found, record what the page looked like, to fix the reader from.
    if (!section) evidence.debug = pageShape(doc, tab);

    Object.assign(evidence, {
      idMatches: true, // the page is addressed by episode ID; there is no second episode view to confuse it with
      segmentCount: segments.length,
      firstSegmentSec: segments.length ? segments[0].start : null,
      lastSegmentSec: segments.length ? segments[segments.length - 1].start : null,
      durationSec: dur,
      timestamped: segments.length > 0,
      durationMs: Date.now() - started,
    });

    return {
      kind: 'transcript',
      platform: 'spotify',
      platformName: 'Spotify',
      url: `https://open.spotify.com/episode/${id}`,
      mediaId: id,
      title,
      media: {
        type: 'podcast episode',
        show: showEl ? T.cleanText(showEl.textContent) : null,
        showLabel: 'Show',
        publishedTime: null,
        durationSec: dur,
        description,
        timeLink: null,
      },
      chapters: [],
      segments,
      evidence,
    };
  }

  function pageShape(doc, tab) {
    const scope = doc.querySelector(SEL.mainView) || doc.body;
    const stamps = stampNodes(scope);
    const describe = (el) => el && `<${el.tagName.toLowerCase()}${[...el.attributes].filter((a) => a.name !== 'class' && a.name !== 'style').map((a) => ` ${a.name}="${a.value.slice(0, 60)}"`).join('')}>`;
    const path = (el) => {
      const out = [];
      for (let e = el; e && e !== doc.body && out.length < 8; e = e.parentElement) out.push(describe(e));
      return out;
    };
    return {
      tab: describe(tab),
      tabPath: tab ? path(tab) : null,
      stampsInMain: stamps.length,
      firstStampPath: stamps.length ? path(stamps[0].parentElement) : null,
      firstStampRowText: stamps.length ? NS.transcript.cleanText(stamps[0].parentElement.parentElement.textContent).slice(0, 120) : null,
      disclaimerFound: /transcript was generated automatically/i.test(scope.textContent || ''),
    };
  }

  // The Description tab panel holds the description (clamped behind
  // "… Show more"), then "See all episodes" and the comments; only the first
  // part is the description. Older layout: an "Episode Description" heading.
  async function readDescription(doc, opts) {
    const panel = doc.getElementById('description-panel');
    const box = panel && panel.firstElementChild;
    if (!box) return episodeDescription(doc);
    const more = () => [...box.querySelectorAll('button')].find((b) => /show more/i.test(b.textContent));
    if (more()) {
      more().click();
      await NS.transcript.waitFor(() => !more(), opts, 2000);
    }
    return descriptionText(box);
  }

  // Paragraphs kept apart; links keep their address.
  function descriptionText(box) {
    const T = NS.transcript;
    const clone = box.cloneNode(true);
    clone.querySelectorAll('button').forEach((n) => n.remove());
    clone.querySelectorAll('a[href]').forEach((a) => {
      if (/^https?:/.test(a.href) && !a.textContent.includes(a.href)) a.textContent = `${a.textContent} (${a.href})`;
    });
    const paras = [...clone.querySelectorAll('p')].map((el) => T.cleanText(el.textContent)).filter(Boolean);
    return (paras.length ? paras.join('\n\n') : T.cleanText(clone.textContent)) || null;
  }

  function episodeDescription(doc) {
    for (const h of doc.querySelectorAll(SEL.heading)) {
      if (!/^(episode )?description$/i.test(NS.transcript.cleanText(h.textContent))) continue;
      const clone = h.parentElement.cloneNode(true);
      clone.querySelectorAll(SEL.heading).forEach((n) => n.remove());
      const text = descriptionText(clone);
      if (text) return text;
    }
    return null;
  }

  NS.platforms = NS.platforms || {};
  NS.platforms.spotify = { id: 'spotify', name: 'Spotify', kind: 'transcript', matches, collect };
})(globalThis);
