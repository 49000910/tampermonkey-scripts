// ==UserScript==
// @name         Chrome for Testing 下载列表扫描器-安全拼接版
// @namespace    local.chrome-for-testing-safe
// @version      2.1.0
// @description  使用官方 JSON 或直接探测下载地址，列出 Chrome for Testing 版本下载链接
// @author       local
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      googlechromelabs.github.io
// @connect      storage.googleapis.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    var JSON_URL = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
    var DOWNLOAD_BASE = 'https://storage.googleapis.com/chrome-for-testing-public';

    var platforms = [
        'win64',
        'win32',
        'linux64',
        'mac-x64',
        'mac-arm64'
    ];

    var state = {
        versions: [],
        platform: 'win64'
    };

    GM_addStyle([
        '#cft-panel {',
        'position: fixed;',
        'z-index: 2147483647;',
        'top: 40px;',
        'left: 50%;',
        'transform: translateX(-50%);',
        'width: min(1200px, calc(100vw - 40px));',
        'max-height: calc(100vh - 80px);',
        'background: #111827;',
        'color: #e5e7eb;',
        'border: 1px solid #374151;',
        'border-radius: 12px;',
        'box-shadow: 0 20px 60px rgba(0,0,0,.45);',
        'font-family: Arial, "Microsoft YaHei", sans-serif;',
        'overflow: hidden;',
        '}',
        '#cft-panel * { box-sizing: border-box; }',
        '#cft-head {',
        'display: flex;',
        'justify-content: space-between;',
        'align-items: center;',
        'background: #1f2937;',
        'padding: 12px 16px;',
        'border-bottom: 1px solid #374151;',
        '}',
        '#cft-head h2 { margin: 0; font-size: 16px; }',
        '#cft-close {',
        'background: #374151;',
        'color: white;',
        'border: 0;',
        'border-radius: 6px;',
        'padding: 6px 10px;',
        'cursor: pointer;',
        '}',
        '#cft-body {',
        'padding: 14px 16px;',
        'overflow: auto;',
        'max-height: calc(100vh - 145px);',
        '}',
        '.cft-row {',
        'display: flex;',
        'flex-wrap: wrap;',
        'gap: 8px;',
        'align-items: center;',
        'margin-bottom: 10px;',
        '}',
        '.cft-row input, .cft-row select {',
        'background: #030712;',
        'color: #f9fafb;',
        'border: 1px solid #4b5563;',
        'border-radius: 6px;',
        'padding: 7px 9px;',
        '}',
        '.cft-row button {',
        'background: #2563eb;',
        'color: white;',
        'border: 0;',
        'border-radius: 6px;',
        'padding: 8px 12px;',
        'cursor: pointer;',
        '}',
        '.cft-row button.secondary { background: #4b5563; }',
        '#cft-status {',
        'color: #93c5fd;',
        'font-size: 13px;',
        'white-space: pre-wrap;',
        'margin: 10px 0;',
        '}',
        '#cft-table {',
        'width: 100%;',
        'border-collapse: collapse;',
        'font-size: 13px;',
        '}',
        '#cft-table th, #cft-table td {',
        'border: 1px solid #374151;',
        'padding: 7px 8px;',
        'vertical-align: top;',
        '}',
        '#cft-table th {',
        'background: #1f2937;',
        'position: sticky;',
        'top: 0;',
        '}',
        '#cft-table a {',
        'color: #60a5fa;',
        'text-decoration: none;',
        'word-break: break-all;',
        '}',
        '#cft-table a:hover { text-decoration: underline; }',
        '.cft-tip {',
        'color: #9ca3af;',
        'font-size: 12px;',
        'line-height: 1.6;',
        'margin: 8px 0 12px;',
        '}',
        '.cft-version {',
        'color: #facc15;',
        'font-family: Consolas, monospace;',
        '}'
    ].join('\n'));

    function request(method, url, responseType) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: method,
                url: url,
                responseType: responseType || 'text',
                timeout: 30000,
                onload: function (res) {
                    resolve(res);
                },
                onerror: function (err) {
                    reject(err);
                },
                ontimeout: function () {
                    reject(new Error('请求超时'));
                }
            });
        });
    }

    async function getJson(url) {
        var res = await request('GET', url, 'json');

        if (res.status >= 200 && res.status < 300) {
            if (res.response) {
                return res.response;
            }

            return JSON.parse(res.responseText);
        }

        throw new Error('HTTP ' + res.status);
    }

    async function existsByHead(url) {
        try {
            var res = await request('HEAD', url, 'text');
            return res.status >= 200 && res.status < 300;
        } catch (e) {
            return false;
        }
    }

    function fileName(product, platform) {
        if (product === 'chrome') {
            return 'chrome-' + platform + '.zip';
        }

        if (product === 'driver') {
            return 'chromedriver-' + platform + '.zip';
        }

        if (product === 'headless') {
            return 'chrome-headless-shell-' + platform + '.zip';
        }

        return '';
    }

    function downloadUrl(version, platform, product) {
        return DOWNLOAD_BASE + '/' + version + '/' + platform + '/' + fileName(product, platform);
    }

   function compareVersion(a, b) {
    var pa = String(a).split('.');
    var pb = String(b).split('.');
    var len = Math.max(pa.length, pb.length);
    var i;

    for (i = 0; i < len; i++) {
        var x = parseInt(pa[i] || '0', 10);
        var y = parseInt(pb[i] || '0', 10);

        if (x !== y) {
            return x - y;
        }
    }

    return 0;
}


       function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setStatus(text) {
        var el = document.querySelector('#cft-status');

        if (el) {
            el.textContent = text;
        }
    }

    function render() {
        var box = document.querySelector('#cft-result');

        if (!box) {
            return;
        }

        if (!state.versions.length) {
            box.innerHTML = '<div class="cft-tip">暂无结果。</div>';
            return;
        }

        var p = state.platform;
        var rows = [];
        var i;

        for (i = 0; i < state.versions.length; i++) {
            var v = state.versions[i];
            var chrome = downloadUrl(v, p, 'chrome');
            var driver = downloadUrl(v, p, 'driver');
            var headless = downloadUrl(v, p, 'headless');

            rows.push(
                '<tr>' +
                    '<td class="cft-version">' + escapeHtml(v) + '</td>' +
                    '<td><a target="_blank" href="' + escapeHtml(chrome) + '">chrome-' + escapeHtml(p) + '.zip</a></td>' +
                    '<td><a target="_blank" href="' + escapeHtml(driver) + '">chromedriver-' + escapeHtml(p) + '.zip</a></td>' +
                    '<td><a target="_blank" href="' + escapeHtml(headless) + '">chrome-headless-shell-' + escapeHtml(p) + '.zip</a></td>' +
                '</tr>'
            );
        }

        box.innerHTML =
            '<table id="cft-table">' +
                '<thead>' +
                    '<tr>' +
                        '<th style="width:150px;">版本</th>' +
                        '<th>Chrome</th>' +
                        '<th>ChromeDriver</th>' +
                        '<th>Headless Shell</th>' +
                    '</tr>' +
                '</thead>' +
                '<tbody>' +
                    rows.join('') +
                '</tbody>' +
            '</table>';
    }

    async function loadFromOfficialJson() {
        var milestoneInput = document.querySelector('#cft-major').value.trim();
        var platform = document.querySelector('#cft-platform').value;
        var prefix = '';

        if (milestoneInput) {
            if (/^\d+$/.test(milestoneInput)) {
                prefix = milestoneInput + '.';
            } else {
                prefix = milestoneInput;
            }
        }

        state.platform = platform;
        state.versions = [];
        render();

        setStatus('正在读取官方 JSON 索引...');

        var json = await getJson(JSON_URL);
        var versions = json.versions || [];
        var result = [];
        var i;

        for (i = 0; i < versions.length; i++) {
            var item = versions[i];

            if (!item || !item.version) {
                continue;
            }

            if (prefix && String(item.version).indexOf(prefix) !== 0) {
                continue;
            }

            if (item.downloads && item.downloads.chrome) {
                var arr = item.downloads.chrome;
                var hasPlatform = false;
                var j;

                for (j = 0; j < arr.length; j++) {
                    if (arr[j].platform === platform) {
                        hasPlatform = true;
                        break;
                    }
                }

                if (!hasPlatform) {
                    continue;
                }
            }

            result.push(item.version);
        }

        result = uniqueArray(result);
        result.sort(function (a, b) {
            return compareVersion(b, a);
        });

        state.versions = result;
        render();

        setStatus('官方 JSON 读取完成，共 ' + result.length + ' 个版本。');
    }

    function uniqueArray(arr) {
        var map = {};
        var result = [];
        var i;

        for (i = 0; i < arr.length; i++) {
            if (!map[arr[i]]) {
                map[arr[i]] = true;
                result.push(arr[i]);
            }
        }

        return result;
    }

    async function probeByPrefix() {
        var prefix = document.querySelector('#cft-prefix').value.trim();
        var start = parseInt(document.querySelector('#cft-start').value, 10);
        var end = parseInt(document.querySelector('#cft-end').value, 10);
        var platform = document.querySelector('#cft-platform').value;

        if (!prefix) {
            alert('请填写版本前缀，例如：146.0.7680.');
            return;
        }

        if (prefix.charAt(prefix.length - 1) !== '.') {
            alert('版本前缀建议以点结尾，例如：146.0.7680.');
            return;
        }

        if (isNaN(start) || isNaN(end) || start > end) {
            alert('探测范围不正确');
            return;
        }

        state.platform = platform;
        state.versions = [];
        render();

        var found = [];
        var current = start;
        var finished = 0;
        var total = end - start + 1;
        var concurrency = 10;

        setStatus('开始探测 ' + prefix + start + ' 到 ' + prefix + end + ' ...');

        async function worker() {
            while (current <= end) {
                var n = current;
                current++;

                var version = prefix + n;
                var url = downloadUrl(version, platform, 'chrome');

                var ok = await existsByHead(url);

                finished++;

                if (ok) {
                    found.push(version);
                    found.sort(function (a, b) {
                        return compareVersion(b, a);
                    });

                    state.versions = found.slice();
                    render();
                }

                setStatus('探测中：' + finished + '/' + total + '\n已发现：' + found.length + ' 个版本');
            }
        }

        var workers = [];
        var i;

        for (i = 0; i < concurrency; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);

        found.sort(function (a, b) {
            return compareVersion(b, a);
        });

        state.versions = found;
        render();

        setStatus('探测完成，共发现 ' + found.length + ' 个版本。');
    }

    function copyAll() {
        if (!state.versions.length) {
            setStatus('没有可复制的结果。');
            return;
        }

        var p = state.platform;
        var blocks = [];
        var i;

        for (i = 0; i < state.versions.length; i++) {
            var v = state.versions[i];

            blocks.push(
                '# ' + v + '\n' +
                downloadUrl(v, p, 'chrome') + '\n' +
                downloadUrl(v, p, 'driver') + '\n' +
                downloadUrl(v, p, 'headless')
            );
        }

        GM_setClipboard(blocks.join('\n\n'));
        setStatus('已复制 ' + state.versions.length + ' 个版本的下载链接。');
    }

    function buildPlatformOptions() {
        var html = [];
        var i;

        for (i = 0; i < platforms.length; i++) {
            var p = platforms[i];
            var selected = '';

            if (p === state.platform) {
                selected = ' selected';
            }

            html.push('<option value="' + escapeHtml(p) + '"' + selected + '>' + escapeHtml(p) + '</option>');
        }

        return html.join('');
    }

    function showPanel() {
        var old = document.querySelector('#cft-panel');

        if (old) {
            old.remove();
            return;
        }

        var panel = document.createElement('div');
        panel.id = 'cft-panel';

        var platformOptions = buildPlatformOptions();

        var html = [];

        html.push('<div id="cft-head">');
        html.push('<h2>Chrome for Testing 下载列表扫描器</h2>');
        html.push('<button id="cft-close">关闭</button>');
        html.push('</div>');

        html.push('<div id="cft-body">');

        html.push('<div class="cft-row">');
        html.push('<label>大版本：');
        html.push('<input id="cft-major" value="146" style="width:100px;" placeholder="例如 146">');
        html.push('</label>');

        html.push('<label>平台：');
        html.push('<select id="cft-platform">');
        html.push(platformOptions);
        html.push('</select>');
        html.push('</label>');

        html.push('<button id="cft-json">读取官方 JSON</button>');
        html.push('<button id="cft-copy" class="secondary">复制全部链接</button>');
        html.push('</div>');

        html.push('<div class="cft-tip">');
        html.push('优先使用“读取官方 JSON”。如果公司也拦了 googlechromelabs.github.io，再用下面的“前缀探测”。');
        html.push('</div>');

        html.push('<div class="cft-row">');

        html.push('<label>版本前缀：');
        html.push('<input id="cft-prefix" value="146.0.7680." style="width:170px;" placeholder="例如 146.0.7680.">');
        html.push('</label>');

        html.push('<label>起始：');
        html.push('<input id="cft-start" value="0" style="width:70px;">');
        html.push('</label>');

        html.push('<label>结束：');
        html.push('<input id="cft-end" value="200" style="width:70px;">');
        html.push('</label>');

        html.push('<button id="cft-probe">探测下载地址是否存在</button>');
        html.push('</div>');

        html.push('<div class="cft-tip">');
        html.push('探测方式不会列目录，只是检查类似下面的文件是否存在：<br>');
        html.push('<code>https://storage.googleapis.com/chrome-for-testing-public/146.0.7680.31/win64/chrome-win64.zip</code>');
        html.push('</div>');

        html.push('<div id="cft-status">等待操作。</div>');

        html.push('<div id="cft-result">');
        html.push('<div class="cft-tip">暂无结果。</div>');
        html.push('</div>');

        html.push('</div>');

        panel.innerHTML = html.join('');

        document.body.appendChild(panel);

        document.querySelector('#cft-close').onclick = function () {
            panel.remove();
        };

        document.querySelector('#cft-json').onclick = async function () {
            try {
                await loadFromOfficialJson();
            } catch (e) {
                console.error(e);
                setStatus('官方 JSON 读取失败：' + (e.message || e) + '\n可以改用“前缀探测”。');
            }
        };

        document.querySelector('#cft-probe').onclick = async function () {
            try {
                await probeByPrefix();
            } catch (e) {
                console.error(e);
                setStatus('探测失败：' + (e.message || e));
            }
        };

        document.querySelector('#cft-copy').onclick = function () {
            copyAll();
        };

        document.querySelector('#cft-platform').onchange = function (e) {
            state.platform = e.target.value;
            render();
        };
    }

    GM_registerMenuCommand('打开 Chrome for Testing 下载列表扫描器', showPanel);

    if (location.hostname === 'storage.googleapis.com') {
        setTimeout(function () {
            showPanel();
        }, 500);
    }
})();
