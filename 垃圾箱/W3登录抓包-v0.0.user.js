// ==UserScript==
// @name         W3登录抓包
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    var logs = GM_getValue('w3logs', []);

    var _o = XMLHttpRequest.prototype.open, _s = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this._m = m; this._u = u; return _o.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
        var t = this;
        var h = function () {
            var entry = { type: 'xhr', m: t._m, u: t._u, s: t.status, b: String(b).substring(0, 500), r: t.responseText.substring(0, 500), t: Date.now() };
            logs.push(entry);
            GM_setValue('w3logs', logs);
        };
        t.addEventListener('load', h);
        return _s.apply(this, arguments);
    };

    var _f = window.fetch;
    window.fetch = function (u, o) {
        var url = typeof u === 'string' ? u : u.url;
        var m = (o && o.method) || 'GET';
        var b = (o && o.body) || '';
        return _f.apply(this, arguments).then(function (r) {
            r.clone().text().then(function (txt) {
                var entry = { type: 'fetch', m: m, u: url, s: r.status, b: String(b).substring(0, 500), r: txt.substring(0, 500), t: Date.now() };
                logs.push(entry);
                GM_setValue('w3logs', logs);
            });
            return r;
        });
    };

    document.addEventListener('submit', function (e) {
        var form = e.target;
        try {
            var fd = new FormData(form);
            var obj = {};
            fd.forEach(function (v, k) { obj[k] = v; });
            var entry = { type: 'form', action: form.action, method: form.method, fields: obj, t: Date.now() };
            logs.push(entry);
            GM_setValue('w3logs', logs);
        } catch {}
    }, true);

    GM_registerMenuCommand('导出抓包结果(下载JSON)', function () {
        var text = JSON.stringify(logs, null, 2);
        var blob = new Blob([text], { type: 'text/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'w3_login_capture.json';
        a.click();
    });

    GM_registerMenuCommand('清空抓包记录', function () {
        logs = [];
        GM_setValue('w3logs', []);
        alert('已清空');
    });
})();
