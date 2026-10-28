# Conversation Capture

A Chrome extension (Manifest V3) that exports the ChatGPT conversation you are viewing to **`conversation.md`** and **`conversation.json`**, locally, with a completeness report. It is the ingestion component of a personal sense-making system.

Version 0.1.0 is the smallest working version: ChatGPT only, with no AI summarization, embeddings, databases or agents.

## Install (2 minutes)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `conversation-capture` folder (the one containing `manifest.json`).
4. Optional: pin it from the puzzle-piece menu so the button stays visible.

## Use

1. Open a ChatGPT conversation (`https://chatgpt.com/c/…`). The toolbar button is **greyed out on every other page**.
2. Click **Capture Conversation**.
3. Keep the tab in front and don't scroll it. A panel at the bottom right shows progress, and the badge shows a percentage. Long conversations take a few minutes, because the extension scrolls through the whole thread to load every message. A 16-turn, 380 KB conversation took about 3½ minutes.
4. When it finishes, two files land in your Downloads folder:

```
Downloads/Conversation Capture/<timestamp>_chatgpt_<title-slug>/conversation.md
Downloads/Conversation Capture/<timestamp>_chatgpt_<title-slug>/conversation.json
```

The badge shows the result: **OK** = verified complete, **?** = unverified, **!** = known incomplete, **ERR** = failed. The same status, with the reasons, is written into both files.

## What gets captured

| Item | How |
| --- | --- |
| Title, source URL, conversation ID, capture timestamp, message count | Header of both files |
| User and assistant roles, in original order | One entry per message, stitched across the whole thread |
| Text, headings, bold/italic/strikethrough, nested lists, block quotes, tables, links | Converted to Markdown |
| Code blocks | Fenced with language label, exact source text |
| ChatGPT "writing blocks" (documents/briefs) | ChatGPT's own Markdown source for the block |
| Citations | `[Source title](url)` links |
| Images (user uploads, assistant images) | References only, never downloaded. Assistant images keep their URL. Uploads are listed by name because ChatGPT shows them from temporary `blob:` links. |
| File attachments | Name only, detected heuristically |
| Completeness report | Checks with PASS / FAIL / UNKNOWN and scope notes |

## Completeness: what "verified" means

ChatGPT shows only a handful of turns at a time and lazy-loads older ones. The extension:

1. scrolls to the top and waits until nothing older loads,
2. scrolls down in half-screen steps, so each snapshot overlaps the last, and records every turn by its stable ID,
3. confirms it reached the bottom, then puts your scroll position back.

The status is **verified** only if all of these hold: it reached the start, it reached the end, every snapshot overlapped the previous ones (no gaps), every turn was fully rendered when read, no message was empty, every role was identified, nothing was still streaming, and no time limit was hit. Any failed check makes it **incomplete**, and any check it could not evaluate makes it **unverified**.

Verified means a continuous top-to-bottom read of the **displayed conversation path**. It does not mean a count match, because ChatGPT doesn't show a total. Things outside that path are always listed as scope notes: alternate branches from edits or regenerations, collapsed reasoning, and image or file contents.

## Privacy and permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the current tab only after you click the button. No standing access to any site. |
| `scripting` | Inject the capture code into that tab on click. |
| `downloads` | Save the two files. |
| `declarativeContent` | Enable the button only on ChatGPT conversation URLs, without host permissions. |

- **No host permissions, no network requests, no remote code.** The extension never calls ChatGPT's or OpenAI's endpoints (documented or not). It reads only the rendered page.
- **No cookies, tokens, credentials, history or other tabs** are read.
- Capture code runs in Chrome's isolated content-script world, so the page's own scripts cannot see it.
- The content goes from the tab to the extension's background worker and then to your Downloads folder. Nothing else receives it.

## Architecture

```
manifest.json
src/
  background.js              Service worker: button enable rules, inject on click, save files
  content/run-capture.js     Entry point in the page: pick adapter, run, normalize, progress panel
  platforms/
    chatgpt.js               ChatGPT adapter: selectors, scroll sweep, DOM -> raw capture
    registry.js              findPlatform(url) across registered adapters
  core/
    html-to-markdown.js      Generic DOM -> Markdown converter (platform rules plug in)
    normalize.js             Raw capture -> common schema "conversation-capture/v1"
    completeness.js          Evidence -> verified / unverified / incomplete + checks
    exporters.js             Common schema -> Markdown / JSON (no platform knowledge)
test/
  fake-chatgpt.js            Simulated ChatGPT page (virtualized, lazy-loading) in jsdom
  capture.test.js            16 tests
examples/                    Example exports
```

Data flow: **page DOM → platform adapter (raw capture) → normalize (common schema + completeness) → exporters (md/json) → downloads**.

### Adding Claude or another platform later

1. Create `src/platforms/claude.js` that registers `ConversationCapture.platforms.claude = { id, name, matches(url), collect({ document, url, onProgress }) }` and returns the same raw-capture shape as `chatgpt.js` (`turns[].messages[]` plus `evidence`).
2. Add it to `CONTENT_FILES` in `background.js` and its URL to `SUPPORTED_PAGES`.

Normalization, completeness and exporters need no changes.

### Common schema (`conversation-capture/v1`)

```jsonc
{
  "schema": "conversation-capture/v1",
  "title": "…",
  "source":   { "platform": "chatgpt", "platformName": "ChatGPT", "url": "…", "conversationId": "…" },
  "capture":  { "capturedAt": "ISO-8601", "tool": "Conversation Capture", "toolVersion": "0.1.0", "method": "…", "durationMs": 0 },
  "stats":    { "messageCount": 0, "turnCount": 0, "userMessages": 0, "assistantMessages": 0, "otherMessages": 0, "codeBlocks": 0, "images": 0, "files": 0 },
  "completeness": { "status": "verified|unverified|incomplete", "summary": "…", "checks": [{ "id", "label", "result": "pass|fail|unknown", "detail", "required" }], "warnings": ["…"] },
  "evidence": { /* raw signals from the sweep */ },
  "messages": [{
    "index": 1, "turnIndex": 1, "role": "user|assistant|system|tool|unknown", "platformRole": "user",
    "platformMessageId": "…",
    "content": { "format": "markdown", "markdown": "…", "text": "…" },
    "attachments": [{ "type": "image", "url": "…", "alt": "…" }, { "type": "file", "name": "…" }],
    "codeBlockCount": 0, "flags": ["has-alternate-branches", "collapsed-reasoning-not-captured"]
  }]
}
```

## Tests

```bash
npm install
npm test
```

The tests run the real extension source against a simulated ChatGPT page. The simulation reproduces the DOM structure observed on chatgpt.com in October 2026 and its virtualization and lazy loading. Covered: short and long (150-turn) conversations, code blocks, Markdown formatting, images and attachments, many mixed turns, branches, the older reply layout, "Show more" expansion, and failure modes (a gap in the sweep, older messages that never load, an unrendered turn, a prompt that won't expand, a still-streaming response). Each failure mode must produce `incomplete`.

## Known limitations

- **DOM-dependent.** ChatGPT changes its markup without notice. All selectors are in one `SEL` object at the top of `src/platforms/chatgpt.js`, plus a legacy fallback. If an export comes back empty or `incomplete`, those selectors are the first thing to check.
- **Only the displayed branch** is captured. Edited or regenerated alternatives ("2/2") are flagged, not exported.
- **Collapsed reasoning** ("Thought for …"), canvas side panels, Deep Research reports opened in a side panel, and tool/agent run details are not captured.
- **Images are references, not files.** Your uploaded images have no lasting URL: ChatGPT shows them from temporary in-browser `blob:` links, so the export lists them without a usable link. Keep the originals yourself. Assistant-side image URLs may need sign-in or expire.
- **Long prompts** collapsed behind "Show more" are expanded automatically (this changes only what the page shows). If one won't expand, the export is marked `incomplete`.
- **File attachments** are detected by filename heuristics. Names may be missed, and contents are never captured.
- **Emphasis inside ChatGPT's new component renderer** is inferred from computed font weight and style. Rare false bold/italic is possible.
- **User messages** are exported as typed plain text. Single line breaks are preserved in the text but render as one paragraph in some Markdown viewers.
- **Keep the tab in front during capture.** Chrome throttles background tabs, which can slow the sweep or trigger the time limit and an `incomplete` result.
- **The capture scrolls the page** and restores your position at the end. Scrolling during capture can cause a gap, which is reported as `incomplete`.
- If Chrome is set to **"Ask where to save each file"**, you'll get two save dialogs.
- Verified is evidence-based, not a guarantee. ChatGPT exposes no total message count to compare against.
