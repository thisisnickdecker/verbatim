/*
 * Completeness assessment. Platform-neutral: it reads the adapter's evidence
 * and the normalized messages and decides what can honestly be claimed.
 *
 * status:
 *   "verified"   every required check passed
 *   "unverified" nothing failed, but at least one required check could not be evaluated
 *   "incomplete" at least one required check failed (content is known to be missing)
 */
(function (root) {
  const NS = (root.Verbatim = root.Verbatim || {});

  function check(id, label, result, detail, required) {
    return { id, label, result, detail, required: required !== false };
  }

  function assess(raw, messages) {
    const e = raw.evidence || {};
    const checks = [];
    const warnings = [];

    checks.push(check('scroll_container', 'Conversation scroll container found',
      e.scrollerFound ? 'pass' : 'unknown',
      e.scrollerFound ? 'Located the scrolling message list.' : 'Could not locate the scrolling list; only messages already on screen were read.'));

    checks.push(check('reached_top', 'Reached the start of the conversation',
      e.reachedTop === true ? 'pass' : e.reachedTop === false ? 'fail' : 'unknown',
      e.reachedTop === true ? 'Scrolled to the top and waited until no older messages loaded.'
        : e.reachedTop === false ? 'Older messages were still loading (or the page did not settle) before the time limit.'
        : 'Start of conversation not checked for this page layout.'));

    checks.push(check('reached_bottom', 'Reached the end of the conversation',
      e.reachedBottom === true ? 'pass' : e.reachedBottom === false ? 'fail' : 'unknown',
      e.reachedBottom === true ? 'Scrolled to the bottom of the message list.'
        : e.reachedBottom === false ? 'Did not reach the bottom before the time limit.'
        : 'End of conversation not checked for this page layout.'));

    checks.push(check('matches_page', 'Messages belong to the conversation in the address bar',
      e.foreignMessages ? 'fail' : 'pass',
      e.foreignMessages ? `${e.foreignMessages} message(s) carry a different conversation ID than the page URL; another conversation's content was read.`
        : `Read only the visible conversation${e.hiddenViewsIgnored ? ` (ignored ${e.hiddenViewsIgnored} hidden view(s) of previously opened chats)` : ''}.`));

    if (e.expectedMessages != null) {
      // The platform states its total (Claude: "Message N of TOTAL"): check every position was read.
      const missing = e.missingIndices || [];
      checks.push(check('count_matches', 'Every message the page says exists was captured',
        missing.length ? 'fail' : 'pass',
        missing.length ? `The page reports ${e.expectedMessages} messages; ${missing.length} were never read (positions ${missing.slice(0, 10).map((i) => i + 1).join(', ')}${missing.length > 10 ? ', …' : ''}).`
          : `Captured all ${e.expectedMessages} messages the page reports.`));
    }

    const continuity = e.snapshots > 0 && e.reachedTop && e.reachedBottom;
    if (e.expectedMessages == null) checks.push(check('continuous_sweep', 'No gaps between scroll snapshots',
      !continuity ? 'unknown' : e.gapCount === 0 && e.olderTurnsAppearedDuringSweep === 0 ? 'pass' : 'fail',
      !continuity ? 'A full top-to-bottom sweep did not happen, so continuity cannot be shown.'
        : e.gapCount === 0 && e.olderTurnsAppearedDuringSweep === 0
          ? `Each of ${e.snapshots} overlapping snapshots shared at least one turn with the previous ones.`
          : `${e.gapCount} snapshot(s) shared no turn with earlier ones and ${e.olderTurnsAppearedDuringSweep} turn(s) appeared above the start mid-sweep; messages may be missing between them.`));

    const unrendered = raw.turns.filter((t) => t.renderState !== 'complete' && t.renderState !== 'unknown').length;
    const unknownRender = raw.turns.filter((t) => t.renderState === 'unknown').length;
    checks.push(check('turns_rendered', 'Every turn was fully rendered when read',
      unrendered ? 'fail' : unknownRender ? 'unknown' : raw.turns.length ? 'pass' : 'fail',
      unrendered ? `${unrendered} turn(s) were still placeholders when read.`
        : unknownRender ? 'The page did not expose render state for some turns.'
        : raw.turns.length ? `All ${raw.turns.length} turns reported a complete render state.` : 'No turns were found.'));

    const empty = messages.filter((m) => !m.content.markdown.trim() && !m.attachments.length);
    checks.push(check('no_empty_messages', 'No empty messages',
      empty.length ? 'fail' : 'pass',
      empty.length ? `Messages ${empty.map((m) => m.index).join(', ')} have no readable content.` : 'Every message has text or an attachment.'));

    const truncated = messages.filter((m) => m.flags.includes('truncated-not-expanded'));
    checks.push(check('no_truncated_messages', 'No message left collapsed ("Show more")',
      truncated.length ? 'fail' : 'pass',
      truncated.length ? `Messages ${truncated.map((m) => m.index).join(', ')} were still collapsed; their text is cut off.`
        : `${e.expandedMessages || 0} collapsed message(s) were expanded before reading.`));

    const unknownRoles = messages.filter((m) => m.role === 'unknown');
    checks.push(check('roles_identified', 'Every message has a known role',
      unknownRoles.length ? 'fail' : 'pass',
      unknownRoles.length ? `Messages ${unknownRoles.map((m) => m.index).join(', ')} have no identifiable role.` : 'All messages are user or assistant (or tool/system).'));

    checks.push(check('not_streaming', 'No response was still being generated',
      e.streaming ? 'fail' : 'pass',
      e.streaming ? 'A response was still streaming; the last message may be cut off.' : 'No stop-generation control was visible.'));

    checks.push(check('no_timeout', 'Capture finished within its time limit',
      e.timedOut ? 'fail' : 'pass', e.timedOut ? 'The capture stopped early.' : `Finished in ${Math.round((e.durationMs || 0) / 1000)} s.`));

    // Scope notes: never block "verified", but always reported.
    if (messages.some((m) => m.flags.includes('has-alternate-branches'))) {
      warnings.push('Some messages have edited/regenerated alternatives (e.g. "2/2"). Only the branch currently shown on screen was captured.');
    }
    if (messages.some((m) => m.flags.includes('collapsed-reasoning-not-captured'))) {
      warnings.push('Some responses include collapsed reasoning or tool-use steps (e.g. "Thought for …"). Only the visible reply text is captured.');
    }
    const imageCount = messages.reduce((n, m) => n + m.attachments.filter((a) => a.type === 'image').length, 0);
    const sessionOnly = messages.reduce((n, m) => n + m.attachments.filter((a) => a.type === 'image' && !a.url).length, 0);
    if (sessionOnly) {
      warnings.push(`${sessionOnly} uploaded image(s) are only listed: ${raw.platformName} displays them from temporary in-browser links, so no lasting URL exists. Keep the originals separately.`);
    }
    if (imageCount) {
      warnings.push(`${imageCount} image(s) are recorded as URL references only; the image files were not downloaded and their URLs may require sign-in or expire.`);
    }
    if (messages.some((m) => m.attachments.some((a) => a.type === 'file'))) {
      warnings.push('File attachments are recorded by name only (detected heuristically); file contents were not captured.');
    }
    if (messages.some((m) => m.attachments.some((a) => a.note && /artifact/.test(a.note)))) {
      warnings.push('Artifacts/documents created in the chat are listed by name; open them in the chat to save their contents.');
    }
    warnings.push(e.expectedMessages != null
      ? `Completeness is judged from the rendered page and checked against the ${e.expectedMessages}-message total that ${raw.platformName} reports.`
      : `Completeness is judged from the rendered page. ${raw.platformName} does not display a total message count, so the check confirms a continuous top-to-bottom read, not a count match.`);

    const required = checks.filter((c) => c.required);
    const status = required.some((c) => c.result === 'fail') ? 'incomplete'
      : required.some((c) => c.result === 'unknown') ? 'unverified' : 'verified';

    const summary = {
      verified: `All ${messages.length} messages on the displayed conversation path were captured; every completeness check passed.`,
      unverified: 'Captured messages are shown below, but completeness could not be confirmed (see checks marked "unknown").',
      incomplete: 'This export is known to be missing content (see checks marked "fail").',
    }[status];

    return { status, summary, checks, warnings };
  }

  // Web pages: there is no "complete" to prove, only whether main content was found.
  function assessPage(raw) {
    const e = raw.evidence || {};
    const found = e.wordCount >= 20; // a few stray words ("Menu") is not content
    const checks = [
      check('main_content', 'Main content found', found ? 'pass' : 'fail',
        found ? `${e.wordCount} words extracted (${e.method === 'readability' ? 'article detection' : 'main page area'}).` : `Only ${e.wordCount} word(s) of readable text were found on the page.`),
    ];
    const warnings = [
      'Navigation, headers, footers and cookie banners are removed; images are kept as links, not downloaded.',
      'The page is read as currently shown. Content that loads only when you scroll, or that sits behind tabs or "read more" buttons, may be missing.',
    ];
    if (e.method !== 'readability') warnings.push('No single article was detected, so the whole main area of the page was converted; expect some layout text.');
    const status = found ? 'captured' : 'incomplete';
    const summary = status === 'captured' ? `Captured the main content of this page (${e.wordCount} words).` : 'No readable content was found on this page.';
    return { status, summary, checks, warnings };
  }

  // Transcripts: the site's own transcript, judged by whether it covers the
  // media from start to end. Allowed slack at either end: closing music,
  // silence, an intro before the first words.
  function assessTranscript(raw) {
    const e = raw.evidence || {};
    const segs = raw.segments;
    const slack = e.durationSec ? Math.max(120, e.durationSec * 0.05) : 0;
    const checks = [];

    checks.push(check('transcript_found', `${raw.platformName} transcript found`,
      segs.length ? 'pass' : 'fail',
      segs.length ? `${segs.length} transcript segments read${e.panelOpened && raw.platform === 'youtube' ? ' from the "Show transcript" panel' : ''}.`
        : e.panelFound ? 'The transcript section was found but held no readable lines.'
          : `This ${raw.media.type} shows no transcript${raw.platform === 'spotify' ? ' (Spotify only shows transcripts to signed-in listeners, and not every episode has one)' : ''}.`));

    checks.push(check('matches_page', `Transcript belongs to the ${raw.media.type} in the address bar`,
      e.idMatches === false ? 'fail' : e.idMatches ? 'pass' : 'unknown',
      e.idMatches === false ? 'The page was showing a different video than the address bar.'
        : e.idMatches ? `Read from the page for ${raw.mediaId}.` : 'Could not confirm which video the page was showing.'));

    checks.push(check('settled', 'Transcript finished loading',
      !segs.length ? 'unknown' : e.settled ? 'pass' : 'fail',
      !segs.length ? 'Nothing to wait for.' : e.settled ? 'The number of lines stopped changing before reading.' : 'Lines were still appearing when the time limit ran out.'));

    const startOk = e.firstSegmentSec != null && e.firstSegmentSec <= Math.max(60, slack);
    checks.push(check('covers_start', 'Starts at the beginning',
      e.firstSegmentSec == null ? 'unknown' : startOk ? 'pass' : 'fail',
      e.firstSegmentSec == null ? 'No timestamps to check.' : startOk ? `First line at ${NS.transcript.clock(e.firstSegmentSec)}.`
        : `First line is at ${NS.transcript.clock(e.firstSegmentSec)}; the opening may be missing.`));

    const endKnown = e.lastSegmentSec != null && e.durationSec;
    const endOk = endKnown && e.lastSegmentSec >= e.durationSec - slack;
    checks.push(check('covers_end', 'Runs to the end',
      !endKnown ? 'unknown' : endOk ? 'pass' : 'fail',
      !endKnown ? (e.durationSec ? 'No timestamps to check.' : `${raw.platformName} did not show the length of this ${raw.media.type}, so the end could not be checked${raw.platform === 'spotify' ? ' (press play on this episode first to make the length visible)' : ''}.`)
        : endOk ? `Last line at ${NS.transcript.clock(e.lastSegmentSec)} of ${NS.transcript.clock(e.durationSec)}.`
          : `Last line is at ${NS.transcript.clock(e.lastSegmentSec)} but the ${raw.media.type} runs ${NS.transcript.clock(e.durationSec)}; the end may be missing.`));

    const warnings = [
      `This is ${raw.platformName}'s own transcript, usually machine-generated: expect misheard words and missing punctuation. Check quotes against the audio before citing them.`,
    ];
    warnings.push(segs.some((s) => s.speaker)
      ? `Speaker labels are ${raw.platformName}'s guesses ("Speaker 1", "Speaker 2"), not names, and can be wrong.`
      : 'Speakers are not labelled; the transcript does not say who is talking.');
    if (raw.platform === 'youtube') warnings.push('Words YouTube masks as profanity appear as "[ __ ]".');

    const required = checks.filter((c) => c.required);
    const status = required.some((c) => c.result === 'fail') ? 'incomplete'
      : required.some((c) => c.result === 'unknown') ? 'unverified' : 'verified';
    const summary = {
      verified: `The whole transcript was captured (${segs.length} segments, start to end).`,
      unverified: `Captured ${segs.length} transcript segments, but full coverage could not be confirmed (see checks marked "unknown").`,
      incomplete: segs.length ? 'This transcript is known to be missing content (see checks marked "fail").' : 'No transcript was captured.',
    }[status];
    return { status, summary, checks, warnings };
  }

  NS.completeness = { assess, assessPage, assessTranscript };
})(globalThis);
