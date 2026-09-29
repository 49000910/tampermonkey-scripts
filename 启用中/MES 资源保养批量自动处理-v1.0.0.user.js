// ==UserScript==
// @name         MES 资源保养批量自动处理
// @namespace   tm.mes.resource.maintain.batch
// @version      1.0.0
// @description MES资源保养批量处理：自动勾选列表行→保养→填随机合法值(电烙铁/电批)→保存→确定→自动下一行，直到处理完。按 Alt+B 开始
// @match       https://w3.huawei.com/mespmm/wipweb*
// @match       https://mes.huawei.com/mes/pmmrmweb*
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rand(a, b) { return (a + Math.random() * (b - a)).toFixed(2); }

  function log(m) { console.log('[保养批量] ' + m); }

  function clickBtnText(text) {
    var els = Array.from(document.querySelectorAll('button'));
    var vis = els.filter(function (e) { return e.textContent.trim() === text && e.getBoundingClientRect().width > 0; });
    if (!vis.length) return false;
    vis[0].click();
    return true;
  }

  async function waitGrid(timeout) {
    var t = 0;
    while (t < (timeout || 8000)) {
      var g = document.querySelector('.check-list-create-grid');
      if (g && g.getBoundingClientRect().height > 0) return g;
      await wait(400); t += 400;
    }
    return null;
  }

  function firstRowSelectPos() {
    var row = document.querySelectorAll('table tbody tr')[0];
    if (!row) return null;
    var c = row.cells[1];
    if (!c) return null;
    c.click();
    return row;
  }

  async function fillGridValues(values) {
    var g = document.querySelector('.check-list-create-grid');
    if (!g) return false;
    var ins = g.querySelectorAll('input');
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (var i = 0; i < values.length; i++) {
      var el = ins[i * 2];
      if (!el) continue;
      setter.call(el, values[i]);
      el.dispatchEvent(new Event('focus', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      await wait(180);
    }
    return true;
  }

  function detectType() {
    var g = document.querySelector('.check-list-create-grid');
    if (!g) return null;
    var text = g.innerText || '';
    if ((text.match(/扭矩测试/g) || []).length >= 3) return 'dianpi';
    if (text.indexOf('温度测试') >= 0) return 'dianlaotie';
    return 'unknown';
  }

  async function processOne() {
    firstRowSelectPos();
    await wait(1200);
    if (!clickBtnText('保养')) { log('点保养失败'); return false; }
    var g = await waitGrid(8000);
    if (!g) { log('弹窗未出现'); return false; }
    var type = detectType();
    var values;
    if (type === 'dianpi') {
      values = [rand(1, 8), rand(1.44, 1.52), rand(1.46, 1.54), rand(1.46, 1.54)];
      log('电批填: ' + values.join('/'));
    } else if (type === 'dianlaotie') {
      values = [rand(2, 8), rand(360, 375)];
      log('电烙铁填: ' + values.join('/'));
    } else {
      log('未知类型: ' + g.innerText.slice(0, 30));
      return false;
    }
    await fillGridValues(values);
    await wait(600);
    if (!clickBtnText('保存')) { log('点保存失败'); return false; }
    await wait(1500);
    clickBtnText('确定');
    await wait(2500);
    log('完成1个');
    return true;
  }

  window.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      log('=== 开始批量保养 ===');
      (async function loop() {
        var count = 0;
        while (true) {
          var ok = await processOne();
          if (!ok) { log('已处理 ' + count + ' 个后停止'); break; }
          count++;
          await wait(1500);
        }
      })();
    }
  });

  log('已加载，按 Alt+B 开始批量保养');
})();