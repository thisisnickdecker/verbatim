/*
 * Normalization layer: platform raw capture -> common conversation schema
 * ("conversation-capture/v1"). Exporters only ever see this schema.
 *
 * Raw capture shape (produced by every platform adapter):
 *   { platform, platformName, url, conversationId, title,
 *     turns: [{ key, renderState, messages: [{ role, platformMessageId, markdown,
 *               text, attachments, codeBlocks, flags }] }],
 *     evidence: { ... } }
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const SCHEMA = 'conversation-capture/v1';
  const ROLE_MAP = { user: 'user', human: 'user', assistant: 'assistant', model: 'assistant', system: 'system', tool: 'tool' };

  function normalize(raw, meta) {
    meta = meta || {};
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
    const completeness = NS.completeness.assess(raw, messages);

    return {
      schema: SCHEMA,
      title: raw.title,
      source: {
        platform: raw.platform,
        platformName: raw.platformName,
        url: raw.url,
        conversationId: raw.conversationId,
      },
      capture: {
        capturedAt: meta.capturedAt || new Date().toISOString(),
        tool: 'Conversation Capture',
        toolVersion: meta.version || null,
        method: 'rendered-page (DOM) read with scroll sweep',
        durationMs: raw.evidence.durationMs || null,
      },
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
      completeness,
      evidence: raw.evidence,
      messages,
    };
  }

  NS.normalize = normalize;
  NS.SCHEMA = SCHEMA;
})(globalThis);
