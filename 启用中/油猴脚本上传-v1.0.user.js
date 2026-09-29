// ==UserScript==
// @name         油猴脚本上传
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  在 github.com 页面上传本地油猴脚本文件夹到 GitHub 仓库：自动建库、小文件直传/大文件分片、实时进度、代理自适应重试、逐字节校验
// @author       49000910
// @match        https://github.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

// == CORE ==
const XKEY = 123;
const API = 'https://api.github.com';
const DIRECT_MAX = 40960;
const CHUNK_SIZE = 16384;

function b64encode(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function xorBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ XKEY;
  return out;
}

function gitBlobShaHex(bytes) {
  const hdr = 'blob ' + bytes.length + '\0';
  const hb = [];
  for (let i = 0; i < hdr.length; i++) hb.push(hdr.charCodeAt(i));
  const all = new Uint8Array(hb.length + bytes.length);
  all.set(hb, 0); all.set(bytes, hb.length);
  return hexOf(sha1raw(all));
}

function sha1raw(bytes) {
  const ml = bytes.length;
  const total = (((ml + 8) >> 6 << 6) + 64);
  const buf = new Uint8Array(total);
  buf.set(bytes, 0);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(ml / 536870912), false);
  dv.setUint32(total - 4, (ml << 3) >>> 0, false);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);
  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) {
      const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f, g;
      if (j < 20) { f = (b & c) | (~b & d); g = 0x5A827999; }
      else if (j < 40) { f = b ^ c ^ d; g = 0x6ED9EBA1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); g = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; g = 0xCA62C1D6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + g + w[j]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => odv.setUint32(i * 4, h, false));
  return out;
}

function hexOf(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

async function zlibCompress(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function zlibDecompress(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function packParts(data, chunkSize) {
  const z = await zlibCompress(data);
  const b64 = b64encode(xorBytes(z));
  const parts = [];
  for (let i = 0; i < b64.length; i += chunkSize) parts.push(b64.slice(i, i + chunkSize));
  return parts;
}

async function unpackAll(parts) {
  const blob = b64decode(parts.join(''));
  const z = await zlibDecompress(xorBytes(blob));
  return z;
}

function buildMeta(rel, parts, data) {
  return {
    name: rel.split('/').pop(),
    chunk_size: CHUNK_SIZE,
    method: { compress: 'zlib', encode: 'base64', obfuscation: 'xor_' + XKEY },
    chunks: parts.map((_, i) => 'chunks/part_' + String(i).padStart(4, '0') + '.bin'),
    sha256: null,
    srcSize: data.length
  };
}

// 与 Python hashlib.sha256 等价（仅用于 meta，WebCrypto 直接可用）
async function sha256hex(bytes) {
  if (crypto && crypto.subtle) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return hexOf(new Uint8Array(d));
  }
  return null;
}

async function uploadFileFlow(gh, f, log, stopped) {
  const data = new Uint8Array(await f.file.arrayBuffer());
  const rel = f.rel;
  const sha = gitBlobShaHex(data);
  if (gh.tree[rel] === sha) { log('跳过 ' + rel + '（已上传且一致）'); return { rel, result: 'skip' }; }
  if (gh.tree[rel + '/meta.json']) {
    const meta = gh.metaCache[rel];
    if (meta && meta.complete) { log('跳过 ' + rel + '（分片包已完整）'); return { rel, result: 'skip' }; }
  }
  if (data.length <= DIRECT_MAX) {
    log('直传 ' + rel + '（' + data.length + ' B' + (gh.tree[rel] ? '，更新' : '') + '）');
    if (await gh.put(rel, data, gh.tree[rel], 4)) { gh.tree[rel] = sha; return { rel, result: 'direct' }; }
    log('直传失败，转分片...');
  }
  if (gh.tree[rel] !== undefined) { log('!! 仓库同名已是普通文件，分片目录会冲突'); return { rel, result: 'fail' }; }
  const parts = await packParts(data, CHUNK_SIZE);
  const meta = buildMeta(rel, parts, data);
  meta.sha256 = await sha256hex(data);
  const toPut = {};
  parts.forEach((p, i) => { toPut[rel + '/chunks/part_' + String(i).padStart(4, '0') + '.bin'] = p; });
  toPut[rel + '/meta.json'] = JSON.stringify(meta, null, 1);
  toPut[rel + '/decode.py'] = DECODE_PY;
  let missing = Object.keys(toPut).filter(p => gh.tree[p] !== gitBlobShaHex(typeof toPut[p] === 'string' ? strToBytes(toPut[p]) : strToBytes(toPut[p])));
  if (!missing.length) { log('分片包已完整，跳过 ' + rel); return { rel, result: 'skip' }; }
  log('分片 ' + rel + '（' + data.length + ' B -> ' + parts.length + ' 片）');
  let done = parts.length - missing.filter(p => p.endsWith('.bin')).length;
  const failList = [];
  for (const p of Object.keys(toPut).sort()) {
    if (stopped()) { log('已停止'); return { rel, result: 'fail' }; }
    if (!missing.includes(p)) continue;
    if (await gh.put(p, strToBytes(toPut[p]), gh.tree[p], 1)) {
      gh.tree[p] = gitBlobShaHex(strToBytes(toPut[p]));
      if (p.endsWith('.bin')) { done++; log('chunk ' + done + '/' + parts.length, true); }
    } else failList.push(p);
  }
  let rnd = 0;
  while (failList.length && rnd < 10 && !stopped()) {
    rnd++;
    log('补传 ' + failList.length + ' 个失败文件（60s 后，代理窗口波动）...');
    await sleep(60000);
    const still = [];
    for (const p of failList) {
      if (stopped()) break;
      if (await gh.put(p, strToBytes(toPut[p]), gh.tree[p], 1)) {
        gh.tree[p] = gitBlobShaHex(strToBytes(toPut[p]));
        if (p.endsWith('.bin')) { done++; log('chunk ' + done + '/' + parts.length, true); }
      } else still.push(p);
    }
    failList.length = 0; failList.push(...still);
  }
  if (failList.length) { log('!! ' + rel + ' 仍有 ' + failList.length + ' 个文件失败'); return { rel, result: 'fail' }; }
  log('分片完成 ' + rel + '（' + parts.length + ' 片）');
  return { rel, result: 'chunked' };
}

function strToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const DECODE_PY = [
  '#!/usr/bin/env python3',
  '# -*- coding: utf-8 -*-',
  '"""meta-driven restore: python decode.py <pack_dir> <out_dir>"""',
  'import base64, json, os, sys, zlib',
  'XOR_KEY = ' + XKEY,
  'def unpack(pack_dir, out_dir):',
  '    meta = json.load(open(os.path.join(pack_dir, "meta.json"), encoding="utf-8"))',
  '    blob = b""',
  '    n = len(meta["chunks"])',
  '    for i, c in enumerate(meta["chunks"], 1):',
  '        blob += open(os.path.join(pack_dir, c), "rb").read()',
  '        if i % 20 == 0 or i == n:',
  '            print("chunk %d/%d" % (i, n), end="\\r")',
  '    blob = base64.b64decode(blob)',
  '    blob = bytes(b ^ XOR_KEY for b in blob)',
  '    data = zlib.decompress(blob)',
  '    import hashlib',
  '    exp = hashlib.sha256(data).hexdigest()',
  '    if exp != meta.get("sha256", ""):',
  '        print("SHA256 MISMATCH!"); return 1',
  '    os.makedirs(out_dir, exist_ok=True)',
  '    out = os.path.join(out_dir, os.path.basename(meta["name"]))',
  '    open(out, "wb").write(data)',
  '    print("restore done: %s (%d bytes, magic=%s)" % (out, len(data), data[:4].hex()))',
  '    return 0',
  'if __name__ == "__main__":',
  '    sys.exit(unpack(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "."))'
].join('\n');

class Uploader {
  constructor(token, log, stopped) {
    this.token = token;
    this.log = log;
    this.stopped = stopped;
    this.tree = {};
    this.metaCache = {};
    this.branch = 'main';
    this.username = null;
  }
  async api(method, path, body) {
    return new Promise((resolve) => {
      const headers = { 'Authorization': 'token ' + this.token, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'tm-upload-tool' };
      const req = {
        method, url: API + path, headers, timeout: 60000,
        onerror: () => resolve({ status: -1, body: { message: '网络错误（代理拦截？）' } }),
        ontimeout: () => resolve({ status: -1, body: { message: '超时' } }),
        onload: (e) => {
          let b;
          try { b = JSON.parse(e.target.response); } catch (err) { b = { message: String(e.target.response).slice(0, 200) }; }
          resolve({ status: e.target.status, body: b });
        }
      };
      if (body !== undefined) { req.data = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
      GM_xmlhttpRequest(req);
    });
  }
  async put(rel, data, currentSha, attempts) {
    const body = { message: 'upload ' + rel.split('/').pop(), content: b64encode(data), branch: this.branch };
    if (currentSha) body.sha = currentSha;
    let last = null;
    for (let i = 0; i < attempts; i++) {
      if (i) {
        const w = [8, 15, 30, 60][Math.min(i - 1, 3)];
        this.log('重试 ' + (i + 1) + '/' + attempts + '（' + w + 's 后）');
        await sleep(w * 1000);
      }
      const r = await this.api('PUT', '/repos/' + this.repo + '/contents/' + encodeURIComponent(rel).replace(/%2F/g, '/'), body);
      last = r;
      if (r.status === 200 || r.status === 201) return true;
      if (r.status === 422 && !currentSha && /sha/i.test(JSON.stringify(r.body))) return false;
      if (r.status === -1 || r.status >= 500) continue;
      break;
    }
    return false;
  }
  async ensureRepo(name, privateRepo) {
    let r = await this.api('GET', '/user');
    if (r.status !== 200) { this.log('!! 获取用户信息失败：' + JSON.stringify(r.body).slice(0, 120)); return null; }
    this.username = r.body.login;
    this.repo = this.username + '/' + name;
    r = await this.api('GET', '/repos/' + this.repo);
    if (r.status === 404) {
      this.log('创建仓库：' + this.repo + '（' + (privateRepo ? '私有' : '公开') + '）');
      r = await this.api('POST', '/user/repos', { name, private: privateRepo, description: 'Tampermonkey scripts (auto-uploaded)', auto_init: true });
      if (r.status !== 200 && r.status !== 201) { this.log('!! 建库失败：' + JSON.stringify(r.body).slice(0, 120)); return null; }
      await sleep(2000);
      r = await this.api('GET', '/repos/' + this.repo);
      if (r.status !== 200) { this.log('!! 建库后读取失败'); return null; }
    } else if (r.status !== 200) {
      this.log('!! 仓库查询失败（' + r.status + '）：' + JSON.stringify(r.body).slice(0, 120));
      return null;
    } else {
      this.log('仓库已存在：' + this.repo);
    }
    this.branch = (r.body && r.body.default_branch) || 'main';
    return this.repo;
  }
  async fetchTree() {
    const r = await this.api('GET', '/repos/' + this.repo + '/git/trees/' + this.branch + '?recursive=1');
    if (r.status !== 200) return false;
    this.tree = {};
    (r.body.tree || []).forEach(t => { if (t.type === 'blob') this.tree[t.path] = t.sha; });
    return true;
  }
  async verify(files) {
    if (!(await this.fetchTree())) { this.log('!! 校验：tree 获取失败'); return false; }
    let good = 0, bad = 0, missing = 0, nchunk = 0, ncok = 0, ncbad = 0;
    for (const f of files) {
      const data = new Uint8Array(await f.file.arrayBuffer());
      const rel = f.rel;
      if (this.tree[rel] !== undefined) {
        if (this.tree[rel] === gitBlobShaHex(data)) good++;
        else { bad++; this.log('SHA 不一致：' + rel); }
        continue;
      }
      if (this.tree[rel + '/meta.json'] !== undefined) {
        nchunk++;
        const parts = await packParts(data, CHUNK_SIZE);
        let ok = true;
        for (let i = 0; i < parts.length; i++) {
          const cp = rel + '/chunks/part_' + String(i).padStart(4, '0') + '.bin';
          if (this.tree[cp] === gitBlobShaHex(strToBytes(parts[i]))) ncok++;
          else { ok = false; ncbad++; this.log('分片缺失/不一致：' + cp); }
        }
        if (this.tree[rel + '/meta.json'] === undefined || this.tree[rel + '/decode.py'] === undefined) ok = false;
        this.log('分片包 ' + rel + '：' + (ok ? 'OK' : 'FAIL'));
        if (ok) good++; else bad++;
        continue;
      }
      missing++; this.log('仓库中不存在：' + rel);
    }
    this.log('校验结果：直接文件一致=' + (good - nchunk) + ' | 分片包 ' + nchunk + ' 个（分片 ' + ncok + ' 一致 / ' + ncbad + ' 坏）| 不一致=' + bad + ' 缺失=' + missing);
    return bad === 0 && missing === 0;
  }
}

// == UI ==
(function () {
  if (window.__tmUploaderLoaded) return;
  window.__tmUploaderLoaded = true;

  const css = `
    #tmul-btn { position: fixed; right: 18px; bottom: 120px; z-index: 2147483000; background: #1f6feb; color: #fff; border: none; border-radius: 8px; padding: 10px 14px; font-size: 13px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.35); font-family: -apple-system, 'Segoe UI', sans-serif; }
    #tmul-btn:hover { background: #388bfd; }
    #tmul-panel { position: fixed; right: 18px; bottom: 160px; z-index: 2147483001; width: 640px; max-height: 78vh; background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5); font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; font-size: 13px; display: none; flex-direction: column; }
    #tmul-panel.open { display: flex; }
    #tmul-head { padding: 12px 16px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; }
    #tmul-head b { font-size: 14px; color: #e6edf3; }
    #tmul-body { padding: 12px 16px; overflow-y: auto; }
    #tmul-panel label { display: block; margin: 8px 0 3px; color: #8b949e; }
    #tmul-panel input[type=text], #tmul-panel input[type=password] { width: 100%; box-sizing: border-box; background: #0d1117; border: 1px solid #30363d; color: #e6edf3; border-radius: 6px; padding: 7px 10px; font-size: 13px; }
    #tmul-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
    #tmul-panel button { background: #238636; border: none; color: #fff; border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
    #tmul-panel button:disabled { background: #21262d; color: #8b949e; cursor: not-allowed; }
    #tmul-panel button.sec { background: #21262d; border: 1px solid #30363d; }
    #tmul-panel button.warn { background: #da3633; }
    #tmul-files { margin-top: 8px; max-height: 130px; overflow-y: auto; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; background: #0d1117; display: none; font-size: 12px; }
    #tmul-log { margin-top: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; height: 220px; overflow-y: auto; font-family: Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
    #tmul-log .ok { color: #3fb950; } #tmul-log .err { color: #f85149; } #tmul-log .info { color: #79c0ff; }
  `;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  const btn = document.createElement('button');
  btn.id = 'tmul-btn';
  btn.textContent = '油猴上传';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'tmul-panel';
  panel.innerHTML = `
    <div id="tmul-head"><b>油猴脚本上传 → GitHub</b><span style="cursor:pointer;color:#8b949e;font-size:16px" id="tmul-close">✕</span></div>
    <div id="tmul-body">
      <label>GitHub Token（ghp_xxx，保存在本机浏览器）</label>
      <input type="password" id="tmul-token" placeholder="ghp_...">
      <label>仓库名</label>
      <input type="text" id="tmul-repo" placeholder="如 tampermonkey-scripts" value="">
      <div id="tmul-row">
        <label style="margin:0;display:flex;align-items:center;gap:5px"><input type="checkbox" id="tmul-private"> 私有仓库</label>
        <button class="sec" id="tmul-test">测试 Token</button>
        <button class="sec" id="tmul-pick">选择文件夹</button>
        <button id="tmul-go">开始上传</button>
        <button class="warn" id="tmul-stop" disabled>停止</button>
      </div>
      <div id="tmul-files"></div>
      <div id="tmul-log">等待操作...</div>
    </div>`;
  document.body.appendChild(panel);

  const $ = id => panel.querySelector('#' + id);
  $('tmul-close').onclick = () => panel.classList.remove('open');
  btn.onclick = () => panel.classList.toggle('open');

  $('tmul-token').value = GM_getValue('token', '');
  $('tmul-repo').value = GM_getValue('repo', 'tampermonkey-scripts');

  const logEl = $('tmul-log');
  function log(msg, cls) {
    const d = new Date();
    const line = '[' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + '] ' + msg + '\n';
    logEl.innerHTML += (cls ? '<span class="' + cls + '">' : '') + line.replace(/</g, '&lt;') + (cls ? '</span>' : '');
    logEl.scrollTop = logEl.scrollHeight;
  }

  let picked = null;
  let stopFlag = false;
  const stopped = () => stopFlag;

  $('tmul-test').onclick = async () => {
    const token = $('tmul-token').value.trim();
    if (!token) { log('先填 token', 'err'); return; }
    log('测试 token...');
    const u = new Uploader(token, log, stopped);
    const r = await u.api('GET', '/user');
    if (r.status === 200) { log('token 有效：' + r.body.login, 'ok'); GM_setValue('token', token); }
    else log('token 无效（' + r.status + '）：' + JSON.stringify(r.body).slice(0, 150), 'err');
  };

  $('tmul-pick').onclick = async () => {
    try {
      let files = [];
      if (window.showDirectoryPicker) {
        const dir = await window.showDirectoryPicker({ mode: 'read' });
        async function walk(d, prefix) {
          for await (const e of d.values()) {
            if (e.kind === 'file') files.push({ rel: prefix + e.name, file: await e.getFile() });
            else if (e.kind === 'directory' && !['node_modules', '.venv', '__pycache__', '.git'].includes(e.name)) await walk(e, prefix + e.name + '/');
          }
        }
        await walk(dir, '');
      } else {
        files = await new Promise(res => {
          const inp = document.createElement('input');
          inp.type = 'file'; inp.webkitdirectory = true; inp.style.display = 'none';
          document.body.appendChild(inp);
          inp.onchange = () => {
            const top = inp.files[0] ? inp.files[0].webkitRelativePath.split('/')[0] + '/' : '';
            res([...inp.files].map(f => ({ rel: f.webkitRelativePath.startsWith(top) ? f.webkitRelativePath.slice(top.length) : f.name, file: f })));
            inp.remove();
          };
          inp.click();
        });
      }
      picked = files;
      const fb = $('tmul-files');
      fb.style.display = 'block';
      fb.innerHTML = files.length ? files.map(f => f.rel + '（' + f.file.size + ' B）').join('\n').replace(/</g, '&lt;') : '（空文件夹）';
      log('已选 ' + files.length + ' 个文件，共 ' + files.reduce((s, f) => s + f.file.size, 0) + ' B', 'info');
    } catch (e) {
      log('选择文件夹取消/失败：' + e.message, 'err');
    }
  };

  $('tmul-go').onclick = async () => {
    const token = $('tmul-token').value.trim();
    GM_setValue('token', token);
    GM_setValue('repo', $('tmul-repo').value.trim());
    if (!token) { log('先填 token', 'err'); return; }
    if (!picked || !picked.length) { log('先选文件夹', 'err'); return; }
    const repoName = $('tmul-repo').value.trim();
    if (!repoName) { log('填仓库名', 'err'); return; }
    stopFlag = false;
    $('tmul-go').disabled = true;
    $('tmul-stop').disabled = false;
    const t0 = Date.now();
    log('=== 开始上传 ' + picked.length + ' 个文件 ===', 'info');
    try {
      const u = new Uploader(token, log, stopped);
      const repo = await u.ensureRepo(repoName, $('tmul-private').checked);
      if (!repo) { log('!! 建库/查库失败，终止', 'err'); return; }
      log('仓库：https://github.com/' + repo);
      if (!(await u.fetchTree())) { log('!! tree 获取失败', 'err'); return; }
      const files = [...picked].sort((a, b) => a.file.size - b.file.size);
      const cnt = { direct: 0, chunked: 0, skip: 0, fail: 0 };
      for (let i = 0; i < files.length; i++) {
        if (stopFlag) break;
        const r = await uploadFileFlow(u, files[i], m => log('[' + (i + 1) + '/' + files.length + '] ' + m), stopped);
        cnt[r.result] = (cnt[r.result] || 0) + 1;
      }
      log('上传完成：直传 ' + cnt.direct + '，分片 ' + cnt.chunked + '，跳过 ' + cnt.skip + '，失败 ' + cnt.fail + '（耗时 ' + Math.round((Date.now() - t0) / 1000) + 's）');
      if (cnt.fail === 0 && !stopFlag) {
        log('开始逐字节校验...', 'info');
        const ok = await u.verify(files);
        log(ok ? '最终结果：PASS - 全部文件逐字节一致' : '最终结果：FAIL - 有文件不一致，重跑即可续传', ok ? 'ok' : 'err');
      }
      log('仓库地址：https://github.com/' + u.repo, 'info');
    } catch (e) {
      log('!! 异常：' + (e && e.message || e), 'err');
    }
    $('tmul-go').disabled = false;
    $('tmul-stop').disabled = true;
  };

  $('tmul-stop').onclick = () => { stopFlag = true; log('正在停止（等当前请求结束）...', 'err'); };

  log('提示：连续 status=0 失败时，可能是 TM offscreen 文档占用，跑 repair-tm-offscreen.js 后重试。', 'info');
})();
