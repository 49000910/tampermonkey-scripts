// ==UserScript==
// @name         MES授权中心（无前台版）
// @namespace    tm.mes.auth.center.hidden
// @version      1.1.1
// @description  MES脚本统一授权中心，无前台按钮，仅快捷键打开管理面板，支持精准到分钟、在线续期及强制过期刷新
// @match        https://w3.huawei.com/mespmm/wipweb*
// @match        https://w3.huawei.com/mespmm/wipweb/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  console.log('[MES授权中心] 已加载，无前台版：', location.href);

  var AUTH_STATE_KEY = 'MES_AUTH_CENTER_STATE_V1';
  var AUTH_ALLOW_KEY = 'MES_AUTH_CENTER_ALLOW_JOBS_V1';
  var AUTH_EXPIRES_KEY = 'MES_AUTH_JOB_EXPIRES_V2';
  var EXPIRE_DAYS_KEY = 'MES_AUTH_EXPIRE_DAYS';

  // ，自己改
  var ADMIN_PASSWORD = '1231';

  // 默认授权工号
  var DEFAULT_ALLOW_JOBS = [
    '82023703'
  ];

  var DEFAULT_EXPIRE_DAYS = parseFloat(localStorage.getItem(EXPIRE_DAYS_KEY)) || 15;

  var ACCOUNT_SELECTORS = [
    '.user-info-name .user-name-display',
    '.user-name-display',
    '.user-info-name'
  ];

  var panelAuthed = false;

  function formatTimeLeft(ms) {
    if (ms <= 0) return '已过期';
    var totalMinutes = Math.floor(ms / 60000);
    var days = Math.floor(totalMinutes / (60 * 24));
    var hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    var minutes = totalMinutes % 60;

    var res = '';
    if (days > 0) res += days + '天 ';
    if (hours > 0 || days > 0) res += hours + '小时 ';
    res += minutes + '分钟';
    return res.trim();
  }

  function getJobExpires() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_EXPIRES_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveJobExpires(obj) {
    localStorage.setItem(AUTH_EXPIRES_KEY, JSON.stringify(obj));
  }

  function getAccountText() {
    for (var i = 0; i < ACCOUNT_SELECTORS.length; i++) {
      var el = document.querySelector(ACCOUNT_SELECTORS[i]);
      var text = el && el.textContent ? el.textContent.trim() : '';
      if (text) return text;
    }
    return '';
  }

  function getJobNumber(text) {
    var m = String(text || '').match(/\b\d{6,12}\b/);
    return m ? m[0] : '';
  }

  function loadAllowJobs() {
    var arr = null;
    try {
      arr = JSON.parse(localStorage.getItem(AUTH_ALLOW_KEY) || 'null');
    } catch (e) {}

    if (!Array.isArray(arr)) {
      arr = DEFAULT_ALLOW_JOBS.slice();
      localStorage.setItem(AUTH_ALLOW_KEY, JSON.stringify(arr));

      var expiresObj = getJobExpires();
      var now = Date.now();
      arr.forEach(function(job) {
        if (!expiresObj[job]) {
          expiresObj[job] = now + (DEFAULT_EXPIRE_DAYS * 24 * 60 * 60 * 1000);
        }
      });
      saveJobExpires(expiresObj);
    }

    return arr.map(function (x) {
      return String(x || '').trim();
    }).filter(function (x) {
      return /^\d{6,12}$/.test(x);
    });
  }

  function saveAllowJobs(list) {
    var seen = {};
    var out = [];
    (list || []).forEach(function (x) {
      x = String(x || '').trim();
      if (!/^\d{6,12}$/.test(x)) return;
      if (!seen[x]) {
        seen[x] = 1;
        out.push(x);
      }
    });
    localStorage.setItem(AUTH_ALLOW_KEY, JSON.stringify(out));
    return out;
  }

  function checkAuth() {
    var accountText = getAccountText();
    var jobNumber = getJobNumber(accountText);
    var allowJobs = loadAllowJobs();

    var ok = false;
    var status = '';
    var reason = '';

    if (!accountText) {
      status = 'unknown';
      reason = '未检测到账号信息';
    } else if (!jobNumber) {
      status = 'unknown';
      reason = '未提取到工号';
    } else if (allowJobs.indexOf(jobNumber) >= 0) {
      var expiresObj = getJobExpires();
      var expireTime = expiresObj[jobNumber] || 0;
      var timeLeft = expireTime - Date.now();

      if (timeLeft <= 0) {
        // 已过期，从未授权列表移除
        allowJobs = allowJobs.filter(function(j) { return j !== jobNumber; });
        localStorage.setItem(AUTH_ALLOW_KEY, JSON.stringify(allowJobs));

        // 清理过期的无用心跳时间戳
        delete expiresObj[jobNumber];
        saveJobExpires(expiresObj);

        status = 'unauthorized';
        reason = '授权已过期';

        // 气泡提示
        var bubble = document.createElement('div');
        bubble.textContent = '工号 ' + jobNumber + ' 授权已过期，页面即将强制刷新...';
        bubble.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#cf1322;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(bubble);

        // ★★★ 新增阻断逻辑：过期后强制刷新页面，清理掉正在运行的功能 ★★★
        setTimeout(function() {
            location.reload();
        }, 1500); // 延迟1.5秒执行，让用户看到红条提示

      } else {
        ok = true;
        status = 'authorized';
        reason = '授权工号，剩余 ' + formatTimeLeft(timeLeft);
      }
    } else {
      status = 'unauthorized';
      reason = '未授权工号';
    }

    var data = {
      ok: ok,
      status: status,
      reason: reason,
      accountText: accountText,
      jobNumber: jobNumber,
      allowJobs: allowJobs,
      ts: Date.now()
    };

    try {
      localStorage.setItem(AUTH_STATE_KEY, JSON.stringify(data));
      window.__MES_AUTH_CENTER_STATE__ = data;
      window.dispatchEvent(new CustomEvent('mes-auth-center-update', { detail: data }));
    } catch (e) {}

    return data;
  }

  function ensureBody(fn) {
    if (document.body) { fn(); return; }
    var timer = setInterval(function () {
      if (document.body) { clearInterval(timer); fn(); }
    }, 100);
  }

  function openPanel() {
    ensureBody(function () {
      var old = document.getElementById('mes-auth-center-panel');
      if (old) {
        old.style.display = 'block';
        refreshPanel();
        return;
      }

      var box = document.createElement('div');
      box.id = 'mes-auth-center-panel';
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%, -50%);z-index:2147483647;width:480px;background:#fff;color:#222;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 10px 35px rgba(0,0,0,.25);font-size:12px;overflow:hidden;font-family:Arial, "Microsoft YaHei", sans-serif;';

      box.innerHTML =
        '<div style="height:40px;line-height:40px;background:#1677ff;color:#fff;padding:0 12px;display:flex;justify-content:space-between;align-items:center;">' +
          '<b>MES授权中心</b>' +
          '<button id="mes-auth-center-close" style="border:0;border-radius:6px;padding:3px 9px;cursor:pointer;">关闭</button>' +
        '</div>' +
        '<div style="padding:12px;">' +
          '<div style="margin-bottom:8px;">当前账号：<span id="mes-auth-center-account">读取中</span></div>' +
          '<div style="margin-bottom:8px;">当前工号：<span id="mes-auth-center-job">读取中</span></div>' +
          '<div style="margin-bottom:8px;">授权状态：<span id="mes-auth-center-state">读取中</span></div>' +
          '<hr style="margin:10px 0;">' +
          '<div id="mes-auth-center-login-box">' +
            '<div style="margin-bottom:6px;">管理密码</div>' +
            '<input id="mes-auth-center-pwd" type="password" placeholder="输入管理密码" style="width:100%;height:30px;box-sizing:border-box;">' +
            '<div style="margin-top:8px;"><button id="mes-auth-center-login">进入管理</button></div>' +
            '<div id="mes-auth-center-login-msg" style="margin-top:6px;color:#cf1322;"></div>' +
          '</div>' +
          '<div id="mes-auth-center-admin-box" style="display:none;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
              '<span>添加新工号/重置时间</span>' +
            '</div>' +
            '<div style="display:flex;gap:5px;margin-bottom:8px;">' +
              '<input id="mes-auth-center-new-job" placeholder="输入工号(如82023703)" style="flex:2;height:30px;box-sizing:border-box;">' +
              '<input id="mes-auth-center-new-days" type="number" step="0.1" placeholder="天数" style="flex:1;height:30px;box-sizing:border-box;" value="' + DEFAULT_EXPIRE_DAYS + '">' +
            '</div>' +
            '<div style="margin-top:4px;margin-bottom:8px;">' +
              '<button id="mes-auth-center-add" style="background:#1677ff;color:#fff;border:0;padding:5px 8px;border-radius:4px;cursor:pointer;">添加/重置</button> ' +
              '<button id="mes-auth-center-add-current">添加当前</button> ' +
              '<button id="mes-auth-center-refresh">刷新检测</button>' +
            '</div>' +
            '<hr style="margin:10px 0;">' +
            '<div style="margin-bottom:6px;font-weight:bold;">已授权工号 (支持在线增加时间)</div>' +
            '<div id="mes-auth-center-list" style="max-height:260px;overflow:auto;border:1px solid #eee;border-radius:6px;padding:8px;background:#fafafa;"></div>' +
            '<div id="mes-auth-center-msg" style="margin-top:6px;color:#389e0d;"></div>' +
          '</div>' +
          '<div style="margin-top:10px;color:#888;line-height:1.5;">' +
            '快捷键：F10 / Ctrl+F10。授权中心无前台按钮，只在后台写入授权状态。' +
          '</div>' +
        '</div>';

      document.body.appendChild(box);

      document.getElementById('mes-auth-center-close').onclick = function () { box.style.display = 'none'; };

      document.getElementById('mes-auth-center-login').onclick = function () {
        var pwd = document.getElementById('mes-auth-center-pwd').value;
        var msg = document.getElementById('mes-auth-center-login-msg');
        if (pwd !== ADMIN_PASSWORD) { msg.textContent = '密码错误'; return; }
        msg.textContent = '';
        panelAuthed = true;
        document.getElementById('mes-auth-center-login-box').style.display = 'none';
        document.getElementById('mes-auth-center-admin-box').style.display = 'block';
        renderAllowList();
      };

      document.getElementById('mes-auth-center-pwd').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { document.getElementById('mes-auth-center-login').click(); }
      });

      document.getElementById('mes-auth-center-add').onclick = function () {
        var input = document.getElementById('mes-auth-center-new-job');
        var daysInput = document.getElementById('mes-auth-center-new-days');
        addJob(input.value, daysInput.value);
      };

      document.getElementById('mes-auth-center-add-current').onclick = function () {
        var st = checkAuth();
        var daysInput = document.getElementById('mes-auth-center-new-days');
        if(st.jobNumber) { addJob(st.jobNumber, daysInput.value); }
      };

      document.getElementById('mes-auth-center-refresh').onclick = function () {
        checkAuth();
        refreshPanel();
      };

      refreshPanel();
    });
  }

  function refreshPanel() {
    var st = checkAuth();
    var accountEl = document.getElementById('mes-auth-center-account');
    var jobEl = document.getElementById('mes-auth-center-job');
    var stateEl = document.getElementById('mes-auth-center-state');

if (accountEl) accountEl.textContent = st.accountText || '未检测到';
    if (jobEl) jobEl.textContent = st.jobNumber || '未识别'; // 修复：把 accountEl 改回 jobEl


    if (stateEl) {
      stateEl.textContent = st.ok ? '已授权' : '未授权：' + st.reason;
      stateEl.style.color = st.ok ? '#389e0d' : '#cf1322';
    }

    if (panelAuthed) {
      updateListTimeText();
    }
  }

  function addJob(job, days) {
    job = String(job || '').trim();
    days = parseFloat(days);

    var msg = document.getElementById('mes-auth-center-msg');

    if (!/^\d{6,12}$/.test(job)) {
      if (msg) { msg.style.color = '#cf1322'; msg.textContent = '工号格式不正确'; }
      return;
    }

    if (isNaN(days) || days <= 0) {
      if (msg) { msg.style.color = '#cf1322'; msg.textContent = '请输入有效的天数 (支持小数，如 0.5)'; }
      return;
    }

    var list = loadAllowJobs();
    var expiresObj = getJobExpires();

    var currentExpire = expiresObj[job] || 0;
    var baseTime = currentExpire > Date.now() ? currentExpire : Date.now();

    var msToAdd = days * 24 * 60 * 60 * 1000;
    expiresObj[job] = baseTime + msToAdd;
    saveJobExpires(expiresObj);

    if (list.indexOf(job) < 0) {
      list.push(job);
      saveAllowJobs(list);
    }

    checkAuth();
    renderAllowList();

    if (msg) {
      msg.style.color = '#389e0d';
      msg.textContent = '操作成功：' + job + ' 已增加 ' + days + ' 天权限！';
    }
  }

  function removeJob(job) {
    var list = loadAllowJobs().filter(function (x) { return x !== job; });
    saveAllowJobs(list);

    var expiresObj = getJobExpires();
    delete expiresObj[job];
    saveJobExpires(expiresObj);

    checkAuth();
    renderAllowList();

    var msg = document.getElementById('mes-auth-center-msg');
    if (msg) { msg.style.color = '#cf1322'; msg.textContent = '已删除：' + job + '，建议刷新页面'; }
  }

  function renderAllowList() {
    var box = document.getElementById('mes-auth-center-list');
    if (!box) return;

    var list = loadAllowJobs();
    var expiresObj = getJobExpires();
    var now = Date.now();

    if (!list.length) {
      box.innerHTML = '<div style="color:#999;padding:10px;text-align:center;">暂无授权工号</div>';
      return;
    }

    box.innerHTML = '';

    list.forEach(function (job) {
      var expireTime = expiresObj[job] || 0;
      var timeLeft = expireTime - now;
      var isExpired = timeLeft <= 0;

      var row = document.createElement('div');
      row.style.cssText = 'padding:8px;border-bottom:1px solid #eee;background:#fff;border-radius:4px;margin-bottom:6px;';

      var infoRow = document.createElement('div');
      infoRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';

      var jobSpan = document.createElement('span');
      jobSpan.innerHTML = '<b style="font-size:13px;">' + job + '</b>';

      var timeSpan = document.createElement('span');
      timeSpan.id = 'time-text-' + job;
      timeSpan.style.cssText = 'font-size:11px;font-weight:bold;color:' + (isExpired ? '#cf1322' : '#389e0d');
      timeSpan.textContent = isExpired ? '已过期' : '剩余 ' + formatTimeLeft(timeLeft);

      infoRow.appendChild(jobSpan);
      infoRow.appendChild(timeSpan);

      var ctrlRow = document.createElement('div');
      ctrlRow.style.cssText = 'display:flex;gap:4px;align-items:center;';

      var input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      input.placeholder = '增加天数';
      input.style.cssText = 'flex:1;height:26px;border:1px solid #ccc;border-radius:4px;padding:0 5px;font-size:11px;';

      var btnAddTime = document.createElement('button');
      btnAddTime.textContent = '+增加';
      btnAddTime.style.cssText = 'padding:4px 6px;background:#1677ff;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:11px;';
      btnAddTime.onclick = function() {
        var val = input.value;
        if (!val) { alert('请输入要增加的天数'); return; }
        addJob(job, val);
        input.value = '';
      };

      var btnDel = document.createElement('button');
      btnDel.textContent = '删除';
      btnDel.style.cssText = 'padding:4px 6px;background:#fff;color:#cf1322;border:1px solid #cf1322;border-radius:4px;cursor:pointer;font-size:11px;';
      btnDel.onclick = function() { removeJob(job); };

      ctrlRow.appendChild(input);
      ctrlRow.appendChild(btnAddTime);
      ctrlRow.appendChild(btnDel);

      row.appendChild(infoRow);
      row.appendChild(ctrlRow);
      box.appendChild(row);
    });
  }

  function updateListTimeText() {
    var list = loadAllowJobs();
    var expiresObj = getJobExpires();
    var now = Date.now();

    list.forEach(function(job) {
      var el = document.getElementById('time-text-' + job);
      if (el) {
        var expireTime = expiresObj[job] || 0;
        var timeLeft = expireTime - now;
        if (timeLeft <= 0) {
          el.textContent = '已过期';
          el.style.color = '#cf1322';
        } else {
          el.textContent = '剩余 ' + formatTimeLeft(timeLeft);
          el.style.color = '#389e0d';
        }
      }
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'F10' || (e.ctrlKey && e.key === 'F10')) {
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    }
  }, true);

  function boot() {
    checkAuth();
    setInterval(function () {
      checkAuth();
      var panel = document.getElementById('mes-auth-center-panel');
      if (panel && panel.style.display !== 'none') {
        refreshPanel();
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
