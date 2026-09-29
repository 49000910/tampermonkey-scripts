// ==UserScript==
// @name         MES 原表格叠加显示超过100条
// @namespace    mes.inline.stack.grid
// @version      1.20
// @description  MES条码采集表格满100条后直接叠加，所有控件设置(去重/分组/高度)永久记忆，每小时节拍按行动态统计（同条码不同工序各计一次；一体化批量队列运行期间暂停统计（读 tm_bulk_passing 开关，不存条码）；重置=按当前页行重新统计；v1.16 联动统计：勾选"联动"的多个窗口共享每小时节拍总数（跨窗口 localStorage 汇总，各窗口都显示总和）；v1.17 联动保活修复：后台窗口 1s 心跳被 Chrome 限流（最慢 1 次/分）→ ts 超 60s 被其他窗口判死、总数掉数/新窗口加不上 → ① 任一窗口写 map 触发 storage 事件，其余窗口立即补心跳（限流下事件仍送达，5s 防抖）② 回前台 visibilitychange 立即补写 ③ 过期阈值 60s→120s ④ pagehide 关闭时自删不残留）
// @match        https://w3.huawei.com/mespmm/wipweb*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(async function () {
  'use strict';

  // ===== MES授权门禁 START =====
  async function __MES_AUTH_GATE__() {
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


  const ROUTE_KEY = '#/ProductTrackInOut';
  const GRID_SELECTOR = '#Grid_18799581';
  const MAX_KEEP = 1000;
  const RENUMBER_SEQ = true;
  const CHECK_INTERVAL = 800;

  // ===== 统一的本地设置保存与读取 =====
  const SETTINGS_KEY = 'MES_INLINE_GRID_SETTINGS_V1';
  const defaultSettings = {
    heightOffset: 510,
    onlyUnique: false,
    groupSize: 0
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      return Object.assign({}, defaultSettings, saved);
    } catch (e) {
      return defaultSettings;
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      heightOffset: heightOffset,
      onlyUnique: onlyUnique,
      groupSize: groupSize
    }));
  }

  // 初始化变量时直接读取本地设置
  let settings = loadSettings();
  let heightOffset = settings.heightOffset;
  let onlyUnique = settings.onlyUnique;
  let groupSize = settings.groupSize;
  // ==================================

  let accRows = [];
  let rendering = false;
  let lastRenderedSig = '';
  let observer = null;
  let timer = null;
  let uphTimer = null;
  let currentTbody = null;
  let started = false;

  // 温和但稍微深一点、清晰点的分组背景色 (柔蓝, 柔黄, 柔绿)
  const softColors = ['#d4e6fc', '#fdf2cf', '#d8efd1'];

  // ========= UPH 按小时统计（按行动态计数：同条码不同工序算多次） =========
  let currentHourKey = new Date().getHours();
  let uphKeys = new Set();

  // 行身份键：去掉会随过站状态变化的字段（snProcessStatus/goodRateQty/scrappedQty），
  // 同一 SN 在不同工序（workstepName）出现 = 不同键 = 各计一次
  function uphKeyOf(r) {
    const d = r.data || {};
    return [d.sn, d.rootSn, d.pId, d.taskNo, d.partNo, d.workstepName, d.snGrade].join('|');
  }

  function log(...args) {
    console.log('[MES原表格叠加]', ...args);
  }

  function isTargetRoute() {
    return location.href.includes(ROUTE_KEY);
  }

  function getGrid() {
    return document.querySelector(GRID_SELECTOR) || document.querySelector('.hae-grid');
  }

  function getTbody() {
    const grid = getGrid();
    return grid && grid.querySelector('.grid-body-content');
  }

  function getBody() {
    const grid = getGrid();
    return grid && grid.querySelector('.grid-body');
  }

  function txt(el) {
    return (el && el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function cell(row, field) {
    const el = row.querySelector('[field="' + field + '"] .grid-input, [field="' + field + '"]');
    return txt(el);
  }

  function readRowsFromDom() {
    const tbody = getTbody();
    if (!tbody) return [];

    return Array.from(tbody.querySelectorAll('tr.grid-row')).map(function (tr) {
      const data = {
        seqNo: cell(tr, 'seqNo'),
        sn: cell(tr, 'sn'),
        rootSn: cell(tr, 'rootSn'),
        pId: cell(tr, 'pId'),
        taskNo: cell(tr, 'taskNo'),
        partNo: cell(tr, 'partNo'),
        workstepName: cell(tr, 'workstepName'),
        snGrade: cell(tr, 'snGrade'),
        snProcessStatus: cell(tr, 'snProcessStatus'),
        goodRateQty: cell(tr, 'goodRateQty'),
        scrappedQty: cell(tr, 'scrappedQty')
      };

      return { html: tr.outerHTML, data };
    }).filter(function (r) {
      return r.data.sn || r.data.taskNo || r.data.partNo;
    });
  }

  function rowKey(r) {
    const d = r.data || {};
    return [d.sn, d.rootSn, d.pId, d.taskNo, d.partNo, d.workstepName, d.snGrade, d.snProcessStatus, d.goodRateQty, d.scrappedQty].join('|');
  }

  function listSig(rows) {
    return rows.map(rowKey).join('\n');
  }

  function fixRowHtml(item, index, total) {
    const tb = document.createElement('tbody');
    tb.innerHTML = item.html;
    const tr = tb.querySelector('tr');
    if (!tr) return item.html;

    tr.setAttribute('_row', String(index));
    if (index !== 0) tr.classList.remove('row-actived');

    if (RENUMBER_SEQ) {
      const seqCell = tr.querySelector('[field="seqNo"] .grid-input');
      if (seqCell) seqCell.textContent = String(total - index);
    }

    // 核心逻辑：分组背景色
    if (groupSize > 0) {
      const colorIndex = Math.floor(index / groupSize) % softColors.length;
      if (!tr.classList.contains('row-actived')) {
        tr.style.setProperty('background-color', softColors[colorIndex], 'important');
      }
    }

    return tr.outerHTML;
  }

  // ========= 核心高度设置 =========
  function adjustGridHeight(offset) {
    heightOffset = offset || heightOffset;
    const grid = getGrid();
    if (!grid) return;

    grid.style.setProperty('height', `calc(100vh - ${heightOffset}px)`, 'important');
    grid.style.setProperty('min-height', '200px', 'important');

    const body = getBody();
    if (body) {
      body.style.setProperty('height', 'calc(100% - 45px)', 'important');
      body.style.setProperty('overflow-y', 'auto', 'important');
    }
  }

  // ========= UPH 独立的跨小时检测 =========
  function checkHourChange() {
    const now = new Date();
    const h = now.getHours();

    if (h !== currentHourKey) {
      currentHourKey = h;
      uphKeys.clear();
      // v1.18：换小时只删旧小时条目（已写新小时的窗口条目保留，后台限流窗口迟发现时也不误杀）
      try {
        var m = JSON.parse(localStorage.getItem(KEY_LINK_MAP) || '{}');
        var changed = false;
        for (var k in m) { if (m[k] && m[k].hour !== h) { delete m[k]; changed = true; } }
        if (changed) localStorage.setItem(KEY_LINK_MAP, JSON.stringify(m));
      } catch (e) {}

      const rangeEl = document.getElementById('mes-uph-range');
      if (rangeEl) {
        const hStr = String(h).padStart(2, '0');
        const nextHStr = String((h + 1) % 24).padStart(2, '0');
        rangeEl.textContent = `${hStr}:00-${nextHStr}:00`;
      }
    }
  }

  // v1.18：tm_bulk_passing 改"标记+心跳时间戳"联动。
  // 一体化 v3.4.10 起运行期间持续刷新 tm_bulk_passing_ts；
  // 标记=1 但无 ts（旧版本/旧电脑残留）或 ts 超 120s（队列已死/页面已关）→ 判死并清掉，恢复统计。
  function bulkActive() {
    try {
      if ((localStorage.getItem('tm_bulk_passing') || '0') !== '1') return false;
      var ts = Number(localStorage.getItem('tm_bulk_passing_ts') || 0);
      if (!ts || Date.now() - ts > 120000) {
        localStorage.setItem('tm_bulk_passing', '0');
        localStorage.removeItem('tm_bulk_passing_ts');
        return false;
      }
      return true;
    } catch (e) { return false; }
  }

  // ========= 联动统计（v1.16）：勾选"联动"的多个窗口共享每小时节拍总数 =========
  // v1.18：换 key 名（旧 key mes_uph_linked_map 的残留记录直接作废，解决换电脑/旧缓存导致联动不汇总）
  const KEY_LINK_MAP = 'mes_uph_linked_map_v2';
  const KEY_LINK_MAP_OLD = 'mes_uph_linked_map';
  const KEY_LINK_TAB = 'mes_uph_link_tab';
  const KEY_LINK_ON = 'mes_uph_link_on';
  const LINK_STALE_MS = 120000; // v1.17：60s→120s——后台窗口定时器被 Chrome 限流到最慢 1 次/分（intensive throttling），60s 必误判死亡
  let lastLinkWriteAt = 0;

  // v1.18：启动时清掉旧 key 的残留（一次性迁移，旧记录不再参与汇总）
  try { localStorage.removeItem(KEY_LINK_MAP_OLD); } catch (e) {}

  // v1.20：tabId 改内存变量（不再用 sessionStorage）——
  // 复制/拖拽出来的窗口 Chrome 会复制源标签的 sessionStorage → 多窗口共用同一 tabId
  // → 往 map 写同一个 key 互相覆盖 → 联动只显示 1 窗、计数被 0 盖掉。
  // 内存变量每个脚本实例（每个标签页）独立，复制窗口也各自新生成，天然唯一。
  const _LINK_TAB_ID = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  function linkTabId() {
    return _LINK_TAB_ID;
  }

  function linkOn() {
    try { return sessionStorage.getItem(KEY_LINK_ON) !== '0'; } catch (e) { return true; }
  }

  function linkWrite() {
    if (!linkOn()) return;
    try {
      const now = Date.now();
      lastLinkWriteAt = now;
      const map = JSON.parse(localStorage.getItem(KEY_LINK_MAP) || '{}');
      map[linkTabId()] = { hour: currentHourKey, count: uphKeys.size, ts: now };
      for (const k of Object.keys(map)) {
        if (k !== linkTabId() && now - (map[k].ts || 0) > LINK_STALE_MS) delete map[k];
      }
      localStorage.setItem(KEY_LINK_MAP, JSON.stringify(map));
    } catch (e) {}
  }

  // v1.17：其他窗口写入 map 时（storage 事件）立即唤醒本窗口补一次心跳，
  // 避免后台窗口定时器被 Chrome 限流（最慢 1 次/分）导致 ts 过期被误判死亡。
  // 只在本窗口"已启动且联动开"时补写，且距上次写入 ≥5s 才补，防多窗口互相唤醒抖动。
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY_LINK_MAP) return;
    if (!started || !linkOn()) return;
    const now = Date.now();
    if (now - lastLinkWriteAt < 5000) return;
    linkWrite();
  });
  // v1.17：窗口回到前台瞬间立即补一次心跳（从限流状态快速恢复，不用等 1s 定时器）
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && started && linkOn()) linkWrite();
  });
  // v1.17：窗口关闭时立即把自己从 map 移除（不用等 120s 过期，总数不残留）
  window.addEventListener('pagehide', function () {
    try {
      const map = JSON.parse(localStorage.getItem(KEY_LINK_MAP) || '{}');
      if (map[linkTabId()]) {
        delete map[linkTabId()];
        localStorage.setItem(KEY_LINK_MAP, JSON.stringify(map));
      }
    } catch (e) {}
  });

  function linkTotal() {
    try {
      const now = Date.now();
      const map = JSON.parse(localStorage.getItem(KEY_LINK_MAP) || '{}');
      let sum = 0;
      for (const k of Object.keys(map)) {
        const e = map[k];
        if (e && e.hour === currentHourKey && now - (e.ts || 0) <= LINK_STALE_MS) sum += (e.count | 0);
      }
      return sum;
    } catch (e) { return uphKeys.size; }
  }

  // v1.19：联动窗口数（当前小时 + 120s 内心跳活的条目数，含本窗口）
  function linkCount() {
    try {
      const now = Date.now();
      const map = JSON.parse(localStorage.getItem(KEY_LINK_MAP) || '{}');
      let n = 0;
      for (const k of Object.keys(map)) {
        const e = map[k];
        if (e && e.hour === currentHourKey && now - (e.ts || 0) <= LINK_STALE_MS) n++;
      }
      return n;
    } catch (e) { return 1; }
  }

  function trackUPH(newRows) {
    if (bulkActive()) return; // 批量队列运行中 → 暂停统计
    newRows.forEach(r => {
      if (!r.data.sn) return;
      uphKeys.add(uphKeyOf(r));
    });
  }

  function mergeRows(currentRows, oldRows) {
    const result = currentRows.slice();
    const countMap = new Map();

    currentRows.forEach(function (r) {
      const k = rowKey(r);
      countMap.set(k, (countMap.get(k) || 0) + 1);
    });

    const oldKeys = new Set(oldRows.map(rowKey));
    const newlyScanned = currentRows.filter(r => !oldKeys.has(rowKey(r)));
    if (newlyScanned.length > 0) {
      trackUPH(newlyScanned);
    }

    oldRows.forEach(function (r) {
      const k = rowKey(r);
      const n = countMap.get(k) || 0;
      if (n > 0) {
        countMap.set(k, n - 1);
      } else {
        result.push(r);
      }
    });

    return result.slice(0, MAX_KEEP);
  }

  function getDisplayRows() {
    if (!onlyUnique) return accRows;

    const display = [];
    const seen = new Set();
    accRows.forEach(r => {
      const sn = r.data.sn;
      if (sn && !seen.has(sn)) {
        seen.add(sn);
        display.push(r);
      } else if (!sn) {
        display.push(r);
      }
    });
    return display;
  }

  function renderRows() {
    const tbody = getTbody();
    if (!tbody) return;
    rendering = true;

    const displayRows = getDisplayRows();
    const total = displayRows.length;

    const body = getBody();
    const oldScrollTop = body ? body.scrollTop : 0;
    const oldScrollHeight = body ? body.scrollHeight : 0;
    const isPinnedToBottom = body ? (oldScrollTop + body.clientHeight + 5 >= oldScrollHeight) : true;

    tbody.innerHTML = displayRows.map(function (r, i) {
      return fixRowHtml(r, i, total);
    }).join('');

    if (body) {
      body.style.overflowY = 'auto';
      body.style.overflowX = body.style.overflowX || 'auto';
      if (isPinnedToBottom) {
        body.scrollTop = body.scrollHeight;
      } else {
        const newScrollHeight = body.scrollHeight;
        body.scrollTop = oldScrollTop * (newScrollHeight / (oldScrollHeight || 1));
      }
    }

    lastRenderedSig = listSig(displayRows);
    updateBadge(total);

    setTimeout(function () {
      rendering = false;
    }, 80);
  }

  function checkAndStack() {
    if (!isTargetRoute() || rendering) return;

    const tbody = getTbody();
    if (!tbody) return;

    if (tbody !== currentTbody) bindObserver();

    const domRows = readRowsFromDom();
    if (!domRows.length) return;

    const domSig = listSig(domRows);
    if (domSig === lastRenderedSig) return;

    const currentTopRows = domRows.slice(0, 100);
    accRows = mergeRows(currentTopRows, accRows);

    renderRows();
    log('当前累计总采集', accRows.length, '条');
  }

  function createBadge() {
    const grid = getGrid();
    if (!grid) return;
    if (document.getElementById('mes-inline-stack-badge')) return;

    const head = grid.querySelector('.hae-grid-head') || grid;

    const badge = document.createElement('div');
    badge.id = 'mes-inline-stack-badge';

    badge.style.cssText = `
      padding: 3px 8px;
      background: #fffbe6;
      border: 1px solid #ffe58f;
      color: #333;
      font-size: 12px;
      line-height: 20px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      vertical-align: middle;
      margin-right: 10px;
      white-space: nowrap;
    `;

    const now = new Date();
    const h = now.getHours();
    const hStr = String(h).padStart(2, '0');
    const nextHStr = String((h + 1) % 24).padStart(2, '0');
    const timeRange = `${hStr}:00-${nextHStr}:00}`;

    badge.innerHTML = `
      <span>叠加:<b id="mes-inline-stack-count" style="color:#1890ff;">0</b></span>
      <span style="color:#d9d9d9;">|</span>
      <span title="每小时节拍：按行动态统计，同条码不同工序各计一次；一体化批量队列运行期间暂停统计">每小时节拍(<span id="mes-uph-range">${timeRange}</span>):<b id="mes-inline-stack-uph" style="color:#d4380d;">0</b></span>
      <span style="color:#d9d9d9;">|</span>
      <label title="联动统计：勾选后本窗口参与多窗口节拍汇总，所有勾选的窗口都显示总和（不勾选=只统计本窗口）"><input type="checkbox" id="mes-uph-link" style="vertical-align:middle;">联动</label>
      <span title="当前参与联动的窗口数（本浏览器内、当前小时、120秒内心跳活着；别的电脑的窗口不会出现在这里——localStorage 不跨机器）">联<b id="mes-uph-link-n" style="color:#1890ff;">-</b>窗</span>
      <span style="color:#d9d9d9;">|</span>
      <label style="display:inline-flex; align-items:center;">组:<input type="number" id="mes-inline-stack-group" value="${groupSize}" min="0" max="100" style="width:32px; text-align:center; margin:0 2px; border:1px solid #ccc;"></label>
      <span style="color:#d9d9d9;">|</span>
      <label><input type="checkbox" id="mes-inline-stack-unique" style="vertical-align:middle;">去重</label>
      <span style="color:#d9d9d9;">|</span>
      <label style="display:inline-flex; align-items:center;">高:<input type="range" id="mes-height-slider" min="50" max="800" value="${heightOffset}" style="width:60px; margin:0 4px; cursor:pointer;"></label>
      <span style="color:#d9d9d9;">|</span>
      <button id="mes-inline-stack-reset" style="font-size:12px; height:20px; padding:0 4px; cursor:pointer; border:1px solid #ccc; background:#fff; border-radius:3px;">重置</button>
      <button id="mes-inline-stack-stop" style="font-size:12px; height:20px; padding:0 4px; cursor:pointer; border:1px solid #ccc; background:#fff; border-radius:3px;">停止</button>
      <button id="mes-inline-stack-hide" style="font-size:12px; height:20px; padding:0 4px; cursor:pointer; border:1px solid #ccc; background:#fff; border-radius:3px;">隐藏</button>
    `;

    head.insertBefore(badge, head.firstChild);

    document.getElementById('mes-inline-stack-reset').onclick = function () {
      accRows = readRowsFromDom().slice(0, 100);
      uphKeys.clear();
      trackUPH(accRows);
      renderRows();
      log('已重置为当前页面记录，节拍已按当前页重新计数');
    };

    document.getElementById('mes-inline-stack-stop').onclick = function () { stop(); };
    document.getElementById('mes-inline-stack-hide').onclick = function () { badge.style.display = 'none'; };

    // 去重开关：改变时触发保存
    const uniqueCb = document.getElementById('mes-inline-stack-unique');
    uniqueCb.checked = onlyUnique;
    uniqueCb.onchange = function() {
      onlyUnique = this.checked;
      saveSettings();
      renderRows();
    };

    // 联动统计开关（按窗口记忆，默认开）
    const linkCb = document.getElementById('mes-uph-link');
    linkCb.checked = linkOn();
    linkCb.onchange = function() {
      try { sessionStorage.setItem(KEY_LINK_ON, this.checked ? '1' : '0'); } catch (e) {}
      linkWrite();
      log('联动统计已' + (this.checked ? '开启' : '关闭'));
    };

    // 组数输入框：输入时触发保存
    const groupInput = document.getElementById('mes-inline-stack-group');
    groupInput.oninput = function() {
      groupSize = parseInt(this.value) || 0;
      saveSettings();
      renderRows();
    };

    // 高度滑动条：拖动时实时改变，松开时触发保存
    const heightSlider = document.getElementById('mes-height-slider');
    heightSlider.onchange = function() {
      saveSettings();
    };
    heightSlider.oninput = function() {
      adjustGridHeight(parseInt(this.value));
    };
  }

  function updateBadge(count) {
    const el = document.getElementById('mes-inline-stack-count');
    if (el) el.textContent = String(count);
  }

  function bindObserver() {
    const tbody = getTbody();
    if (!tbody) return;
    if (observer) { try { observer.disconnect(); } catch (e) {} }
    currentTbody = tbody;

    observer = new MutationObserver(function () {
      if (rendering) return;
      clearTimeout(window.__mesInlineStackTimer);
      window.__mesInlineStackTimer = setTimeout(checkAndStack, 120);
    });

    observer.observe(tbody, { childList: true, subtree: true, characterData: true });
  }

  function start() {
    if (started) return;
    if (!isTargetRoute()) return;

    const grid = getGrid();
    const tbody = getTbody();
    if (!grid || !tbody) return;

    started = true;

    adjustGridHeight(heightOffset);
    createBadge();

    accRows = readRowsFromDom();
    trackUPH(accRows);

    if (accRows.length) renderRows();
    bindObserver();

    timer = setInterval(checkAndStack, CHECK_INTERVAL);

    uphTimer = setInterval(function() {
      checkHourChange();
      linkWrite();
      const uphEl = document.getElementById('mes-inline-stack-uph');
      if (uphEl) {
        const shown = linkOn() ? linkTotal() : uphKeys.size;
        uphEl.textContent = bulkActive() ? '⏸' + shown : String(shown);
      }
      const linkNEl = document.getElementById('mes-uph-link-n');
      if (linkNEl) {
        linkNEl.textContent = linkOn() ? String(linkCount()) : '-';
      }
    }, 1000);

    log('已启动，当前累计', accRows.length, '条');
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (uphTimer) { clearInterval(uphTimer); uphTimer = null; }
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    const badge = document.getElementById('mes-inline-stack-badge');
    if (badge) badge.remove();
    started = false;
    log('已停止运行');
  }

  function bootWait() {
    if (!isTargetRoute()) return;
    if (getGrid() && getTbody()) {
      start();
      return;
    }
    setTimeout(bootWait, 800);
  }

  let lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (isTargetRoute()) {
        setTimeout(bootWait, 1000);
      } else {
        stop();
      }
    }
    if (isTargetRoute() && !started) bootWait();
  }, 1000);

  bootWait();

})();