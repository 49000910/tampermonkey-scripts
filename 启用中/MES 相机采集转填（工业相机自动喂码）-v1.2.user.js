// ==UserScript==
// @name         MES 相机采集转填（工业相机自动喂码）
// @namespace    tm.mes.camera.feed
// @version      1.2.0
// @description  一体化相机采集：轮询本地「一体化采集」服务(127.0.0.1:8768)，工业相机识别结果（03开头模块码+SN）自动回填 MES 过站页：模块进条码采集框→查编码按框位填SN→交给现有 SN 校验/自动过站。连续作业：下一个模块来时自动清空采集框旧码并重填新码；MES 查询带 8s 超时防卡死；漏扫可人工扫码枪补扫。带相机实时画面小窗 + 网页端「拍照识别」按钮（POST /capture 触发本地拍照）。
// @match        https://w3.huawei.com/mespmm/wipweb*
// @grant        none
// ==/UserScript==

(async function () {
  'use strict';

  // ===== MES授权门禁 START =====
  async function __MES_AUTH_GATE__() {
    if (
      location.hostname === 'mes.huawei.com' &&
      location.href.indexOf('/mespmm/rptwebnew') >= 0 &&
      location.hash.indexOf('autoExtract=1') >= 0
    ) {
      return true;
    }
    var KEY = 'MES_AUTH_CENTER_STATE_V1';
    var start = Date.now();
    while (Date.now() - start < 180000) {
      try {
        var st = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (st && st.ok && Date.now() - Number(st.ts || 0) < 10000) return true;
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    return false;
  }
  if (!(await __MES_AUTH_GATE__())) {
    console.log('[相机采集转填] 未通过MES授权门禁，退出');
    return;
  }
  // ===== MES授权门禁 END =====

  var LOCAL = 'http://127.0.0.1:8768';
  var POLL_MS = 700;
  var SN_BASE = 'https://w3.huawei.com/mespmm/gateway/com.huawei.supply.mes.mesplus.pspw:mespmmpreallservice/mespmmpreallone/services/emsComponentDataInfo/find/page';
  var GATE_KEY = 'sn_code_check_gate_status';
  var POS_KEY = 'cam_feed_panel_pos_v1';

  var lastSeq = 0;
  var busy = false;
  var localOk = false;
  var liveOn = false;
  var liveTimer = null;

  // ===== 基础 =====
  function toStr(v) { return v == null ? '' : String(v).trim(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function isVisible(el) {
    if (!el) return false;
    var st = getComputedStyle(el);
    return el.offsetParent !== null && st.display !== 'none' && st.visibility !== 'hidden';
  }

  // ===== DOM（与一体化 v3.4.12 同款协议）=====
  function isLoadingVisible() {
    var el = document.querySelector('#global_toploading_flag');
    if (!el) return false;
    var st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }
  function getParentInput() {
    var all = [].slice.call(document.querySelectorAll('div[id^="Input_"] > input.hae-ui-input[type="text"],div[id^="Input_"] > input'));
    for (var i = 0; i < all.length; i++) {
      var box = all[i].closest('div[id^="Input_"]');
      var ctx = ((box && box.parentElement ? box.parentElement.innerText : '') || '').replace(/\s+/g, '');
      if (ctx.indexOf('条码采集') >= 0) return all[i];
    }
    return all[3] || null;
  }
  function allSnInputsVis() {
    var arr = [].slice.call(document.querySelectorAll('input[id^="sn-input"]'));
    var out = [];
    for (var i = 0; i < arr.length; i++) if (isVisible(arr[i])) out.push(arr[i]);
    out.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var dy = ra.top - rb.top;
      if (Math.abs(dy) > 4) return dy;
      return ra.left - rb.left;
    });
    return out;
  }
  function fillInputValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function pressEnter(el) {
    try { el.focus(); } catch (e) {}
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }
  function normGateParent(v) { return v == null ? '' : String(v).replace(/\s+/g, '').toUpperCase(); }
  function holdNormSn(v) {
    v = toStr(v).replace(/\u00A0/g, ' ').replace(/\s+/g, '').trim();
    if (v.indexOf('：') >= 0) v = v.split('：').pop();
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v.toUpperCase();
  }
  function suppressRefillActive() {
    try { return Date.now() < Number(localStorage.getItem('sn_suppress_refill_v1') || 0); } catch (e) { return false; }
  }

  // ===== 带超时的 fetch（MES 查询挂住时 8s 兜底，防单任务卡死几分钟）=====
  function fetchT(url, opts, ms) {
    ms = ms || 8000;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('fetch 超时')); }
      }, ms);
      fetch(url, opts).then(function (r) { return r.text(); }).then(function (t) {
        if (done) return;
        done = true; clearTimeout(timer);
        try { resolve(JSON.parse(t)); } catch (e) { reject(e); }
      }).catch(function (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      });
    });
  }

  // ===== 查编码（与 SN 校验 v2.7.18 同款接口/规则）=====
  function normSn(v) {
    v = toStr(v).replace(/\s+/g, '');
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v;
  }
  function isStrongCode(v) { return /^(34|45)\d{6}(-\d{3})?$/.test(toStr(v)); }
  function isWeakCode(v) { return /^\d{8}(-\d{3})?$/.test(toStr(v)); }
  function looksLikeDate8(v) { return /^20\d{6}$/.test(toStr(v)); }
  function isNineCode(v) {
    v = toStr(v).toUpperCase();
    return /^9[A-Z0-9]{7}(?:-\d{3})?$/.test(v);
  }
  function pickFirstMatchedCode(obj) {
    var strong = '', weak = '', nine = '';
    (function walk(x) {
      if (x == null) return;
      if (typeof x !== 'object') {
        var s = toStr(x).toUpperCase();
        if (!s) return;
        if (!strong && isStrongCode(s)) { strong = s; return; }
        if (!weak && isWeakCode(s) && !looksLikeDate8(s)) weak = s;
        if (!nine && isNineCode(s)) nine = s;
        return;
      }
      if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) walk(x[i]); return; }
      var keys = Object.keys(x);
      for (var k = 0; k < keys.length; k++) walk(x[keys[k]]);
    })(obj);
    return strong || weak || nine || '';
  }
  async function fetchPage(sn, pageSize, pageNo, a, b) {
    var url = SN_BASE + '/' + pageSize + '/' + pageNo + '/' + a + '/' + b;
    var body = { barCode: '', snStr: sn, itemName: '', componentType: '', createdFrom: '', createdTo: '' };
    return await fetchT(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function queryAllRows(snRaw, pageSize) {
    pageSize = pageSize || 100;
    var sn = normSn(snRaw);
    var modes = [[0, 0], [7, 0]];
    for (var i = 0; i < modes.length; i++) {
      var a = modes[i][0], b = modes[i][1];
      var page = 1, totalPages = 1, rows = [];
      do {
        var j = await fetchPage(sn, pageSize, page, a, b);
        var vo = (j && j.resultObjVO) || {};
        var pageVO = vo.pageVO || {};
        rows = rows.concat(vo.result || []);
        totalPages = Number(pageVO.totalPages || 1);
        page++;
      } while (page <= totalPages);
      if (rows.length) return { sn: sn, rows: rows, mode: a + '/' + b };
    }
    return { sn: sn, rows: [], mode: '-' };
  }
  async function queryCodeBySn_OpenApi(snRaw) {
    var sn = normSn(snRaw);
    var url = 'https://w3.huawei.com/mes/qmgateway/com.huawei.supply.mes.mesplus.qm:mesqmmitrservice/mes/mitrservice/services/openapi/getSnAttr';
    var j = await fetchT(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sn: sn }) });
    var vo = (j && j.resultObjVO) || {};
    return { sn: sn, code: toStr(vo.partNo), altCodes: [], source: 'openapi', mode: '-', rows: 0 };
  }
  async function queryCodeHybrid(snRaw) {
    var q1 = await queryAllRows(snRaw, 100);
    var code1 = pickFirstMatchedCode(q1.rows);
    if (code1) return { sn: q1.sn, code: code1, altCodes: [], source: 'ems-find', mode: q1.mode, rows: q1.rows.length };
    return queryCodeBySn_OpenApi(snRaw);
  }

  // ===== 按编码找框位（与一体化 holdFindBoxByCode 同款）=====
  function holdNormalizeCode(v) {
    v = toStr(v).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/\uFF1A/g, ':').toUpperCase();
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v.replace(/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]+[-_]/i, '');
  }
  function holdGetNearCode(inputEl) {
    var ir = inputEl.getBoundingClientRect();
    var cands = [].slice.call(document.querySelectorAll('td.grid-cell'));
    var best = null, bestScore = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var td = cands[i];
      var r = td.getBoundingClientRect();
      if (r.right > ir.left) continue;
      var dy = Math.abs((r.top + r.height / 2) - (ir.top + ir.height / 2));
      var dx = ir.left - r.right;
      if (dy > 80 || dx > 700) continue;
      var bonus = (td.className || '').indexOf('col0') >= 0 ? -20 : 0;
      var score = dy * 3 + dx + bonus;
      if (score < bestScore) { bestScore = score; best = td; }
    }
    return best ? toStr(best.innerText).trim() : '';
  }
  function holdFindBoxByCode(targets, code) {
    if (!code) return null;
    var cn = holdNormalizeCode(code);
    if (!cn) return null;
    for (var i = 0; i < targets.length; i++) {
      var gridCode = holdNormalizeCode(holdGetNearCode(targets[i]));
      if (gridCode && gridCode === cn && !toStr(targets[i].value)) return targets[i];
    }
    return null;
  }

  // ===== 面板 =====
  var panel, stEl, modEl, liveBtn, shotBtn, liveImg, dotEl;
  var shotBusy = false, shotT = 0;
  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:70px;right:18px;z-index:2147483647;width:250px;' +
      'background:#fff;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);' +
      'font:12px/1.6 "Microsoft YaHei",sans-serif;color:#333;user-select:none;';
    panel.innerHTML =
      '<div style="padding:6px 10px;background:#f5f7fa;border-bottom:1px solid #eee;border-radius:8px 8px 0 0;' +
      'display:flex;align-items:center;cursor:move;">' +
      '<span id="camfeed-dot" style="width:8px;height:8px;border-radius:50%;background:#fa8c16;margin-right:6px;"></span>' +
      '<b style="flex:1">相机采集转填</b>' +
      '<span id="camfeed-min" style="cursor:pointer;padding:0 6px;color:#999;">—</span>' +
      '</div>' +
      '<div style="padding:8px 10px;" id="camfeed-body">' +
      '<div id="camfeed-status" style="min-height:18px;">连接本地服务…</div>' +
      '<div id="camfeed-mod" style="font-weight:bold;color:#cf1322;"></div>' +
      '<div style="margin-top:6px;display:flex;gap:6px;">' +
      '<button id="camfeed-shot" style="flex:2;padding:5px 0;cursor:pointer;background:#1677ff;color:#fff;border:none;border-radius:4px;font-weight:bold;font-size:13px;">拍照识别</button>' +
      '<button id="camfeed-live" style="flex:1;padding:2px 0;cursor:pointer;">实时画面</button>' +
      '</div>' +
      '<img id="camfeed-img" style="display:none;width:100%;border-radius:4px;margin-top:6px;" />' +
      '</div>';
    document.body.appendChild(panel);
    dotEl = panel.querySelector('#camfeed-dot');
    stEl = panel.querySelector('#camfeed-status');
    modEl = panel.querySelector('#camfeed-mod');
    shotBtn = panel.querySelector('#camfeed-shot');
    liveBtn = panel.querySelector('#camfeed-live');
    liveImg = panel.querySelector('#camfeed-img');
    var minBtn = panel.querySelector('#camfeed-min');

    // 拖拽
    var head = panel.children[0];
    head.addEventListener('mousedown', function (e) {
      if (e.target === minBtn) return;
      var sx = e.clientX - panel.offsetLeft, sy = e.clientY - panel.offsetTop;
      function mv(ev) {
        panel.style.left = (ev.clientX - sx) + 'px';
        panel.style.top = (ev.clientY - sy) + 'px';
        panel.style.right = 'auto';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ l: panel.offsetLeft, t: panel.offsetTop }));
        } catch (e2) {}
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    minBtn.addEventListener('click', function () {
      var b = panel.querySelector('#camfeed-body');
      var hidden = b.style.display === 'none';
      b.style.display = hidden ? '' : 'none';
      minBtn.textContent = hidden ? '—' : '+';
    });
    liveBtn.addEventListener('click', toggleLive);
    shotBtn.addEventListener('click', doCapture);
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && typeof p.l === 'number') {
        panel.style.left = p.l + 'px'; panel.style.top = p.t + 'px'; panel.style.right = 'auto';
      }
    } catch (e) {}
  }
  function setStatus(msg, color) {
    if (!stEl) return;
    stEl.textContent = msg;
    stEl.style.color = color || '#333';
  }
  function setDot(color) { if (dotEl) dotEl.style.background = color; }

  function toggleLive() {
    liveOn = !liveOn;
    if (liveOn) {
      liveImg.style.display = '';
      liveBtn.textContent = '关闭画面';
      liveTick();
      liveTimer = setInterval(liveTick, 300);
    } else {
      liveImg.style.display = 'none';
      liveBtn.textContent = '实时画面';
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    }
  }
  function liveTick() {
    if (!liveOn) return;
    liveImg.src = LOCAL + '/frame?ts=' + Date.now();
  }

  // ===== 拍照 =====
  function setShotBusy(b) {
    shotBusy = b;
    if (shotBtn) {
      shotBtn.disabled = b;
      shotBtn.style.background = b ? '#bfbfbf' : '#1677ff';
      shotBtn.textContent = b ? '识别中…' : '拍照识别';
    }
  }
  async function doCapture() {
    if (shotBusy) return;
    if (!localOk) { setStatus('本地服务未连接，先启动本地程序', '#cf1322'); return; }
    setShotBusy(true);
    shotT = Date.now();
    setStatus('已发拍照指令，等识别…', '#1677ff');
    try {
      var r = await fetch(LOCAL + '/capture', { method: 'POST' });
      var j = await r.json();
      if (!j || j.ok !== true) throw new Error('bad resp');
      if (!j['已触发']) {
        setStatus('相机未开或正忙（先在本地窗口打开相机）', '#fa8c16');
        setShotBusy(false);
      }
    } catch (e) {
      setStatus('拍照指令失败：' + e.message, '#cf1322');
      setShotBusy(false);
    }
    // 识别结果由轮询 /jobs 拿到后 processJob 处理；30s 安全兜底复位
  }

  // ===== 本地服务 =====
  async function pollOnce() {
    // 拍照按钮安全兜底：30s 没处理完就复位，防卡死
    if (shotBusy && Date.now() - shotT > 30000) {
      setShotBusy(false);
      if (localOk && !busy) setStatus('等待相机拍照…', '#389e0d');
    }
    try {
      var r = await fetch(LOCAL + '/jobs?after=' + lastSeq, { method: 'GET' });
      var j = await r.json();
      if (!j || j.ok !== true) throw new Error('bad resp');
      if (!localOk) { localOk = true; setDot('#52c41a'); if (!busy) setStatus('等待相机拍照…', '#389e0d'); }
      // 注意：lastSeq 不在这里跳到 j.seq——只在前面的 job 真正 ack 后才前进，
      // 否则本地正忙跳过某个 job 时，该 job 会被 lastSeq 越过而永远丢失（连续拍照会丢任务）
      if (j.jobs && j.jobs.length) {
        for (var i = 0; i < j.jobs.length; i++) {
          (function (job) { handleJob(job); })(j.jobs[i]);
        }
      }
    } catch (e) {
      if (localOk) { localOk = false; setDot('#cf1322'); if (!busy) setStatus('本地服务断开', '#cf1322'); }
    }
  }

  async function ackJob(seq) {
    try {
      var r = await fetch(LOCAL + '/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seq: seq }) });
      var j = await r.json();
      if (j && j.ok) lastSeq = Math.max(lastSeq, seq); // ack 成功才前进游标
    } catch (e) {}
  }

  // ===== 任务处理：模块回填 + SN 按编码转填 =====
  function onTrackPage() { return location.href.indexOf('#/ProductTrackInOut') >= 0; }
  function bulkPassing() {
    try { return localStorage.getItem('tm_bulk_passing') === '1'; } catch (e) { return false; }
  }

  function handleJob(job) {
    if (busy) return; // 一个没处理完不接下一个（本地会保留任务，下轮再拉）
    busy = true;
    setDot('#1677ff');
    processJob(job).catch(function (e) {
      setStatus('处理异常：' + e.message, '#cf1322');
      setDot('#cf1322');
    }).then(function () {
      busy = false;
      setShotBusy(false);
      setDot(localOk ? '#52c41a' : '#cf1322');
      if (localOk) setStatus('等待相机拍照…', '#389e0d');
    });
  }

  // 等上一模块校验收尾（最多 ms）：全过/有异常都算收尾，仍 pending 才继续等
  async function waitGateSettle(mod, ms) {
    var t = Date.now();
    while (Date.now() - t < ms) {
      var settled = true;
      try {
        var raw = localStorage.getItem(GATE_KEY);
        if (raw) {
          var g = JSON.parse(raw);
          if (g && Date.now() - g.ts < 120000 && normGateParent(g.parentSn) === normGateParent(mod)) {
            if (!g.allOk && g.pending > 0) settled = false; // 还在校验中
          }
        }
      } catch (e) {}
      if (settled) return;
      await sleep(400);
    }
  }

  // 清空采集框旧模块码 + 旧 SN 框（对齐一体化 v3.4.3 连续取出模式：清框→立即重载新模块，
  // 靠 processJob 的 ②等loading 区分新旧网格，不在此空框回车/等网格消失，避免触发 MES 迟到重写）
  function clearCollectionBox() {
    var stale = allSnInputsVis().filter(function (el) { return toStr(el.value); });
    for (var s = 0; s < stale.length; s++) fillInputValue(stale[s], '');
    var p = getParentInput();
    if (p) fillInputValue(p, '');
  }

  async function processJob(job) {
    var module = toStr(job.module).toUpperCase();
    var sns = (job.sns || []).map(function (s) { return toStr(s).toUpperCase(); }).filter(Boolean);
    modEl.textContent = module ? ('模块 ' + module + ' · ' + sns.length + ' SN') : ('任务#' + job.seq + ' 无模块码');
    var tStart = Date.now();

    if (!onTrackPage()) { setStatus('请在过站页（#/ProductTrackInOut）操作', '#fa8c16'); return; }
    if (bulkPassing()) { setStatus('一体化批量队列运行中，本任务跳过', '#fa8c16'); await ackJob(job.seq); return; }
    if (!module) { setStatus('任务#' + job.seq + '：无 03 开头模块码，跳过', '#fa8c16'); await ackJob(job.seq); return; }
    if (module.length !== 16) { setStatus('模块码 ' + module + ' 不是16位，跳过', '#cf1322'); await ackJob(job.seq); return; }

    var parent = getParentInput();
    if (!parent) { setStatus('未找到条码采集框', '#cf1322'); return; } // 不 ack，等页面就绪

    // === 采集框状态：旧模块(清空复位再加载) / 同模块(补填) / 空(直接加载) ===
    var curMod = toStr(parent.value).replace(/\s+/g, '').toUpperCase();
    var sameModule = (curMod === module);
    if (curMod && !sameModule) {
      setStatus('采集框是旧模块 ' + curMod.slice(0, 6) + '…，等校验收尾…', '#fa8c16');
      await waitGateSettle(curMod, 12000);
      setStatus('清空旧模块，重进新模块…', '#fa8c16');
      clearCollectionBox();
      parent = getParentInput();
      if (!parent) { setStatus('复位后未找到条码采集框', '#cf1322'); await ackJob(job.seq); return; }
    }

    // 清残留 SN（仅新模块时清；同模块补填保留已填的 SN）+ 抑制窗（防 SN 校验脚本转填干扰）
    if (!sameModule) {
      var stale = allSnInputsVis().filter(function (el) { return toStr(el.value); });
      for (var s = 0; s < stale.length; s++) fillInputValue(stale[s], '');
    }
    try { localStorage.setItem('sn_suppress_refill_v1', String(Date.now() + 5000)); } catch (e) {}

    // 决定要不要（重新）进模块：非同模块要进；同模块但网格没在也要重进
    var doLoad = !sameModule;
    if (!doLoad) {
      var tg = Date.now();
      while (Date.now() - tg < 3000 && !allSnInputsVis().length) await sleep(200);
      if (!allSnInputsVis().length) { doLoad = true; setStatus('同模块无网格，重进模块', '#fa8c16'); }
    }

    if (doLoad) {
      // ① 模块进采集框
      setStatus('① 回填模块 ' + module, '#1677ff');
      fillInputValue(parent, module);
      await sleep(60);
      pressEnter(parent);

      // ② 等 MES 受理（loading 出现又消失）
      setStatus('② 等 MES 受理模块…', '#1677ff');
      var sawLoad = false, loadGone = 0, tL = Date.now();
      while (Date.now() - tL < 15000) {
        if (isLoadingVisible()) { sawLoad = true; loadGone = 0; }
        else if (sawLoad) { loadGone++; if (loadGone >= 2) break; }
        await sleep(150);
      }
      if (!sawLoad) { setStatus('✗ 模块回车后无 loading（MES 未受理），请人工检查', '#cf1322'); await ackJob(job.seq); return; }
      await sleep(400);

      // ③ 等 SN 网格
      setStatus('③ 等 SN 网格出现…', '#1677ff');
      var t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        if (allSnInputsVis().length >= 1) break;
        await sleep(300);
      }
    } else {
      setStatus('同模块，补填 SN…', '#1677ff');
    }

    var targets = allSnInputsVis();
    if (!targets.length) { setStatus('✗ SN 网格未出现，请人工检查', '#cf1322'); await ackJob(job.seq); return; }

    // ④ 逐个 SN 查编码 → 找框 → 回填
    var filled = 0, skipped = [];
    for (var i = 0; i < sns.length; i++) {
      var sn = sns[i];
      // 已在框里？
      var hit = null;
      for (var b = 0; b < targets.length; b++) {
        if (holdNormSn(targets[b].value) === holdNormSn(sn)) { hit = targets[b]; break; }
      }
      if (hit) { filled++; continue; }
      var code = '';
      try { var q = await queryCodeHybrid(sn); code = q.code || ''; if (!code && q.altCodes && q.altCodes.length) code = q.altCodes[0]; } catch (e) {}
      var box = code ? holdFindBoxByCode(targets, code) : null;
      if (!box) { skipped.push(sn); continue; }
      var curV = toStr(box.value);
      if (curV) { fillInputValue(box, ''); await sleep(30); }
      fillInputValue(box, sn);
      await sleep(20);
      pressEnter(box);
      filled++;
      setStatus('④ 填 SN ' + (i + 1) + '/' + sns.length + '  ' + sn, '#1677ff');
      if (Date.now() - tStart > 180000) { setStatus('⚠ 处理超时，先提交已填部分，剩余请补扫', '#fa8c16'); break; }
      await sleep(120);
    }

    await ackJob(job.seq);
    if (skipped.length) {
      setStatus('已填 ' + filled + '/' + sns.length + '，漏 ' + skipped.length + ' 个可手工补扫：' + skipped.join(' '), '#fa8c16');
    } else {
      setStatus('✓ 全部填入 ' + filled + ' 个，等待校验/过站…', '#389e0d');
    }
    watchGate(module);
  }

  // 后台盯校验状态（只提示，不干预——推进交给一体化/SN校验原有逻辑）
  var gateWatched = {};
  async function watchGate(module) {
    if (gateWatched[module]) return;
    gateWatched[module] = true;
    var t = Date.now();
    while (Date.now() - t < 90000) {
      await sleep(1500);
      if (busy) continue;
      try {
        var raw = localStorage.getItem(GATE_KEY);
        if (!raw) continue;
        var g = JSON.parse(raw);
        if (!g || Date.now() - g.ts > 120000) continue;
        if (normGateParent(g.parentSn) !== normGateParent(module)) continue;
        if (g.allOk) { setStatus('✓ ' + module + ' 校验全过 ' + g.ok + '/' + g.total + '，交一体化自动过站', '#389e0d'); return; }
        var msg = (g.pending > 0 ? '校验中' + g.pending : '') + (g.bad > 0 ? ' 异常' + g.bad : '') + (g.filled < g.total ? ' 未填全' + g.filled + '/' + g.total : '');
        if (msg) setStatus(module + '：' + msg, '#fa8c16');
      } catch (e) {}
    }
    delete gateWatched[module];
  }

  // ===== 启动 =====
  try {
    buildPanel();
    pollOnce();
    setInterval(pollOnce, POLL_MS);
    console.log('[相机采集转填] 已启动，轮询 ' + LOCAL);
  } catch (e) {
    console.error('[相机采集转填] 启动失败', e);
  }
})();
