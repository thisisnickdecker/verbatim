/*
 * Platform registry. Each adapter exposes:
 *   { id, name, matches(url) -> bool, collect({ document, url, onProgress }) -> Promise<RawCapture> }
 *
 * To add a platform (e.g. Claude), write src/platforms/<id>.js that registers
 * itself on ConversationCapture.platforms, add it to the injected file list in
 * background.js, and add its URL pattern to the manifest's show-action rules.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  NS.findPlatform = function findPlatform(url) {
    const all = Object.values(NS.platforms || {});
    return all.find((p) => p.matches(url)) || null;
  };
})(globalThis);
