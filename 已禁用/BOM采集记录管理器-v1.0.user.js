// ==UserScript==
// @name         BOM采集记录管理器
// @namespace    bom-collect-manager
// @version      1.0
// @description  查看、导出、删除BOM采集记录
// @match        https://w3.huawei.com/mespmm/wipweb*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  var STORE_KEY = 'sn_bom_collect_store_v1';
  var panel = null;

  function loadData() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{"parents":{},"snIndex":{}}');
    } catch(e) {
      return { parents: {}, snIndex: {} };
    }
  }

  function saveData(data) {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  }

  function formatTime(ts) {
    if (!ts) return '未知';
    var d = new Date(ts);
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0') + ' ' +
           String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }

  function createPanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = '__bom_manager_panel';
    panel.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:900px;max-width:calc(100vw-40px);height:700px;max-height:calc(100vh-40px);background:#fff;border-radius:12px;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,0.15);font-size:13px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;overflow:hidden;display:none;flex-direction:column;';

    panel.innerHTML = `
      <div style="padding:14px 18px;background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
        <span style="font-weight:600;font-size:15px;">📋 BOM采集记录管理</span>
        <div style="display:flex;gap:8px;">
          <button id="__bom_export_btn" style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:5px 14px;border-radius:6px;cursor:pointer;font-size:12px;">📥 导出JSON</button>
          <button id="__bom_export_csv_btn" style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:5px 14px;border-radius:6px;cursor:pointer;font-size:12px;">📊 导出CSV</button>
          <button id="__bom_clear_btn" style="background:rgba(255,50,50,0.3);border:none;color:#fff;padding:5px 14px;border-radius:6px;cursor:pointer;font-size:12px;">🗑️ 清空全部</button>
          <button id="__bom_close_btn" style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:5px 14px;border-radius:6px;cursor:pointer;font-size:12px;">✕ 关闭</button>
        </div>
      </div>

      <div style="padding:8px 18px;background:#f8f9fa;border-bottom:1px solid #eee;display:flex;gap:12px;align-items:center;flex-shrink:0;flex-wrap:wrap;">
        <span style="font-size:12px;color:#666;">共 <strong id="__bom_total_count">0</strong> 条父项记录</span>
        <input id="__bom_search" placeholder="搜索父项SN..." style="flex:1;min-width:150px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:12px;">
        <button id="__bom_refresh_btn" style="padding:6px 14px;border:1px solid #1677ff;border-radius:6px;background:#fff;color:#1677ff;cursor:pointer;font-size:12px;">🔄 刷新</button>
      </div>

      <div style="flex:1;overflow:auto;padding:10px 18px;">
        <div id="__bom_list"></div>
      </div>
    `;

    document.body.appendChild(panel);

    // 绑定事件
    document.getElementById('__bom_close_btn').onclick = function() { panel.style.display = 'none'; };
    document.getElementById('__bom_refresh_btn').onclick = renderList;
    document.getElementById('__bom_search').oninput = renderList;

    document.getElementById('__bom_export_btn').onclick = exportJSON;
    document.getElementById('__bom_export_csv_btn').onclick = exportCSV;
    document.getElementById('__bom_clear_btn').onclick = clearAll;

    renderList();
  }

  function renderList() {
    var data = loadData();
    var parents = data.parents || {};
    var search = (document.getElementById('__bom_search').value || '').toLowerCase();

    var keys = Object.keys(parents);
    document.getElementById('__bom_total_count').textContent = keys.length;

    // 过滤
    if (search) {
      keys = keys.filter(function(k) {
        return k.toLowerCase().includes(search) ||
               (parents[k].parentSn || '').toLowerCase().includes(search);
      });
    }

    // 按时间排序（最新的在前）
    keys.sort(function(a, b) {
      return (parents[b].ts || 0) - (parents[a].ts || 0);
    });

    var listEl = document.getElementById('__bom_list');

    if (keys.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;padding:40px;color:#999;font-size:14px;">' +
        (search ? '未找到匹配的记录' : '暂无记录') + '</div>';
      return;
    }

    var html = '';
    keys.forEach(function(key) {
      var p = parents[key];
      var items = p.items || [];
      var snList = items.map(function(item) { return item.sn || ''; }).filter(Boolean).join(', ');

      html += `
        <div style="border:1px solid #e8e8e8;border-radius:10px;margin-bottom:8px;padding:12px 14px;background:#fff;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div style="flex:1;">
              <div style="font-weight:600;color:#1a1a2e;font-size:14px;margin-bottom:4px;">
                父项: ${escapeHtml(p.parentSn || key)}
                <span style="font-size:11px;color:#999;font-weight:400;margin-left:8px;">${formatTime(p.ts)}</span>
              </div>
              <div style="font-size:12px;color:#666;margin-bottom:6px;">
                子项数量: <strong>${items.length}</strong> |
                BOM编码: ${items.map(function(item) { return escapeHtml(item.bomCode || ''); }).filter(Boolean).join(', ')}
              </div>
              <div style="font-size:11px;color:#999;word-break:break-all;">
                SN: ${escapeHtml(snList)}
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;margin-left:12px;">
              <button class="__bom_delete_one" data-key="${escapeHtml(key)}" style="padding:4px 10px;border:1px solid #ff4d4f;border-radius:6px;background:#fff;color:#ff4d4f;cursor:pointer;font-size:11px;">删除</button>
            </div>
          </div>
        </div>
      `;
    });

    listEl.innerHTML = html;

    // 绑定删除事件
    listEl.querySelectorAll('.__bom_delete_one').forEach(function(btn) {
      btn.onclick = function() {
        var key = this.getAttribute('data-key');
        if (confirm('确定删除父项 ' + key + ' 的记录？')) {
          var data = loadData();
          delete data.parents[key];
          saveData(data);
          renderList();
        }
      };
    });
  }

  function exportJSON() {
    var data = loadData();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'bom_collect_records_' + Date.now() + '.json');
  }

  function exportCSV() {
    var data = loadData();
    var parents = data.parents || {};
    var keys = Object.keys(parents);

    var csv = '父项SN,子项SN,BOM编码,时间\n';
    keys.forEach(function(key) {
      var p = parents[key];
      var items = p.items || [];
      items.forEach(function(item) {
        csv += '"' + (p.parentSn || key) + '","' + (item.sn || '') + '","' + (item.bomCode || '') + '","' + formatTime(p.ts) + '"\n';
      });
    });

    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'bom_collect_records_' + Date.now() + '.csv');
  }

  function clearAll() {
    if (confirm('确定清空所有BOM采集记录？此操作不可恢复！')) {
      localStorage.removeItem(STORE_KEY);
      renderList();
    }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // 快捷键 Alt+B 打开面板
  document.addEventListener('keydown', function(e) {
    if (e.altKey && (e.key || '').toLowerCase() === 'b') {
      e.preventDefault();
      if (!panel) createPanel();
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      if (panel.style.display === 'flex') renderList();
    }
  });

  // 创建浮动按钮
  function createFloatBtn() {
    var btn = document.createElement('div');
    btn.id = '__bom_float_btn';
    btn.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646;background:#1a1a2e;color:#fff;border-radius:10px;padding:8px 14px;font-size:12px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.2);font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;user-select:none;';
    btn.textContent = '📋 BOM记录';
    btn.onclick = function() {
      if (!panel) createPanel();
      panel.style.display = 'flex';
      renderList();
    };
    document.body.appendChild(btn);
  }

  // 启动
  setTimeout(createFloatBtn, 2000);
  console.log('[BOM管理器] 已加载，按 Alt+B 打开，或点击右下角按钮');
})();
