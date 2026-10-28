/*
 * Normalization layer: platform raw capture -> common schema ("verbatim/v1").
 * Exporters only ever see this schema.
 *
 * Raw capture shape (produced by every platform adapter):
 *   conversations: { platform, platformName, url, conversationId, title,
 *     turns: [{ key, renderState, messages: [{ role, platformMessageId, markdown,
 *               text, attachments, codeBlocks, flags }] }],
 *     evidence: { ... } }
 *   pages: { kind: 'page', platform: 'web', platformName, url, title,
 *     page: { markdown, text, description, byline, publishedTime, language, host },
 *     evidence: { ... } }
 *   transcripts: see core/transcript.js
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const SCHEMA = 'verbatim/v1';
  const ROLE_MAP = { user: 'user', human: 'user', assistant: 'assistant', model: 'assistant', system: 'system', tool: 'tool' };

  function captureMeta(raw, meta) {
    return {
      capturedAt: meta.capturedAt || new Date().toISOString(),
      timeZone: meta.timeZone || (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : null),
      tool: 'Verbatim',
      toolVersion: meta.version || null,
      method: raw.kind === 'page' ? 'rendered page, main content extracted' : 'rendered page (DOM) read with scroll sweep',
      durationMs: raw.evidence.durationMs || null,
    };
  }

  function normalizePage(raw, meta) {
    const page = {
      schema: SCHEMA,
      kind: 'page',
      title: raw.title,
      source: {
        platform: 'web',
        platformName: raw.platformName,
        url: raw.url,
        host: raw.page.host,
        byline: raw.page.byline,
        publishedTime: raw.page.publishedTime,
        language: raw.page.language,
        description: raw.page.description,
      },
      capture: captureMeta(raw, meta),
      stats: { words: NS.enrich.words(raw.page.markdown) },
      completeness: NS.completeness.assessPage(raw),
      evidence: raw.evidence,
      content: { format: 'markdown', markdown: raw.page.markdown, text: raw.page.text },
    };
    page.enrichment = NS.enrich.enrichPage(page);
    return page;
  }

  function normalizeTranscript(raw, meta) {
    const segments = raw.segments.map((s, i) => ({ index: i + 1, start: s.start, text: s.text, speaker: s.speaker || null }));
    const tr = {
      schema: SCHEMA,
      kind: 'transcript',
      title: raw.title,
      source: {
        platform: raw.platform,
        platformName: raw.platformName,
        url: raw.url,
        mediaId: raw.mediaId,
        mediaType: raw.media.type,
        show: raw.media.show,
        showLabel: raw.media.showLabel,
        publishedTime: raw.media.publishedTime,
        durationSec: raw.media.durationSec,
        description: raw.media.description ? raw.media.description.trim() : null,
        timeLink: raw.media.timeLink,
      },
      capture: Object.assign(captureMeta(raw, meta), { method: `rendered page, ${raw.platformName}'s own transcript read` }),
      stats: {
        segments: segments.length,
        chapters: raw.chapters.length,
        words: segments.reduce((n, s) => n + NS.enrich.words(s.text), 0),
      },
      completeness: NS.completeness.assessTranscript(raw),
      evidence: raw.evidence,
      chapters: raw.chapters,
      segments,
    };
    tr.enrichment = NS.enrich.enrichTranscript(tr);
    return tr;
  }

  function normalize(raw, meta) {
    meta = meta || {};
    if (raw.kind === 'page') return normalizePage(raw, meta);
    if (raw.kind === 'transcript') return normalizeTranscript(raw, meta);

    const messages = [];
    raw.turns.forEach((turn, t) => {
      turn.messages.forEach((m) => {
        messages.push({
          index: messages.length + 1,
          turnIndex: t + 1,
          role: ROLE_MAP[(m.role || '').toLowerCase()] || 'unknown',
          platformRole: m.role || null,
          platformMessageId: m.platformMessageId || null,
          content: {
            format: 'markdown',
            markdown: (m.markdown || '').trim(),
            text: (m.text || '').trim(),
          },
          attachments: (m.attachments || []).map((a) => Object.assign({ type: 'file' }, a)),
          codeBlockCount: m.codeBlocks || 0,
          flags: m.flags || [],
        });
      });
    });

    const count = (role) => messages.filter((m) => m.role === role).length;

    const conv = {
      schema: SCHEMA,
      kind: 'conversation',
      title: raw.title,
      source: {
        platform: raw.platform,
        platformName: raw.platformName,
        url: raw.url,
        conversationId: raw.conversationId,
      },
      capture: captureMeta(raw, meta),
      stats: {
        messageCount: messages.length,
        turnCount: raw.turns.length,
        userMessages: count('user'),
        assistantMessages: count('assistant'),
        otherMessages: messages.length - count('user') - count('assistant'),
        codeBlocks: messages.reduce((n, m) => n + m.codeBlockCount, 0),
        images: messages.reduce((n, m) => n + m.attachments.filter((a) => a.type === 'image').length, 0),
        files: messages.reduce((n, m) => n + m.attachments.filter((a) => a.type === 'file').length, 0),
      },
      completeness: NS.completeness.assess(raw, messages),
      evidence: raw.evidence,
      messages,
    };
    conv.enrichment = NS.enrich.enrichConversation(conv);
    return conv;
  }

  NS.normalize = normalize;
  NS.SCHEMA = SCHEMA;
})(globalThis);
