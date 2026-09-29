// ==UserScript==
// @name         MES 父项批量过站（仅按加载圈判断）
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  仅根据 #global_toploading_flag 出现->消失 判断一条完成
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const fallbackIndex = 3;
  const loadingSelector = '#global_toploading_flag';
  const maxWaitMs = 15000;
  const tickMs = 200;

  let queue = [];
  let idx = 0;
  let running = false;
  let waiting = false;
  let waitStart = 0;
  let currentCode = '';
  let ticking = false;

  let sawLoading = false;       // 本条是否见过loading显示
  let loadingGoneCount = 0;     // loading消失连续计数（抗抖）

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function getParentInput() {
    const all = [...document.querySelectorAll('div[id^="Input_"] > input.hae-ui-input[type="text"]')];
    for (const el of all) {
      const box = el.closest('div[id^="Input_"]');
      const ctx = ((box?.parentElement?.innerText || box?.innerText || '')).replace(/\s+/g, '');
      if (ctx.includes('条码采集')) return el;
    }
    return all[fallbackIndex] || null;
  }

  function isLoadingVisible() {
    const el = document.querySelector(loadingSelector);
    if (!el) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  function setStatus(msg, color = '#333') {
    const el = document.getElementById('tm-batch-status');
    if (el) {
      el.textContent = msg;
      el.style.color = color;
    }
    console.log('[批量过站]', msg);
  }

  function setProgress() {
    const el = document.getElementById('tm-batch-progress');
    if (el) el.textContent = `@@@MATH_INLINE_0_END@@@{queue.length}`;
  }

  function parseCodes(text) {
    return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }

  async function submitOne(code) {
    const input = getParentInput();
    if (!input) {
      setStatus('未找到“条码采集”输入框', '#cf1322');
      running = false;
      return false;
    }

    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(input, code) : (input.value = code);

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(60);

    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    await sleep(10);
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    await sleep(10);
    input.dispatchEvent(new KeyboardEvent('keyup', opts));

    return true;
  }

  async function tick() {
    if (!running || ticking) return;
    ticking = true;
    try {
      if (waiting) {
        const loadingNow = isLoadingVisible();

        if (loadingNow) {
          sawLoading = true;
          loadingGoneCount = 0;
        } else {
          if (sawLoading) loadingGoneCount++;
        }

        // 见过loading后，连续3次检测都已消失 -> 判定完成
        if (sawLoading && loadingGoneCount >= 3) {
          waiting = false;
          idx++;
          setProgress();
          await sleep(180);
          return;
        }

        if (Date.now() - waitStart > maxWaitMs) {
          running = false;
          waiting = false;
          setStatus(`第 @@@MATH_INLINE_1_END@@@{currentCode}，已暂停`, '#cf1322');
          return;
        }
        return;
      }

      if (idx >= queue.length) {
        running = false;
        setStatus(`完成：共 ${queue.length} 条`, '#389e0d');
        return;
      }

      currentCode = queue[idx];
      sawLoading = false;
      loadingGoneCount = 0;

      const ok = await submitOne(currentCode);
      if (!ok) return;

      waiting = true;
      waitStart = Date.now();
      setStatus(`提交中 (@@@MATH_INLINE_2_END@@@{queue.length})：${currentCode}`, '#1677ff');
    } finally {
      ticking = false;
    }
  }

  function buildPanel() {
    const box = document.createElement('div');
    box.style.cssText = `
      position: fixed; right: 16px; bottom: 16px; z-index: 999999;
      width: 330px; background: #fff; border: 1px solid #d9d9d9;
      border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.15);
      font-size: 12px; padding: 10px;
    `;
    box.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;">父项批量过站（仅loading）</div>
      <textarea id="tm-batch-input" placeholder="每行一个条码" style="width:100%;height:110px;box-sizing:border-box;"></textarea>/g
      <div style="margin-top:8px;display:flex;gap:6px;">
        <button id="tm-load">载入</button>
        <button id="tm-start">开始</button>
        <button id="tm-pause">暂停</button>
        <button id="tm-reset">重置</button>
      </div>
      <div style="margin-top:8px;">进度：<span id="tm-batch-progress">0/0</span></div>
      <div id="tm-batch-status" style="margin-top:4px;">待命</div>
    `;
    document.body.appendChild(box);

    document.getElementById('tm-load').onclick = () => {
      queue = parseCodes(document.getElementById('tm-batch-input').value);
      idx = 0; running = false; waiting = false; currentCode = '';
      setProgress();
      setStatus(`已载入 ${queue.length} 条`);
    };
    document.getElementById('tm-start').onclick = () => {
      if (!queue.length) return setStatus('请先载入条码', '#cf1322');
      running = true;
      setStatus('开始执行...', '#1677ff');
    };
    document.getElementById('tm-pause').onclick = () => {
      running = false; waiting = false;
      setStatus('已暂停', '#fa8c16');
    };
    document.getElementById('tm-reset').onclick = () => {
      running = false; waiting = false; idx = 0; currentCode = '';
      setProgress();
      setStatus('已重置');
    };
  }

  window.addEventListener('load', () => {
    buildPanel();
    setInterval(() => { tick(); }, tickMs);
  });
})();
