/*
 * Optional save folder (e.g. an Obsidian vault), chosen once in Verbatim's
 * settings with Chrome's folder picker (File System Access API).
 *
 * The folder handle is kept in IndexedDB. Writing needs Chrome's permission
 * to still be "granted"; Chrome may reset it (for example after a restart),
 * and only the settings page can ask again. When it isn't granted, the
 * background worker falls back to Downloads/Verbatim.
 *
 * Shared by the settings page and the background service worker.
 */
(function (root) {
  const NS = (root.Verbatim = root.Verbatim || {});

  const DB = 'verbatim-settings';
  const STORE = 'kv';
  const KEY = 'saveFolder';

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  }

  const getFolder = () => tx('readonly', (s) => s.get(KEY));
  const setFolder = (handle) => tx('readwrite', (s) => s.put(handle, KEY));
  const clearFolder = () => tx('readwrite', (s) => s.delete(KEY));

  async function permission(handle) {
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch (_) {
      return 'denied';
    }
  }

  // Write [{ filename: 'Verbatim/<folder>/<file>', text }] under `handle`.
  // The leading "Verbatim/" (the Downloads subfolder) is dropped: the chosen
  // folder takes its place. If the capture folder already exists, " (2)",
  // " (3)"… is appended so nothing is overwritten.
  async function writeFiles(handle, files) {
    const parts = files.map((f) => f.filename.replace(/^Verbatim\//, '').split('/'));
    const folderName = parts[0][0];
    let name = folderName;
    for (let n = 2; ; n++) {
      try {
        await handle.getDirectoryHandle(name, { create: false });
        name = `${folderName} (${n})`;
      } catch (_) {
        break; // doesn't exist yet
      }
    }
    const dir = await handle.getDirectoryHandle(name, { create: true });
    for (let i = 0; i < files.length; i++) {
      const fileHandle = await dir.getFileHandle(parts[i].slice(1).join(' '), { create: true });
      const w = await fileHandle.createWritable();
      await w.write(files[i].text);
      await w.close();
    }
    return { folder: handle.name, subfolder: name };
  }

  // Write a folder tree: [{ path: 'startups/a.md', text } | { path, bytes }]
  // into a new subfolder `name` (made unique like writeFiles).
  async function writeTree(handle, name, files, onProgress) {
    let sub = name;
    for (let n = 2; ; n++) {
      try {
        await handle.getDirectoryHandle(sub, { create: false });
        sub = `${name} (${n})`;
      } catch (_) {
        break;
      }
    }
    const top = await handle.getDirectoryHandle(sub, { create: true });
    const dirs = new Map([['', top]]);
    const dirFor = async (parts) => {
      let key = '';
      let dir = top;
      for (const p of parts) {
        key += '/' + p;
        if (!dirs.has(key)) dirs.set(key, await dir.getDirectoryHandle(p, { create: true }));
        dir = dirs.get(key);
      }
      return dir;
    };
    for (let i = 0; i < files.length; i++) {
      const parts = files[i].path.split('/');
      const dir = await dirFor(parts.slice(0, -1));
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(files[i].bytes || files[i].text || '');
      await w.close();
      if (onProgress) onProgress(i + 1, files.length);
    }
    return { folder: handle.name, subfolder: sub };
  }

  NS.saveFolder = { getFolder, setFolder, clearFolder, permission, writeFiles, writeTree };
})(globalThis);
