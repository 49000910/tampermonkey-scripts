#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""meta-driven restore: python decode.py <pack_dir> <out_dir>"""
import base64, json, os, sys, zlib

XOR_KEY = 123

def unpack(pack_dir, out_dir):
    meta = json.load(open(os.path.join(pack_dir, "meta.json"), encoding="utf-8"))
    blob = b""
    n = len(meta["chunks"])
    for i, c in enumerate(meta["chunks"], 1):
        blob += open(os.path.join(pack_dir, c), "rb").read()
        if i % 20 == 0 or i == n:
            print("chunk %d/%d" % (i, n), end="\r")
    blob = base64.b64decode(blob)
    blob = bytes(b ^ XOR_KEY for b in blob)
    data = zlib.decompress(blob)
    exp = hashlib.sha256(data).hexdigest()
    if exp != meta.get("sha256", exp):
        print("SHA256 MISMATCH!"); return 1
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, os.path.basename(meta["name"]))
    open(out, "wb").write(data)
    magic = data[:4].hex()
    print("restore done: %s (%d bytes, magic=%s)" % (out, len(data), magic))
    return 0

if __name__ == "__main__":
    sys.exit(unpack(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "."))
