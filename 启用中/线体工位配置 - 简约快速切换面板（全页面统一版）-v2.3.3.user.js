// ==UserScript==
// @name         线体工位配置 - 简约快速切换面板（全页面统一版）
// @namespace    tm-line-station-panel-unified
// @version      2.3.3
// @description  支持同名线体选择第几个，格式：线体名|2 表示选第二个；配置完保存后脚本面板自动关闭；双向联动：MES 保存→脚本关闭，脚本关闭→MES 保存
// @match        https://w3.huawei.com/mespmm/wipweb*
// @grant        none
// ==/UserScript==

(async function () {
  'use strict';

  async function __MES_AUTH_GATE__() {
    var KEY = 'MES_AUTH_CENTER_STATE_V1';
    var start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        var st = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (st && st.ok && Date.now() - Number(st.ts || 0) < 10000) {
          console.log('[MES 授权门禁] 已授权，脚本继续运行：', st.jobNumber);
          return true;
        }
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    console.warn('[MES 授权门禁] 未授权，脚本已停止运行');
    return false;
  }
  if (!(await __MES_AUTH_GATE__())) return;

  const STORE_KEY = '__tm_line_station_presets_unified__';
  const OPEN_TEXT = '线体工位配置';
  const SAVE_TEXT = '保存';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function isVisible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }
  function textOf(el) { return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim(); }
  function norm(s) { return String(s || '').replace(/\s+/g, '').replace(/[＿_－-]/g, '').toLowerCase(); }
  function click(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }
  function pressEnter(input) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
  function findButtonsByText(text, root = document) {
    return [...root.querySelectorAll('button, .hae-btn, [role="button"]')].filter(isVisible).filter(el => textOf(el).includes(text));
  }
  async function waitFor(fn, timeout = 7000, interval = 120) {
    const st = Date.now();
    while (Date.now() - st < timeout) { const v = fn(); if (v) return v; await sleep(interval); }
    return null;
  }
  function hasLoading() {
    const sels = ['.loading', '.is-loading', '.hae-loading', '.el-loading-mask', '[class*="loading"]', '[class*="spinner"]'];
    for (const s of sels) if ([...document.querySelectorAll(s)].find(isVisible)) return true;
    return false;
  }
  async function waitLoadingDone(timeout = 7000) {
    const st = Date.now(); let stable = 0;
    while (Date.now() - st < timeout) {
      if (!hasLoading()) { stable++; if (stable >= 3) return true; } else stable = 0;
      await sleep(150);
    }
    return false;
  }
  async function waitOptionsReady(timeout = 4000) {
    const st = Date.now(); let lastCount = -1, stable = 0;
    while (Date.now() - st < timeout) {
      const count = getVisibleOptions().length;
      if (count > 0 && count === lastCount) { stable++; if (stable >= 2) return true; } else stable = 0;
      lastCount = count; await sleep(180);
    }
    return false;
  }

  function getActiveTabScope() {
    const activeTab = document.querySelector('.hae-tabs__item.is-active[aria-controls]');
    if (activeTab) {
      const paneId = activeTab.getAttribute('aria-controls');
      if (paneId) { const pane = document.getElementById(paneId); if (pane && isVisible(pane)) return pane; }
    }
    return document;
  }
  function getLineInputNow() {
    const scope = getActiveTabScope();
    const fixed = ['#lineDesc > input[type="text"]', '#lineDesc > input', 'div#lineNo > input[type="text"]', 'div#lineNo > input'];
    for (const s of fixed) { const el = scope.querySelector(s); if (el && isVisible(el)) return el; }
    const all = [...scope.querySelectorAll('input[type="text"], input')].filter(el => { if (!isVisible(el)) return false; const t = (el.type || '').toLowerCase(); return t === 'text' || t === ''; });
    if (!all.length) return null;
    const p = all.find(el => (el.placeholder || '').includes('请选择')); if (p) return p;
    all.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return all[0];
  }
  function getStationInputByRelative() {
    const scope = getActiveTabScope(); const line = getLineInputNow(); if (!line) return null;
    const lr = line.getBoundingClientRect();
    const cands = [...scope.querySelectorAll('div[id^="Dropdown_"] > input, input[type="text"], input')].filter(el => isVisible(el) && el !== line);
    let best = null, bestScore = Infinity;
    for (const el of cands) {
      const r = el.getBoundingClientRect(); const topDiff = r.top - lr.top;
      if (topDiff <= 0 || topDiff > 520) continue;
      const score = topDiff * 10 + Math.abs(r.left - lr.left);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }
  function getVisibleOptions() {
    const selectors = ['li.list-item', '.selector-poplist li', '.hae-dropdown-menu li', '.hae-select-dropdown li', '.hae-dropdown li', '[role="option"]', 'li'];
    const all = selectors.flatMap(s => [...document.querySelectorAll(s)]);
    return [...new Set(all)].filter(el => isVisible(el) && textOf(el));
  }
  function pickOption(keyword, selectIndex) {
    const k = norm(keyword); const list = getVisibleOptions();
    var matches = list.filter(function(el) { return norm(textOf(el)).includes(k); });
    matches.sort(function(a, b) { return norm(textOf(a)).localeCompare(norm(textOf(b))); });
    if (matches.length >= selectIndex) { return matches[selectIndex - 1]; }
    return null;
  }
  async function chooseByInput(input, keyword) {
    if (!input) throw new Error('输入框不存在');
    var parts = keyword.split('|'); var realKeyword = parts[0]; var selectIndex = parseInt(parts[1]) || 1;
    click(input); await sleep(100);
    input.focus(); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = realKeyword; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true })); pressEnter(input);
    await waitLoadingDone(7000); await waitOptionsReady(4000); await sleep(180);
    const hit = pickOption(realKeyword, selectIndex);
    if (hit) { click(hit); await sleep(180); return; }
    const cur = norm(input.value), tar = norm(realKeyword);
    if (cur && (cur === tar || cur.includes(tar) || tar.includes(cur))) return;
    throw new Error('候选未命中：' + realKeyword + ' (第' + selectIndex + '个)');
  }
  async function applyPreset(lineText, stationText) {
    await sleep(250);
    const lineInput = await waitFor(() => getLineInputNow(), 7000, 120); if (!lineInput) throw new Error('未找到线体输入框');
    await chooseByInput(lineInput, lineText);
    const stationInput = await waitFor(() => getStationInputByRelative(), 6000, 120); if (!stationInput) throw new Error('未找到工位输入框');
    await chooseByInput(stationInput, stationText);
    const saveBtn = findButtonsByText(SAVE_TEXT, document)[0]; if (!saveBtn) throw new Error('未找到保存按钮');
    click(saveBtn); await waitLoadingDone(5000);
  }

  let presets = loadPresets();
  function loadPresets() { try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  function savePresets() { localStorage.setItem(STORE_KEY, JSON.stringify(presets)); }
  function uid() { return Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function escapeHtml(str) { return String(str).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }

  let panel, listBox, settingsBox, nameIpt, lineIpt, stationIpt, statusEl;
  let showingSettings = false;

  function setStatus(msg, isErr = false) { if (!statusEl) return; statusEl.textContent = msg || ''; statusEl.style.color = isErr ? '#d33' : '#666'; }
  function toggleSettings(force) { showingSettings = typeof force === 'boolean' ? force : !showingSettings; settingsBox.style.display = showingSettings ? 'block' : 'none'; }

  function safeHidePanel() {
    const saveBtn = findButtonsByText(SAVE_TEXT, document)[0];
    if (saveBtn && panel && panel.style.display === 'block') {
      console.log('[线体工位配置] 脚本面板关闭，自动保存 MES 页面');
      click(saveBtn);
      sessionStorage.setItem('__mes_recent_save__', Date.now().toString());
    }
    if (panel) panel.style.display = 'none';
  }

  function showPanel() { buildUI(); panel.style.display = 'block'; renderList(); renderDeleteList(); setStatus('点击任意配置即可切换'); }
  function hidePanel() { safeHidePanel(); }

  function renderList() {
    listBox.innerHTML = '';
    if (!presets.length) { const empty = document.createElement('div'); empty.className = 'tm-empty'; empty.textContent = '暂无配置，点"设置"新增'; listBox.appendChild(empty); return; }
    presets.forEach(item => {
      const row = document.createElement('div'); row.className = 'tm-item';
      var lineDisplay = item.line; var lineParts = item.line.split('|');
      if (lineParts.length > 1 && lineParts[1]) { lineDisplay = lineParts[0] + ' (第' + lineParts[1] + '个)'; }
      row.innerHTML = '<div class="tm-name">' + escapeHtml(item.name) + '</div><div class="tm-sub">线体：' + escapeHtml(lineDisplay) + '</div><div class="tm-sub">工位：' + escapeHtml(item.station) + '</div>';
      row.onclick = async () => {
        try { setStatus('应用中：' + item.name + ' ...'); await applyPreset(item.line, item.station); setStatus('已应用：' + item.name); hidePanel(); }
        catch (e) { setStatus('应用失败：' + e.message, true); }
      };
      listBox.appendChild(row);
    });
  }

  function renderDeleteList() {
    const box = panel.querySelector('#tm_del_list'); box.innerHTML = '';
    if (!presets.length) { box.innerHTML = '<div style="font-size:12px;color:#999;">无可删除项</div>'; return; }
    presets.forEach(item => {
      const r = document.createElement('div'); r.className = 'tm-del-item';
      r.innerHTML = '<span><b>' + escapeHtml(item.name) + '</b></span>';
      const btn = document.createElement('button'); btn.textContent = '删除';
      btn.onclick = () => { presets = presets.filter(x => x.id !== item.id); savePresets(); renderList(); renderDeleteList(); setStatus('已删除：' + item.name); };
      r.appendChild(btn); box.appendChild(r);
    });
  }

  function buildUI() {
    if (panel) return;
    const style = document.createElement('style');
    style.textContent = '.tm-minipanel{position:fixed;right:18px;top:110px;z-index:999999;width:320px;background:#fff;border:1px solid #e8e8e8;border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.16);font-family:Arial,"Microsoft YaHei";overflow:hidden;display:none;}.tm-head{height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;background:linear-gradient(180deg,#fafafa,#f6f6f6);border-bottom:1px solid #eee;font-size:13px;font-weight:600;}.tm-head .tm-btn{border:1px solid #ddd;background:#fff;border-radius:8px;padding:3px 8px;cursor:pointer;transition:.15s;}.tm-head .tm-btn:hover{background:#f0f7ff;border-color:#b3d8ff;}.tm-body{padding:10px;}.tm-status{font-size:12px;color:#666;margin-bottom:8px;min-height:16px;}.tm-list{max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:6px;}.tm-item{border:1px solid #eee;border-radius:10px;padding:8px;cursor:pointer;transition:all .15s;background:#fff;}.tm-item:hover{border-color:#b3d8ff;background:#f5faff;transform:translateY(-1px);}.tm-item:active{transform:scale(.995);}.tm-name{font-size:13px;font-weight:600;color:#222;}.tm-sub{font-size:12px;color:#666;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.tm-settings{margin-top:10px;padding-top:10px;border-top:1px dashed #e6e6e6;display:none;}.tm-settings input{width:100%;box-sizing:border-box;margin-bottom:6px;padding:7px 8px;border:1px solid #ddd;border-radius:8px;}.tm-row{display:flex;gap:6px;}.tm-row button{border:1px solid #ddd;background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;}.tm-del-list{max-height:130px;overflow:auto;margin-top:8px;border:1px solid #eee;border-radius:8px;padding:6px;}.tm-del-item{display:flex;justify-content:space-between;align-items:center;padding:4px 2px;font-size:12px;}.tm-del-item button{border:1px solid #f2b8b5;background:#fff5f5;color:#d33;border-radius:6px;padding:2px 6px;cursor:pointer;}.tm-empty{font-size:12px;color:#999;padding:10px;text-align:center;border:1px dashed #eee;border-radius:8px;}';
    document.head.appendChild(style);
    panel = document.createElement('div'); panel.className = 'tm-minipanel';
    panel.innerHTML = '<div class="tm-head"><span>线体工位快速切换</span><div><button class="tm-btn" id="tm_setting_btn">设置</button><button class="tm-btn" id="tm_close_btn">关闭</button></div></div><div class="tm-body"><div class="tm-status" id="tm_status"></div><div class="tm-list" id="tm_list"></div><div class="tm-settings" id="tm_settings"><input id="tm_name" placeholder="配置名（如：A 线 - 制作）"><input id="tm_line" placeholder="线体（如：独立工位线体|2 选第二个）"><input id="tm_station" placeholder="工位（如：装配_制作_独立工位）"><div class="tm-row"><button id="tm_add" type="button">新增配置</button><button id="tm_hide_setting" type="button">收起设置</button></div><div class="tm-del-list" id="tm_del_list"></div></div></div>';
    document.body.appendChild(panel);
    listBox = panel.querySelector('#tm_list'); settingsBox = panel.querySelector('#tm_settings'); statusEl = panel.querySelector('#tm_status');
    nameIpt = panel.querySelector('#tm_name'); lineIpt = panel.querySelector('#tm_line'); stationIpt = panel.querySelector('#tm_station');
    panel.querySelector('#tm_close_btn').onclick = (e) => { e.preventDefault(); e.stopPropagation(); safeHidePanel(); };
    panel.querySelector('#tm_setting_btn').onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleSettings(); };
    panel.querySelector('#tm_hide_setting').onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleSettings(false); };
    panel.querySelector('#tm_add').onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const item = { id: uid(), name: (nameIpt.value || '').trim() || '未命名', line: (lineIpt.value || '').trim(), station: (stationIpt.value || '').trim() };
      if (!item.line || !item.station) return setStatus('线体和工位不能为空', true);
      presets.push(item); savePresets(); nameIpt.value = ''; lineIpt.value = ''; stationIpt.value = '';
      renderList(); renderDeleteList(); setStatus('已新增配置：' + item.name);
    };
    renderList(); renderDeleteList();
  }

  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('button, .hae-btn, [role="button"]') : null;
    if (!t) return;
    if (textOf(t).includes(OPEN_TEXT)) setTimeout(showPanel, 280);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key || '').toLowerCase() !== 'q') return;
    e.preventDefault(); showPanel();
  }, true);

  // 联动：MES 保存按钮点击 → 脚本面板自动关闭
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, .hae-btn, [role="button"]');
    if (btn && textOf(btn).includes(SAVE_TEXT)) {
      sessionStorage.setItem('__mes_manual_save__', Date.now().toString());
      console.log('[线体工位配置] 检测到 MES 页面保存按钮点击');
      if (panel && panel.style.display === 'block') {
        setTimeout(() => { console.log('[线体工位配置] MES 页面已保存，脚本面板自动关闭'); panel.style.display = 'none'; }, 2000);
      }
    }
  }, true);

  // 监听 loading 消失
  const saveObserver = new MutationObserver((mutations) => {
    if (!hasLoading()) {
      const lastSave = sessionStorage.getItem('__mes_manual_save__');
      if (lastSave && (Date.now() - Number(lastSave) < 5000)) {
        if (panel && panel.style.display === 'block') { console.log('[线体工位配置] MES 保存完成，脚本面板自动关闭'); panel.style.display = 'none'; }
        sessionStorage.removeItem('__mes_manual_save__');
      }
    }
  });
  saveObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  window.__lineStationPanel = { showPanel, hidePanel: safeHidePanel, applyPreset };
  console.log('[TM] v2.3.3 已加载，双向联动：MES 保存→脚本关闭，脚本关闭→MES 保存');
})();
