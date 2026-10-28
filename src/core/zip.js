/*
 * Minimal .zip writer (no compression), for saving a whole-site capture as
 * one download. Files are stored as-is: images and videos are already
 * compressed, and Markdown is small. UTF-8 names; no ZIP64, so the archive
 * must stay under 4 GB.
 *
 * zip([{ path, text } | { path, bytes } | { path, blob, size, crc }], date?)
 * -> array of parts (pass to new Blob(parts, { type: 'application/zip' })).
 * A Blob entry is not read again: its size and CRC-32 come with it (worked
 * out while it downloaded, with crc32(chunk, previous)), so large videos
 * stay in Chrome's blob storage instead of memory.
 */
(function (root) {
  const NS = (root.ConversationCapture = root.ConversationCapture || {});

  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  // crc32(all) === crc32(second, crc32(first)).
  function crc32(bytes, previous) {
    let c = ((previous || 0) ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function header(size) {
    const buf = new Uint8Array(size);
    return { buf, view: new DataView(buf.buffer) };
  }

  function zip(files, when) {
    const enc = new TextEncoder();
    const { time, date } = dosTime(when || new Date());
    if (files.length > 0xffff) throw new Error('This capture has more than 65,535 files, too many for one .zip file.');
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.path);
      const data = f.blob || f.bytes || enc.encode(f.text || '');
      const size = f.blob ? f.size : data.length;
      const crc = f.blob ? f.crc : crc32(data);
      const local = header(30 + name.length);
      const v = local.view;
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true); // version needed
      v.setUint16(6, 0x0800, true); // UTF-8 names
      v.setUint16(8, 0, true); // stored
      v.setUint16(10, time, true);
      v.setUint16(12, date, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, size, true);
      v.setUint32(22, size, true);
      v.setUint16(26, name.length, true);
      v.setUint16(28, 0, true);
      local.buf.set(name, 30);
      parts.push(local.buf, data);

      const cen = header(46 + name.length);
      const c = cen.view;
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, size, true);
      c.setUint32(24, size, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      cen.buf.set(name, 46);
      central.push(cen.buf);

      offset += local.buf.length + size;
      if (offset > 0xffffffff) throw new Error('This capture is larger than 4 GB, too large for one .zip file.');
    }
    const centralSize = central.reduce((n, b) => n + b.length, 0);
    const end = header(22);
    const e = end.view;
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true);
    e.setUint16(10, files.length, true);
    e.setUint32(12, centralSize, true);
    e.setUint32(16, offset, true);
    return [...parts, ...central, end.buf];
  }

  NS.zip = { zip, crc32 };
})(globalThis);
