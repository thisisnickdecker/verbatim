/*
 * Exporters: common schema -> files. No platform knowledge here.
 * Loaded by the background service worker (importScripts) and by tests.
 *
 * filesFor(capture) returns every file to save for one capture:
 *   conversation -> <title>.md, <title>.json, <title> — handoff.md
 *   page         -> <title>.md, <title>.json
 *   transcript   -> <title>.md, <title>.json
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const RESULT_ICON = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' };

  const roleLabel = (conv, role) =>
    ({ user: 'You', assistant: conv.source.platformName, system: 'System', tool: 'Tool' }[role] || 'Unknown');

  function toJSON(capture) {
    return JSON.stringify(capture, null, 2) + '\n';
  }

  // ---------- shared pieces ----------

  function yamlValue(v) {
    if (v == null) return '""';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(String(v)); // JSON strings are valid YAML scalars
  }

  function frontmatter(fields) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(fields)) {
      if (Array.isArray(v)) lines.push(`${k}:`, ...v.map((x) => `  - ${yamlValue(x)}`));
      else lines.push(`${k}: ${yamlValue(v)}`);
    }
    lines.push('---', '');
    return lines;
  }

  function localStamp(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}-${p(d.getMinutes())}` };
  }

  function attachmentLine(a, platformName) {
    if (a.type === 'image' && !a.url) return `- Image: ${a.alt || 'uploaded image'} (shown in ${platformName || 'the chat'} from a session-only link; not retrievable from this export)`;
    if (a.type === 'image') return `- Image: ${a.alt ? a.alt + ' — ' : ''}<${a.url}>`;
    return `- File: ${a.name || a.url || '(unnamed)'}${a.note ? ` (${a.note})` : ''}${a.url ? ' <' + a.url + '>' : ''}`;
  }

  function linkLine(l, conv) {
    const where = l.messageIndex ? ` (message ${l.messageIndex}${conv ? ', ' + roleLabel(conv, l.role) : ''})` : '';
    return `- [${(l.label || l.url).replace(/[[\]]/g, '')}](${l.url})${where}`;
  }

  function completenessSection(c) {
    const out = ['---', '', '## Completeness report', ''];
    out.push(`**Status: ${c.status.toUpperCase()}** — ${c.summary}`, '');
    out.push('| Check | Result | Detail |', '| --- | --- | --- |');
    for (const k of c.checks) out.push(`| ${k.label} | ${RESULT_ICON[k.result]} | ${k.detail.replace(/\|/g, '\\|')} |`);
    if (c.warnings.length) out.push('', '**Scope notes**', '', ...c.warnings.map((w) => '- ' + w));
    out.push('');
    return out;
  }

  // ---------- conversation ----------

  function conversationMarkdown(conv) {
    const c = conv.completeness;
    const s = conv.stats;
    const e = conv.enrichment;
    const out = frontmatter({
      title: conv.title,
      source: conv.source.url,
      platform: conv.source.platformName,
      kind: 'conversation',
      captured: conv.capture.capturedAt,
      messages: s.messageCount,
      status: c.status,
      tags: ['verbatim', conv.source.platform],
    });

    out.push(`# ${conv.title}`, '');
    out.push(`- **Source:** ${conv.source.url}`);
    out.push(`- **Captured:** ${conv.capture.capturedAt}`);
    out.push(`- **Messages:** ${s.messageCount} (${s.userMessages} from you, ${s.assistantMessages} from ${conv.source.platformName}${s.otherMessages ? ', ' + s.otherMessages + ' other' : ''})`);
    out.push(`- **Completeness:** ${c.status.toUpperCase()} — ${c.summary}`);
    out.push('');

    out.push('## At a glance', '');
    out.push(`- **Your words:** ${e.contributions.userWords.toLocaleString('en-US')} (${e.contributions.userShare}% of the conversation)`);
    out.push(`- **${conv.source.platformName}'s words:** ${e.contributions.assistantWords.toLocaleString('en-US')}`);
    out.push(`- **Links and sources:** ${e.links.length} · **Code blocks:** ${e.codeBlocks.length} · **Images:** ${e.images.length} · **Files:** ${e.files.length}`);
    out.push(`- **Questions you asked:** ${e.questions.length}`);
    out.push('');

    if (e.outline.length) {
      out.push('## Outline: your prompts', '');
      for (const o of e.outline) out.push(`${o.messageIndex}. ${o.text || '(empty)'}${o.words > 150 ? ` _(${o.words} words)_` : ''}`);
      out.push('');
    }

    for (const m of conv.messages) {
      out.push('---', '');
      out.push(`<!-- message ${m.index} role=${m.role}${m.platformMessageId ? ' id=' + m.platformMessageId : ''} -->`);
      out.push(`## ${m.index}. ${roleLabel(conv, m.role)}`, '');
      out.push(m.content.markdown || '_(no readable content)_', '');
      // Image references inside assistant Markdown are already inline; list
      // attachments only where they are not part of the body.
      const extra = m.role === 'user' ? m.attachments : m.attachments.filter((a) => !m.content.markdown.includes(a.url || '\u0000'));
      if (extra.length) out.push('**Attachments:**', '', ...extra.map((a) => attachmentLine(a, conv.source.platformName)), '');
      if (m.flags.length) out.push(`> Note: ${m.flags.join(', ')}`, '');
    }

    if (e.links.length) out.push('---', '', '## Links and sources', '', ...e.links.map((l) => linkLine(l, conv)), '');
    if (e.questions.length) {
      out.push('## Questions you asked', '');
      for (const q of e.questions) out.push(`- ${q.text} _(message ${q.messageIndex})_`);
      out.push('');
    }
    out.push(...completenessSection(c));
    return out.join('\n');
  }

  // Shorten an assistant reply for the handoff: keep headings, the first
  // sentence of each paragraph, a few items per list; replace code with a stub.
  function condense(md, maxChars) {
    const text = md.replace(/^(`{3,})([^\n]*)\n[\s\S]*?^\1[ \t]*$/gm, (_, f, lang) => `[code block${lang.trim() ? ': ' + lang.trim() : ''}]`);
    const out = [];
    let size = 0;
    for (const block of text.split(/\n{2,}/)) {
      if (size > maxChars) {
        out.push('…');
        break;
      }
      let piece;
      if (/^#{1,6}\s|^\[code block/.test(block)) piece = block.split('\n')[0];
      else if (/^\s*([-*]|\d+\.)\s/.test(block)) {
        const items = block.split('\n').filter((l) => /^([-*]|\d+\.)\s/.test(l)); // top-level items only
        piece = items.slice(0, 4).join('\n') + (items.length > 4 ? '\n- …' : '');
      } else if (/^>/.test(block)) piece = block.split('\n')[0];
      else {
        const first = block.replace(/\s+/g, ' ').match(/^.+?[.!?](\s|$)/);
        piece = (first ? first[0] : block.replace(/\s+/g, ' ')).trim();
      }
      if (piece) {
        out.push(piece);
        size += piece.length;
      }
    }
    return out.join('\n\n');
  }

  function handoffMarkdown(conv) {
    const e = conv.enrichment;
    const name = conv.source.platformName;
    const { date } = localStamp(conv.capture.capturedAt);
    const lastAssistant = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    const out = frontmatter({ title: `Handoff: ${conv.title}`, source: conv.source.url, kind: 'handoff', captured: conv.capture.capturedAt, tags: ['verbatim', 'handoff'] });

    out.push(`# Handoff: ${conv.title}`, '');
    out.push(`> Upload or paste this file into another AI assistant to continue a conversation that started in ${name}. It contains every message I wrote, word for word, and a condensed version of ${name}'s replies (the last reply is in full).`, '');

    out.push('## Instructions for the assistant', '');
    out.push(`You're picking up a conversation I had with ${name} on ${date}. Read everything below before replying.`, '');
    out.push('1. In about five bullets, tell me where things stand.');
    out.push('2. List the decisions or conclusions we reached.');
    out.push('3. List the open questions and anything left unresolved.');
    out.push('4. Then ask me what I want to do next. Don\'t start new work until I answer.', '');
    out.push(`Treat my messages as the authority on what I think and want. ${name}'s replies are earlier AI suggestions, not established facts.`, '');

    out.push('## Brief', '');
    out.push(`- **Conversation:** ${conv.title}`);
    out.push(`- **Source:** ${conv.source.url}`);
    out.push(`- **Messages:** ${conv.stats.messageCount} (${conv.stats.userMessages} mine, ${conv.stats.assistantMessages} from ${name}) · capture ${conv.completeness.status}`);
    out.push('');
    if (e.outline.length) {
      out.push('**What I asked, in order:**', '');
      for (const o of e.outline) out.push(`${o.messageIndex}. ${o.text}`);
      out.push('');
    }
    if (e.questions.length) {
      out.push('**Questions I raised:**', '');
      for (const q of e.questions.slice(0, 25)) out.push(`- ${q.text}`);
      if (e.questions.length > 25) out.push(`- …and ${e.questions.length - 25} more in the transcript`);
      out.push('');
    }
    if (e.links.length) {
      out.push('**Links and sources mentioned:**', '');
      for (const l of e.links.slice(0, 30)) out.push(linkLine(l));
      out.push('');
    }

    out.push('## The conversation', '');
    for (const m of conv.messages) {
      if (m.role === 'user') {
        out.push(`### ${m.index}. Me (verbatim)`, '', m.content.markdown || '_(attachment only)_', '');
        if (m.attachments.length) out.push(...m.attachments.map((a) => attachmentLine(a, name)), '');
      } else if (m === lastAssistant) {
        out.push(`### ${m.index}. ${name} (latest reply, in full)`, '', m.content.markdown, '');
      } else {
        const short = condense(m.content.markdown, 1200);
        const total = NS.enrich.words(m.content.markdown);
        out.push(`### ${m.index}. ${name} (condensed from ${total} words)`, '', short || '_(no text)_', '');
      }
    }
    return out.join('\n');
  }

  // ---------- page ----------

  function pageMarkdown(page) {
    const e = page.enrichment;
    const src = page.source;
    const out = frontmatter({
      title: page.title,
      source: src.url,
      site: src.platformName,
      kind: 'page',
      author: src.byline,
      published: src.publishedTime,
      captured: page.capture.capturedAt,
      words: page.stats.words,
      tags: ['verbatim', 'web'],
    });
    out.push(`# ${page.title}`, '');
    out.push(`- **Source:** ${src.url}`);
    if (src.byline) out.push(`- **By:** ${src.byline}`);
    if (src.publishedTime) out.push(`- **Published:** ${src.publishedTime}`);
    out.push(`- **Captured:** ${page.capture.capturedAt}`);
    out.push(`- **Length:** ${page.stats.words.toLocaleString('en-US')} words (about ${e.readingMinutes} min read)`);
    if (src.description) out.push('', `> ${src.description.replace(/\n+/g, ' ')}`);
    out.push('');
    if (e.outline.length > 2) {
      out.push('## Outline', '');
      for (const o of e.outline) out.push(`${'  '.repeat(Math.max(0, o.level - 1))}- ${o.text}`);
      out.push('');
    }
    out.push('---', '', page.content.markdown || '_(no readable content)_', '');
    if (e.links.length) out.push('---', '', '## Links on this page', '', ...e.links.map((l) => linkLine(l)), '');
    out.push(...completenessSection(page.completeness));
    return out.join('\n');
  }

  // ---------- transcript ----------

  // Join segments into readable paragraphs: break at chapters and speaker
  // changes, after a
  // sentence once a paragraph spans ~45 s, and always by ~90 s.
  function paragraphs(tr) {
    const chapterAt = new Map(tr.chapters.filter((c) => c.start != null).map((c) => [c.start, c.title]));
    const out = [];
    let cur = null;
    for (const s of tr.segments) {
      const chapter = chapterAt.get(s.start);
      if (chapter) chapterAt.delete(s.start);
      const span = cur && s.start != null && cur.start != null ? s.start - cur.start : 0;
      const sentenceEnd = cur && /[.!?]["')\]]?$/.test(cur.text);
      const untimed = s.start == null && cur && cur.count >= 6;
      const newSpeaker = cur && s.speaker && s.speaker !== cur.speaker;
      if (!cur || chapter || newSpeaker || span >= 90 || (span >= 45 && sentenceEnd) || untimed) {
        cur = { start: s.start, chapter: chapter || null, speaker: s.speaker || null, text: s.text, count: 1 };
        out.push(cur);
      } else {
        cur.text += ' ' + s.text;
        cur.count++;
      }
    }
    return out;
  }

  function stampLink(tr, sec) {
    const c = NS.transcript.clock(sec);
    if (!c) return '';
    return tr.source.timeLink ? `[${c}](${tr.source.timeLink.replace('{s}', Math.floor(sec))})` : c;
  }

  function transcriptMarkdown(tr) {
    const src = tr.source;
    const e = tr.enrichment;
    const clock = NS.transcript.clock;
    const out = frontmatter({
      title: tr.title,
      source: src.url,
      platform: src.platformName,
      kind: 'transcript',
      [src.showLabel.toLowerCase()]: src.show,
      published: src.publishedTime,
      duration: clock(src.durationSec),
      captured: tr.capture.capturedAt,
      words: tr.stats.words,
      status: tr.completeness.status,
      tags: ['verbatim', src.platform, 'transcript'],
    });
    out.push(`# ${tr.title}`, '');
    out.push(`- **Source:** ${src.url}`);
    if (src.show) out.push(`- **${src.showLabel}:** ${src.show}`);
    if (src.publishedTime) out.push(`- **Published:** ${src.publishedTime}`);
    if (src.durationSec) out.push(`- **Length:** ${clock(src.durationSec)}`);
    out.push(`- **Captured:** ${tr.capture.capturedAt}`);
    out.push(`- **Transcript:** ${tr.stats.words.toLocaleString('en-US')} words (about ${e.readingMinutes} min read)`);
    out.push(`- **Completeness:** ${tr.completeness.status.toUpperCase()} — ${tr.completeness.summary}`);
    out.push('');
    if (src.description) out.push('## Description', '', src.description.replace(/\n{3,}/g, '\n\n'), '');
    if (tr.chapters.length) {
      out.push('## Chapters', '');
      for (const c of tr.chapters) out.push(`- ${c.start != null ? stampLink(tr, c.start) + ' ' : ''}${c.title}`);
      out.push('');
    }
    out.push('---', '', '## Transcript', '');
    if (!tr.segments.length) out.push('_(no transcript captured)_', '');
    for (const p of paragraphs(tr)) {
      if (p.chapter) out.push(`### ${p.chapter}`, '');
      const label = [stampLink(tr, p.start), p.speaker].filter(Boolean).join(' ');
      out.push(`${label ? `**${label}${p.speaker ? ':' : ''}** ` : ''}${p.text}`, '');
    }
    if (e.links.length) out.push('---', '', '## Links in the description', '', ...e.links.map((l) => linkLine(l)), '');
    out.push(...completenessSection(tr.completeness));
    return out.join('\n');
  }

  // ---------- files ----------

  function safeName(s, max) {
    const clean = String(s || 'Untitled')
      .replace(/[\\/:*?"<>|#^[\]{}\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, max || 80)
      .trim();
    return clean || 'Untitled';
  }

  function folderName(capture) {
    const { date, time } = localStamp(capture.capture.capturedAt);
    const where = capture.kind === 'page' ? capture.source.host : capture.source.platformName;
    return `Verbatim/${date} ${time} ${safeName(where, 40)} — ${safeName(capture.title, 70)}`;
  }

  function filesFor(capture) {
    const folder = folderName(capture);
    const base = safeName(capture.title, 70);
    if (capture.kind === 'page' || capture.kind === 'transcript') {
      return [
        { filename: `${folder}/${base}.md`, mime: 'text/markdown', text: toMarkdown(capture) },
        { filename: `${folder}/${base}.json`, mime: 'application/json', text: toJSON(capture) },
      ];
    }
    return [
      { filename: `${folder}/${base}.md`, mime: 'text/markdown', text: conversationMarkdown(capture) },
      { filename: `${folder}/${base}.json`, mime: 'application/json', text: toJSON(capture) },
      { filename: `${folder}/${base} — handoff.md`, mime: 'text/markdown', text: handoffMarkdown(capture) },
    ];
  }

  // One line for the capture panel: what was saved.
  function savedLine(capture) {
    if (capture.kind === 'page') return `Page saved (${capture.stats.words} words).`;
    if (capture.kind === 'transcript') return `Transcript saved (${capture.stats.words.toLocaleString('en-US')} words, ${capture.stats.segments} segments).`;
    return `${capture.stats.messageCount} messages saved, plus a handoff file.`;
  }

  const toMarkdown = (capture) =>
    ({ page: pageMarkdown, transcript: transcriptMarkdown }[capture.kind] || conversationMarkdown)(capture);

  NS.exporters = { toJSON, toMarkdown, toHandoff: handoffMarkdown, condense, paragraphs, savedLine, filesFor, folderName, safeName };
})(globalThis);
