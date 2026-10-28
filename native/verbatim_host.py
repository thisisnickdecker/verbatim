#!/usr/bin/python3
"""
Verbatim save helper (Chrome native messaging host).

Optional. When installed (see native/install.sh), Verbatim hands each capture
to this script, which writes the files into the folder named in
~/.verbatim/config.json, e.g. an Obsidian vault in iCloud Drive. Chrome starts
it on demand; it only accepts messages from the Verbatim extension ID listed
in its host manifest, and only writes inside the configured folder.

Protocol: 4-byte little-endian length + UTF-8 JSON, both directions.
  {"type": "ping"}                                   -> {"ok": true, "saveFolder": ...}
  {"type": "save", "files": [{"filename", "text"}]}  -> {"ok": true, "folder", "subfolder"}
"""
import json
import os
import struct
import sys

CONFIG = os.environ.get("VERBATIM_CONFIG") or os.path.expanduser("~/.verbatim/config.json")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def save_folder():
    with open(CONFIG, encoding="utf-8") as f:
        folder = os.path.expanduser(json.load(f)["saveFolder"])
    if not os.path.isdir(folder):
        raise RuntimeError(f"save folder does not exist: {folder}")
    return os.path.realpath(folder)


def safe_part(part):
    # Names come from Verbatim's own exporter, but never trust a path blindly.
    if part in ("", ".", "..") or "/" in part or "\\" in part or "\0" in part:
        raise ValueError(f"unsafe path segment: {part!r}")
    return part


def save(files):
    root = save_folder()
    parts = [f["filename"].split("/") for f in files]
    parts = [p[1:] if p[0] == "Verbatim" else p for p in parts]  # drop the Downloads subfolder name
    base = safe_part(parts[0][0])
    sub, n = base, 2
    while os.path.exists(os.path.join(root, sub)):
        sub, n = f"{base} ({n})", n + 1
    target = os.path.join(root, sub)
    os.makedirs(target)
    for f, p in zip(files, parts):
        name = " ".join(safe_part(x) for x in p[1:])
        path = os.path.join(target, name)
        if os.path.dirname(os.path.realpath(path)) != os.path.realpath(target):
            raise ValueError("refusing to write outside the save folder")
        with open(path, "w", encoding="utf-8") as out:
            out.write(f["text"])
    return {"ok": True, "folder": os.path.basename(root), "subfolder": sub}


def main():
    msg = read_message()
    if msg is None:
        return
    try:
        if msg.get("type") == "ping":
            send({"ok": True, "saveFolder": save_folder()})
        elif msg.get("type") == "save":
            send(save(msg["files"]))
        else:
            send({"ok": False, "error": "unknown message type"})
    except Exception as e:  # report every failure back to the extension
        send({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
