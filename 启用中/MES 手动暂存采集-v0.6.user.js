
// ==UserScript==
// @name         MES 手动暂存采集
// @namespace    tm.mes.manual.collect
// @version      0.6
// @match        https://w3.huawei.com/mespmm/wipweb*
// @match        https://mes.huawei.com/mespmm/rptwebnew*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ===== 常量 =====
  var TEMPLATE_KEY = 'manual_collect_template_v1';
  var HOLD_STORE_KEY = 'mes_pass_hold_v1';
  var BASE = 'https://w3.huawei.com/mespmm/gateway/com.huawei.supply.mes.mesplus.pspw:mespmmpreallservice/mespmmpreallone/services/emsComponentDataInfo/find/page';

  // ===== 状态 =====
  var template = [];
  var templateRows = [];
  var currentModule = '';
  var currentSNs = [];
  var setNumber = 1;
  var panel = null;
  var toggleBtn = null;
  var isVisible = false;
  var activeTab = 'template';
  var isQuerying = false;
  var queryChain = Promise.resolve();

  // ===== 工具 =====
  function toStr(v) { return v == null ? '' : String(v); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function timeStr(ts) {
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function escAttr(s) { return toStr(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function holdNormSn(v) {
    v = toStr(v).replace(/\u00A0/g, ' ').replace(/\s+/g, '').trim();
    if (v.indexOf('\uff1a') >= 0) v = v.split('\uff1a').pop();
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v.toUpperCase();
  }
  function normSn(v) {
    v = toStr(v).replace(/\s+/g, '');
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v;
  }
  function normalizeForCompare(v) {
    return toStr(v).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/\uFF1A/g, ':').toUpperCase();
  }

  // v0.4：模块条码 ASN 截取转换
  // 例：[)>06S035FDT10S90001741P3407040718VLEHWT1VHSC4LCN → 035FDT10S9000174
  // 规律：ASN 头 [)>06 + S(字段标识) + 16位模块码 + 1P/V...(后续字段)
  // 模块码格式：3位数字 + 3位字母 + 2位数字 + 1位字母 + 7位数字 = 16位
  function parseModuleBarcode(raw) {
    var s = toStr(raw).trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return '';
    if (s.length === 16) return s;
    // 优先用模块码格式正则从整串里提取
    var m = s.match(/\d{3}[A-Z]{3}\d{2}[A-Z]\d{7}/);
    if (m) return m[0];
    // 兜底：剥 ASN 头 [)>XX + 字段标识，取前 16 位
    var stripped = s.replace(/^\[?\)?>?\s*\d*/i, '');
    m = stripped.match(/[A-Z0-9]{16}/i);
    if (m) return m[0].toUpperCase();
    return s;
  }

  // ===== 存储 =====
  function loadTemplate() {
    try { template = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '[]'); } catch (e) { template = []; }
  }
  function saveTemplate() {
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(template)); } catch (e) {}
  }
  function loadHoldStore() {
    try { return JSON.parse(localStorage.getItem(HOLD_STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveHoldStore(h) {
    try { localStorage.setItem(HOLD_STORE_KEY, JSON.stringify(h)); } catch (e) {}
  }

  // ===== SN 查码接口（从 SN 校验脚本移植）=====
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

  function extractCodeSmart(text) {
    text = toStr(text).replace(/\u00A0/g, ' ').replace(/\uFF1A/g, ':');
    var parts = text.split(/\s+/).filter(Boolean);
    var last = '';
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg.indexOf(':') >= 0) seg = seg.split(':').pop();
      seg = seg.replace(/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]+[-_]/i, '');
      seg = normalizeForCompare(seg);
      if (seg) last = seg;
    }
    return last || normalizeForCompare(text);
  }

  // v0.5：读 SN 规则兜底的接口二转换编码（双向：from→to 和 to→from 都算）
  var CONVERT_KEY = 'sn_code_rule_fallback_api2_convert_v1';
  function loadConvertRules() {
    try {
      var arr = JSON.parse(localStorage.getItem(CONVERT_KEY) || '[]');
      if (Array.isArray(arr)) {
        return arr.filter(function (r) { return r && r.from && r.to; })
          .map(function (r) { return { from: normalizeForCompare(r.from), to: normalizeForCompare(r.to) }; });
      }
    } catch (e) {}
    return [];
  }
  function findConvertedCodes(code) {
    var cn = normalizeForCompare(code);
    if (!cn) return [];
    var rules = loadConvertRules();
    var results = [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].from === cn) results.push(rules[i].to);
      if (rules[i].to === cn) results.push(rules[i].from);
    }
    return results;
  }

  // v0.6：读 SN 规则兜底的左侧条码清洗规则，模板编码匹配时也走清洗
  var LEFT_CLEAN_KEY = 'sn_code_left_clean_rules_v1';
  function loadLeftCleanRules() {
    try {
      var arr = JSON.parse(localStorage.getItem(LEFT_CLEAN_KEY) || '[]');
      if (Array.isArray(arr)) {
        var out = [];
        arr.forEach(function (x) {
          x = toStr(x).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/\uFF1A/g, ':').replace(/－/g, '-');
          if (x && out.indexOf(x) < 0) out.push(x);
        });
        return out;
      }
    } catch (e) {}
    return [];
  }
  function cleanLeftByRules(seg) {
    var s = toStr(seg).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/\uFF1A/g, ':').replace(/－/g, '-');
    if (!s) return '';
    var rules = loadLeftCleanRules();
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r) continue;
      if (r === ':') { var p = s.indexOf(':'); if (p >= 0) { s = s.slice(p + 1); } continue; }
      if (r === '-') { var p2 = s.indexOf('-'); if (p2 >= 0) { s = s.slice(p2 + 1); } continue; }
      if (s.toUpperCase().indexOf(r.toUpperCase()) === 0) { s = s.slice(r.length); }
    }
    return s;
  }
  // 带左侧清洗的编码提取（和 SN 校验脚本 extractLeftCodeSmart 一致）
  function extractLeftCodeSmartLocal(text) {
    text = toStr(text).replace(/\u00A0/g, ' ').replace(/\uFF1A/g, ':');
    var parts = text.split(/\s+/).filter(Boolean);
    var last = '';
    for (var i = 0; i < parts.length; i++) {
      var seg = cleanLeftByRules(parts[i]);
      if (seg.indexOf(':') >= 0) seg = seg.split(':').pop();
      seg = seg.replace(/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]+[-_]/i, '');
      seg = normalizeForCompare(seg);
      if (seg) last = seg;
    }
    return last || normalizeForCompare(cleanLeftByRules(text));
  }

  async function fetchPage(sn, pageSize, pageNo, a, b) {
    var url = BASE + '/' + pageSize + '/' + pageNo + '/' + a + '/' + b;
    var body = { barCode: '', snStr: sn, itemName: '', componentType: '', createdFrom: '', createdTo: '' };
    var r = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return JSON.parse(await r.text());
  }

  async function queryAllRows(snRaw, pageSize) {
    pageSize = pageSize || 100;
    var sn = normSn(snRaw);
    var modes = [[0, 0], [7, 0]];
    var best = { sn: sn, rows: [], mode: '-' };
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
      best = { sn: sn, rows: rows, mode: a + '/' + b };
    }
    return best;
  }

  async function queryCodeBySn_OpenApi(snRaw) {
    var sn = normSn(snRaw);
    var url = 'https://w3.huawei.com/mes/qmgateway/com.huawei.supply.mes.mesplus.qm:mesqmmitrservice/mes/mitrservice/services/openapi/getSnAttr';
    var r = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sn: sn })
    });
    var j = await r.json();
    var vo = (j && j.resultObjVO) || {};
    return { sn: sn, code: toStr(vo.partNo), source: 'openapi', mode: '-', rows: 0 };
  }

  async function queryCodeHybrid(snRaw) {
    var q1 = await queryAllRows(snRaw, 100);
    var code1 = pickFirstMatchedCode(q1.rows);
    if (code1) return { sn: q1.sn, code: code1, source: 'ems-find', mode: q1.mode, rows: q1.rows.length };
    return queryCodeBySn_OpenApi(snRaw);
  }

  // ===== CSS（白色主题）=====
  var css = ''
    + '#mc-toggle { position:fixed; top:120px; right:4px; z-index:999998; width:34px; height:34px; border-radius:6px;'
    + '  background:#fff; color:#1565c0; border:1px solid #cbd5e0; font-size:15px; cursor:pointer;'
    + '  box-shadow:0 2px 8px rgba(0,0,0,0.12); display:flex; align-items:center; justify-content:center; }'
    + '#mc-toggle:hover { background:#f0f7ff; border-color:#90caf9; }'
    + '#mc-panel { position:fixed; top:60px; right:20px; z-index:999999; width:470px; max-height:84vh; overflow:hidden;'
    + '  background:#fff; color:#1a1a2e; border:1px solid #d1d5db; border-radius:10px;'
    + '  box-shadow:0 8px 32px rgba(0,0,0,0.15); font-family:"Segoe UI",system-ui,sans-serif; font-size:13px;'
    + '  display:none; flex-direction:column; }'
    + '#mc-panel.mc-show { display:flex; }'
    + '.mc-header { display:flex; align-items:center; justify-content:space-between; padding:8px 14px;'
    + '  background:#f8fafc; cursor:move; user-select:none; border-bottom:1px solid #e2e8f0; border-radius:10px 10px 0 0; }'
    + '.mc-title { font-weight:600; color:#1565c0; font-size:14px; }'
    + '.mc-hold-count { font-size:11px; color:#64748b; margin-left:8px; }'
    + '.mc-hold-count .mc-num { color:#1565c0; font-weight:600; }'
    + '.mc-close { cursor:pointer; color:#94a3b8; font-size:20px; padding:0 6px; line-height:1; }'
    + '.mc-close:hover { color:#e53e3e; }'
    + '.mc-tabs { display:flex; border-bottom:1px solid #e2e8f0; }'
    + '.mc-tab { flex:1; padding:7px 8px; text-align:center; cursor:pointer; color:#64748b;'
    + '  border-bottom:2px solid transparent; transition:all 0.15s; font-size:13px; }'
    + '.mc-tab:hover { color:#1565c0; background:#f8fafc; }'
    + '.mc-tab.active { color:#1565c0; border-bottom-color:#1565c0; font-weight:500; }'
    + '.mc-tab-content { display:none; padding:12px 14px; overflow-y:auto; flex:1; }'
    + '.mc-tab-content.active { display:block; }'
    + '.mc-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; }'
    + '.mc-idx { width:22px; text-align:center; color:#94a3b8; flex-shrink:0; font-size:12px; }'
    + '.mc-input { flex:1; background:#fff; color:#1a1a2e; border:1px solid #cbd5e0; border-radius:5px;'
    + '  padding:5px 10px; font-family:inherit; font-size:13px; outline:none; min-width:0; transition:border-color 0.15s; }'
    + '.mc-input:focus { border-color:#1976d2; box-shadow:0 0 0 2px rgba(25,118,210,0.12); }'
    + '.mc-input.filled { border-color:#43a047; background:#f0fdf4; }'
    + '.mc-input:disabled { background:#f1f5f9; color:#64748b; }'
    + '.mc-btn { padding:5px 12px; border-radius:5px; cursor:pointer; font-size:12px; border:1px solid #cbd5e0;'
    + '  background:#fff; color:#475569; font-family:inherit; transition:all 0.15s; }'
    + '.mc-btn:hover { background:#f1f5f9; border-color:#94a3b8; }'
    + '.mc-btn:disabled { opacity:0.5; cursor:not-allowed; }'
    + '.mc-btn-primary { background:#1976d2; color:#fff; border-color:#1976d2; }'
    + '.mc-btn-primary:hover { background:#1565c0; }'
    + '.mc-btn-danger { background:#fff; color:#e53e3e; border-color:#fc8181; }'
    + '.mc-btn-danger:hover { background:#fef2f2; }'
    + '.mc-btn-sm { padding:3px 8px; font-size:11px; }'
    + '.mc-status { padding:8px 12px; margin-bottom:10px; border-radius:6px; background:#f0f7ff; color:#475569;'
    + '  font-size:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px; }'
    + '.mc-status .mc-count { color:#1565c0; font-weight:600; }'
    + '.mc-status .mc-count.done { color:#2e7d32; }'
    + '.mc-module-bar { padding:10px 12px; margin-bottom:10px; border-radius:6px; border:2px solid #1976d2;'
    + '  background:#f0f7ff; }'
    + '.mc-module-bar.filled { border-color:#43a047; background:#f0fdf4; }'
    + '.mc-module-bar label { font-size:11px; color:#64748b; display:block; margin-bottom:4px; }'
    + '.mc-module-input { width:100%; box-sizing:border-box; padding:6px 10px; font-size:14px; font-family:Consolas,monospace;'
    + '  border:1px solid #cbd5e0; border-radius:5px; outline:none; background:#fff; color:#1a1a2e; }'
    + '.mc-module-input:focus { border-color:#1976d2; box-shadow:0 0 0 2px rgba(25,118,210,0.12); }'
    + '.mc-collect-row { display:flex; align-items:center; gap:8px; margin-bottom:5px; padding:4px 6px;'
    + '  border-radius:4px; transition:background 0.15s; }'
    + '.mc-collect-row.filled { background:#f0fdf4; }'
    + '.mc-code-label { width:150px; flex-shrink:0; color:#475569; font-size:12px; overflow:hidden;'
    + '  text-overflow:ellipsis; white-space:nowrap; font-family:Consolas,monospace; }'
    + '.mc-sn-display { flex:1; color:#1a1a2e; font-size:12px; overflow:hidden; text-overflow:ellipsis;'
    + '  white-space:nowrap; font-family:Consolas,monospace; padding:3px 8px; border-radius:4px;'
    + '  border:1px solid #e2e8f0; background:#f8fafc; min-height:22px; }'
    + '.mc-sn-display.filled { border-color:#43a047; background:#f0fdf4; color:#1b5e20; }'
    + '.mc-sn-display.querying { border-color:#1976d2; background:#f0f7ff; color:#1976d2; }'
    + '.mc-sn-display.error { border-color:#e53e3e; background:#fef2f2; color:#c62828; }'
    + '.mc-check { width:20px; text-align:center; flex-shrink:0; font-size:15px; }'
    + '.mc-check.done { color:#43a047; }'
    + '.mc-check.todo { color:#cbd5e0; }'
    + '.mc-check.loading { color:#1976d2; }'
    + '.mc-check.error { color:#e53e3e; }'
    + '.mc-scan-area { margin-top:10px; padding:10px; border:1px solid #e2e8f0; border-radius:6px; background:#f8fafc; }'
    + '.mc-scan-area label { font-size:11px; color:#64748b; display:block; margin-bottom:4px; }'
    + '.mc-scan-input { width:100%; box-sizing:border-box; padding:6px 10px; font-size:14px; font-family:Consolas,monospace;'
    + '  border:2px solid #1976d2; border-radius:5px; outline:none; background:#fff; color:#1a1a2e; }'
    + '.mc-scan-input:focus { box-shadow:0 0 0 3px rgba(25,118,210,0.15); }'
    + '.mc-scan-input:disabled { background:#f1f5f9; color:#94a3b8; border-color:#cbd5e0; }'
    + '.mc-scan-msg { font-size:11px; margin-top:6px; min-height:16px; }'
    + '.mc-scan-msg.ok { color:#2e7d32; }'
    + '.mc-scan-msg.err { color:#c62828; }'
    + '.mc-scan-msg.warn { color:#f57c00; }'
    + '.mc-scan-msg.busy { color:#1976d2; }'
    + '.mc-empty { color:#94a3b8; text-align:center; padding:40px 10px; font-size:13px; }'
    + '.mc-hint { color:#64748b; font-size:11px; margin-bottom:8px; line-height:1.5; }'
    + '.mc-controls { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }'
    + '.mc-flash { animation:mc-flash-anim 0.6s ease; }'
    + '@keyframes mc-flash-anim {'
    + '  0% { box-shadow:0 0 0 0 rgba(67,160,71,0.6),0 8px 32px rgba(0,0,0,0.15); }'
    + '  100% { box-shadow:0 0 0 20px rgba(67,160,71,0),0 8px 32px rgba(0,0,0,0.15); }'
    + '}'
    + '.mc-del-btn { width:24px; height:24px; border-radius:4px; border:1px solid #cbd5e0; background:#fff;'
    + '  color:#e53e3e; cursor:pointer; font-size:14px; flex-shrink:0; display:flex; align-items:center; justify-content:center; }'
    + '.mc-del-btn:hover { background:#fef2f2; }'
    + '.mc-stored-list { margin-top:8px; }'
    + '.mc-stored-item { display:flex; align-items:center; gap:8px; padding:6px 8px; margin-bottom:4px;'
    + '  border-radius:5px; border:1px solid #e2e8f0; background:#f8fafc; font-size:12px; }'
    + '.mc-stored-item .mc-mod { flex:1; font-family:Consolas,monospace; color:#1565c0; font-weight:500; }'
    + '.mc-stored-item .mc-sub { color:#64748b; font-size:11px; }'
    ;

  // ===== UI 创建 =====
  function createUI() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    toggleBtn = document.createElement('div');
    toggleBtn.id = 'mc-toggle';
    toggleBtn.textContent = '\u270E';
    toggleBtn.title = '手动暂存采集';
    toggleBtn.onclick = function () {
      isVisible = !isVisible;
      panel.classList.toggle('mc-show', isVisible);
      if (isVisible) {
        updateHoldCount();
        if (activeTab === 'collect') setTimeout(focusCollectInput, 100);
      }
    };
    document.body.appendChild(toggleBtn);

    panel = document.createElement('div');
    panel.id = 'mc-panel';
    panel.innerHTML = ''
      + '<div class="mc-header" id="mc-header">'
      +   '<div><span class="mc-title">手动暂存采集</span><span class="mc-hold-count" id="mc-hold-count">暂存区 <span class="mc-num">0</span> 组</span></div>'
      +   '<span class="mc-close" id="mc-close">&times;</span>'
      + '</div>'
      + '<div class="mc-tabs">'
      +   '<div class="mc-tab' + (activeTab === 'template' ? ' active' : '') + '" data-tab="template">模板设置</div>'
      +   '<div class="mc-tab' + (activeTab === 'collect' ? ' active' : '') + '" data-tab="collect">扫码采集</div>'
      +   '<div class="mc-tab' + (activeTab === 'stored' ? ' active' : '') + '" data-tab="stored">暂存区</div>'
      + '</div>'
      + '<div class="mc-tab-content' + (activeTab === 'template' ? ' active' : '') + '" id="mc-tab-template"></div>'
      + '<div class="mc-tab-content' + (activeTab === 'collect' ? ' active' : '') + '" id="mc-tab-collect"></div>'
      + '<div class="mc-tab-content' + (activeTab === 'stored' ? ' active' : '') + '" id="mc-tab-stored"></div>';
    document.body.appendChild(panel);

    document.getElementById('mc-close').onclick = function () {
      isVisible = false;
      panel.classList.remove('mc-show');
    };

    panel.querySelectorAll('.mc-tab').forEach(function (tab) {
      tab.onclick = function () {
        activeTab = tab.dataset.tab;
        panel.querySelectorAll('.mc-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
        panel.querySelectorAll('.mc-tab-content').forEach(function (c) {
          c.classList.toggle('active', c.id === 'mc-tab-' + activeTab);
        });
        if (activeTab === 'template') renderTemplate();
        if (activeTab === 'collect') { renderCollect(); setTimeout(focusCollectInput, 100); }
        if (activeTab === 'stored') renderStored();
      };
    });

    makeDraggable(panel, document.getElementById('mc-header'));
    renderTemplate();
    renderCollect();
    updateHoldCount();
  }

  function makeDraggable(el, handle) {
    var dx = 0, dy = 0, dragging = false;
    handle.onmousedown = function (e) {
      if (e.target.classList.contains('mc-close')) return;
      dragging = true;
      var rect = el.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      e.preventDefault();
    };
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      el.style.left = (e.clientX - dx) + 'px';
      el.style.top = (e.clientY - dy) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  function updateHoldCount() {
    var el = document.getElementById('mc-hold-count');
    if (!el) return;
    var h = loadHoldStore();
    var n = Object.keys(h).length;
    el.innerHTML = '\u6682\u5b58\u533a <span class="mc-num">' + n + '</span> \u7ec4';
  }

  // ===== 模板设置 =====
  function syncTemplateRowsFromDOM() {
    var container = document.getElementById('mc-template-rows');
    if (!container) { templateRows = []; return; }
    templateRows = [];
    var inputs = container.querySelectorAll('.mc-input');
    for (var i = 0; i < inputs.length; i++) templateRows.push(inputs[i].value.trim());
  }

  function renderTemplate() {
    var el = document.getElementById('mc-tab-template');
    if (!el) return;
    var html = '<div class="mc-hint">每行一条物料编码（扫 SN 时接口查出编码自动匹配对应框位）。<br>保存后到"扫码采集"页扫码。</div>';
    html += '<div id="mc-template-rows"></div>';
    html += '<div class="mc-controls">';
    html += '<button class="mc-btn" id="mc-add-row">+ 添加行</button>';
    html += '<button class="mc-btn mc-btn-primary" id="mc-save-template">保存模板</button>';
    html += '<button class="mc-btn mc-btn-danger" id="mc-clear-template">清空</button>';
    html += '</div>';
    html += '<div class="mc-hint" style="margin-top:10px;" id="mc-template-info">已保存: ' + template.length + ' 条</div>';
    el.innerHTML = html;
    renderTemplateRows();

    document.getElementById('mc-add-row').onclick = function () {
      syncTemplateRowsFromDOM();
      templateRows.push('');
      renderTemplateRows();
    };
    document.getElementById('mc-save-template').onclick = function () {
      syncTemplateRowsFromDOM();
      template = templateRows.filter(function (c) { return c; });
      saveTemplate();
      templateRows = template.slice();
      currentSNs = new Array(template.length).fill('');
      renderTemplateRows();
      var info = document.getElementById('mc-template-info');
      if (info) info.textContent = '已保存: ' + template.length + ' 条';
      renderCollect();
    };
    document.getElementById('mc-clear-template').onclick = function () {
      template = []; templateRows = [];
      saveTemplate();
      currentSNs = [];
      renderTemplate();
      renderCollect();
    };
  }

  function renderTemplateRows() {
    var container = document.getElementById('mc-template-rows');
    if (!container) return;
    if (templateRows.length === 0) {
      container.innerHTML = '<div class="mc-empty">点击"+ 添加行"开始设置模板</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < templateRows.length; i++) {
      html += '<div class="mc-row">';
      html += '<span class="mc-idx">' + (i + 1) + '</span>';
      html += '<input class="mc-input" type="text" value="' + escAttr(templateRows[i]) + '" placeholder="物料编码" data-idx="' + i + '">';
      html += '<button class="mc-del-btn" data-del="' + i + '" title="删除">&times;</button>';
      html += '</div>';
    }
    container.innerHTML = html;
    container.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.onclick = function () {
        syncTemplateRowsFromDOM();
        templateRows.splice(parseInt(btn.dataset.del), 1);
        renderTemplateRows();
      };
    });
  }

  // ===== 扫码采集 =====
  function renderCollect() {
    var el = document.getElementById('mc-tab-collect');
    if (!el) return;
    if (template.length === 0) {
      el.innerHTML = '<div class="mc-empty">请先在"模板设置"中添加并保存模板</div>';
      return;
    }
    if (currentSNs.length !== template.length) {
      currentSNs = new Array(template.length).fill('');
    }

    var filledCount = currentSNs.filter(function (s) { return s; }).length;
    var html = '';

    // 模块条码区
    html += '<div class="mc-module-bar' + (currentModule ? ' filled' : '') + '" id="mc-module-bar">';
    html += '<label>\u6A21\u5757\u6761\u7801\uFF08\u626B\u5165\u540E\u81EA\u52A8\u8DF3\u5230 SN \u626B\u7801\uFF09</label>';
    html += '<input class="mc-module-input" type="text" id="mc-module-input" value="' + escAttr(currentModule) + '" placeholder="\u626B\u6A21\u5757\u6761\u7801" autocomplete="off">';
    html += '</div>';

    // 状态栏
    html += '<div class="mc-status">';
    html += '<span>\u7B2C <span class="mc-count">' + setNumber + '</span> \u7EC4</span>';
    html += '<span>\u8FDB\u5EA6 <span class="mc-count' + (filledCount === template.length ? ' done' : '') + '">' + filledCount + '</span>/' + template.length + '</span>';
    if (currentModule) html += '<span style="font-family:Consolas,monospace;color:#1565c0;">' + escAttr(currentModule) + '</span>';
    html += '</div>';

    // SN 框位列表
    html += '<div id="mc-collect-rows"></div>';

    // SN 扫码区
    html += '<div class="mc-scan-area">';
    html += '<label>SN \u626B\u7801\u8F93\u5165\uFF08\u63A5\u53E3\u81EA\u52A8\u6821\u9A8C\u7269\u6599\u7F16\u7801\u2192\u81EA\u52A8\u5206\u914D\u6846\u4F4D\uFF09</label>';
    html += '<input class="mc-scan-input" type="text" id="mc-scan-input" placeholder="\u626B SN" autocomplete="off"' + (currentModule ? '' : ' disabled') + '>';
    html += '<div class="mc-scan-msg" id="mc-scan-msg"></div>';
    html += '</div>';

    // 控制按钮
    html += '<div class="mc-controls">';
    html += '<button class="mc-btn mc-btn-sm" id="mc-refocus">\u91CD\u65B0\u805A\u7126</button>';
    html += '<button class="mc-btn mc-btn-sm mc-btn-primary" id="mc-save-set">\u624B\u52A8\u4FDD\u5B58</button>';
    html += '<button class="mc-btn mc-btn-sm mc-btn-danger" id="mc-clear-current">\u6E05\u7A7A\u5F53\u524D</button>';
    html += '</div>';

    el.innerHTML = html;
    renderCollectRows();

    // 模块条码输入
    var modInput = document.getElementById('mc-module-input');
    if (modInput) {
      modInput.onkeydown = function (e) {
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          onModuleEnter(modInput.value);
          return false;
        }
      };
    }

    var scanInput = document.getElementById('mc-scan-input');
    if (scanInput) {
      scanInput.onkeydown = function (e) {
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          onSnEnter(scanInput.value);
          return false;
        }
      };
    }

    document.getElementById('mc-refocus').onclick = focusCollectInput;
    document.getElementById('mc-save-set').onclick = function () { saveCurrentSet(true); };
    document.getElementById('mc-clear-current').onclick = function () {
      currentModule = '';
      currentSNs = new Array(template.length).fill('');
      renderCollect();
      setTimeout(focusCollectInput, 50);
    };
  }

  function renderCollectRows() {
    var container = document.getElementById('mc-collect-rows');
    if (!container) return;
    var html = '';
    for (var i = 0; i < template.length; i++) {
      var filled = !!currentSNs[i];
      html += '<div class="mc-collect-row' + (filled ? ' filled' : '') + '" data-row="' + i + '">';
      html += '<span class="mc-idx">' + (i + 1) + '</span>';
      html += '<span class="mc-code-label" title="' + escAttr(template[i]) + '">' + escAttr(template[i]) + '</span>';
      html += '<span class="mc-sn-display' + (filled ? ' filled' : '') + '" id="mc-sn-disp-' + i + '">' + escAttr(currentSNs[i] || '') + '</span>';
      html += '<span class="mc-check ' + (filled ? 'done' : 'todo') + '" id="mc-check-' + i + '">' + (filled ? '\u2713' : '\u25CB') + '</span>';
      html += '</div>';
    }
    container.innerHTML = html;
  }

  function setScanMsg(msg, type) {
    var el = document.getElementById('mc-scan-msg');
    if (el) { el.textContent = msg; el.className = 'mc-scan-msg' + (type ? ' ' + type : ''); }
  }

  function setRowStatus(idx, status, sn) {
    var disp = document.getElementById('mc-sn-disp-' + idx);
    var chk = document.getElementById('mc-check-' + idx);
    var row = panel.querySelector('[data-row="' + idx + '"]');
    if (disp) {
      disp.className = 'mc-sn-display';
      disp.textContent = sn != null ? sn : (currentSNs[idx] || '');
      if (status === 'filled') disp.classList.add('filled');
      else if (status === 'querying') disp.classList.add('querying');
      else if (status === 'error') disp.classList.add('error');
    }
    if (chk) {
      chk.className = 'mc-check';
      if (status === 'filled') { chk.classList.add('done'); chk.textContent = '\u2713'; }
      else if (status === 'querying') { chk.classList.add('loading'); chk.textContent = '\u2026'; }
      else if (status === 'error') { chk.classList.add('error'); chk.textContent = '\u2717'; }
      else { chk.classList.add('todo'); chk.textContent = '\u25CB'; }
    }
    if (row) {
      row.classList.toggle('filled', status === 'filled');
    }
  }

  function updateProgress() {
    var filledCount = currentSNs.filter(function (s) { return s; }).length;
    var statusEl = panel.querySelector('.mc-status');
    if (statusEl) {
      var spans = statusEl.querySelectorAll('span');
      if (spans[1]) {
        var cnt = spans[1].querySelector('.mc-count');
        if (cnt) {
          cnt.textContent = filledCount;
          cnt.classList.toggle('done', filledCount === template.length);
        }
      }
    }
  }

  function onModuleEnter(value) {
    var raw = toStr(value).trim();
    if (!raw) return;
    var mod = parseModuleBarcode(raw);
    if (mod.length !== 16) {
      setScanMsg('\u26A0 \u6A21\u5757\u6761\u7801\u89E3\u6790\u540E ' + mod.length + ' \u4F4D\uFF08\u987B 16 \u4F4D\uFF09\uFF0C\u539F\u59CB: ' + raw, 'warn');
      return;
    }
    var h = loadHoldStore();
    var key = holdNormSn(mod);
    if (h[key]) {
      setScanMsg('\u26A0 \u8BE5\u6A21\u5757\u5DF2\u5728\u6682\u5B58\u533A\uFF0C\u8BF7\u5148\u53D6\u51FA\u6216\u5220\u9664', 'warn');
      return;
    }
    currentModule = mod;
    setScanMsg('\u2713 \u6A21\u5757 ' + mod + ' \u5C31\u7EEA\uFF0C\u5F00\u59CB\u626B SN' + (raw !== mod ? '\uFF08\u5DF2\u4ECE ASN \u622A\u53D6\uFF09' : ''), 'ok');
    var modBar = document.getElementById('mc-module-bar');
    if (modBar) modBar.classList.add('filled');
    var modInput = document.getElementById('mc-module-input');
    if (modInput) modInput.value = mod;
    var scanInput = document.getElementById('mc-scan-input');
    if (scanInput) scanInput.disabled = false;
    focusCollectInput();
  }

  function onSnEnter(value) {
    var sn = toStr(value).trim();
    if (!sn) return;
    if (!currentModule) {
      setScanMsg('\u8BF7\u5148\u626B\u6A21\u5757\u6761\u7801', 'err');
      focusModuleInput();
      return;
    }

    // 重复检查
    var snNorm = holdNormSn(sn);
    for (var i = 0; i < currentSNs.length; i++) {
      if (currentSNs[i] && holdNormSn(currentSNs[i]) === snNorm) {
        setScanMsg('\u26A0 \u91CD\u590D SN: ' + sn + ' \u5DF2\u5728\u672C\u7EC4', 'warn');
        clearScanInput();
        return;
      }
    }
    // 跨模块查重
    var h = loadHoldStore();
    var oKeys = Object.keys(h);
    for (var ok = 0; ok < oKeys.length; ok++) {
      var oEnt = h[oKeys[ok]];
      if (!oEnt || !oEnt.items) continue;
      for (var oi = 0; oi < oEnt.items.length; oi++) {
        if (holdNormSn(oEnt.items[oi].sn) === snNorm) {
          setScanMsg('\u2717 SN ' + sn + ' \u4E0E\u6682\u5B58\u533A ' + oEnt.module + ' \u91CD\u590D', 'err');
          clearScanInput();
          return;
        }
      }
    }

    // 串行查码
    queryChain = queryChain.then(function () { return doQuerySn(sn); }).catch(function () {});
    clearScanInput();
  }

  async function doQuerySn(sn) {
    setScanMsg('\u67E5\u7801\u4E2D\u2026 ' + sn, 'busy');
    isQuerying = true;
    var scanInput = document.getElementById('mc-scan-input');
    if (scanInput) scanInput.disabled = true;

    var q;
    try { q = await queryCodeHybrid(sn); }
    catch (e) {
      setScanMsg('\u67E5\u8BE2\u5931\u8D25: ' + (e && e.message ? e.message : e), 'err');
      isQuerying = false;
      if (scanInput) scanInput.disabled = false;
      focusCollectInput();
      return;
    }

    var code = (q && q.code) ? q.code : '';
    var src = (q && q.source) ? q.source : '';
    if (!code) {
      setScanMsg('\u2717 \u672A\u67E5\u5230\u7269\u6599\u7F16\u7801: ' + sn + '\uFF08\u53EF\u53BB SN \u89C4\u5219\u515C\u5E95\u6DFB\u52A0\u89C4\u5219\uFF09', 'err');
      isQuerying = false;
      if (scanInput) scanInput.disabled = false;
      focusCollectInput();
      return;
    }

    // v0.5：收集所有候选编码（原始 + 接口二转换编码，双向）
    var candidateCodes = [code];
    var converted = findConvertedCodes(code);
    for (var ci = 0; ci < converted.length; ci++) {
      if (candidateCodes.indexOf(converted[ci]) < 0) candidateCodes.push(converted[ci]);
    }

    // 匹配模板——尝试所有候选编码
    var matchedIdx = -1;
    var matchedCode = '';
    for (var candI = 0; candI < candidateCodes.length && matchedIdx < 0; candI++) {
      var tryCode = candidateCodes[candI];
      var snCodeNorm = extractLeftCodeSmartLocal(tryCode);
      for (var i = 0; i < template.length; i++) {
        var tplCodeNorm = extractLeftCodeSmartLocal(template[i]);
        if (tplCodeNorm === snCodeNorm && !currentSNs[i]) {
          matchedIdx = i;
          matchedCode = tryCode;
          break;
        }
      }
    }

    if (matchedIdx < 0) {
      // 看是不是模板里有但已填（用所有候选编码检查）
      for (var candJ = 0; candJ < candidateCodes.length; candJ++) {
        var tryCodeJ = candidateCodes[candJ];
        var tryCodeNormJ = extractLeftCodeSmartLocal(tryCodeJ);
        for (var j = 0; j < template.length; j++) {
          var tcn = extractLeftCodeSmartLocal(template[j]);
          if (tcn === tryCodeNormJ && currentSNs[j]) {
            setScanMsg('\u26A0 \u7269\u6599\u7F16\u7801 ' + code + ' \u5BF9\u5E94\u6846\u4F4D\u5DF2\u586B: ' + currentSNs[j], 'warn');
            isQuerying = false;
            if (scanInput) scanInput.disabled = false;
            focusCollectInput();
            return;
          }
        }
      }
      var codeDisplay = candidateCodes.length > 1 ? code + ' (转换: ' + candidateCodes.slice(1).join(', ') + ')' : code;
      setScanMsg('\u2717 \u7269\u6599\u7F16\u7801 ' + codeDisplay + ' \u4E0D\u5728\u6A21\u677F\u4E2D\uFF08SN: ' + sn + '\uFF09\u2014\u2014\u53EF\u590D\u5236\u7F16\u7801\u53BB\u6A21\u677F\u6DFB\u52A0', 'err');
      isQuerying = false;
      if (scanInput) scanInput.disabled = false;
      focusCollectInput();
      return;
    }

    // 填入
    setRowStatus(matchedIdx, 'querying', sn);
    await sleep(100);
    currentSNs[matchedIdx] = sn;
    setRowStatus(matchedIdx, 'filled', sn);
    updateProgress();

    var filledCount = currentSNs.filter(function (s) { return s; }).length;
    var srcTag = src === 'openapi' ? '[\u63A5\u53E32]' : src === 'ems-find' ? '[\u63A5\u53E31]' : '';
    var convertTag = matchedCode !== code ? ' \u2192\u8F6C\u6362 ' + matchedCode : '';
    if (filledCount === template.length) {
      setScanMsg('\u2713 \u5168\u90E8\u586B\u6EE1\uFF0C\u81EA\u52A8\u4FDD\u5B58\u2026', 'ok');
      await sleep(300);
      saveCurrentSet(false);
    } else {
      setScanMsg('\u2713 \u7269\u6599\u7F16\u7801 ' + matchedCode + ' ' + srcTag + convertTag + ' \u2192 \u6846 ' + (matchedIdx + 1) + '\uFF08' + filledCount + '/' + template.length + '\uFF09', 'ok');
    }

    isQuerying = false;
    if (scanInput) scanInput.disabled = false;
    focusCollectInput();
  }

  function clearScanInput() {
    var el = document.getElementById('mc-scan-input');
    if (el) el.value = '';
  }

  function focusCollectInput() {
    if (!currentModule) { focusModuleInput(); return; }
    var el = document.getElementById('mc-scan-input');
    if (el && !el.disabled) { try { el.focus(); } catch (e) {} }
    else focusModuleInput();
  }

  function focusModuleInput() {
    var el = document.getElementById('mc-module-input');
    if (el) { try { el.focus(); el.select(); } catch (e) {} }
  }

  function saveCurrentSet(manual) {
    var filledCount = currentSNs.filter(function (s) { return s; }).length;
    if (filledCount === 0) {
      setScanMsg('\u6CA1\u6709\u5DF2\u586B SN\uFF0C\u65E0\u6CD5\u4FDD\u5B58', 'err');
      return;
    }
    if (!currentModule) {
      setScanMsg('\u8BF7\u5148\u626B\u6A21\u5757\u6761\u7801', 'err');
      focusModuleInput();
      return;
    }
    if (currentModule.length !== 16) {
      setScanMsg('\u6A21\u5757\u6761\u7801\u4E0D\u662F 16 \u4F4D', 'err');
      return;
    }

    var h = loadHoldStore();
    var key = holdNormSn(currentModule);
    if (h[key]) {
      setScanMsg('\u8BE5\u6A21\u5757\u5DF2\u5728\u6682\u5B58\u533A', 'err');
      return;
    }

    var items = [];
    for (var i = 0; i < currentSNs.length; i++) {
      if (currentSNs[i]) items.push({ sn: holdNormSn(currentSNs[i]), boxId: '', code: template[i] || '' });
    }

    // 跨模块查重
    for (var di = 0; di < items.length; di++) {
      var oKeys = Object.keys(h);
      for (var oj = 0; oj < oKeys.length; oj++) {
        var oEnt = h[oKeys[oj]];
        if (!oEnt || !oEnt.items) continue;
        for (var oj2 = 0; oj2 < oEnt.items.length; oj2++) {
          if (holdNormSn(oEnt.items[oj2].sn) === holdNormSn(items[di].sn)) {
            setScanMsg('SN ' + items[di].sn + ' \u4E0E\u6682\u5B58\u533A ' + oEnt.module + ' \u91CD\u590D\uFF0C\u4E0D\u4FDD\u5B58', 'err');
            return;
          }
        }
      }
    }

    h[key] = { module: currentModule, holdTs: Date.now(), count: items.length, total: template.length, items: items };
    saveHoldStore(h);
    console.log('[MC] \u4FDD\u5B58\u5230\u4E00\u4F53\u5316\u6682\u5B58\u533A:', currentModule, items.length + ' SN');

    panel.classList.add('mc-flash');
    setTimeout(function () { panel.classList.remove('mc-flash'); }, 600);

    setScanMsg('\u2713 \u5DF2\u4FDD\u5B58 ' + currentModule + '\uFF08' + items.length + ' SN\uFF09\u2192\u4E00\u4F53\u5316\u6682\u5B58\u533A', 'ok');

    currentModule = '';
    currentSNs = new Array(template.length).fill('');
    setNumber++;
    updateHoldCount();
    renderStored();
    setTimeout(function () {
      renderCollect();
      setTimeout(focusModuleInput, 50);
    }, 400);
  }

  // ===== 暂存区（只读，取出/删请到一体化面板）=====
  function renderStored() {
    var el = document.getElementById('mc-tab-stored');
    if (!el) return;
    var h = loadHoldStore();
    var keys = Object.keys(h).sort(function (a, b) { return (h[a].holdTs || 0) - (h[b].holdTs || 0); });
    if (keys.length === 0) {
      el.innerHTML = '<div class="mc-empty">\u6682\u5B58\u533A\u4E3A\u7A7A<br><br>\u5230\u201C\u626B\u7801\u91C7\u96C6\u201D\u9875\u626B\u7801\u91C7\u96C6\u6570\u636E</div>';
      return;
    }
    var html = '<div class="mc-hint">\u53D6\u51FA/\u5220\u9664\u8BF7\u5230\u4E00\u4F53\u5316\u811A\u672C\u7684\u6682\u5B58\u9762\u677F\u64CD\u4F5C</div>';
    html += '<div class="mc-stored-list">';
    for (var i = 0; i < keys.length; i++) {
      var e = h[keys[i]];
      var sns = (e.items || []).map(function (it) { return it.sn; }).join(', ');
      html += '<div class="mc-stored-item">';
      html += '<span class="mc-mod">' + escAttr(e.module) + '</span>';
      html += '<span class="mc-sub">' + e.count + ' SN \xB7 ' + timeStr(e.holdTs) + '</span>';
      html += '</div>';
      html += '<div class="mc-hint" style="margin:-2px 0 6px 8px;font-family:Consolas,monospace;color:#475569;">' + escAttr(sns) + '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  // ===== 初始化 =====
  function init() {
    loadTemplate();
    templateRows = template.slice();
    currentSNs = new Array(template.length).fill('');
    activeTab = template.length > 0 ? 'collect' : 'template';
    createUI();
    console.log('[MC] \u624B\u52A8\u6682\u5B58\u91C7\u96C6 v0.2 \u5DF2\u52A0\u8F7D | \u6A21\u677F ' + template.length + ' \u6761');
  }

  if (document.readyState !== 'loading') {
    setTimeout(init, 800);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 800); });
  }
})();
