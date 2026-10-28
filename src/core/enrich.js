/*
 * Enrichment: structure pulled out of a normalized capture with plain code,
 * no AI and no network. Feeds the "At a glance" sections of the Markdown
 * export and the handoff file.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const words = (s) => (String(s || '').match(/\S+/g) || []).length;
  const stripFences = (md) => md.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  const oneLine = (s, max) => {
    const line = String(s || '').replace(/\s+/g, ' ').trim();
    return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
  };

  function linksIn(md) {
    const out = [];
    const seen = new Set();
    const text = stripFences(md);
    for (const m of text.matchAll(/(!?)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
      if (m[1]) continue; // images are listed separately
      if (!seen.has(m[3])) { seen.add(m[3]); out.push({ url: m[3], label: m[2].trim() }); }
    }
    for (const m of text.matchAll(/(?<![(<[])\bhttps?:\/\/[^\s)<>\]"']+/g)) {
      const url = m[0].replace(/[.,;:!?]+$/, '');
      if (!seen.has(url)) { seen.add(url); out.push({ url, label: '' }); }
    }
    return out;
  }

  function codeBlocksIn(md) {
    return [...md.matchAll(/^(`{3,})([^\n`]*)\n/gm)]
      .filter((_, i) => i % 2 === 0) // opening fences only
      .map((m) => m[2].trim() || 'text');
  }

  function questionsIn(md) {
    return stripFences(md)
      .split(/(?<=[?.!])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.endsWith('?') && words(s) >= 3)
      .map((s) => oneLine(s, 240));
  }

  function enrichConversation(conv) {
    const msgs = conv.messages;
    const userMsgs = msgs.filter((m) => m.role === 'user');
    const asstMsgs = msgs.filter((m) => m.role === 'assistant');
    const userWords = userMsgs.reduce((n, m) => n + words(m.content.markdown), 0);
    const assistantWords = asstMsgs.reduce((n, m) => n + words(m.content.markdown), 0);

    const links = [];
    const seen = new Set();
    for (const m of msgs) {
      for (const l of linksIn(m.content.markdown)) {
        if (seen.has(l.url)) continue;
        seen.add(l.url);
        links.push(Object.assign({ messageIndex: m.index, role: m.role }, l));
      }
    }

    return {
      outline: userMsgs.map((m) => ({
        messageIndex: m.index,
        text: oneLine(m.content.markdown.split('\n').find((l) => l.trim()) || (m.attachments.length ? '(attachment only)' : ''), 120),
        words: words(m.content.markdown),
      })),
      contributions: {
        userWords,
        assistantWords,
        userShare: userWords + assistantWords ? Math.round((userWords / (userWords + assistantWords)) * 100) : 0,
      },
      questions: userMsgs.flatMap((m) => questionsIn(m.content.markdown).map((q) => ({ messageIndex: m.index, text: q }))),
      links,
      codeBlocks: msgs.flatMap((m) => codeBlocksIn(m.content.markdown).map((language) => ({ messageIndex: m.index, role: m.role, language }))),
      images: msgs.flatMap((m) => m.attachments.filter((a) => a.type === 'image').map((a) => Object.assign({ messageIndex: m.index, role: m.role }, a))),
      files: msgs.flatMap((m) => m.attachments.filter((a) => a.type === 'file').map((a) => Object.assign({ messageIndex: m.index, role: m.role }, a))),
    };
  }

  function enrichPage(page) {
    const md = page.content.markdown;
    return {
      outline: [...stripFences(md).matchAll(/^(#{1,4})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, text: oneLine(m[2], 120) })),
      links: linksIn(md),
      codeBlocks: codeBlocksIn(md).map((language) => ({ language })),
      images: [...md.matchAll(/!\[([^\]]*)\]\((\S+?)\)/g)].map((m) => ({ type: 'image', alt: m[1], url: m[2] })),
      readingMinutes: Math.max(1, Math.round(words(md) / 230)),
    };
  }

  NS.enrich = { enrichConversation, enrichPage, words, oneLine };
})(globalThis);
