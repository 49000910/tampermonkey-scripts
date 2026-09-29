// ==UserScript==
// @name         自动过站双模式控制面板（SN门禁 / 测试记录）
// @namespace    tm.auto.pass.dual.panel
// @version      1.0.1
// @match        https://w3.huawei.com/mespmm/wipweb*
// @grant        GM_xmlhttpRequest
// @connect      w3.huawei.com
// ==/UserScript==

(function () {
  'use strict';
  if (!location.href.includes('#/ProductTrackInOut')) return;

  // ===== 开关 =====
  const KEY_SN_GUARD_ON = 'sn_guard_auto_pass_on';   // SN门禁过站
  const KEY_HUMEP_ON = 'sn_humep_auto_pass_on';      // 测试记录过站
  const KEY_MODE = 'sn_dual_pass_mode';              // OR / AND
  const KEY_POS = 'sn_dual_pass_panel_pos';          // 面板位置

  if (localStorage.getItem(KEY_SN_GUARD_ON) == null) localStorage.setItem(KEY_SN_GUARD_ON, '0');
  if (localStorage.getItem(KEY_HUMEP_ON) == null) localStorage.setItem(KEY_HUMEP_ON, '0');
  if (localStorage.getItem(KEY_MODE) == null) localStorage.setItem(KEY_MODE, 'OR');

  const SN_SELECTOR = 'input[id^="sn"]';
  const HUMEP_URL = 'https://w3.huawei.com/mes/qmgateway/com.huawei.mes.qualitytraceability:huMepDataReport/queryByCond';

  let busy = false;
  let cooldownUntil = 0;
  let lastSn = '';
  let lastHumepHit = null;

function toStr(v){ return v == null ? '' : String(v).trim(); }


  function norm(v){
    v = toStr(v).replace(/\s+/g, '');
    if (v.indexOf('：') >= 0) v = v.split('：').pop();
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v.toUpperCase();
  }

  function isSnOn(){ return localStorage.getItem(KEY_SN_GUARD_ON) === '1'; }
  function isHumepOn(){ return localStorage.getItem(KEY_HUMEP_ON) === '1'; }
  function mode(){ return (localStorage.getItem(KEY_MODE) || 'OR').toUpperCase(); }

  function getPassBtn() {
    var list = document.querySelectorAll('button.hae-btn,button.btn-primary,button');
    for (var i = 0; i < list.length; i++) {
      var txt = (list[i].innerText || '').replace(/\s+/g, '');
      var hasSaveIcon = !!list[i].querySelector('.hae-icon.icon-save');
      if (txt === '过站' || (txt.indexOf('过站') >= 0 && hasSaveIcon)) return list[i];
    }
    return null;
  }

  function getParentInput() {
    var all = [].slice.call(document.querySelectorAll('div[id^="Input_"] > input.hae-ui-input[type="text"],div[id^="Input_"] > input'));
    for (var i = 0; i < all.length; i++) {
      var box = all[i].closest('div[id^="Input_"]');
      var ctx = ((box && box.parentElement ? box.parentElement.innerText : '') || '').replace(/\s+/g, '');
      if (ctx.indexOf('条码采集') >= 0) return all[i];
    }
    return all[0] || null;
  }

  function currentBarcode(){
    var el = getParentInput();
    return toStr(el && el.value);
  }

  function allSnFilledNoDup() {
    var els = [].slice.call(document.querySelectorAll(SN_SELECTOR));
    if (!els.length) return false;

    var seen = new Set();
    for (var i = 0; i < els.length; i++) {
      var sn = norm(els[i].value);
      if (!sn) return false;
      if (seen.has(sn)) return false;
      seen.add(sn);
    }
    return true;
  }

  // 若你的SN脚本提供了更严格函数，优先用它
  function snPass() {
    try {
      if (typeof window.__snCanAutoPass === 'function') return !!window.__snCanAutoPass();
      if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.__snCanAutoPass === 'function') return !!unsafeWindow.__snCanAutoPass();
    } catch (e) {}
    return allSnFilledNoDup();
  }

  function pad2(n){ return n < 10 ? '0' + n : '' + n; }
  function fmtDate(d){ return [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join('-'); }

  function buildHumepBody(sn) {
    var end = new Date();
    var start = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
    return {
      filter: "sn='" + sn + "'",
      pageNo: 1,
      pageSize: 60,
      isReplaceSensitiveInfo: true,
      startDate: fmtDate(start),
      endDate: fmtDate(end),
      orderBy: [
        { sort: 'asc', column: 'sn', type: 'String' },
        { sort: 'desc', column: 'starttime', type: 'Date' }
      ]
    };
  }

  function humepHitRule(row){
    return String((row && row.tracedesc) || '').indexOf('成功') >= 0 ||
           Number(row && row.result) === 0;
  }

  function gmPost(url, data) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(data),
        timeout: 20000,
        onload: function (res) {
          try { resolve(JSON.parse(res.responseText)); }
          catch (e) { reject(new Error('JSON解析失败')); }
        },
        onerror: function (e) { reject(e); },
        ontimeout: function () { reject(new Error('请求超时')); }
      });
    });
  }

  async function humepPass() {
    var sn = currentBarcode();
    if (!sn) { lastHumepHit = null; return false; }

    // 同SN用缓存
    if (sn === lastSn && lastHumepHit != null) return lastHumepHit;

    var j = await gmPost(HUMEP_URL, buildHumepBody(sn));
    var list = (j && j.result && Array.isArray(j.result.data)) ? j.result.data : [];
    var hit = list.some(humepHitRule);

    lastSn = sn;
    lastHumepHit = hit;
    return hit;
  }

  function setStatus(msg, color){
    var el = document.getElementById('sn-dual-pass-status');
    if (el) {
      el.textContent = msg;
      el.style.color = color || '#666';
    }
  }

  function canClick(){ return Date.now() >= cooldownUntil; }
  function markClick(){ cooldownUntil = Date.now() + 2500; }

  async function loop() {
    if (busy) return;
    busy = true;

    try {
      var onSn = isSnOn();
      var onHm = isHumepOn();
      var md = mode();

      if (!onSn && !onHm) {
        setStatus('待命（两个开关都关闭）', '#666');
        return;
      }

      var passBtn = getPassBtn();
      if (!passBtn) {
        setStatus('未找到过站按钮', '#cf1322');
        return;
      }

      var snOk = onSn ? snPass() : null;
      var hmOk = onHm ? await humepPass() : null;

      var allow = false;
      if (onSn && onHm) {
        allow = (md === 'AND') ? (snOk && hmOk) : (snOk || hmOk);
      } else if (onSn) {
        allow = !!snOk;
      } else if (onHm) {
        allow = !!hmOk;
      }

      if (!allow) {
        var detail = [];
        if (onSn) detail.push('SN=' + (snOk ? '通过' : '未通过'));
        if (onHm) detail.push('测试记录=' + (hmOk ? '命中' : '未命中'));
        setStatus('未满足过站条件：' + detail.join(' / '), '#fa8c16');
        return;
      }

      if (!canClick()) return;
      passBtn.click();
      markClick();
      setStatus('已自动过站（' + (onSn && onHm ? md : (onSn ? 'SN' : '测试记录')) + '）', '#389e0d');
    } catch (e) {
      setStatus('异常：' + (e && e.message ? e.message : e), '#cf1322');
    } finally {
      busy = false;
    }
  }

  // ===== 控制面板 =====
  function buildPanel() {
    if (document.getElementById('sn-dual-pass-panel')) return;

    var p = document.createElement('div');
    p.id = 'sn-dual-pass-panel';
    p.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;background:#fff;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.15);font-size:12px;padding:10px;width:300px;';
    p.innerHTML =
      '<div id="sn-dual-head" style="font-weight:600;cursor:move;display:flex;justify-content:space-between;align-items:center;">' +
      '<span>自动过站双模式</span><button id="sn-dual-mini" style="border:0;background:#f0f0f0;border-radius:6px;padding:2px 8px;cursor:pointer;">最小化</button></div>' +
      '<div id="sn-dual-body" style="margin-top:8px;">' +
      '<label style="display:block;margin-bottom:6px;"><input id="sn-dual-sn" type="checkbox"> SN校验过站</label>' +
      '<label style="display:block;margin-bottom:6px;"><input id="sn-dual-hm" type="checkbox"> 测试记录过站</label>' +
      '<div style="margin:6px 0;">组合模式：' +
      '<label><input name="sn-dual-mode" type="radio" value="OR"> OR</label> ' +
      '<label><input name="sn-dual-mode" type="radio" value="AND"> AND</label></div>' +
      '<div id="sn-dual-pass-status" style="color:#666;">待命</div>' +
      '</div>';

    document.body.appendChild(p);

    var snEl = p.querySelector('#sn-dual-sn');
    var hmEl = p.querySelector('#sn-dual-hm');
    var modeEls = p.querySelectorAll('input[name="sn-dual-mode"]');
    var mini = p.querySelector('#sn-dual-mini');
    var body = p.querySelector('#sn-dual-body');

    snEl.checked = isSnOn();
    hmEl.checked = isHumepOn();
    [].forEach.call(modeEls, function (r) { r.checked = (r.value === mode()); });

    snEl.addEventListener('change', function () {
      localStorage.setItem(KEY_SN_GUARD_ON, snEl.checked ? '1' : '0');
    });
    hmEl.addEventListener('change', function () {
      localStorage.setItem(KEY_HUMEP_ON, hmEl.checked ? '1' : '0');
      lastHumepHit = null;
      lastSn = '';
    });
    [].forEach.call(modeEls, function (r) {
      r.addEventListener('change', function () {
        if (r.checked) localStorage.setItem(KEY_MODE, r.value);
      });
    });

    var collapsed = false;
    mini.addEventListener('click', function () {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : '';
      mini.textContent = collapsed ? '展开' : '最小化';
    });

    // 拖拽
    (function drag(panel, head) {
      var down = false, sx = 0, sy = 0, ox = 0, oy = 0;
      head.addEventListener('mousedown', function (e) {
        down = true; sx = e.clientX; sy = e.clientY;
        var r = panel.getBoundingClientRect();
        ox = r.left; oy = r.top;
        panel.style.left = ox + 'px';
        panel.style.top = oy + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', function (e) {
        if (!down) return;
        panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      });
      document.addEventListener('mouseup', function () {
        if (!down) return;
        down = false;
        document.body.style.userSelect = '';
        var r = panel.getBoundingClientRect();
        localStorage.setItem(KEY_POS, JSON.stringify({ left: r.left, top: r.top }));
      });
    })(p, p.querySelector('#sn-dual-head'));

    // 恢复位置
    try {
      var pos = JSON.parse(localStorage.getItem(KEY_POS) || '{}');
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        p.style.left = Math.max(0, pos.left) + 'px';
        p.style.top = Math.max(0, pos.top) + 'px';
        p.style.right = 'auto';
        p.style.bottom = 'auto';
      }
    } catch (e) {}
  }

  buildPanel();
  setInterval(loop, 1200);
})();
