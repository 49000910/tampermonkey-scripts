// ==UserScript==
// @name         MES 暂存过站（调试）
// @namespace    tm.mes.hold.pass.debug
// @version      0.3
// @description  独立调试面板：提前扫完的模块+SN 暂存（不过站），到点"取出"自动回填模块和SN，交现有自动过站/手动过站。v0.2 暂存模式开关（mes_pass_hold_mode 心跳，开=一体化只校验不点过站）+清空本页框。v0.3 ①暂存存纯SN（剥系统加的前缀如 VOA1:/U1:，取出回填不再被二次加前缀）②暂存模式下校验全过自动暂存+自动清空+焦点回条码采集框（校验+ATE 模式额外等 ATE 通过，与一体化同一接口/命中规则）③"清空"改名"清空暂存区"。独立 localStorage（mes_pass_hold_v1 / hpd_hold_mode_pref / hpd_panel_pos）。
// @match        https://w3.huawei.com/mespmm/wipweb*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(async function () {
  'use strict';

  // ===== MES 授权门禁（与其他 wipweb 脚本一致，10 秒窗）=====
  async function __MES_AUTH_GATE__() {
    var KEY = 'MES_AUTH_CENTER_STATE_V1';
    var start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        var st = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (st && st.ok && Date.now() - Number(st.ts || 0) < 10000) {
          console.log('[暂存调试] 已授权：', st.jobNumber);
          return true;
        }
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    console.warn('[暂存调试] 未授权，脚本停止');
    return false;
  }
  if (!(await __MES_AUTH_GATE__())) return;
  // ===== 门禁 END =====

  var HOLD_KEY = 'mes_pass_hold_v1';
  var HOLD_MODE_KEY = 'mes_pass_hold_mode';
  var MODE_PREF_KEY = 'hpd_hold_mode_pref';
  var GATE_KEY = 'sn_code_check_gate_status';
  var CLEAN_KEY = 'sn_code_left_clean_rules_v1';
  var POS_KEY = 'hpd_panel_pos';
  var SN_SELECTOR = 'input[id^="sn-input"]';

  var busy = false;
  var holdModeOn = false;
  var panelEl = null, liveEl = null, listEl = null, statusEl = null, countEl = null, modeCb = null;

  function toStr(v) { return v == null ? '' : String(v).trim(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function normClean(v) {
    return toStr(v).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/：/g, ':').toUpperCase();
  }
  function normalizeSn(v) {
    v = toStr(v).replace(/\u00A0/g, ' ').replace(/\s+/g, '').trim();
    if (v.indexOf('：') >= 0) v = v.split('：').pop();
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v.toUpperCase();
  }

  // ===== 左侧编码（与校验脚本同一套：最近左侧单元格 + 自定义清洗规则）=====
  function loadLeftCleanRules() {
    try {
      var arr = JSON.parse(localStorage.getItem(CLEAN_KEY) || '[]');
      if (Array.isArray(arr)) {
        var out = [];
        arr.forEach(function (x) {
          x = toStr(x).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/：/g, ':').replace(/－/g, '-');
          if (x && out.indexOf(x) < 0) out.push(x);
        });
        return out;
      }
    } catch (e) {}
    return [];
  }

  function cleanLeftByRules(seg) {
    var s = toStr(seg).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/：/g, ':').replace(/－/g, '-');
    if (!s) return '';
    var rules = loadLeftCleanRules();
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r) continue;
      if (r === ':') { var p = s.indexOf(':'); if (p >= 0) s = s.slice(p + 1); continue; }
      if (r === '-') { var p2 = s.indexOf('-'); if (p2 >= 0) s = s.slice(p2 + 1); continue; }
      if (s.toUpperCase().indexOf(r.toUpperCase()) === 0) s = s.slice(r.length);
    }
    return s;
  }

  function extractLeftCodeSmart(text) {
    text = toStr(text).replace(/\u00A0/g, ' ').replace(/：/g, ':');
    var parts = text.split(/\s+/).filter(Boolean);
    var last = '';
    for (var i = 0; i < parts.length; i++) {
      var seg = cleanLeftByRules(parts[i]);
      if (seg.indexOf(':') >= 0) seg = seg.split(':').pop();
      seg = seg.replace(/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]+[-_]/i, '');
      seg = normClean(seg);
      if (seg) last = seg;
    }
    return last || normClean(cleanLeftByRules(text));
  }

  function nearestLeftCodeCell(inputEl) {
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
    return best;
  }

  function leftCodeOf(el) {
    var td = nearestLeftCodeCell(el);
    return extractLeftCodeSmart(td ? toStr(td.innerText) : '');
  }

  // ===== 页面元素（与一体化/校验脚本同一套选择器）=====
  function getParentInput() {
    var all = [].slice.call(document.querySelectorAll('div[id^="Input_"] > input.hae-ui-input[type="text"],div[id^="Input_"] > input'));
    for (var i = 0; i < all.length; i++) {
      var box = all[i].closest('div[id^="Input_"]');
      var ctx = ((box && box.parentElement ? box.parentElement.innerText : '') || '').replace(/\s+/g, '');
      if (ctx.indexOf('条码采集') >= 0) return all[i];
    }
    return all[3] || null;
  }

  function allSnInputs() {
    var arr = [].slice.call(document.querySelectorAll(SN_SELECTOR));
    arr.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var dy = ra.top - rb.top;
      if (Math.abs(dy) > 4) return dy;
      return ra.left - rb.left;
    });
    return arr;
  }

  function isVisible(el) {
    if (!el || !document.body.contains(el)) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function onTrackPage() { return location.hash.indexOf('ProductTrackInOut') >= 0; }

  // ===== 暂存区存储 =====
  function loadHold() {
    try { return JSON.parse(localStorage.getItem(HOLD_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveHold(h) {
    try { localStorage.setItem(HOLD_KEY, JSON.stringify(h)); } catch (e) {}
  }

  function readGate() {
    try {
      var g = JSON.parse(localStorage.getItem(GATE_KEY) || 'null');
      if (!g || !g.ts) return null;
      if (Date.now() - g.ts > 120000) return null;
      return g;
    } catch (e) { return null; }
  }

  function setStatus(msg, color) {
    if (statusEl) { statusEl.textContent = msg || '待命'; statusEl.style.color = color || '#475465'; }
    console.log('[暂存调试]', msg);
  }

  // ===== v0.2 暂存模式（写心跳给一体化读；30s 无刷新自动失效，脚本挂了也不会锁死自动过站）=====
  function writeHoldMode(on) {
    try { localStorage.setItem(HOLD_MODE_KEY, JSON.stringify({ on: !!on, ts: Date.now() })); } catch (e) {}
  }
  function setHoldMode(on, silent) {
    holdModeOn = !!on;
    try { localStorage.setItem(MODE_PREF_KEY, holdModeOn ? 'on' : 'off'); } catch (e) {}
    writeHoldMode(holdModeOn);
    if (modeCb) modeCb.checked = holdModeOn;
    if (panelEl) {
      panelEl.style.borderColor = holdModeOn ? '#722ed1' : '#e4e7ec';
      panelEl.style.boxShadow = holdModeOn ? '0 8px 24px rgba(114,46,209,.28)' : '0 8px 24px rgba(16,24,40,.18)';
    }
    if (!silent) setStatus(holdModeOn ? '暂存模式已开：校验全过→自动暂存+清空+回采集框（按钮仅手动兜底）' : '暂存模式已关：恢复自动过站', holdModeOn ? '#722ed1' : '#475465');
  }
  function refreshHoldModeHeartbeat() {
    if (holdModeOn) writeHoldMode(true);
  }
  // 清空本页 模块+SN 框（等效手动全选删除；MES 网格随下次扫码重建）+ 焦点回条码采集框
  function clearBoxesDo() {
    var cleared = 0;
    var parent = getParentInput();
    if (parent && toStr(parent.value)) { setNativeValue(parent, ''); cleared++; }
    var els = allSnInputs().filter(isVisible);
    for (var i = 0; i < els.length; i++) {
      if (toStr(els[i].value)) { setNativeValue(els[i], ''); cleared++; }
    }
    if (parent) { try { parent.focus(); } catch (e) {} }
    return cleared;
  }

  try { holdModeOn = localStorage.getItem(MODE_PREF_KEY) === 'on'; } catch (e) {}
  if (holdModeOn) writeHoldMode(true);

  // ===== v0.3 ATE 查询（与一体化同一接口/命中规则；"校验+ATE"模式自动暂存前等 ATE）=====
  var ATE_URL = 'https://w3.huawei.com/mespmm/gateway/S007307:mespmmrptservice/mespmm/rpt/services/wipAteFacade/selectPrintAteTestResultList/page/10/1/1/0';
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtAteDate(d, endOfDay) {
    return [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join('-') + (endOfDay ? ' 23:59:59' : ' 00:00:00');
  }
  function ateHitRule(row, sn) {
    if (!row) return false;
    var barCode = toStr(row.barCode);
    if (barCode && barCode !== sn) return false;
    return toStr(row.testResult) === '0' ||
      toStr(row.orgTestResult) === '0' ||
      toStr(row.mesTestResult).toUpperCase() === 'Y' ||
      toStr(row.failDesc).indexOf('成功') >= 0;
  }
  async function queryAteHit(sn) {
    try {
      var end = new Date();
      var start = new Date(end.getTime() - 180 * 24 * 3600 * 1000);
      var body = { siteId: '50', workProcess: null, workSite: null, barCode: sn, testResult: null, tpsName: null, equipmentSn: null, createdFrom: fmtAteDate(start, false), createdTo: fmtAteDate(end, true) };
      var r = await fetch(ATE_URL, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) return { hit: false, err: 'HTTP ' + r.status };
      var j = null;
      try { j = await r.json(); } catch (e) {}
      var rows = (j && j.resultObjVO && Array.isArray(j.resultObjVO.result)) ? j.resultObjVO.result : [];
      return { hit: rows.some(function (row) { return ateHitRule(row, sn); }) };
    } catch (e) {
      return { hit: false, err: e.message };
    }
  }
  // 一体化面板的过站模式：只校验（tm-pass-mode-bom-only 勾中）→ 不等 ATE；否则=校验+ATE
  function passModeNeedsAte() {
    var el = document.getElementById('tm-pass-mode-bom-only');
    return !(el && el.checked);
  }

  // ===== 暂存当前模块（v0.3：存纯 SN=剥系统加的前缀 VOA1:/U1: 等，取出回填不再被二次加前缀）=====
  function saveCurrentModule() {
    var g = readGate();
    var parent = getParentInput();
    var mod = parent ? toStr(parent.value) : '';
    if (!mod) return { ok: false, msg: '未识别模块码（条码采集框为空）' };
    if (!g) return { ok: false, msg: 'BOM 校验状态缺失/过期（校验脚本 1 秒刷新一次，稍等再试）' };
    if (g.parentSn && normalizeSn(g.parentSn) !== normalizeSn(mod)) return { ok: false, msg: '门禁父项与采集框不一致：' + g.parentSn };
    if (!g.allOk) return { ok: false, msg: 'BOM 未全部通过（' + g.filled + '/' + g.total + '，bad=' + g.bad + ' pend=' + g.pending + ' dup=' + g.duplicate + '）' };
    var els = allSnInputs().filter(isVisible);
    var items = [];
    for (var i = 0; i < els.length; i++) {
      var v = toStr(els[i].value);
      if (!v) continue;
      items.push({ sn: normalizeSn(v), boxId: els[i].id || '', leftCode: leftCodeOf(els[i]) });
    }
    if (!items.length) return { ok: false, msg: '没扫到任何 SN' };
    var h = loadHold();
    var key = normalizeSn(mod);
    if (h[key]) return { ok: false, msg: '该模块已在暂存区' };
    h[key] = { module: mod, holdTs: Date.now(), count: items.length, total: els.length, items: items };
    saveHold(h);
    renderList();
    return { ok: true, mod: mod, count: items.length, total: els.length };
  }

  function holdCurrent(auto) {
    if (busy) { setStatus('正在取出中，请稍候', '#fa8c16'); return; }
    if (!onTrackPage()) { setStatus('不在过站页', '#cf1322'); return; }
    if (!auto && !holdModeOn) setStatus('提示：先打开"暂存模式"，否则一体化校验完就自动过站，来不及暂存', '#fa8c16');
    var res = saveCurrentModule();
    if (!res.ok) { setStatus(res.msg, '#fa8c16'); return; }
    clearBoxesDo();
    setStatus('✓ 已暂存 ' + res.mod + '（' + res.count + '/' + res.total + ' SN，纯码）+ 已清空，扫下个模块', '#389e0d');
  }

  // ===== v0.3 自动暂存（暂存模式：BOM 全过 +（校验+ATE 模式再等 ATE 过）→ 自动暂存+清空+焦点回采集框，连续扫下一个）=====
  var autoHoldBusy = false;
  function autoHoldTick() {
    if (autoHoldBusy || busy) return;
    if (!onTrackPage()) return;
    var parent = getParentInput();
    var mod = parent ? toStr(parent.value) : '';
    if (!mod) return;
    if (loadHold()[normalizeSn(mod)]) return;
    var g = readGate();
    if (!g || !g.allOk) return;
    if (g.parentSn && normalizeSn(g.parentSn) !== normalizeSn(mod)) return;

    if (passModeNeedsAte()) {
      autoHoldBusy = true;
      (async function () {
        try {
          var r = await queryAteHit(mod);
          if (r.hit) {
            var res = saveCurrentModule();
            if (res.ok) { clearBoxesDo(); setStatus('✓ [校验+ATE] 自动暂存 ' + res.mod + '（' + res.count + ' SN）+ 已清空，扫下个模块', '#389e0d'); }
            else setStatus('自动暂存未成：' + res.msg, '#cf1322');
          } else {
            setStatus(r.err ? 'ATE 查询异常，继续等：' + r.err : 'ATE 未通过/未出结果，继续等（未暂存）', '#fa8c16');
          }
        } finally { autoHoldBusy = false; }
      })();
      return;
    }
    var res2 = saveCurrentModule();
    if (res2.ok) { clearBoxesDo(); setStatus('✓ [只校验] 自动暂存 ' + res2.mod + '（' + res2.count + ' SN）+ 已清空，扫下个模块', '#389e0d'); }
  }

  // ===== 回填提交（与一体化 submitOne / 校验脚本提交同一套事件）=====
  function setNativeValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function commitEnter(el) {
    try { el.focus(); } catch (e) {}
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ===== 取出过站（回填模块+SN，过站交给现有自动过站/手动）=====
  async function releaseOne(key) {
    if (busy) return;
    var h = loadHold();
    var entry = h[key];
    if (!entry) { setStatus('暂存区没有该模块', '#cf1322'); return; }
    if (!onTrackPage()) { setStatus('不在过站页（#/ProductTrackInOut）', '#cf1322'); return; }
    if (holdModeOn) { setStatus('暂存模式还开着，先关掉再取出（否则回填后不会自动过站）', '#cf1322'); return; }
    var parent = getParentInput();
    if (!parent) { setStatus('未找到条码采集框', '#cf1322'); return; }
    if (toStr(parent.value)) { setStatus('条码采集框未清空，不能取出', '#cf1322'); return; }
    var preFilled = allSnInputs().some(function (el) { return isVisible(el) && toStr(el.value); });
    if (preFilled) { setStatus('页面 SN 框未清空，不能取出', '#cf1322'); return; }

    busy = true;
    try {
      setStatus('① 回填模块 ' + entry.module, '#1677ff');
      setNativeValue(parent, entry.module);
      await sleep(60);
      commitEnter(parent);
      await sleep(500);

      setStatus('② 等待网格渲染…', '#1677ff');
      var gridOk = false;
      var t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        var boxes0 = allSnInputs().filter(isVisible);
        if (boxes0.length >= entry.count) { gridOk = true; break; }
        await sleep(300);
      }
      if (!gridOk) {
        setStatus('✗ 模块回填后网格未出来（MES 可能拒收：已过站/已采集？），暂存保留，请手动处理', '#cf1322');
        return;
      }
      await sleep(300);

      for (var i = 0; i < entry.items.length; i++) {
        if (!onTrackPage()) { setStatus('✗ 页面离开了过站页，取出中止（暂存保留）', '#cf1322'); return; }
        var item = entry.items[i];
        var boxes = allSnInputs().filter(isVisible);
        var target = null;
        if (item.boxId) {
          for (var b = 0; b < boxes.length; b++) {
            if (boxes[b].id === item.boxId && !toStr(boxes[b].value)) { target = boxes[b]; break; }
          }
        }
        if (!target && item.leftCode) {
          for (var c = 0; c < boxes.length; c++) {
            if (toStr(boxes[c].value)) continue;
            if (normClean(leftCodeOf(boxes[c])) === normClean(item.leftCode)) { target = boxes[c]; break; }
          }
        }
        if (!target) {
          setStatus('✗ SN[' + (i + 1) + '] ' + item.sn + ' 未找到对应空框，中止（暂存保留）', '#cf1322');
          return;
        }
        setNativeValue(target, item.sn);
        await sleep(20);
        commitEnter(target);
        setStatus('③ 回填 SN ' + (i + 1) + '/' + entry.items.length + '  ' + item.sn, '#1677ff');
        await sleep(150);
      }

      setStatus('④ 回填完成，等待过站（自动过站或手动点过站按钮）…', '#fa8c16');
      var t1 = Date.now();
      var passed = false;
      while (Date.now() - t1 < 600000) {
        if (!onTrackPage()) { setStatus('✗ 离开过站页，停止等待（暂存保留）', '#cf1322'); return; }
        var p2 = getParentInput();
        var pv = p2 ? toStr(p2.value) : '';
        var snLeft = allSnInputs().some(function (el) { return isVisible(el) && toStr(el.value); });
        if (!pv && !snLeft) { passed = true; break; }
        await sleep(1000);
      }
      if (passed) {
        var h2 = loadHold();
        delete h2[key];
        saveHold(h2);
        renderList();
        setStatus('✓ 已过站，' + entry.module + ' 移出暂存区', '#389e0d');
      } else {
        setStatus('等待过站超时（10 分钟），暂存保留，请手动检查', '#cf1322');
      }
    } finally {
      busy = false;
    }
  }

  function releaseAll() {
    if (busy) { setStatus('正在取出中，请稍候', '#fa8c16'); return; }
    var keys = Object.keys(loadHold()).sort(function (a, b) {
      return (loadHold()[a].holdTs || 0) - (loadHold()[b].holdTs || 0);
    });
    if (!keys.length) { setStatus('暂存区为空', '#fa8c16'); return; }
    (async function () {
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!loadHold()[k]) continue;
        await releaseOne(k);
        if (loadHold()[k]) {
          setStatus('第 ' + (i + 1) + ' 条未完成，停止"全部取出"（后续保留）', '#cf1322');
          break;
        }
      }
    })();
  }

  function deleteEntry(key) {
    var h = loadHold();
    var e = h[key];
    if (!e) return;
    if (!confirm('删除暂存的 ' + e.module + '？（不执行过站）')) return;
    delete h[key];
    saveHold(h);
    renderList();
    setStatus('已删除 ' + e.module, '#fa8c16');
  }

  // ===== 面板 =====
  function renderList() {
    if (!listEl) return;
    var h = loadHold();
    var keys = Object.keys(h).sort(function (a, b) { return (h[a].holdTs || 0) - (h[b].holdTs || 0); });
    if (countEl) countEl.textContent = keys.length;
    listEl.innerHTML = '';
    if (!keys.length) {
      listEl.innerHTML = '<div style="padding:8px;color:#98a2b3">（空）</div>';
      return;
    }
    keys.forEach(function (k) {
      var e = h[k];
      var d = new Date(e.holdTs);
      var tstr = ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
        ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid #eef0f3';
      var info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      info.innerHTML =
        '<div style="font-family:Consolas,monospace;font-weight:700;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + e.module + '">' + e.module + '</div>' +
        '<div style="color:#98a2b3;font-size:10.5px">' + e.count + ' SN · ' + tstr + '</div>';
      var b1 = document.createElement('button');
      b1.textContent = '取出';
      b1.style.cssText = 'border:1px solid #0958d9;color:#0958d9;background:#fff;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:11px';
      b1.onclick = function () { releaseOne(k); };
      var b2 = document.createElement('button');
      b2.textContent = '删';
      b2.style.cssText = 'border:1px solid #d0d5dd;color:#cf1322;background:#fff;border-radius:5px;padding:2px 6px;cursor:pointer;font-size:11px';
      b2.onclick = function () { deleteEntry(k); };
      row.appendChild(info);
      row.appendChild(b1);
      row.appendChild(b2);
      listEl.appendChild(row);
    });
  }

  function updateLive() {
    if (!liveEl) return;
    var g = readGate();
    var parent = getParentInput();
    var mod = parent ? toStr(parent.value) : '';
    var els = allSnInputs().filter(isVisible);
    var filled = 0;
    for (var i = 0; i < els.length; i++) if (toStr(els[i].value)) filled++;
    var held = loadHold()[normalizeSn(mod)] ? ' <span style="color:#0958d9">（已暂存）</span>' : '';
    var gateHtml;
    if (!g) gateHtml = '<span style="color:#98a2b3">无/过期</span>';
    else if (g.allOk) gateHtml = '<span style="color:#389e0d">✓ 全过 ' + g.ok + '/' + g.total + '</span>';
    else gateHtml = '<span style="color:#fa8c16">未过 ' + g.filled + '/' + g.total + '（bad' + g.bad + '/pend' + g.pending + '/dup' + g.duplicate + '）</span>';
    liveEl.innerHTML =
      '模块: <span style="font-family:Consolas,monospace;font-weight:700">' + (mod || '(空)') + '</span>' + held +
      '<br>SN: ' + filled + '/' + els.length +
      ' · 门禁: ' + gateHtml;
  }

  function buildPanel() {
    if (document.getElementById('hpd-panel')) return;

    var p = document.createElement('div');
    p.id = 'hpd-panel';
    p.style.cssText = 'position:fixed;left:16px;top:96px;z-index:2147483643;width:300px;background:#fff;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 8px 24px rgba(16,24,40,.18);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;color:#1d2939;overflow:hidden;display:none';
    panelEl = p;

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:linear-gradient(180deg,#f5f7fb,#eef1f6);border-bottom:1px solid #e8ebf0;cursor:grab';
    var title = document.createElement('span');
    title.style.cssText = 'flex:1;font-weight:700;font-size:12.5px';
    title.textContent = '暂存过站（调试）v0.3';
    var toggle = document.createElement('button');
    toggle.textContent = '收起';
    toggle.style.cssText = 'border:1px solid #d0d5dd;background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px';
    head.appendChild(title);
    head.appendChild(toggle);
    p.appendChild(head);

    var body = document.createElement('div');
    body.id = 'hpd-body';
    body.style.cssText = 'padding:8px 10px';
    p.appendChild(body);
    document.body.appendChild(p);

    var live = document.createElement('div');
    live.style.cssText = 'margin-bottom:6px;color:#667085;line-height:17px';
    body.appendChild(live);
    liveEl = live;

    var modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;padding:5px 8px;border:1px solid #e9d5ff;background:#faf5ff;border-radius:7px';
    var mc = document.createElement('input');
    mc.type = 'checkbox';
    mc.id = 'hpd-hold-mode';
    mc.style.cssText = 'cursor:pointer;flex:none';
    var ml = document.createElement('label');
    ml.style.cssText = 'flex:1;cursor:pointer;line-height:15px';
    ml.innerHTML = '<b style="color:#722ed1">暂存模式</b> <span style="color:#98a2b3">开=校验全过自动暂存+清空（校验+ATE 再等 ATE）</span>';
    modeRow.appendChild(mc);
    modeRow.appendChild(ml);
    body.appendChild(modeRow);
    modeCb = mc;
    mc.checked = holdModeOn;
    mc.onchange = function () { setHoldMode(mc.checked); };

    var btnHold = document.createElement('button');
    btnHold.textContent = '手动暂存当前模块（暂存+清空+回焦）';
    btnHold.style.cssText = 'width:100%;padding:6px;border:1px solid #0958d9;background:#0958d9;color:#fff;border-radius:7px;font-weight:600;cursor:pointer;font-size:12px';
    btnHold.onclick = function () { holdCurrent(false); };
    body.appendChild(btnHold);

    var listHead = document.createElement('div');
    listHead.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-weight:600';
    listHead.innerHTML = '<span>暂存列表 <span id="hpd-count" style="color:#0958d9">0</span> 条</span><span style="color:#98a2b3;font-weight:400;font-size:10.5px">取出=自动回填+过站</span>';
    body.appendChild(listHead);
    countEl = document.getElementById('hpd-count');

    var list = document.createElement('div');
    list.style.cssText = 'max-height:180px;overflow-y:auto;border:1px solid #eaecf0;border-radius:8px;background:#f9fafb;margin-top:4px';
    body.appendChild(list);
    listEl = list;

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px';
    var btnAll = document.createElement('button');
    btnAll.textContent = '全部取出（逐模块：条码回车重建→回填SN→自动过站）';
    btnAll.style.cssText = 'flex:1;padding:4px;border:1px solid #d0d5dd;background:#fff;border-radius:6px;cursor:pointer;font-size:11.5px';
    btnAll.onclick = releaseAll;
    btnRow.appendChild(btnAll);
    body.appendChild(btnRow);

    var st = document.createElement('div');
    st.style.cssText = 'margin-top:7px;padding:5px 8px;background:#f9fafb;border:1px solid #f2f4f7;border-radius:6px;min-height:16px;color:#475465;line-height:15px';
    body.appendChild(st);
    statusEl = st;

    toggle.onclick = function (e) {
      e.stopPropagation();
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      toggle.textContent = hidden ? '收起' : '展开';
    };

    // 拖动 + 位置记忆
    var drag = null;
    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || e.target === toggle) return;
      var r = p.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, left: r.left, top: r.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var nx = Math.max(0, Math.min(drag.left + e.clientX - drag.sx, window.innerWidth - 60));
      var ny = Math.max(0, Math.min(drag.top + e.clientY - drag.sy, window.innerHeight - 40));
      p.style.left = nx + 'px';
      p.style.top = ny + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left: p.offsetLeft, top: p.offsetTop })); } catch (e) {}
    });
    try {
      var sp = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (sp && typeof sp.left === 'number') { p.style.left = sp.left + 'px'; p.style.top = sp.top + 'px'; }
    } catch (e) {}

    setInterval(function () {
      try {
        refreshHoldModeHeartbeat();
        var on = onTrackPage();
        p.style.display = on ? '' : 'none';
        if (!on) return;
        if (holdModeOn) autoHoldTick();
        updateLive();
        renderList();
      } catch (e) {}
    }, 1000);

    setHoldMode(holdModeOn, true);
    renderList();
    updateLive();
    setStatus(holdModeOn ? '调试面板已启动（暂存模式：开）' : '调试面板已启动（独立，不影响其他脚本）', holdModeOn ? '#722ed1' : '#1677ff');
  }

  buildPanel();
})();
