// ==UserScript==
// @name         MES 单组Push（动态SN重建稳定版）
// @namespace    mes.plugin.push.dynamic
// @version      4.1
// @match        https://w3.huawei.com/mespmm/wipweb*
// @match        https://mes.huawei.com/mespmm/rptwebnew*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(async function () {
  'use strict';

  // ===== MES授权门禁 =====
  async function __MES_AUTH_GATE__() {
    var KEY = 'MES_AUTH_CENTER_STATE_V1';
    var start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        var st = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (st && st.ok && Date.now() - Number(st.ts || 0) < 10000) return true;
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    return false;
  }
  if (!(await __MES_AUTH_GATE__())) return;
  if (!location.href.includes('#/ProductTrackInOut')) return;

  // ===== 常量 =====
  var KEY_CFG = 'mes_plugin_push_cfg_dynamic_v30';
  var KEY_SAVED = 'mes_plugin_push_saved_configs';
  var POS_KEY = 'mes_push_panel_pos_v2';
  var BARCODE_SELECTOR = 'div[id^="Input_"] > input.hae-ui-input[type="text"], div[id^="Input_"] > input';
  var PUSH_URL = 'http://127.0.0.1:8766/push';
  var PING_URL = 'http://127.0.0.1:8766/ping';

  var defaultCfg = { snListText: '1 8 9', debug: true, autoPush: false, waitAllSn: false };

  // ===== 配置加载 =====
  var cfg = Object.assign({}, defaultCfg);
  try { var s = GM_getValue(KEY_CFG, null); if (s) cfg = Object.assign({}, defaultCfg, JSON.parse(s)); } catch (e) {}

  var savedConfigs = [];
  try { var sc = GM_getValue(KEY_SAVED, null); if (sc) savedConfigs = JSON.parse(sc); } catch (e) {}

  // ===== 状态 =====
  var lastSig = '';
  var lastParentSeen = '';
  var parentChangeAt = 0;
  var snTouchedAtById = new Map();

  // ===== 日志系统 =====
  var logEntries = [];
  var MAX_LOGS = 60;
  var logThrottleMap = new Map();
  var LOG_THROTTLE_MS = 3000;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function ts() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function addLog(msg, type, force) {
    var now = Date.now();
    var text = String(msg);
    if (!force) {
      var last = logThrottleMap.get(text) || 0;
      if (now - last < LOG_THROTTLE_MS) return;
      logThrottleMap.set(text, now);
    }
    logEntries.unshift({ time: ts(), text: text, type: type || 'info' });
    if (logEntries.length > MAX_LOGS) logEntries.length = MAX_LOGS;
    renderLog();
  }

  function renderLog() {
    var box = document.getElementById('mp-log-list');
    if (!box) return;
    var html = '';
    for (var i = 0; i < logEntries.length; i++) {
      var e = logEntries[i];
      var cls = 'mp-log-item mp-log-' + e.type;
      html += '<div class="' + cls + '"><span class="mp-log-time">' + e.time + '</span><span class="mp-log-text">' + escHtml(e.text) + '</span></div>';
    }
    box.innerHTML = html;
  }

  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function setMsg(text, type) {
    var msg = document.getElementById('mp-msg');
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'mp-msg mp-msg-' + (type || 'info');
  }

  function dlog() {
    if (cfg.debug) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[PUSH]');
      console.log.apply(console, args);
    }
  }

  // ===== 配置保存 =====
  function saveConfig() { try { GM_setValue(KEY_CFG, JSON.stringify(cfg)); } catch (e) {} }
  function saveSavedConfigs() { try { GM_setValue(KEY_SAVED, JSON.stringify(savedConfigs)); } catch (e) {} }

  // ===== 工具 =====
  function normalize(v) {
    v = (v || '').trim().replace(/\u00A0/g, ' ').replace(/\s+/g, '');
    if (v.indexOf('\uff1a') >= 0) v = v.split('\uff1a').pop();
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v.toUpperCase();
  }

  function parseSnNums(txt) {
    return (txt || '').split(/\s+/).map(function (x) { return parseInt(x, 10); }).filter(function (n) { return !isNaN(n) && n >= 1; });
  }

  function getBarcodeInput() {
    var all = Array.prototype.slice.call(document.querySelectorAll(BARCODE_SELECTOR)).filter(function (el) { return !el.closest('#mp-panel'); });
    for (var i = 0; i < all.length; i++) {
      var box = all[i].closest('div[id^="Input_"]');
      var ctx = ((box && box.parentElement ? box.parentElement.innerText : '') || '').replace(/\s+/g, '');
      if (ctx.indexOf('\u6761\u7801\u91c7\u96c6') >= 0) return all[i];
    }
    return all[0] || null;
  }

  function getBarcode() { return normalize(getBarcodeInput() ? getBarcodeInput().value : ''); }

  function getAllSnFilled() {
    var els = Array.prototype.slice.call(document.querySelectorAll('input[id^="sn-input"]'));
    for (var i = 0; i < els.length; i++) if (!normalize(els[i].value || '')) return false;
    return true;
  }

  function allSnNoDuplicate() {
    var els = Array.prototype.slice.call(document.querySelectorAll('input[id^="sn-input"]'));
    var vals = els.map(function (el) { return normalize(el.value || ''); }).filter(Boolean);
    return new Set(vals).size === vals.length;
  }

  function readBomGate() {
    var KEY = 'sn_code_check_gate_status';
    var candidates = [];
    function addGate(src, raw) {
      if (!raw) return;
      try { var data = JSON.parse(raw); if (!data || !data.ts || !Array.isArray(data.details)) return; candidates.push({ src: src, data: data }); } catch (e) {}
    }
    try { addGate('localStorage', localStorage.getItem(KEY)); } catch (e) {}
    try { addGate('sessionStorage', sessionStorage.getItem(KEY)); } catch (e) {}
    if (!candidates.length) return null;
    var currentParent = '';
    try { currentParent = normalize(getBarcode()); } catch (e) {}
    if (currentParent) {
      var matched = candidates.filter(function (x) { return normalize(x.data.parentSn || '') === currentParent; });
      if (!matched.length) return null;
      matched.sort(function (a, b) { return (b.data.ts || 0) - (a.data.ts || 0); });
      return matched[0].data;
    }
    candidates.sort(function (a, b) { return (b.data.ts || 0) - (a.data.ts || 0); });
    return candidates[0].data;
  }

  // ===== Push 逻辑 =====
  function buildLines() {
    var barcode = getBarcode();
    var nums = parseSnNums(cfg.snListText);
    if (!barcode || !nums.length) return null;
    if (cfg.waitAllSn && !getAllSnFilled()) return null;
    var out = [barcode];
    for (var i = 0; i < nums.length; i++) {
      var idx = nums[i] - 1;
      var v = normalize(document.querySelector('#sn-input' + idx) ? document.querySelector('#sn-input' + idx).value : '');
      if (!v) return null;
      out.push(v);
    }
    return out;
  }

  async function pushToLocal(lines) {
    var r = await fetch(PUSH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: lines }) });
    var ret = {};
    try { ret = await r.json(); } catch (e) {}
    if (!r.ok || ret.ok === false) throw new Error('HTTP' + r.status + (ret.msg ? ' ' + ret.msg : ''));
    return ret;
  }

  async function healthCheck() {
    var r = await fetch(PING_URL);
    return r.json();
  }

  async function doPush(force) {
    var lines = buildLines();
    if (!lines) {
      setMsg(cfg.waitAllSn ? '\u7b49\u5f85\u5168\u90e8SN\u586b\u5199' : '\u6761\u7801/SN\u4e0d\u5b8c\u6574', 'warn');
      return;
    }
    var currentBarcode = getBarcode();
    if (!currentBarcode || currentBarcode !== lastParentSeen) { setMsg('\u7236\u9879\u672a\u626b\u7801\u786e\u8ba4', 'warn'); return; }
    if (!allSnNoDuplicate()) { addLog('SN\u91cd\u590d\uff0c\u672a\u63d0\u4ea4', 'warn', true); setMsg('SN\u91cd\u590d\uff0c\u672a\u63d0\u4ea4', 'warn'); return; }

    try {
      var gate = readBomGate();
      if (!gate || !gate.ts || Date.now() - gate.ts > 120000) { setMsg('\u7b49\u5f85\u6821\u9a8c', 'warn'); return; }
      if (parentChangeAt && gate.ts < parentChangeAt) { setMsg('\u7b49\u5f85\u6821\u9a8c', 'warn'); return; }
      if (!Array.isArray(gate.details)) { setMsg('\u7b49\u5f85\u6821\u9a8c', 'warn'); return; }

      var nums = parseSnNums(cfg.snListText);
      if (!nums.length) { addLog('\u672a\u914d\u7f6eSN\u5e8f\u53f7', 'warn', true); setMsg('\u672a\u914d\u7f6eSN\u5e8f\u53f7', 'warn'); return; }

      for (var i = 0; i < nums.length; i++) {
        var id = 'sn-input' + (nums[i] - 1);
        var el = document.getElementById(id);
        var val = normalize(el && el.value || '');
        if (!el) { addLog('\u672a\u627e\u5230SN\u6846 ' + id, 'warn', true); setMsg('\u672a\u627e\u5230SN\u6846 ' + id, 'warn'); return; }
        if (!val) { setMsg('SN\u672a\u586b\u5199 ' + id, 'warn'); return; }
        var touchedAt = snTouchedAtById.get(id) || 0;
        if (parentChangeAt && touchedAt < parentChangeAt) { setMsg('SN\u672a\u5237\u65b0 ' + id, 'warn'); return; }
        var d = gate.details.find(function (x) { return x && x.id === id; });
        if (!d) { setMsg('\u7b49\u5f85\u6821\u9a8c', 'warn'); return; }
        if (normalize(d.sn || '') !== val) { setMsg('\u7b49\u5f85\u6821\u9a8c', 'warn'); return; }
        if (d.status !== 'ok') { setMsg('\u7b49\u5f85\u6821\u9a8c', 'warn'); return; }
      }
    } catch (e) { setMsg('\u7b49\u5f85\u6821\u9a8c', 'warn'); return; }

    var sig = lines.join('|');
    if (!force && sig === lastSig) return;
    if (!force) lastSig = sig;

    addLog('\u6293\u53d6: ' + lines.join(' | '), 'info', true);
    setMsg('\u63a8\u9001\u4e2d\u2026', 'busy');

    try {
      var ret = await pushToLocal(lines);
      var cnt = ret.count || lines.length;
      addLog('\u2713 Push \u6210\u529f ' + cnt + ' \u6761', 'ok', true);
      setMsg('\u5df2Push ' + cnt + ' \u6761', 'ok');
      dlog('push ok', lines);
    } catch (e) {
      addLog('\u2717 Push \u5931\u8d25: ' + e, 'err', true);
      setMsg('Push\u5931\u8d25', 'err');
      dlog('push fail', e);
    }
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    var pushTimer = null;

    function isSnRouteMoving(el) { return !!(el && el.dataset && (el.dataset.snAutoFill === '1' || el.dataset.snRouteMoving === '1')); }
    function anySnRouteMoving() { return Array.prototype.slice.call(document.querySelectorAll('input[id^="sn-input"]')).some(isSnRouteMoving); }
    function markSnTouched(el) { if (!el || !el.id || !/^sn-input\d+$/i.test(el.id)) return; snTouchedAtById.set(el.id, Date.now()); }
    function isBarcodeTarget(t) { return !!(t && t === getBarcodeInput()); }

    function commitParentChangedByEnter() {
      var b = getBarcode();
      if (!b || b === lastParentSeen) return false;
      lastParentSeen = b; lastSig = '';
      parentChangeAt = Date.now();
      snTouchedAtById.clear();
      clearTimeout(pushTimer);
      setMsg('\u7236\u9879\u5df2\u626b\u7801\uff0c\u7b49\u5f85SN\u6821\u9a8c', 'info');
      addLog('\u7236\u9879\u53d8\u5316: ' + b, 'info');
      dlog('parent changed:', b);
      return true;
    }

    function markConfiguredOkFromGate(gate) {
      if (!gate || !Array.isArray(gate.details)) return;
      var nums = parseSnNums(cfg.snListText);
      if (!nums.length) return;
      for (var i = 0; i < nums.length; i++) {
        var id = 'sn-input' + (nums[i] - 1);
        var el = document.getElementById(id);
        if (!el) continue;
        var val = normalize(el.value || '');
        if (!val) continue;
        var d = gate.details.find(function (x) { return x && x.id === id; });
        if (!d) continue;
        if (d.status === 'ok' && normalize(d.sn || '') === val) snTouchedAtById.set(id, Date.now());
      }
    }

    function configuredSnReadyAndOk() {
      var barcode = getBarcode();
      if (!barcode) return { ok: false, msg: '\u7236\u9879\u6761\u7801\u4e3a\u7a7a' };
      if (barcode !== lastParentSeen) return { ok: false, msg: '\u7236\u9879\u672a\u626b\u7801\u786e\u8ba4\uff0c\u8bf7\u91cd\u65b0\u626b\u7801' };
      var nums = parseSnNums(cfg.snListText);
      if (!nums.length) return { ok: false, msg: '\u672a\u914d\u7f6eSN\u5e8f\u53f7' };
      if (!allSnNoDuplicate()) return { ok: false, msg: 'SN\u91cd\u590d\uff0c\u672aPush' };
      if (cfg.waitAllSn && !getAllSnFilled()) return { ok: false, msg: '\u7b49\u5f85\u5168\u90e8SN\u586b\u5199' };
      var gate = readBomGate();
      if (!gate || !gate.ts || Date.now() - gate.ts > 120000) return { ok: false, msg: '\u7b49\u5f85\u6821\u9a8c' };
      if (parentChangeAt && gate.ts < parentChangeAt) return { ok: false, msg: '\u7b49\u5f85\u6821\u9a8c' };
      if (!Array.isArray(gate.details)) return { ok: false, msg: '\u7b49\u5f85\u6821\u9a8c' };
      markConfiguredOkFromGate(gate);
      for (var i = 0; i < nums.length; i++) {
        var id = 'sn-input' + (nums[i] - 1);
        var el = document.getElementById(id);
        if (!el) return { ok: false, msg: '\u672a\u627e\u5230SN\u6846 ' + id };
        var val = normalize(el.value || '');
        if (!val) return { ok: false, msg: 'SN\u672a\u586b\u5199 ' + id };
        var touchedAt = snTouchedAtById.get(id) || 0;
        if (parentChangeAt && touchedAt < parentChangeAt) return { ok: false, msg: 'SN\u672a\u5237\u65b0 ' + id };
        var d = gate.details.find(function (x) { return x && x.id === id; });
        if (!d) { try { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} return { ok: false, msg: '\u7b49\u5f85\u6821\u9a8c' }; }
        if (normalize(d.sn || '') !== val) return { ok: false, msg: '\u7b49\u5f85\u6821\u9a8c' };
        if (d.status !== 'ok') return { ok: false, msg: '\u7b49\u5f85\u6821\u9a8c' };
      }
      return { ok: true, msg: '\u914d\u7f6eSN\u5df2\u6821\u9a8c\u901a\u8fc7' };
    }

    function tryAutoPushByConfiguredSn() {
      if (!cfg.autoPush) return;
      if (anySnRouteMoving()) { setMsg('SN\u5f52\u4f4d\u4e2d\uff0c\u7b49\u5f85Push', 'warn'); return; }
      if (!allSnNoDuplicate()) { setMsg('SN\u91cd\u590d\uff0c\u672aPush', 'warn'); return; }
      var ready = configuredSnReadyAndOk();
      if (!ready.ok) { setMsg(ready.msg, 'warn'); return; }
      clearTimeout(pushTimer);
      pushTimer = setTimeout(function () { doPush(false); }, 300);
    }

    lastParentSeen = getBarcode();
    parentChangeAt = 0;
    snTouchedAtById.clear();

    window.addEventListener('sn-code-check-gate', function (e) {
      markConfiguredOkFromGate(e.detail);
      setTimeout(function () { markConfiguredOkFromGate(readBomGate()); tryAutoPushByConfiguredSn(); }, 120);
    }, true);

    document.addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.matches && t.matches('input[id^="sn-input"]')) {
        markSnTouched(t);
        setTimeout(function () { markConfiguredOkFromGate(readBomGate()); tryAutoPushByConfiguredSn(); }, 200);
        return;
      }
      if (isBarcodeTarget(t)) setMsg('\u7236\u9879\u8f93\u5165\u4e2d\u2026', 'info');
    }, true);

    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.matches && t.matches('input[id^="sn-input"]')) {
        markSnTouched(t);
        setTimeout(function () { markConfiguredOkFromGate(readBomGate()); tryAutoPushByConfiguredSn(); }, 200);
      }
    }, true);

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!isBarcodeTarget(t)) return;
      if (e.key === 'Enter') setTimeout(function () { if (commitParentChangedByEnter()) tryAutoPushByConfiguredSn(); }, 30);
    }, true);

    document.addEventListener('blur', function (e) {
      var t = e.target;
      if (t && t.matches && t.matches('input[id^="sn-input"]')) { markSnTouched(t); tryAutoPushByConfiguredSn(); }
    }, true);

    setInterval(function () { markConfiguredOkFromGate(readBomGate()); tryAutoPushByConfiguredSn(); }, 800);
  }

  // ===== CSS =====
  var css = ''
    + '#mp-panel{position:fixed;z-index:999999;background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.15);font-size:12px;font-family:"Segoe UI",system-ui,sans-serif;overflow:hidden;transition:width .2s ease}'
    + '#mp-panel.mp-collapsed{width:100px}'
    + '#mp-panel.mp-expanded{width:300px}'
    + '.mp-header{height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#f8fafc;color:#1e293b;cursor:move;user-select:none;border-bottom:1px solid #e2e8f0}'
    + '.mp-header .mp-title{font-weight:600;font-size:13px;color:#1e293b}'
    + '.mp-header .mp-btns{display:flex;gap:4px}'
    + '.mp-header .mp-btn{width:22px;height:22px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;color:#64748b;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s;line-height:1}'
    + '.mp-header .mp-btn:hover{background:#f1f5f9;color:#1e293b;border-color:#94a3b8}'
    + '.mp-body{padding:10px 12px}'
    + '.mp-msg{padding:6px 10px;margin-bottom:8px;border-radius:5px;font-size:12px;min-height:28px;display:flex;align-items:center;user-select:text;transition:all .2s}'
    + '.mp-msg-info{background:#eff6ff;color:#1d4ed8}'
    + '.mp-msg-warn{background:#fffbeb;color:#b45309}'
    + '.mp-msg-ok{background:#f0fdf4;color:#15803d}'
    + '.mp-msg-err{background:#fef2f2;color:#b91c1c}'
    + '.mp-msg-busy{background:#f0f9ff;color:#0369a1}'
    + '.mp-field{margin-bottom:8px}'
    + '.mp-field label{display:block;font-size:11px;color:#64748b;margin-bottom:3px}'
    + '.mp-field-row{display:flex;align-items:center;gap:6px}'
    + '.mp-input{flex:1;height:26px;padding:3px 8px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;outline:none;min-width:0}'
    + '.mp-input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.15)}'
    + '.mp-select{height:26px;padding:2px 6px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;outline:none;background:#fff;flex:1;min-width:0}'
    + '.mp-sm-btn{height:26px;padding:0 8px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;cursor:pointer;font-size:11px;color:#475569;transition:all .15s}'
    + '.mp-sm-btn:hover{background:#f1f5f9}'
    + '.mp-checks{display:flex;align-items:center;gap:12px;margin-bottom:8px}'
    + '.mp-checks label{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;color:#475569}'
    + '.mp-btns-row{display:flex;gap:6px;margin-bottom:8px}'
    + '.mp-btn-primary{flex:1;height:28px;border:1px solid #2563eb;border-radius:5px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;transition:all .15s}'
    + '.mp-btn-primary:hover{background:#1d4ed8}'
    + '.mp-btn-secondary{height:28px;padding:0 14px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#475569;cursor:pointer;font-size:12px;transition:all .15s}'
    + '.mp-btn-secondary:hover{background:#f1f5f9}'
    + '.mp-log-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}'
    + '.mp-log-header span{font-size:11px;color:#64748b;font-weight:500}'
    + '.mp-log-clear{font-size:10px;color:#94a3b8;cursor:pointer;border:none;background:none}'
    + '.mp-log-clear:hover{color:#dc2626}'
    + '.mp-log-box{border:1px solid #e2e8f0;border-radius:5px;background:#f8fafc;max-height:120px;overflow-y:auto}'
    + '.mp-log-item{display:flex;gap:6px;padding:2px 8px;font-size:11px;line-height:18px;border-bottom:1px solid #f1f5f9}'
    + '.mp-log-item:last-child{border-bottom:none}'
    + '.mp-log-time{color:#94a3b8;flex-shrink:0;font-family:Consolas,monospace;width:52px}'
    + '.mp-log-text{color:#475569;word-break:break-all;user-select:text}'
    + '.mp-log-info .mp-log-text{color:#475569}'
    + '.mp-log-ok .mp-log-text{color:#15803d}'
    + '.mp-log-warn .mp-log-text{color:#b45309}'
    + '.mp-log-err .mp-log-text{color:#b91c1c}'
    ;

  // ===== UI 创建 =====
  function createPanel() {
    if (document.getElementById('mp-panel')) return;

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var state = {};
    try { state = GM_getValue(POS_KEY, null) || {}; } catch (e) { try { state = JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch (e2) {} }
    var left = typeof state.left === 'number' ? state.left : null;
    var top = typeof state.top === 'number' ? state.top : 90;
    var collapsed = !!state.collapsed;

    var panel = document.createElement('div');
    panel.id = 'mp-panel';
    panel.className = collapsed ? 'mp-collapsed' : 'mp-expanded';
    panel.style.top = top + 'px';
    if (left === null) panel.style.right = '12px';
    else panel.style.left = left + 'px';

    var optionsHtml = '<option value="">\u624b\u52a8\u8f93\u5165</option>';
    savedConfigs.forEach(function (s) { optionsHtml += '<option value="' + escHtml(s) + '"' + (s === cfg.snListText ? ' selected' : '') + '>' + escHtml(s) + '</option>'; });

    panel.innerHTML = ''
      + '<div class="mp-header" id="mp-drag-handle">'
      +   '<span class="mp-title">MES Push</span>'
      +   '<div class="mp-btns"><button class="mp-btn" id="mp-collapse" title="\u6298\u53e0">\u2500</button></div>'
      + '</div>'
      + '<div class="mp-body" id="mp-body" style="' + (collapsed ? 'display:none' : '') + '">'
      +   '<div class="mp-msg mp-msg-info" id="mp-msg">\u63d2\u4ef6\u5df2\u52a0\u8f7d</div>'
      +   '<div class="mp-field"><label>SN \u914d\u7f6e</label>'
      +     '<div class="mp-field-row"><select class="mp-select" id="mp-sn-select">' + optionsHtml + '</select></div>'
      +     '<div class="mp-field-row" style="margin-top:4px;"><input class="mp-input" id="mp-sn-list" value="' + escHtml(cfg.snListText) + '"><button class="mp-sm-btn" id="mp-save-btn">\u4fdd\u5b58</button><button class="mp-sm-btn" id="mp-del-btn">\u5220\u9664</button></div>'
      +   '</div>'
      +   '<div class="mp-checks"><label><input type="checkbox" id="mp-auto"' + (cfg.autoPush ? ' checked' : '') + '>\u81ea\u52a8</label><label><input type="checkbox" id="mp-wait-all"' + (cfg.waitAllSn ? ' checked' : '') + '>\u7b49\u5168\u90e8SN</label></div>'
      +   '<div class="mp-btns-row"><button class="mp-btn-primary" id="mp-push-btn">Push</button><button class="mp-btn-secondary" id="mp-health-btn">\u68c0\u6d4b</button></div>'
      +   '<div class="mp-log-header"><span>\u64cd\u4f5c\u65e5\u5fd7</span><button class="mp-log-clear" id="mp-log-clear">\u6e05\u7a7a</button></div>'
      +   '<div class="mp-log-box" id="mp-log-list"></div>'
      + '</div>';

    document.body.appendChild(panel);

    function savePanelState() {
      var rect = panel.getBoundingClientRect();
      var l = Math.max(0, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 2));
      var t = Math.max(0, Math.min(rect.top, window.innerHeight - panel.offsetHeight - 2));
      panel.style.left = l + 'px'; panel.style.top = t + 'px'; panel.style.right = 'auto';
      try { GM_setValue(POS_KEY, { left: l, top: t, collapsed: panel.classList.contains('mp-collapsed') }); } catch (e) { try { localStorage.setItem(POS_KEY, JSON.stringify({ left: l, top: t, collapsed: panel.classList.contains('mp-collapsed') })); } catch (e2) {} }
    }

    function refreshSelect() {
      var sel = document.getElementById('mp-sn-select');
      if (!sel) return;
      var html = '<option value="">\u624b\u52a8\u8f93\u5165</option>';
      savedConfigs.forEach(function (s) { html += '<option value="' + escHtml(s) + '"' + (s === cfg.snListText ? ' selected' : '') + '>' + escHtml(s) + '</option>'; });
      sel.innerHTML = html;
    }

    // 拖动
    (function () {
      var dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
      var handle = document.getElementById('mp-drag-handle');
      handle.addEventListener('mousedown', function (e) {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        var r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panel.style.left = sl + 'px'; panel.style.top = st + 'px'; panel.style.right = 'auto';
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        panel.style.left = (sl + e.clientX - sx) + 'px';
        panel.style.top = (st + e.clientY - sy) + 'px';
      });
      document.addEventListener('mouseup', function () { if (dragging) { dragging = false; savePanelState(); } });
    })();

    // 折叠
    document.getElementById('mp-collapse').addEventListener('click', function () {
      var body = document.getElementById('mp-body');
      if (body.style.display === 'none') { body.style.display = ''; panel.classList.remove('mp-collapsed'); panel.classList.add('mp-expanded'); }
      else { body.style.display = 'none'; panel.classList.remove('mp-expanded'); panel.classList.add('mp-collapsed'); }
      savePanelState();
    });

    // SN 输入
    document.getElementById('mp-sn-list').addEventListener('change', function () {
      cfg.snListText = this.value || ''; saveConfig(); setMsg('SN\u5e8f\u53f7\u5df2\u66f4\u65b0', 'info');
    });

    document.getElementById('mp-sn-select').addEventListener('change', function () {
      if (this.value) { cfg.snListText = this.value; document.getElementById('mp-sn-list').value = this.value; saveConfig(); setMsg('\u5df2\u9009\u62e9: ' + this.value, 'info'); }
    });

    document.getElementById('mp-save-btn').addEventListener('click', function () {
      var v = cfg.snListText.trim();
      if (!v) { setMsg('\u8bf7\u8f93\u5165SN\u5e8f\u53f7', 'warn'); return; }
      if (savedConfigs.indexOf(v) < 0) { savedConfigs.push(v); savedConfigs.sort(); saveSavedConfigs(); refreshSelect(); document.getElementById('mp-sn-select').value = v; setMsg('\u5df2\u4fdd\u5b58: ' + v, 'ok'); }
      else setMsg('\u5df2\u5b58\u5728: ' + v, 'warn');
    });

    document.getElementById('mp-del-btn').addEventListener('click', function () {
      var v = cfg.snListText.trim();
      if (!v) { setMsg('\u8bf7\u8f93\u5165\u8981\u5220\u9664\u7684SN\u5e8f\u53f7', 'warn'); return; }
      var idx = savedConfigs.indexOf(v);
      if (idx >= 0) { savedConfigs.splice(idx, 1); saveSavedConfigs(); refreshSelect(); document.getElementById('mp-sn-select').value = ''; setMsg('\u5df2\u5220\u9664: ' + v, 'info'); }
      else setMsg('\u672a\u627e\u5230: ' + v, 'warn');
    });

    document.getElementById('mp-auto').addEventListener('change', function () { cfg.autoPush = this.checked; saveConfig(); setMsg(cfg.autoPush ? '\u81ea\u52a8Push\u5df2\u5f00\u542f' : '\u81ea\u52a8Push\u5df2\u5173\u95ed', 'info'); });

    document.getElementById('mp-wait-all').addEventListener('change', function () { cfg.waitAllSn = this.checked; saveConfig(); setMsg(cfg.waitAllSn ? '\u7b49\u5f85\u5168\u90e8SN\u5df2\u5f00\u542f' : '\u7b49\u5f85\u5168\u90e8SN\u5df2\u5173\u95ed', 'info'); });

    document.getElementById('mp-push-btn').addEventListener('click', function () { doPush(true); });

    document.getElementById('mp-health-btn').addEventListener('click', async function () {
      setMsg('\u68c0\u6d4b\u4e2d\u2026', 'busy');
      try { var ret = await healthCheck(); addLog('\u670d\u52a1\u6b63\u5e38: ' + JSON.stringify(ret), 'ok', true); setMsg('\u670d\u52a1\u6b63\u5e38', 'ok'); }
      catch (e) { addLog('\u670d\u52a1\u5f02\u5e38: ' + e, 'err', true); setMsg('\u670d\u52a1\u5f02\u5e38', 'err'); }
    });

    document.getElementById('mp-log-clear').addEventListener('click', function () { logEntries = []; renderLog(); });

    window.addEventListener('resize', savePanelState);
    setTimeout(savePanelState, 100);
    addLog('\u63d2\u4ef6\u5df2\u52a0\u8f7d v4.0', 'info', true);
  }

  createPanel();
  bindEvents();
})();
