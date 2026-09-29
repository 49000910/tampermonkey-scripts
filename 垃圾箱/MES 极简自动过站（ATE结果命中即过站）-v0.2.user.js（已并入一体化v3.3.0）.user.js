// ==UserScript==
// @name         MES 极简自动过站（ATE结果命中即过站）
// @namespace    tm.mes.autopass.ate.result
// @version      0.2
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

    while (Date.now() - start < 10000) {
      try {
        var st = JSON.parse(localStorage.getItem(KEY) || 'null');

        if (st && st.ok && Date.now() - Number(st.ts || 0) < 10000) {
          console.log('[MES授权门禁] 已授权，脚本继续运行：', st.jobNumber);
          return true;
        }
      } catch (e) {}

      await new Promise(function (r) {
        setTimeout(r, 300);
      });
    }

    console.warn('[MES授权门禁] 未授权，脚本已停止运行');
    return false;
  }

  if (!(await __MES_AUTH_GATE__())) return;
  // ===== MES授权门禁 END =====

  if (!location.href.includes('#/ProductTrackInOut')) return;

  // 后面是你的代码


  // 这里换成你抓到的完整URL
  var ATE_URL = 'https://w3.huawei.com/mespmm/gateway/S007307:mespmmrptservice/mespmm/rpt/services/wipAteFacade/selectPrintAteTestResultList/page/10/1/1/0';

var INTERVAL_MS = 1200;

var SN_CODE_CHECK_GATE_KEY = 'sn_code_check_gate_status';
var SN_CODE_GATE_STALE_MS = 120000;

// ===== 自动过站模式 =====
// bom_ate  = BOM子项校验通过 + ATE通过 后过站
// bom_only = 只要BOM子项校验通过就过站，不查ATE
var AUTO_PASS_MODE_KEY = 'auto_pass_mode';
var AUTO_PASS_MODE_BOM_ATE = 'bom_ate';
var AUTO_PASS_MODE_BOM_ONLY = 'bom_only';

var autoPassMode = localStorage.getItem(AUTO_PASS_MODE_KEY) || AUTO_PASS_MODE_BOM_ATE;


  var timer = null;
  var busy = false;

  // 已经自动点过过站的SN，防止重复点
  var passedSet = new Set();

  // 连续未命中次数，仅用于角标显示
  var missCountMap = new Map();

  // ===== 状态角标 =====
 var badge = document.createElement('div');
    badge.style.position = 'fixed';
    badge.style.left = '12px';
    badge.style.bottom = '12px';
    badge.style.zIndex = '2147483647';

    badge.style.padding = '6px 10px';
    badge.style.borderRadius = '8px';
    badge.style.background = '#1677ff';
    badge.style.color = '#fff';
    badge.style.fontSize = '12px';
    badge.style.boxShadow = '0 4px 12px rgba(0,0,0,.2)';
    badge.textContent = '自动过站：初始化';

  function appendBadge() {
    if (!document.body.contains(badge)) {
      document.body.appendChild(badge);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', appendBadge);
  } else {
    appendBadge();
  }

  function setBadge(text, color) {
    badge.textContent = '自动过站：' + text;
    badge.style.background = color || '#1677ff';
    console.log('[AUTO-PASS]', text);
  }
function syncAutoPassMode() {
  autoPassMode = localStorage.getItem(AUTO_PASS_MODE_KEY) || AUTO_PASS_MODE_BOM_ATE;
}

function createAutoPassModePanel() {
  var panel = document.createElement('div');
  panel.id = '__auto_pass_mode_panel';
  panel.style.position = 'fixed';
  panel.style.right = '12px';
  panel.style.bottom = '52px';
  panel.style.zIndex = '2147483647';
  panel.style.padding = '8px 10px';
  panel.style.borderRadius = '8px';
  panel.style.background = '#fff';
  panel.style.color = '#333';
  panel.style.fontSize = '12px';
  panel.style.boxShadow = '0 4px 12px rgba(0,0,0,.2)';
  panel.style.border = '1px solid #d9d9d9';
  panel.style.lineHeight = '1.8';

  var title = document.createElement('div');
  title.textContent = '自动过站模式';
  title.style.fontWeight = '700';
  title.style.marginBottom = '4px';
  panel.appendChild(title);

  function makeRadio(text, value) {
    var label = document.createElement('label');
    label.style.display = 'block';
    label.style.cursor = 'pointer';
    label.style.whiteSpace = 'nowrap';

    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = '__auto_pass_mode_radio';
    radio.value = value;
    radio.checked = autoPassMode === value;
    radio.style.marginRight = '6px';

    radio.addEventListener('change', function () {
      if (!radio.checked) return;

      localStorage.setItem(AUTO_PASS_MODE_KEY, value);
      syncAutoPassMode();

      if (autoPassMode === AUTO_PASS_MODE_BOM_ATE) {
        setBadge('模式：校验+ATE过站', '#1677ff');
      } else {
        setBadge('模式：只校验过站', '#fa8c16');
      }
    });

    label.appendChild(radio);
    label.appendChild(document.createTextNode(text));
    return label;
  }

  panel.appendChild(makeRadio('校验 + ATE过站', AUTO_PASS_MODE_BOM_ATE));
  panel.appendChild(makeRadio('只校验过站', AUTO_PASS_MODE_BOM_ONLY));

  function append() {
    if (!document.getElementById('__auto_pass_mode_panel')) {
      document.body.appendChild(panel);
    }
  }

  if (document.body) {
    append();
  } else {
    document.addEventListener('DOMContentLoaded', append);
  }
}

// createAutoPassModePanel(); // 模式开关已移到一体化面板脚本


window.addEventListener('storage', function (e) {
  if (e.key === AUTO_PASS_MODE_KEY) {
    syncAutoPassMode();
  }
});

  function toStr(v) {
    return v == null ? '' : String(v).trim();
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function fmtDateTime(d, endOfDay) {
    return [
      d.getFullYear(),
      pad(d.getMonth() + 1),
      pad(d.getDate())
    ].join('-') + (endOfDay ? ' 23:59:59' : ' 00:00:00');
  }

  function getParentInput() {
    var all = [].slice.call(document.querySelectorAll(
      'div[id^="Input_"] > input.hae-ui-input[type="text"], div[id^="Input_"] > input'
    ));

    for (var i = 0; i < all.length; i++) {
      var box = all[i].closest('div[id^="Input_"]');
      var ctx = ((box && box.parentElement ? box.parentElement.innerText : '') || '').replace(/\s+/g, '');
      if (ctx.indexOf('条码采集') >= 0) return all[i];
    }

    return all[3] || null;
  }
function normGateParent(v) {
  return v == null ? '' : String(v).replace(/\s+/g, '').toUpperCase();
}

function readSnCodeGate(currentParentSn) {
  var raw = localStorage.getItem(SN_CODE_CHECK_GATE_KEY);


  if (!raw) {
    return {
      ok: false,
      msg: '未收到BOM子项SN校验状态'
    };
  }

  var data = null;

  try {
    data = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      msg: 'BOM子项SN状态解析失败'
    };
  }

  if (!data || !data.ts) {
    return {
      ok: false,
      msg: 'BOM子项SN状态无效'
    };
  }

  if (Date.now() - data.ts > SN_CODE_GATE_STALE_MS) {
    return {
      ok: false,
      msg: 'BOM子项SN状态过期'
    };
  }

  if (!data.parentSn) {
    return {
      ok: false,
      msg: '未识别父项条码'
    };
  }

  if (normGateParent(data.parentSn) !== normGateParent(currentParentSn)) {
    return {
      ok: false,
      msg: '父项条码不一致，等待BOM状态刷新'
    };
  }

  if (!data.total) {
    return {
      ok: false,
      msg: '未检测到BOM子项SN框'
    };
  }

  if (data.filled < data.total) {
    return {
      ok: false,
      msg: 'BOM子项未扫完 ' + data.filled + '/' + data.total
    };
  }

  if (data.duplicate > 0) {
    return {
      ok: false,
      msg: 'BOM子项重复条码 ' + data.duplicate + ' 个'
    };
  }

  if (data.pending > 0) {
    return {
      ok: false,
      msg: 'BOM子项校验中 ' + data.pending + ' 个'
    };
  }

  if (data.bad > 0) {
    return {
      ok: false,
      msg: 'BOM子项编码异常 ' + data.bad + ' 个'
    };
  }

  if (!data.allOk) {
    return {
      ok: false,
      msg: 'BOM子项未全部通过'
    };
  }

  return {
    ok: true,
    msg: 'BOM子项校验通过 ' + data.ok + '/' + data.total,
    data: data
  };
}

  function getPassBtn() {
    var list = document.querySelectorAll('button.hae-btn');

    for (var i = 0; i < list.length; i++) {
      var txt = (list[i].innerText || '').replace(/\s+/g, '');
      var hasSaveIcon = !!list[i].querySelector('.hae-icon.icon-save');

      if (txt === '过站' && hasSaveIcon) return list[i];
    }

    return null;
  }

  function buildBody(sn) {
  var end = new Date();


    // 你抓到的是大约往前半年，这里用180天，够查最近ATE结果
    var start = new Date(end.getTime() - 180 * 24 * 3600 * 1000);

    return {
      siteId: '50',
      workProcess: null,
      workSite: null,
      barCode: sn,
      testResult: null,
      tpsName: null,
      equipmentSn: null,
      createdFrom: fmtDateTime(start, false),
      createdTo: fmtDateTime(end, true)
    };
  }

  async function postJson(url, body) {
    console.groupCollapsed('[AUTO-PASS] 查询ATE');
    console.log('URL:', url);
    console.log('Body:', body);
    console.groupEnd();

    var r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    var text = await r.text();

    console.groupCollapsed('[AUTO-PASS] ATE返回 ' + r.status);
    console.log('responseText:', text.slice(0, 1500));
    console.groupEnd();

    if (!r.ok) {
      throw new Error('HTTP ' + r.status + '：' + text.slice(0, 200));
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('JSON解析失败：' + text.slice(0, 200));
    }
  }

  function getRows(j) {
    if (
      j &&
      j.resultObjVO &&
      Array.isArray(j.resultObjVO.result)
    ) {
      return j.resultObjVO.result;
    }

    return [];
  }

  // 新接口命中规则：
  // testResult === "0" 或 orgTestResult === "0" 或 mesTestResult === "Y"
  function hitRule(row, sn) {
    if (!row) return false;

    var barCode = toStr(row.barCode);
    if (barCode && barCode !== sn) return false;

    var testResult = toStr(row.testResult);
    var orgTestResult = toStr(row.orgTestResult);
    var mesTestResult = toStr(row.mesTestResult).toUpperCase();
    var failDesc = toStr(row.failDesc);

    return testResult === '0' ||
           orgTestResult === '0' ||
           mesTestResult === 'Y' ||
           failDesc.indexOf('成功') >= 0;
  }

  async function queryAtePass(sn) {
    var j = await postJson(ATE_URL, buildBody(sn));
    var rows = getRows(j);

    console.log('[AUTO-PASS] ATE rows:', rows.length);
    if (rows.length) console.table(rows.slice(0, 5));

    var hit = rows.some(function (row) {
      return hitRule(row, sn);
    });

    return {
      hit: hit,
      rows: rows,
      raw: j
    };
  }

  async function checkLoop() {
    if (busy) return;
    busy = true;

    try {
      var input = getParentInput();

      if (!input) {
        setBadge('未找到条码采集框', '#cf1322');
        return;
      }

      var sn = toStr(input.value);

      if (!sn) {
        setBadge('等待扫码', '#1677ff');
        return;
      }

    if (passedSet.has(sn)) {
  setBadge('已处理：' + sn, '#389e0d');
  return;
}

syncAutoPassMode();

// 第一步：无论哪个模式，都必须先校验BOM子项SN
var gate = readSnCodeGate(sn);
if (!gate.ok) {
  setBadge('等待BOM校验：' + gate.msg, '#fa8c16');
  return;
}

// 第二步：根据模式决定是否查询ATE
if (autoPassMode === AUTO_PASS_MODE_BOM_ATE) {
  setBadge(gate.msg + '，查询ATE：' + sn, '#1677ff');

  var ret = await queryAtePass(sn);

  if (!ret.hit) {
    var n = (missCountMap.get(sn) || 0) + 1;
    missCountMap.set(sn, n);

    setBadge('ATE未通过/未出结果，继续等 ' + n + '：' + sn, '#fa8c16');
    return;
  }

  setBadge('BOM校验通过，ATE通过，准备过站：' + sn, '#389e0d');

} else if (autoPassMode === AUTO_PASS_MODE_BOM_ONLY) {
  setBadge('BOM校验通过，只校验模式，准备过站：' + sn, '#fa8c16');

} else {
  setBadge('未知过站模式，禁止过站', '#cf1322');
  return;
}


      var btn = getPassBtn();

      if (!btn) {
        setBadge('校验通过，但未找到过站按钮', '#cf1322');
        return;
      }

      btn.click();

      passedSet.add(sn);
      missCountMap.delete(sn);

      setBadge('已自动过站：' + sn, '#389e0d');
    } catch (e) {
      console.error('[AUTO-PASS] 异常详情:', e);
      setBadge('异常：' + (e && e.message ? e.message : String(e)), '#cf1322');
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;

    timer = setInterval(checkLoop, INTERVAL_MS);
    setBadge('运行中', '#1677ff');

    // 启动后立即查一次
    setTimeout(checkLoop, 300);
  }

  window.autoPassAteTest = async function (sn) {
    sn = toStr(sn);
    if (!sn) {
      console.warn('用法：autoPassAteTest("SN")');
      return;
    }

    var ret = await queryAtePass(sn);
    console.log('[AUTO-PASS TEST] hit:', ret.hit);
    console.log('[AUTO-PASS TEST] rows:', ret.rows);
    return ret;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
