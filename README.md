# Verbatim

**Save your AI conversations, verified complete.**

Verbatim is a Chrome extension that saves the ChatGPT or Claude conversation you're viewing, or any web page, as clean Markdown and structured JSON. It tells you plainly whether the capture is complete. Everything runs in your browser: nothing is uploaded, and it never touches your login.

Most chat exporters quietly hand you whatever happened to be on screen. ChatGPT and Claude only keep a few messages in the page at a time, collapse long prompts, and leave hidden copies of other chats in the background. Verbatim scrolls the whole thread, expands what's collapsed, reads only the conversation in the address bar, and checks its own work. When it can't prove it got everything, it says so.

## What you get

Click the toolbar button and Verbatim picks the right mode from the page you're on:

| Page | Files | Completeness |
| --- | --- | --- |
| ChatGPT conversation | `Title.md`, `Title.json`, `Title — handoff.md` | Continuous top-to-bottom read, no gaps, every message rendered |
| Claude.ai conversation | same three files | Same, plus a count check against Claude's own "Message N of TOTAL" |
| Any other web page | `Title.md`, `Title.json` | Main content found (Readability), navigation and cookie banners removed |

Files are saved to `Downloads/Verbatim/<date> <time> <source> — <title>/`.

**Every conversation export includes:**

- **Obsidian-ready front matter:** title, source, platform, date, status and tags.
- **At a glance:** your words vs. the AI's, plus counts of links, code blocks, images, files and questions.
- **Outline:** each of your prompts as a one-line table of contents.
- **The full transcript,** with headings, lists, tables, code (with language), links, citations and checklists preserved.
- **Links and sources** and **Questions you asked,** collected from the whole conversation.
- **Completeness report:** every check, PASS / FAIL / UNKNOWN, with scope notes.

**The handoff file** is built for continuing in another assistant, for example ChatGPT → Claude. It includes instructions for the receiving AI, a brief, every message you wrote word for word, and the AI's replies condensed (the latest one in full).

Everything is computed locally with plain code: no AI calls, no API keys, nothing sent anywhere.

## Install

1. Download or clone this repository.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `verbatim` folder (the one with `manifest.json`).
4. Pin **Verbatim** from the puzzle-piece menu.

After updating the code, click the reload ↻ icon on the extension's card.

## Use

Open a conversation or page and click **Verbatim**. For conversations, keep the tab in front and don't scroll until the panel says it's done. A long conversation takes a few minutes, because Verbatim reads the whole thread.

Badge: **OK** = verified (or page captured) · **?** = couldn't be verified · **!** = known to be missing content · **ERR** = failed · **—** = Chrome's own pages can't be read.

## Privacy and permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the current tab, only when you click. No standing access to any site. |
| `scripting` | Run the capture code in that tab on click. |
| `downloads` | Save the files. |

There are no host permissions, no network requests, no remote code, and no analytics. It doesn't call ChatGPT's or Claude's internal APIs and doesn't read cookies or tokens. Capture code runs in Chrome's isolated extension context, out of reach of the page's own scripts.

## How "verified" works

- **ChatGPT:** shows only a handful of turns at a time and lazy-loads older ones. Verbatim scrolls to the top until nothing older loads, then steps down half a screen at a time so every snapshot overlaps the last, and stitches turns together by their IDs. It expands prompts collapsed behind "Show more", ignores hidden copies of previously opened chats, and confirms every message carries the conversation ID in the address bar.
- **Claude:** every message is labeled with its position and the total, so Verbatim checks that each position from 1 to TOTAL was read.

**Verified** means a complete read of the **displayed conversation**. These are always listed as scope notes rather than claimed:

- edited or regenerated alternatives ("2/2")
- collapsed reasoning and tool steps
- artifact contents
- the files behind images and uploads

## Architecture

```
manifest.json
src/
  background.js            toolbar click → inject → save files
  content/run-capture.js   in-page entry: pick adapter, run, normalize, progress panel
  platforms/
    chatgpt.js             ChatGPT adapter (selectors, scroll sweep, stitching)
    claude.js              Claude.ai adapter (indexed rows, count check)
    web.js                 any page (Readability + fallback)
    registry.js            URL → adapter
  core/
    html-to-markdown.js    DOM → Markdown, with per-platform rules
    normalize.js           raw capture → common schema "verbatim/v1"
    completeness.js        evidence → verified / unverified / incomplete
    enrich.js              outline, word split, links, questions (no AI)
    exporters.js           Markdown, JSON, handoff, file names
  vendor/Readability.js    Mozilla Readability 0.5.0 (Apache-2.0)
test/                      27 tests on simulated ChatGPT, Claude and web pages
```

Data flow: **page → adapter (raw capture) → normalize + completeness + enrich → exporters → downloads.** To add a platform, write one adapter file and register it. Nothing else changes.

## Tests

```bash
npm install
npm test
```

The tests run the real extension code against simulated pages that reproduce ChatGPT's and Claude's October 2026 page structure, including virtualization and lazy loading. Failure modes must produce `incomplete`, never `verified`: a gap in the sweep, older messages that never load, an unrendered turn, a prompt that won't expand, a hidden view of another chat, messages from another conversation, a still-streaming reply, and a Claude message that never renders.

## Known limitations

- **ChatGPT and Claude change their pages without notice.** All selectors sit in one `SEL` block at the top of each adapter. An `incomplete` or empty export is the first sign one needs updating.
- **Images and files are references.** Uploads appear only through temporary in-browser links, so they're listed by name. Keep your originals.
- **Web pages are read as shown.** Content that loads on scroll or sits behind tabs may be missing. Very app-like pages may convert with some layout text.
- **Keep the tab in front during conversation captures.** Chrome throttles background tabs.
- **The handoff condenses AI replies mechanically:** headings, first sentences, the first few list items. Your own messages are never shortened.
- If Chrome is set to "Ask where to save each file," you'll get one dialog per file.

## License

MIT for Verbatim's own code. `src/vendor/Readability.js` is Mozilla's, under Apache-2.0 (see `src/vendor/Readability.LICENSE.md`).
