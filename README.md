# Verbatim

**Save your AI conversations, verified complete.**

Verbatim is a Chrome extension that saves the ChatGPT or Claude conversation you're viewing, the transcript of a YouTube video or Spotify podcast episode, or any web page, as clean Markdown and structured JSON. It tells you plainly whether the capture is complete. Everything runs in your browser: nothing is uploaded, and it never touches your login.

Most chat exporters quietly hand you whatever happened to be on screen. ChatGPT and Claude only keep a few messages in the page at a time, collapse long prompts, and leave hidden copies of other chats in the background. Verbatim scrolls the whole thread, expands what's collapsed, reads only the conversation in the address bar, and checks its own work. When it can't prove it got everything, it says so.

## What you get

Click the toolbar button and Verbatim picks the right mode from the page you're on:

| Page | Files | Completeness |
| --- | --- | --- |
| ChatGPT conversation | `Title.md`, `Title.json`, `Title — handoff.md` | Continuous top-to-bottom read, no gaps, every message rendered |
| Claude.ai conversation | same three files | Same, plus a count check against Claude's own "Message N of TOTAL" |
| YouTube video | `Title.md`, `Title.json` | YouTube's own transcript, chapters kept, last line checked against the video length |
| Spotify podcast episode | `Title.md`, `Title.json` | Spotify's own transcript (sign in on open.spotify.com; only episodes that have one) |
| Any other web page | `Title.md`, `Title.json` | Main content found (Readability), navigation and cookie banners removed |
| A whole website | a folder: one `.md` per page mirroring the site, `media/`, `index.md`, `site.json` | Every page found (sitemap + links) visited and saved, every image, video and file downloaded |

Files are saved to `Downloads/Verbatim/<date> <time> <source> — <title>/`, or straight into a folder you choose, such as your Obsidian vault (see **Save folder** below).

**Every conversation export includes:**

- **Obsidian-ready front matter:** title, source, platform, date, status and tags.
- **At a glance:** your words vs. the AI's, plus counts of links, code blocks, images, files and questions.
- **Outline:** each of your prompts as a one-line table of contents.
- **The full transcript,** with headings, lists, tables, code (with language), links, citations and checklists preserved.
- **Links and sources** and **Questions you asked,** collected from the whole conversation.
- **Completeness report:** every check, PASS / FAIL / UNKNOWN, with scope notes.

**The handoff file** is built for continuing in another assistant, for example ChatGPT → Claude. It includes instructions for the receiving AI, a brief, every message you wrote word for word, and the AI's replies condensed (the latest one in full).

Everything is computed locally with plain code: no AI calls, no API keys, nothing sent anywhere.

**A whole-site capture** is a folder you can drop into Obsidian:

```
2026-10-28 13-25 hardli.st — whole site/
  index.md             every page, grouped by section, plus the completeness report
  home.md, about.md …  one Markdown file per page, in folders that mirror the site
  startups/acme.md
  media/               images, video files, PDFs, downloaded once and shared
  site.json            every page, media file and failure, machine-readable
```

Images are saved at full size: the largest size a page offers, and the original file instead of a resized copy on common image services (imgix, Next.js, Sanity, Framer, Shopify, Squarespace, WordPress, Webflow, Cloudinary, Contentful). Media a site lists only in its page data (sites built with JavaScript) is found too. Files are named by what the server sent, so a video thumbnail is saved as an image, not as a broken .mp4. Video files can be turned off before starting; large captures download as several .zip parts. Images show inline from `media/`, links between captured pages point to each other's files, and each page ends with **Media on this page**, so nothing the page showed is lost. YouTube and Vimeo players are linked (they can't be downloaded). Without a save folder, the capture downloads as one `.zip`.

**Every transcript export includes:** front matter (title, channel or show, published date, length, status, tags), the description and its links, chapters, and the transcript in readable paragraphs, each starting with a timestamp. On YouTube, every timestamp links to that moment in the video.

## Install

1. Download or clone this repository.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `verbatim` folder (the one with `manifest.json`).
4. Pin **Verbatim** from the puzzle-piece menu.

After updating the code, click the reload ↻ icon on the extension's card.

### Save straight to a folder, e.g. your Obsidian vault (optional, recommended)

Install the small save helper once. Chrome hands each capture to it, and it writes the files into the folder you name:

```bash
native/install.sh <extension-id> "/path/to/your/vault/Conversation Capture"
```

The extension ID is shown on Verbatim's card in `chrome://extensions`. Reload Verbatim afterwards. The helper is a short Python script (`native/verbatim_host.py`) that only accepts messages from your Verbatim install and only writes inside that folder. `native/uninstall.sh` removes it. Without it, captures go to `Downloads/Verbatim`.

### Save folder in Options (experimental)

Right-click the Verbatim icon → **Options** → **Choose folder…** and pick a folder, for example one inside your Obsidian vault. Every capture is then written there, one dated subfolder per capture. Use **Save a test file** to confirm it works.

Chrome may ask you to re-allow access later, for example after it restarts. Until you do, captures fall back to `Downloads/Verbatim` and the capture panel says so. Click **Allow access again** in Options to switch back.

## Use

Open a conversation or page and click **Verbatim**. On an ordinary web page, choose **This page** or **Whole site**. Whole site opens a Verbatim tab: set a page limit, click **Start**, and keep the tab open until it finishes (Stop saves what's done). The first time, Chrome asks to let Verbatim access websites; that's needed to read the site's pages and download images hosted elsewhere. For conversations, keep the tab in front and don't scroll until the panel says it's done. A long conversation takes a few minutes, because Verbatim reads the whole thread.

Badge: **OK** = verified (or page captured) · **?** = couldn't be verified · **!** = known to be missing content · **ERR** = failed · **—** = Chrome's own pages can't be read.

## Privacy and permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the current tab, only when you click. No standing access to any site. |
| `scripting` | Run the capture code in that tab on click. |
| `downloads` | Save the files to Downloads when no save folder is chosen. |
| `nativeMessaging` | Talk to the optional save helper, if you installed it. Does nothing otherwise. |
| Access to websites (optional) | Asked only when you start a **Whole site** capture: read that site's pages and download the images and files they show, including from other hosts (CDNs, image services). You can remove it in Chrome's extension settings at any time. |

The optional save folder uses Chrome's standard folder picker: Verbatim can only write inside the one folder you pick. Single-page and conversation captures make no network requests. A whole-site capture requests only the site you chose (staying on it, following its robots.txt, a few pages at a time) and the media its pages show. No remote code, no analytics. It doesn't call ChatGPT's or Claude's internal APIs and doesn't read cookies or tokens. Capture code runs in Chrome's isolated extension context, out of reach of the page's own scripts.

## How "verified" works

- **ChatGPT:** shows only a handful of turns at a time and lazy-loads older ones. Verbatim scrolls to the top until nothing older loads, then steps down half a screen at a time so every snapshot overlaps the last, and stitches turns together by their IDs. It expands prompts collapsed behind "Show more", ignores hidden copies of previously opened chats, and confirms every message carries the conversation ID in the address bar.
- **Claude:** every message is labeled with its position and the total, so Verbatim checks that each position from 1 to TOTAL was read.
- **YouTube and Spotify:** Verbatim opens the site's own transcript, waits until it stops loading, and checks that it starts near 0:00 and that its last line is within a couple of minutes of the end. Spotify only shows how long an episode is while it's playing, so press play first, or the end check reads UNKNOWN.

**Verified** means a complete read of the **displayed conversation**. These are always listed as scope notes rather than claimed:

- edited or regenerated alternatives ("2/2")
- collapsed reasoning and tool steps
- artifact contents
- the files behind images and uploads

## Architecture

```
manifest.json
src/
  background.js            toolbar click → inject → save to chosen folder or Downloads
  settings/                options page + save-folder storage and writer
  site/                    whole-site capture tab (crawl → media → save / .zip)
native/                    optional save helper (Chrome native messaging host) + installer
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
    site.js                whole site: sitemap + robots.txt, crawl, media, folder layout, completeness
    zip.js                 minimal .zip writer for site captures
  vendor/Readability.js    Mozilla Readability 0.5.0 (Apache-2.0)
test/                      58 tests on simulated ChatGPT, Claude, YouTube, Spotify, web pages and a whole site
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
- **Transcripts come from the site, not from Verbatim.** They are usually machine-generated, label speakers only as "Speaker 1, 2" at best, and can mishear words. Videos and episodes without a transcript can't be captured this way. The Spotify reader finds the transcript through its Transcript tab and timestamps, so a Spotify redesign is the most likely thing to break it.
- **Images and files are references.** Uploads appear only through temporary in-browser links, so they're listed by name. Keep your originals.
- **Whole-site captures read pages as the site serves them.** Text that appears only after clicking (tabs, "load more", infinite scroll) may be missing. Pages a site builds entirely with JavaScript are opened in a background tab to render, which is slower. Pages behind a login are captured only if you're signed in. Media files over 250 MB are skipped and listed.
- **Web pages are read as shown.** Content that loads on scroll or sits behind tabs may be missing. Very app-like pages may convert with some layout text.
- **Keep the tab in front during conversation captures.** Chrome throttles background tabs.
- **The handoff condenses AI replies mechanically:** headings, first sentences, the first few list items. Your own messages are never shortened.
- If Chrome is set to "Ask where to save each file," Downloads saves show one dialog per file. Choosing a save folder avoids this.
- Don't point `Downloads/Verbatim` at another folder with a symlink: Chrome won't save through it. Use the save folder setting instead.

## License

MIT for Verbatim's own code. `src/vendor/Readability.js` is Mozilla's, under Apache-2.0 (see `src/vendor/Readability.LICENSE.md`).
