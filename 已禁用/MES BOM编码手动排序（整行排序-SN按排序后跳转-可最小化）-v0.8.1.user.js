// ==UserScript==
// @name         MES BOM编码手动排序（整行排序-SN按排序后跳转-可最小化）
// @namespace    tm.mes.bom.sort.row.sn.enter.tab.min
// @version      0.8.1
// @description  BOM整行排序；SN框按排序后页面从上往下跳；Tab/Shift+Tab/扫码Enter支持；不改SN框id；面板可最小化
// @match        https://w3.huawei.com/mespmm/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const ROW_SELECTOR = 'tr.grid-row';
  const CELL_SELECTOR = 'td.grid-cell';
  const SN_INPUT_SELECTOR = 'input[id^="sn-input"]';

  // 如果识别错编码列，可改成 0、1、2；不确定保持 null。
  const CODE_COL_INDEX = null;

  const ENABLE_KEY = 'mes_bom_sort_panel_enable_v2';
  const ORDER_KEY = 'mes_bom_sort_panel_order_v2';
  const PANEL_POS_KEY = 'mes_bom_sort_panel_pos_v2';
  const PANEL_MIN_KEY = 'mes_bom_sort_panel_min_v2';

  let inited = false;
  let movingRow = null;
  let movingParent = null;
  let startY = 0;
  let applying = false;
  let timer = null;
  let lastManualMoveTs = 0;
  let snStarted = false;

  function toStr(v) {
    return v == null ? '' : String(v).trim();
  }

  function isEnabled() {
    return localStorage.getItem(ENABLE_KEY) !== '0';
  }

  function setEnabled(v) {
    localStorage.setItem(ENABLE_KEY, v ? '1' : '0');
    updatePanel();
    scheduleWork();
    console.log('[BOM排序] 开关：', v ? '开' : '关');
  }

  function isVisible(el) {
    if (!el || !document.body.contains(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function getCells(row) {
    return Array.from(row.querySelectorAll(CELL_SELECTOR));
  }

  function getRowInput(row) {
    return row ? row.querySelector(SN_INPUT_SELECTOR) : null;
  }

  function getCleanCellText(cell) {
    if (!cell) return '';

    return toStr(cell.innerText || cell.textContent || '')
      .replace(/^▲\s*▼\s*/, '')
      .replace(/\s+/g, ' ');
  }

  function getCodeCell(row) {
    const cells = getCells(row);
    if (!cells.length) return null;

    if (Number.isInteger(CODE_COL_INDEX) && cells[CODE_COL_INDEX]) {
      return cells[CODE_COL_INDEX];
    }

    for (let i = 0; i < cells.length; i++) {
      const cls = cells[i].className || '';
      const txt = getCleanCellText(cells[i]);

      if (cls.indexOf('fzcol1') >= 0 && txt) {
        return cells[i];
      }
    }

    const input = getRowInput(row);
    const inputCellIndex = input
      ? cells.findIndex(function (cell) {
          return cell.contains(input);
        })
      : -1;

    let candidates;

    if (inputCellIndex > 0) {
      candidates = cells.slice(0, inputCellIndex);
    } else {
      candidates = cells.slice(0, Math.min(6, cells.length));
    }

    for (let j = 0; j < candidates.length; j++) {
      const txt = getCleanCellText(candidates[j]);
      if (txt) return candidates[j];
    }

    return cells[0] || null;
  }

  function getRowCode(row) {
    return getCleanCellText(getCodeCell(row));
  }

  function isBomRow(row) {
    if (!row || !row.matches || !row.matches(ROW_SELECTOR)) return false;

    const input = getRowInput(row);
    if (!input || !isVisible(input)) return false;

    return !!getCodeCell(row);
  }

  function visualSortRows(rows) {
    return Array.from(rows || []).sort(function (a, b) {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();

      const dy = ra.top - rb.top;
      if (Math.abs(dy) > 2) return dy;

      return ra.left - rb.left;
    });
  }

  function allBomRows() {
    return visualSortRows(
      Array.from(document.querySelectorAll(ROW_SELECTOR)).filter(isBomRow)
    );
  }

  function rowsInParent(parent) {
    if (!parent) return [];

    return visualSortRows(
      Array.from(parent.children || []).filter(function (row) {
        return row && row.matches && row.matches(ROW_SELECTOR) && isBomRow(row);
      })
    );
  }

  function reorderRowsKeepBlock(parent, sortedRows) {
    if (!parent || !sortedRows || !sortedRows.length) return;

    const currentRows = rowsInParent(parent);
    if (!currentRows.length) return;

    const firstRow = currentRows[0];
    const marker = document.createComment('bom-sort-anchor');

    parent.insertBefore(marker, firstRow);

    const frag = document.createDocumentFragment();

    sortedRows.forEach(function (row) {
      if (row && row.parentElement === parent) {
        frag.appendChild(row);
      }
    });

    parent.insertBefore(frag, marker.nextSibling);

    if (marker.parentNode) {
      marker.parentNode.removeChild(marker);
    }
  }

  function visibleSnInputs() {
    return Array.from(document.querySelectorAll(SN_INPUT_SELECTOR)).filter(isVisible);
  }

  function hasAnySnValue() {
    const els = visibleSnInputs();

    for (let i = 0; i < els.length; i++) {
      if (toStr(els[i].value)) return true;
    }

    return false;
  }

  function resetSnStartedIfAllEmpty() {
    if (!hasAnySnValue()) {
      snStarted = false;
    }
  }

  /***********************
   * SN 跳转：按排序后的整行顺序
   ***********************/

  function sortedSnInputs() {
    return allBomRows()
      .map(function (row) {
        return getRowInput(row);
      })
      .filter(function (input) {
        return input && isVisible(input) && !input.disabled && !input.readOnly;
      });
  }

  function syncSnTabIndex() {
    const inputs = sortedSnInputs();

    inputs.forEach(function (input, index) {
      input.tabIndex = index + 1;
    });
  }

  function focusInput(input) {
    if (!input) return false;

    try {
      input.focus({ preventScroll: true });
    } catch (e) {
      input.focus();
    }

    if (typeof input.select === 'function') {
      input.select();
    }

    return true;
  }

  function focusFirstSnBySortedOrder() {
    const inputs = sortedSnInputs();
    if (!inputs.length) return false;

    focusInput(inputs[0]);

    console.log('[BOM排序] 已聚焦排序后第一个SN：', inputs[0].id || '');

    return true;
  }

  function getNextSnBySortedOrder(currentInput, step) {
    if (!currentInput) return null;

    const inputs = sortedSnInputs();
    const index = inputs.indexOf(currentInput);

    if (index < 0) return null;

    const nextIndex = index + step;

    if (nextIndex < 0 || nextIndex >= inputs.length) {
      return null;
    }

    return inputs[nextIndex] || null;
  }

  function focusSnBySortedOrder(currentInput, step) {
    const next = getNextSnBySortedOrder(currentInput, step);

    if (!next) {
      console.log('[BOM排序] SN已到头，不跳。当前：', currentInput ? currentInput.id : '');
      return false;
    }

    focusInput(next);

    console.log('[BOM排序] SN跳转：', currentInput.id || '', '=>', next.id || '');

    return true;
  }

  function watchSnActivity() {
    document.addEventListener('input', function (e) {
      if (!e.target || !e.target.matches || !e.target.matches(SN_INPUT_SELECTOR)) return;

      if (toStr(e.target.value)) {
        snStarted = true;
      } else {
        resetSnStartedIfAllEmpty();
      }
    }, true);

    document.addEventListener('change', function (e) {
      if (!e.target || !e.target.matches || !e.target.matches(SN_INPUT_SELECTOR)) return;

      if (toStr(e.target.value)) {
        snStarted = true;
      } else {
        resetSnStartedIfAllEmpty();
      }
    }, true);

    function keyHandler(e) {
      if (!e.target || !e.target.matches || !e.target.matches(SN_INPUT_SELECTOR)) {
        return;
      }

      const isTab = e.key === 'Tab' || e.keyCode === 9;
      const isEnter = e.key === 'Enter' || e.keyCode === 13;

      if (!isTab && !isEnter) return;

      const input = e.target;

      // 扫码 Enter：空值不处理。
      if (isEnter && !toStr(input.value)) {
        return;
      }

      // 关键：
      // Tab + Shift 才往上；
      // 普通 Tab 往下；
      // Enter/扫码 永远往下，避免扫码时往上跳。
      const step = isTab && e.shiftKey ? -1 : 1;

    const next = getNextSnBySortedOrder(input, step);

if (toStr(input.value)) {
  snStarted = true;
}

// 没有下一个/上一个时，允许默认行为（回车提交表单）
if (!next) {
  // 只阻止事件传播，不阻止默认行为
  e.stopPropagation();

  if (e.stopImmediatePropagation) {
    e.stopImmediatePropagation();
  }

  console.log(
    '[BOM排序] SN已到头，允许默认行为。当前：',
    input.id || '',
    isEnter ? '来源：Enter/扫码' : '来源：Tab'
  );

  return; // 不阻止默认行为，让回车可以提交表单
}

// 正常跳转时阻止默认行为
e.preventDefault();
e.stopPropagation();

if (e.stopImmediatePropagation) {
  e.stopImmediatePropagation();
}

focusInput(next);


      console.log(
        '[BOM排序] 捕获',
        isEnter ? 'Enter/扫码' : (e.shiftKey ? 'Shift+Tab' : 'Tab'),
        '按排序后顺序跳：',
        input.id || '',
        '=>',
        next.id || ''
      );
    }

    // window 捕获比 document 更早，避免 MES 先处理。
    window.addEventListener('keydown', keyHandler, true);
    document.addEventListener('keydown', keyHandler, true);
  }

  /***********************
   * 保存/应用排序
   ***********************/

  function cleanSavedCode(code) {
    return toStr(code)
      .replace(/^▲\s*▼\s*/, '')
      .replace(/\s+/g, ' ');
  }

  function loadOrder() {
    try {
      const obj = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null');
      let arr = [];

      if (Array.isArray(obj)) {
        arr = obj;
      } else if (obj && Array.isArray(obj.order)) {
        arr = obj.order;
      }

      return arr.map(cleanSavedCode).filter(Boolean);
    } catch (e) {}

    return [];
  }

  function saveOrderByRows(rows) {
    rows = visualSortRows(rows || []);

    if (!rows || !rows.length) return false;

    const order = rows.map(getRowCode).map(cleanSavedCode).filter(Boolean);

    if (!order.length) return false;

    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify({
        version: 1,
        ts: Date.now(),
        order: order
      }));

      console.log('[BOM排序] 已保存顺序：');
      console.table(order.map(function (code, index) {
        return {
          index: index + 1,
          code: code
        };
      }));
    } catch (e) {
      console.warn('[BOM排序] 保存失败：', e);
    }

    syncSnTabIndex();
    updatePanel();

    return true;
  }

  function clearOrder() {
    localStorage.removeItem(ORDER_KEY);
    syncSnTabIndex();
    updatePanel();
    toast('已清除BOM排序');
    console.log('[BOM排序] 已清除保存顺序');
  }

  function buildRank(order) {
    const rank = new Map();

    order.forEach(function (code, index) {
      code = cleanSavedCode(code);
      if (!code) return;

      if (!rank.has(code)) {
        rank.set(code, index);
      }
    });

    return rank;
  }

  function applySavedOrder(force) {
    if (!isEnabled()) return;
    if (movingRow) return;
    if (applying) return;

    resetSnStartedIfAllEmpty();

    const order = loadOrder();

    if (!order.length) {
      syncSnTabIndex();
      return;
    }

    // 自动模式下，只在SN未开始/全空时自动动DOM。
    if (!force && (snStarted || hasAnySnValue())) {
      syncSnTabIndex();
      return;
    }

    const rank = buildRank(order);
    if (!rank.size) {
      syncSnTabIndex();
      return;
    }

    const rows = allBomRows();
    if (!rows.length) return;

    const groups = new Map();

    rows.forEach(function (row) {
      const parent = row.parentElement;
      if (!parent) return;

      if (!groups.has(parent)) {
        groups.set(parent, []);
      }

      groups.get(parent).push(row);
    });

    let didChange = false;

    applying = true;

    try {
      groups.forEach(function (groupRows, parent) {
        if (!groupRows || groupRows.length <= 1) return;

        const items = groupRows.map(function (row, index) {
          const code = cleanSavedCode(getRowCode(row));
          const has = rank.has(code);

          return {
            row: row,
            code: code,
            oldIndex: index,
            rank: has ? rank.get(code) : 999999999
          };
        });

        const hasMatched = items.some(function (x) {
          return x.rank !== 999999999;
        });

        if (!hasMatched) return;

        items.sort(function (a, b) {
          if (a.rank !== b.rank) return a.rank - b.rank;
          return a.oldIndex - b.oldIndex;
        });

        const changed = items.some(function (x, idx) {
          return x.row !== groupRows[idx];
        });

        if (!changed) return;

        didChange = true;

        reorderRowsKeepBlock(
          parent,
          items.map(function (x) {
            return x.row;
          })
        );

        console.log('[BOM排序] 已应用保存顺序：', items.map(function (x) {
          return x.code;
        }));
      });
    } finally {
      setTimeout(function () {
        applying = false;
      }, 150);
    }

    syncSnTabIndex();

    // 如果SN都为空，排序完成后自动到排序后的第一个SN。
    if ((force || didChange) && !hasAnySnValue()) {
      focusFirstSnBySortedOrder();
    }

    updatePanel();
  }

  /***********************
   * BOM行拖动
   ***********************/

  function findTargetRowByY(parent, clientY) {
    const rows = rowsInParent(parent).filter(function (row) {
      return row !== movingRow;
    });

    if (!rows.length) return null;

    let target = null;
    let before = true;
    let bestDist = Infinity;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      const center = r.top + r.height / 2;

      if (clientY >= r.top && clientY <= r.bottom) {
        return {
          row: rows[i],
          before: clientY < center
        };
      }

      const dist = Math.abs(clientY - center);

      if (dist < bestDist) {
        bestDist = dist;
        target = rows[i];
        before = clientY < center;
      }
    }

    return target ? { row: target, before: before } : null;
  }

  function beginMove(row, e) {
    if (movingRow) return;
    if (!isEnabled()) return;

    // 必须按住 Alt 或 Ctrl，避免影响普通扫码/点击。
    if (!e.altKey && !e.ctrlKey) return;

    if (e.button != null && e.button !== 0) return;

    // 不允许从SN框里面拖。
    if (e.target && e.target.closest && e.target.closest(SN_INPUT_SELECTOR)) {
      return;
    }

    movingRow = row;
    movingParent = row.parentElement;
    startY = e.clientY;
    lastManualMoveTs = Date.now();

    e.preventDefault();
    e.stopPropagation();

    console.log('[BOM排序] 开始拖动：', getRowCode(row));
  }

  function moveByY(clientY) {
    if (!movingRow || !movingParent) return;
    if (Math.abs(clientY - startY) < 2) return;

    const hit = findTargetRowByY(movingParent, clientY);
    if (!hit || !hit.row || hit.row === movingRow) return;

    if (hit.before) {
      movingParent.insertBefore(movingRow, hit.row);
    } else {
      movingParent.insertBefore(movingRow, hit.row.nextSibling);
    }

    lastManualMoveTs = Date.now();
  }

  function onMouseDown(e) {
    const row = e.target && e.target.closest ? e.target.closest(ROW_SELECTOR) : null;
    if (!row || !isBomRow(row)) return;

    beginMove(row, e);
  }

  function onPointerDown(e) {
    const row = e.target && e.target.closest ? e.target.closest(ROW_SELECTOR) : null;
    if (!row || !isBomRow(row)) return;

    beginMove(row, e);
  }

  function onMouseMove(e) {
    if (!movingRow) return;

    moveByY(e.clientY);

    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    if (!movingRow) return;

    moveByY(e.clientY);

    e.preventDefault();
    e.stopPropagation();
  }

  function endMove(e) {
    if (!movingRow) return;

    const row = movingRow;
    const parent = row.parentElement;
    const code = getRowCode(row);

    movingRow = null;
    movingParent = null;

    if (parent) {
      saveOrderByRows(rowsInParent(parent));
      syncSnTabIndex();

      if (!hasAnySnValue()) {
        focusFirstSnBySortedOrder();
      }

      toast('BOM顺序已保存');
    }

    console.log('[BOM排序] 结束拖动，已保存：', code);

    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function enhanceRows() {
    const rows = allBomRows();

    rows.forEach(function (row) {
      if (row.dataset.bomSortBound === '1') return;

      row.dataset.bomSortBound = '1';

      row.addEventListener('pointerdown', onPointerDown, true);
      row.addEventListener('mousedown', onMouseDown, true);
    });

    syncSnTabIndex();
  }

  /***********************
   * 页面观察
   ***********************/

  function scheduleWork() {
    if (movingRow) return;

    clearTimeout(timer);

    timer = setTimeout(function () {
      try {
        resetSnStartedIfAllEmpty();

        enhanceRows();

        applySavedOrder(false);

        updatePanel();
      } catch (e) {
        console.warn('[BOM排序] 执行异常：', e);
      }
    }, 300);
  }

  function isPanelRelatedNode(node) {
    if (!node) return false;

    if (node.nodeType === 3) {
      node = node.parentElement;
    }

    if (!node || !node.closest) return false;

    return !!(
      node.closest('#mes-bom-sort-panel') ||
      node.closest('#mes-bom-sort-toast')
    );
  }

  function observePage() {
    const mo = new MutationObserver(function (list) {
      if (applying) return;
      if (movingRow) return;
      if (Date.now() - lastManualMoveTs < 500) return;

      let onlyPanel = true;

      for (let i = 0; i < list.length; i++) {
        const m = list[i];

        if (!isPanelRelatedNode(m.target)) {
          onlyPanel = false;
          break;
        }

        const nodes = Array.from(m.addedNodes || []).concat(Array.from(m.removedNodes || []));

        for (let j = 0; j < nodes.length; j++) {
          if (!isPanelRelatedNode(nodes[j])) {
            onlyPanel = false;
            break;
          }
        }

        if (!onlyPanel) break;
      }

      if (onlyPanel) return;

      scheduleWork();
    });

    mo.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  /***********************
   * 面板
   ***********************/

  function loadPanelPos() {
    try {
      const obj = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');

      if (obj && typeof obj.left === 'number' && typeof obj.top === 'number') {
        return obj;
      }
    } catch (e) {}

    return null;
  }

  function savePanelPos(left, top) {
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({
        left: Math.round(left),
        top: Math.round(top)
      }));
    } catch (e) {}
  }

  function isPanelMinimized() {
    return localStorage.getItem(PANEL_MIN_KEY) === '1';
  }

  function setPanelMinimized(v) {
    localStorage.setItem(PANEL_MIN_KEY, v ? '1' : '0');
    updatePanel();
  }

  function createPanel() {
    if (document.getElementById('mes-bom-sort-panel')) {
      updatePanel();
      return;
    }

    const box = document.createElement('div');
    box.id = 'mes-bom-sort-panel';

    box.innerHTML =
      '<div class="bom-panel-head">' +
        '<span class="bom-title">BOM排序</span>' +
        '<span class="bom-info"></span>' +
        '<button type="button" data-act="min" title="最小化/展开">—</button>' +
      '</div>' +
      '<div class="bom-body">' +
        '<button type="button" data-act="toggle"></button>' +
        '<button type="button" data-act="save">保存当前</button>' +
        '<button type="button" data-act="apply">应用</button>' +
        '<button type="button" data-act="first">首个SN</button>' +
        '<button type="button" data-act="clear">清除</button>' +
        '<button type="button" data-act="print">打印</button>' +
      '</div>';

    box.style.position = 'fixed';
    box.style.zIndex = '2147483647';
    box.style.background = 'rgba(0,0,0,.72)';
    box.style.color = '#fff';
    box.style.padding = '6px 8px';
    box.style.borderRadius = '8px';
    box.style.fontSize = '12px';
    box.style.fontFamily = 'Arial, Microsoft YaHei, sans-serif';
    box.style.boxShadow = '0 3px 12px rgba(0,0,0,.25)';
    box.style.userSelect = 'none';
    box.style.minWidth = '280px';

    const pos = loadPanelPos();

    if (pos) {
      box.style.left = pos.left + 'px';
      box.style.top = pos.top + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    } else {
      box.style.right = '12px';
      box.style.bottom = '12px';
    }

    document.body.appendChild(box);

    const head = box.querySelector('.bom-panel-head');
    const title = box.querySelector('.bom-title');
head.addEventListener('click', function (e) {
  // 点最小化按钮时，不执行这里
  if (e.target && e.target.closest && e.target.closest('button')) return;

  if (!isPanelMinimized()) return;

  setPanelMinimized(false);

  e.preventDefault();
  e.stopPropagation();
}, true);


    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '6px';
    head.style.cursor = 'move';
    head.style.marginBottom = '6px';

    title.style.fontWeight = '700';

    Array.from(box.querySelectorAll('button')).forEach(function (btn) {
      btn.style.margin = '0 2px 2px 0';
      btn.style.padding = '2px 6px';
      btn.style.border = '0';
      btn.style.borderRadius = '4px';
      btn.style.cursor = 'pointer';
      btn.style.fontSize = '12px';
    });

    box.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;

      const act = btn.getAttribute('data-act');

      if (act === 'toggle') {
        setEnabled(!isEnabled());
      } else if (act === 'min') {
        setPanelMinimized(!isPanelMinimized());
      } else if (act === 'save') {
        if (saveOrderByRows(allBomRows())) {
          syncSnTabIndex();

          if (!hasAnySnValue()) {
            focusFirstSnBySortedOrder();
          }

          toast('BOM顺序已保存');
        } else {
          toast('未找到BOM行');
        }
      } else if (act === 'apply') {
        applySavedOrder(true);
      } else if (act === 'first') {
        focusFirstSnBySortedOrder();
      } else if (act === 'clear') {
        clearOrder();
      } else if (act === 'print') {
        printDebug();
      }
    }, true);

    let draggingPanel = false;
    let panelStartX = 0;
    let panelStartY = 0;
    let panelStartLeft = 0;
    let panelStartTop = 0;

    head.addEventListener('mousedown', function (e) {
      // 点最小化按钮时不要拖动
      if (e.target && e.target.closest && e.target.closest('button')) return;

      draggingPanel = true;

      const rect = box.getBoundingClientRect();

      panelStartX = e.clientX;
      panelStartY = e.clientY;
      panelStartLeft = rect.left;
      panelStartTop = rect.top;

      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';

      e.preventDefault();
      e.stopPropagation();
    }, true);

    document.addEventListener('mousemove', function (e) {
      if (!draggingPanel) return;

      let left = panelStartLeft + (e.clientX - panelStartX);
      let top = panelStartTop + (e.clientY - panelStartY);

      const rect = box.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - 4;
      const maxTop = window.innerHeight - rect.height - 4;

      if (left < 4) left = 4;
      if (top < 4) top = 4;
      if (left > maxLeft) left = Math.max(4, maxLeft);
      if (top > maxTop) top = Math.max(4, maxTop);

      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';

      e.preventDefault();
      e.stopPropagation();
    }, true);

    document.addEventListener('mouseup', function () {
      if (!draggingPanel) return;

      draggingPanel = false;

      const rect = box.getBoundingClientRect();
      savePanelPos(rect.left, rect.top);
    }, true);

    updatePanel();
  }

function updatePanel() {
  const box = document.getElementById('mes-bom-sort-panel');
  if (!box) return;

  const toggleBtn = box.querySelector('button[data-act="toggle"]');
  const minBtn = box.querySelector('button[data-act="min"]');
  const body = box.querySelector('.bom-body');
  const info = box.querySelector('.bom-info');
  const title = box.querySelector('.bom-title');
  const head = box.querySelector('.bom-panel-head');

  const enabled = isEnabled();
  const rows = allBomRows();
  const order = loadOrder();
  const minimized = isPanelMinimized();

  if (minimized) {
    // 最小化：只显示一个 BOM 小块
    box.style.minWidth = 'auto';
    box.style.padding = '5px 9px';
    box.style.borderRadius = '8px';
    box.style.cursor = 'pointer';

    if (head) {
      head.style.marginBottom = '0';
      head.style.cursor = 'pointer';
      head.style.gap = '0';
    }

    if (title) {
      title.textContent = 'BOM';
      title.style.fontWeight = '700';
      title.style.marginRight = '0';
    }

    if (info) {
      info.textContent = '';
      info.style.display = 'none';
    }

    if (body) {
      body.style.display = 'none';
    }

    if (minBtn) {
      minBtn.style.display = 'none';
    }

    return;
  }

  // 展开状态
  box.style.minWidth = '280px';
  box.style.padding = '6px 8px';
  box.style.borderRadius = '8px';
  box.style.cursor = 'default';

  if (head) {
    head.style.marginBottom = '6px';
    head.style.cursor = 'move';
    head.style.gap = '6px';
  }

  if (title) {
    title.textContent = 'BOM排序';
    title.style.fontWeight = '700';
    title.style.marginRight = '0';
  }

  if (body) {
    body.style.display = 'block';
  }

  if (minBtn) {
    minBtn.style.display = '';
    minBtn.textContent = '—';
    minBtn.style.marginLeft = 'auto';
  }

  if (toggleBtn) {
    toggleBtn.textContent = enabled ? '开' : '关';
    toggleBtn.style.background = enabled ? '#52c41a' : '#999';
    toggleBtn.style.color = '#fff';
  }

  if (info) {
    info.style.display = '';
    info.textContent = '行' + rows.length + ' / 已存' + order.length;
    info.style.color = '#ddd';
    info.style.flex = '1';
  }
}


  function toast(msg) {
    const old = document.getElementById('mes-bom-sort-toast');

    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }

    const div = document.createElement('div');
    div.id = 'mes-bom-sort-toast';
    div.textContent = msg;

    div.style.position = 'fixed';
    div.style.right = '12px';
    div.style.bottom = '58px';
    div.style.zIndex = '2147483647';
    div.style.background = '#333';
    div.style.color = '#fff';
    div.style.padding = '6px 10px';
    div.style.borderRadius = '6px';
    div.style.fontSize = '12px';
    div.style.boxShadow = '0 3px 12px rgba(0,0,0,.25)';

    document.body.appendChild(div);

    setTimeout(function () {
      if (div && div.parentNode) {
        div.parentNode.removeChild(div);
      }
    }, 1200);
  }

  function printDebug() {
    const rows = allBomRows();
    const inputs = sortedSnInputs();

    console.group('[BOM排序] 当前识别结果');
    console.log('href =', location.href);
    console.log('grid-row总数 =', document.querySelectorAll(ROW_SELECTOR).length);
    console.log('sn-input总数 =', document.querySelectorAll(SN_INPUT_SELECTOR).length);
    console.log('可排序行数 =', rows.length);
    console.log('排序后SN顺序 =', inputs.map(function (x) { return x.id; }));
    console.log('开关 =', isEnabled() ? '开' : '关');
    console.log('已保存顺序 =', loadOrder());
    console.log('任意SN已有值 =', hasAnySnValue());
    console.log('snStarted =', snStarted);
    console.log('面板最小化 =', isPanelMinimized());

    console.table(rows.map(function (row, index) {
      const cell = getCodeCell(row);
      const input = getRowInput(row);
      const rect = row.getBoundingClientRect();

      return {
        index: index + 1,
        code: getRowCode(row),
        inputId: input ? input.id : '',
        inputValue: input ? input.value : '',
        tabIndex: input ? input.tabIndex : '',
        top: Math.round(rect.top),
        cellClass: cell ? cell.className : '',
        cellText: cell ? getCleanCellText(cell) : ''
      };
    }));

    console.groupEnd();
  }

  /***********************
   * 初始化
   ***********************/

  function init() {
    if (inited) return;
    inited = true;

    createPanel();
    watchSnActivity();

    document.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mousemove', onMouseMove, true);

    document.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointermove', onPointerMove, true);

    document.addEventListener('mouseup', endMove, true);
    window.addEventListener('mouseup', endMove, true);

    document.addEventListener('pointerup', endMove, true);
    window.addEventListener('pointerup', endMove, true);

    enhanceRows();

    applySavedOrder(false);

    observePage();

    setInterval(function () {
      try {
        updatePanel();
        syncSnTabIndex();
      } catch (e) {}
    }, 1500);

    window.BomSortPanel = {
      print: printDebug,
      save: function () {
        const ok = saveOrderByRows(allBomRows());
        syncSnTabIndex();
        return ok;
      },
      apply: function () {
        return applySavedOrder(true);
      },
      clear: clearOrder,
      on: function () {
        setEnabled(true);
      },
      off: function () {
        setEnabled(false);
      },
      first: focusFirstSnBySortedOrder,
      order: loadOrder,
      rows: allBomRows,
      inputs: sortedSnInputs,
      min: function () {
        setPanelMinimized(true);
      },
      max: function () {
        setPanelMinimized(false);
      },
      next: function () {
        const el = document.activeElement;
        if (el && el.matches && el.matches(SN_INPUT_SELECTOR)) {
          return focusSnBySortedOrder(el, 1);
        }
        return false;
      },
      prev: function () {
        const el = document.activeElement;
        if (el && el.matches && el.matches(SN_INPUT_SELECTOR)) {
          return focusSnBySortedOrder(el, -1);
        }
        return false;
      }
    };

    setTimeout(printDebug, 1000);

    console.log('[BOM排序] 已启动');
    console.log('[BOM排序] 整行排序：编码和SN框一起移动，不改SN框id');
    console.log('[BOM排序] 拖动BOM行：按住 Alt 或 Ctrl + 鼠标左键拖动BOM行');
    console.log('[BOM排序] SN跳转：Tab下一个，Shift+Tab上一个，扫码Enter当下一个');
    console.log('[BOM排序] 面板：点 — 最小化，点 □ 展开');
    console.log('[BOM排序] 控制台命令：BomSortPanel.print() / save() / apply() / clear() / first() / next() / prev() / min() / max()');
  }

  function waitProductTrackPage() {
    const href = location.href;

    if (href.includes('/wipweb') && href.includes('ProductTrackInOut')) {
      console.log('[BOM排序] 已进入 ProductTrackInOut，准备启动');
      setTimeout(init, 800);
      return;
    }

    setTimeout(waitProductTrackPage, 800);
  }

  waitProductTrackPage();

  window.addEventListener('hashchange', function () {
    if (location.href.includes('ProductTrackInOut')) {
      console.log('[BOM排序] hash变化，尝试启动');
      setTimeout(init, 800);
    }
  });

})();
