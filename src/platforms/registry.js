/*
 * Platform registry. Each adapter exposes:
 *   { id, name, matches(url) -> bool, collect({ document, url, onProgress }) -> Promise<RawCapture> }
 *
 * Conversation adapters are tried first; the generic web page adapter
 * (fallback: true) handles any other http(s) page.
 *
 * To add a platform, write src/platforms/<id>.js that registers itself on
 * Verbatim.platforms and add it to CONTENT_FILES in background.js.
 */
(function (root) {
  const NS = (root.Verbatim = root.Verbatim || {});

  NS.findPlatform = function findPlatform(url) {
    const all = Object.values(NS.platforms || {});
    return all.find((p) => !p.fallback && p.matches(url)) || all.find((p) => p.fallback && p.matches(url)) || null;
  };
})(globalThis);
