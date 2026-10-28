# Verbatim

**Keep what you read, exactly as it was.**

A Chrome extension that saves AI conversations, podcast and video transcripts, web pages and entire websites as clean Markdown, and tells you plainly whether it got everything.

[![check](https://github.com/thisisnickdecker/verbatim/actions/workflows/check.yml/badge.svg)](https://github.com/thisisnickdecker/verbatim/actions/workflows/check.yml)
[![release](https://img.shields.io/github/v/release/thisisnickdecker/verbatim)](https://github.com/thisisnickdecker/verbatim/releases/latest)
[![license](https://img.shields.io/github/license/thisisnickdecker/verbatim)](LICENSE)

**[Download](https://github.com/thisisnickdecker/verbatim/releases/latest)** · [Install](#install) · [What it captures](#what-it-captures) · [Privacy](#privacy)

<!-- Hero image goes here: docs/hero.png — the capture panel next to the resulting note in Obsidian. -->

## Why

I keep a library of everything I learn from: conversations with AI, podcasts, talks, the studios and sites I study. Copy and paste loses things, and every exporter I tried saved whatever happened to be on screen and called it done. ChatGPT only keeps a few messages loaded at a time. Spotify hides its transcript behind a tab. Most sites keep their full-size images somewhere other than the page.

So I designed Verbatim around three rules:

- **Complete, or honest about it.** Every capture ends with a report: what was checked, what passed, and what's missing. If it can't prove it got everything, it says so.
- **Made for a library, not a downloads folder.** Markdown with front matter, readable file names, and folders that drop straight into Obsidian.
- **Yours.** It runs entirely in your browser. No account, no server, no AI calls, no analytics.

## What it captures

Click the toolbar button. Verbatim picks the right mode for the page you're on.

| Page | You get | How completeness is checked |
| --- | --- | --- |
| ChatGPT or Claude conversation | `.md`, `.json` and a handoff file for continuing in another assistant | The whole thread is read top to bottom with no gaps; Claude's "message N of total" is counted |
| YouTube video | Timestamped transcript with chapters; every timestamp links to that moment | The last line reaches the end of the video |
| Spotify podcast episode | Transcript with speakers and the full description | The last line reaches the end of the episode |
| Any web page | The main content, without navigation or cookie banners | Main content found |
| A whole website | A folder: one note per page, every image and video, an index | Every page found was saved; every media file was downloaded |

A whole-site capture looks like this:

```
2026-10-28 13-25 hardli.st — whole site/
  index.md        every page, grouped by section, with the completeness report
  home.md         one note per page, in folders that mirror the site
  startups/
    alice-and-bob.md
  media/          full-size images, video files and PDFs, saved once and shared
  site.json       every page, file and failure, machine-readable
```

Images are saved at their largest size, and as the original file rather than a resized copy on the common image services (imgix, Next.js, Sanity, Framer, Shopify, Squarespace, WordPress, Webflow, Cloudinary, Contentful). Media that a site only lists in its page data is found too. Links between pages point to the saved copies, so you can click through the site inside Obsidian. Embedded YouTube and Vimeo players are linked.

## Install

Verbatim isn't in the Chrome Web Store yet. Installing from the download takes about a minute:

1. Download `verbatim-<version>.zip` from the [latest release](https://github.com/thisisnickdecker/verbatim/releases/latest) and unzip it. Keep the folder somewhere permanent: Chrome loads Verbatim from it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.
4. Pin Verbatim from the puzzle-piece menu.

Works in Chrome, Arc, Brave and Edge. To update, replace the files inside that same folder and click Verbatim's reload icon in `chrome://extensions`. Keeping the folder in place keeps your settings.

### Save straight into your vault (optional)

By default captures go to `Downloads/Verbatim`. To send them straight into a folder such as an Obsidian vault, either:

- **Choose a folder in Options:** right-click the Verbatim icon → **Options** → **Choose folder…**. Chrome may ask you to allow access again after a restart; Options has a one-click button for that.
- **Or install the save helper** (macOS, Python 3), which never needs re-allowing. From Terminal, in the Verbatim folder:

  ```bash
  bash native/install.sh <extension-id> "/path/to/your/vault/Verbatim"
  ```

  The extension ID is on Verbatim's card in `chrome://extensions`. The helper only accepts messages from your Verbatim and only writes inside that folder. `bash native/uninstall.sh` removes it.

## Use

Open a page and click **Verbatim**.

- **Conversations:** keep the tab in front until the panel says it's done. Long threads take a few minutes.
- **Spotify:** sign in and press play first, so the episode length is visible for the end check.
- **Web pages:** choose **This page** or **Whole site**. Whole site opens a Verbatim tab where you set a page limit, choose whether to download video files, and press **Start**. Stop saves what's done. Without a save folder, the site downloads as a `.zip`.

The toolbar badge shows the result: **OK** complete · **?** couldn't be verified · **!** something is missing · **ERR** failed.

## Privacy

| Permission | Why |
| --- | --- |
| `activeTab`, `scripting` | Read the current tab, only when you click. |
| `downloads` | Save to Downloads when no folder is chosen. |
| `nativeMessaging` | Talk to the optional save helper, if installed. |
| Access to websites (optional) | Asked only when you start a whole-site capture, to read that site and download its images. Removable any time in Chrome's settings. |

Single pages and conversations make no network requests. A whole-site capture stays on the site you chose, follows its robots.txt and reads a few pages at a time. Verbatim never calls ChatGPT's or Claude's internal APIs and never reads cookies or tokens.

## How completeness is checked

- **ChatGPT** loads only a few turns at a time. Verbatim scrolls to the very top, then steps down in overlapping snapshots and stitches turns together by ID. It expands collapsed prompts, ignores hidden copies of other chats, and confirms every message belongs to the conversation in the address bar.
- **Claude** labels each message with its position and the total, so every position is accounted for.
- **YouTube and Spotify:** the site's own transcript is opened, read once it stops loading, and checked against the start and the length of the media.
- **Whole sites:** pages come from the sitemap and from following links. Anything that failed, was blocked by robots.txt, or was beyond the page limit is listed by name.

Some things are listed as scope notes instead of claimed: edited or regenerated replies, collapsed reasoning, artifact contents, and the original files behind uploads.

## Development

```bash
npm install
npm run check     # lint + 58 tests
npm run package   # dist/verbatim-<version>.zip for a release
```

No framework and no build step: Chrome loads `src/` as is.

```
src/
  background.js         toolbar click → run the capture → save
  content/              in-page entry point and progress panel
  platforms/            one adapter per site: chatgpt, claude, youtube, spotify, web
  core/                 DOM → Markdown, schema, completeness, enrichment, exporters
  site/                 whole-site capture: crawl → media → output, .zip, and its tab
  settings/             options page and save folder
  vendor/               Mozilla Readability
native/                 optional save helper (Chrome native messaging)
test/                   simulated pages for every platform, including failure cases
```

Every capture flows the same way: **adapter → raw capture → normalize, check, enrich → exporters → save.** Adding a site means writing one adapter. The tests run the real extension code against simulated pages that reproduce each site's structure, including lazy loading and virtualization, and every failure mode must come out `incomplete`, never `verified`.

## Limitations

- Sites change their pages without notice. Each adapter keeps its selectors in one `SEL` block, and an `incomplete` capture is usually the first sign one needs updating.
- Transcripts are the site's own, usually machine-generated. Videos and episodes without one can't be captured.
- Whole-site captures read pages as the server sends them (JavaScript-built pages are rendered in a background tab). Text behind clicks or infinite scroll may be missing, and files over 250 MB are skipped and listed.
- Uploads inside conversations are listed by name; their files aren't downloadable.

## License

MIT. `src/vendor/Readability.js` is Mozilla's, under Apache-2.0.

Designed and built by [Nick Decker](https://github.com/thisisnickdecker).
