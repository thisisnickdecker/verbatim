/*
 * Exporters: common schema -> files. No platform knowledge here.
 * Loaded by the background service worker (importScripts) and by tests.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const ROLE_LABEL = { user: 'User', assistant: 'Assistant', system: 'System', tool: 'Tool', unknown: 'Unknown' };
  const RESULT_ICON = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' };

  function toJSON(conv) {
    return JSON.stringify(conv, null, 2) + '\n';
  }

  function attachmentLine(a) {
    if (a.type === 'image' && !a.url) return `- Image: ${a.alt || 'uploaded image'} (shown in ChatGPT from a session-only link; not retrievable from this export)`;
    if (a.type === 'image') return `- Image: ${a.alt ? a.alt + ' — ' : ''}<${a.url}>`;
    return `- File: ${a.name || a.url || '(unnamed)'}${a.url ? ' <' + a.url + '>' : ''}`;
  }

  function toMarkdown(conv) {
    const c = conv.completeness;
    const s = conv.stats;
    const out = [];

    out.push(`# ${conv.title}`, '');
    out.push(`- **Source:** ${conv.source.url}`);
    out.push(`- **Platform:** ${conv.source.platformName}`);
    out.push(`- **Captured:** ${conv.capture.capturedAt}`);
    out.push(`- **Messages:** ${s.messageCount} (${s.userMessages} user, ${s.assistantMessages} assistant${s.otherMessages ? ', ' + s.otherMessages + ' other' : ''}) in ${s.turnCount} turns`);
    out.push(`- **Completeness:** ${c.status.toUpperCase()} — ${c.summary}`);
    out.push('');

    for (const m of conv.messages) {
      out.push('---', '');
      out.push(`<!-- message ${m.index} role=${m.role}${m.platformMessageId ? ' id=' + m.platformMessageId : ''} -->`);
      out.push(`## ${m.index}. ${ROLE_LABEL[m.role] || m.role}`, '');
      out.push(m.content.markdown || '_(no readable content)_', '');
      // Image references inside assistant Markdown are already inline; list
      // attachments only where they are not part of the body.
      const extra = m.role === 'user' ? m.attachments : m.attachments.filter((a) => !m.content.markdown.includes(a.url || '\u0000'));
      if (extra.length) out.push('**Attachments:**', '', ...extra.map(attachmentLine), '');
      if (m.flags.length) out.push(`> Note: ${m.flags.join(', ')}`, '');
    }

    out.push('---', '', '## Completeness report', '');
    out.push(`**Status: ${c.status.toUpperCase()}** — ${c.summary}`, '');
    out.push('| Check | Result | Detail |', '| --- | --- | --- |');
    for (const k of c.checks) out.push(`| ${k.label} | ${RESULT_ICON[k.result]} | ${k.detail.replace(/\|/g, '\\|')} |`);
    if (c.warnings.length) out.push('', '**Scope notes**', '', ...c.warnings.map((w) => '- ' + w));
    out.push('');
    return out.join('\n');
  }

  function slug(s) {
    return (s || 'conversation')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation';
  }

  function folderName(conv) {
    const stamp = conv.capture.capturedAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
    return `Conversation Capture/${stamp}_${conv.source.platform}_${slug(conv.title)}`;
  }

  NS.exporters = { toJSON, toMarkdown, folderName, slug };
})(globalThis);
