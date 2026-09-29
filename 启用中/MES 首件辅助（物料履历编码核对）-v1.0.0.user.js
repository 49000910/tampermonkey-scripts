// ==UserScript==
// @name         MES 首件辅助（物料履历编码核对）
// @namespace    tm.first.article.mtl.check
// @version      1.0.14
// @description  物料履历页首件辅助：物料PSN(序列号)走接口查编码，与物料产品编码比对；命中在PSN右侧显示绿色"编码正确"气泡；序列号重复高亮。v1.0.14：BOM清单编码与两个接口命中同款规则——物料产品编码先按同一套左侧清洗（用户规则+剥 E13-/J2-/M1-/S3- 等字母前缀）再比BOM，带前缀的码不再落"不在BOM(通用料)"。v1.0.13：BOM卡行序=绿✓→采齐的小数辅料(0.几PCS)→红缺/多(含辅料缺1)→灰重量容量辅料；数量文案"应"改"pdm"（pdm0.42PCS 已采1PCS）。v1.0.12：小数数量的PCS（0.42/0.04等辅料）采1条即算齐不再标"多"，重量/容量单位同样1条算齐（未采标缺1）；数量显示单位紧贴不留空格（应0.04PCS 已采1PCS）。v1.0.11：BOM编码保留版本后缀（34100311-002 不再被剥成 34100311，匹配仍按基础码兜底）；BOM卡重排版——测试记录置顶、物料名改悬浮显示、状态色条一目了然；表格PSN行新增"BOM编码"气泡（编码在BOM里才显示，悬浮看应采数量）。v1.0.10：测试记录改 GM_xmlhttpRequest 跨域直连HUMEP（油猴后台代理免CORS，不再新开工作窗）；修复通过判定（按result字段0=PASS/1=FAIL，之前误用tracedesc）。v1.0.9：物料履历查询后自动在BOM卡片下方显示R1测试记录区块（关键信息进药丸状态；核对规则=每个TPS最后一次测试必须全部PASS，未过的红色置顶）；药丸"测试记录"按钮手动重查
// @match        https://mes.huawei.com/mespmm/rptwebnew*
// @match        https://w3.huawei.com/mespmm/rptwebnew*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(async function () {
  'use strict';

  // ===== MES授权门禁 START =====
  async function __MES_AUTH_GATE__() {
    if (location.hostname === 'mes.huawei.com') return true;

    var KEY = 'MES_AUTH_CENTER_STATE_V1';
    var start = Date.now();

    while (Date.now() - start < 180000) {
      try {
        var st = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (st && st.ok && Date.now() - Number(st.ts || 0) < 10000) return true;
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    console.warn('[首件辅助] 等待3分钟仍未授权，脚本停止运行');
    return false;
  }
  if (!(await __MES_AUTH_GATE__())) return;
  // ===== MES授权门禁 END =====

  function onTracePage() { return location.hash.indexOf('WipMTraceability') >= 0; }

  if (!onTracePage()) {
    var started = false;
    function tryStart() {
      if (started) return;
      if (!onTracePage()) return;
      started = true;
      boot();
    }
    window.addEventListener('hashchange', tryStart);
    return;
  }

  boot();

  // ===== 查询/命中（与 SN编码自动校验 v2.7.4 同一套规则） =====
  const BASE = 'https://w3.huawei.com/mespmm/gateway/com.huawei.supply.mes.mesplus.pspw:mespmmpreallservice/mespmmpreallone/services/emsComponentDataInfo/find/page';
  const LEFT_CLEAN_KEY = 'sn_code_left_clean_rules_v1';

  function toStr(v){ return v == null ? '' : String(v).trim(); }
  function normSn(v){
    v = toStr(v).replace(/\s+/g, '');
    if (v.indexOf(':') >= 0) v = v.split(':').pop();
    return v;
  }
  function normalizeForCompare(v){
    return toStr(v).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/：/g, ':').toUpperCase();
  }
  function loadLeftCleanRules() {
    try {
      var arr = JSON.parse(localStorage.getItem(LEFT_CLEAN_KEY) || '[]');
      if (Array.isArray(arr)) {
        var out = [];
        arr.forEach(function (x) {
          x = toStr(x).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/：/g, ':').replace(/－/g, '-');
          if (x && out.indexOf(x) < 0) out.push(x);
        });
        return out;
      }
    } catch (e) {}
    return [];
  }
  function cleanLeftByRules(seg) {
    var s = toStr(seg).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/：/g, ':').replace(/－/g, '-');
    if (!s) return '';
    var rules = loadLeftCleanRules();
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r) continue;
      if (r === ':') { var p = s.indexOf(':'); if (p >= 0) s = s.slice(p + 1); continue; }
      if (r === '-') { var p2 = s.indexOf('-'); if (p2 >= 0) s = s.slice(p2 + 1); continue; }
      if (s.toUpperCase().indexOf(r.toUpperCase()) === 0) s = s.slice(r.length);
    }
    return s;
  }
  function extractCodeSmart(text){
    text = toStr(text).replace(/\u00A0/g, ' ').replace(/：/g, ':');
    var parts = text.split(/\s+/).filter(Boolean);
    var last = '';
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg.indexOf(':') >= 0) seg = seg.split(':').pop();
      seg = seg.replace(/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]+[-_]/i, '');
      seg = normalizeForCompare(seg);
      if (seg) last = seg;
    }
    return last || normalizeForCompare(text);
  }
  function extractLeftCodeSmart(text) {
    text = toStr(text).replace(/\u00A0/g, ' ').replace(/：/g, ':');
    var parts = text.split(/\s+/).filter(Boolean);
    var last = '';
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      seg = cleanLeftByRules(seg);
      if (seg.indexOf(':') >= 0) seg = seg.split(':').pop();
      seg = seg.replace(/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]+[-_]/i, '');
      seg = normalizeForCompare(seg);
      if (seg) last = seg;
    }
    return last || normalizeForCompare(cleanLeftByRules(text));
  }
  function isCodeEqual(leftText, actualCode){
    var L = extractLeftCodeSmart(leftText);
    var A = extractCodeSmart(actualCode);
    return !!L && !!A && L === A;
  }
  function isStrongCode(v){ return /^(34|45)\d{6}(-\d{3})?$/.test(toStr(v)); }
  function isWeakCode(v){ return /^\d{8}(-\d{3})?$/.test(toStr(v)); }
  function looksLikeDate8(v){ return /^20\d{6}$/.test(toStr(v)); }
  function isNineCode(v){
    v = toStr(v).toUpperCase();
    return /^9[A-Z0-9]{7}(?:-\d{3})?$/.test(v);
  }
  function pickFirstMatchedCode(obj){
    var strong = '', weak = '', nine = '';
    (function walk(x){
      if (x == null) return;
      if (typeof x !== 'object') {
        var s = toStr(x).toUpperCase();
        if (!s) return;
        if (!strong && isStrongCode(s)) { strong = s; return; }
        if (!weak && isWeakCode(s) && !looksLikeDate8(s)) weak = s;
        if (!nine && isNineCode(s)) nine = s;
        return;
      }
      if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) walk(x[i]); return; }
      var keys = Object.keys(x);
      for (var k = 0; k < keys.length; k++) walk(x[keys[k]]);
    })(obj);
    return strong || weak || nine || '';
  }
  async function fetchJsonSafe(url, body) {
    try {
      var r = await fetch(url, { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (!r.ok) return null;
      var text = await r.text();
      try { return JSON.parse(text); } catch (e) { return null; }
    } catch (e) { return null; }
  }
  async function fetchPage(sn, pageSize, pageNo, a, b){
    var url = BASE + '/' + pageSize + '/' + pageNo + '/' + a + '/' + b;
    var body = { barCode:'', snStr:sn, itemName:'', componentType:'', createdFrom:'', createdTo:'' };
    return (await fetchJsonSafe(url, body)) || {};
  }
  async function queryAllRows(snRaw, pageSize){
    pageSize = pageSize || 100;
    var sn = normSn(snRaw);
    var modes = [[0,0],[7,0]];
    var best = { sn: sn, rows: [], mode: '-' };
    for (var i = 0; i < modes.length; i++) {
      var a = modes[i][0], b = modes[i][1];
      var page = 1, totalPages = 1, rows = [];
      do {
        var j = await fetchPage(sn, pageSize, page, a, b);
        var vo = (j && j.resultObjVO) || {};
        var pageVO = vo.pageVO || {};
        rows = rows.concat(vo.result || []);
        totalPages = Number(pageVO.totalPages || 1);
        page++;
      } while (page <= totalPages);
      if (rows.length) return { sn: sn, rows: rows, mode: a + '/' + b };
      best = { sn: sn, rows: rows, mode: a + '/' + b };
    }
    return best;
  }
  async function queryCodeBySn_OpenApi(snRaw){
    var sn = normSn(snRaw);
    var url = 'https://w3.huawei.com/mes/qmgateway/com.huawei.supply.mes.mesplus.qm:mesqmmitrservice/mes/mitrservice/services/openapi/getSnAttr';
    var j = (await fetchJsonSafe(url, { sn: sn })) || {};
    var vo = (j && j.resultObjVO) || {};
    return { sn: sn, code: toStr(vo.partNo), source: 'openapi', mode: '-', rows: 0 };
  }
  async function queryCodeHybrid(snRaw){
    var q1 = await queryAllRows(snRaw, 100);
    var code1 = pickFirstMatchedCode(q1.rows);
    if (code1) return { sn: q1.sn, code: code1, source: 'ems-find', mode: q1.mode, rows: q1.rows.length };
    var q2 = await queryCodeBySn_OpenApi(snRaw);
    if (q2.code) return q2;
    // 临时失败（限流/网络抖动）：等500ms整条链路重试一次
    await new Promise(function (r) { setTimeout(r, 500); });
    q1 = await queryAllRows(snRaw, 100);
    code1 = pickFirstMatchedCode(q1.rows);
    if (code1) return { sn: q1.sn, code: code1, source: 'ems-find-retry', mode: q1.mode, rows: q1.rows.length };
    return queryCodeBySn_OpenApi(snRaw);
  }

  // ===== PDM辅料/BOM查询 =====
  const PDM_BASE = 'https://pbm.ipd.huawei.com/pdmcore/pdmmvpgw/';
  let __pdmToken = '', __pdmTokenTs = 0;
  async function getPdmToken() {
    if (__pdmToken && Date.now() - __pdmTokenTs < 600000) return __pdmToken;
    const r = await fetch(PDM_BASE + 'pdmcore/pdmpublicservice/services/aiops/health/current', { method: 'GET', credentials: 'include' });
    const t = await r.text();
    const m = t.match(/GW[0-9A-F]{60,80}/);
    if (!m) throw new Error('取不到PDM令牌');
    __pdmToken = m[0]; __pdmTokenTs = Date.now();
    return __pdmToken;
  }
  const __pdmPartCache = new Map();
  async function getPdmPart(code) {
    code = toStr(code);
    if (!code) return null;
    if (__pdmPartCache.has(code)) return __pdmPartCache.get(code);
    const token = await getPdmToken();
    const r = await fetch(PDM_BASE + 'pdmcore/pdmpartservice/services/part/blurrySearchParts', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ curPage: 1, pageSize: 15, orderBy: 'number', sort: 'asc', input: [{ partNumber: code, name: '', description: '', creator: '', version: '', isMajorVersioin: '', partView: '', isExact: '', withoutDynamicAccess: 'N' }] })
    });
    const j = await r.json();
    const hit = (j.data || []).find(x => toStr(x.number) === code) || (j.data || [])[0] || null;
    const out = hit ? { number: toStr(hit.number), versionID: toStr(hit.versionID), name: toStr(hit.name || hit.descriptionCn) } : null;
    __pdmPartCache.set(code, out);
    return out;
  }
  const __pdmBomCache = new Map();
  async function getPdmBom(productCode) {
    productCode = toStr(productCode);
    if (!productCode) return [];
    if (__pdmBomCache.has(productCode)) return __pdmBomCache.get(productCode);
    const part = await getPdmPart(productCode);
    let items = [];
    if (part && part.versionID) {
      const token = await getPdmToken();
      const r = await fetch(PDM_BASE + 'pdmcore/pdmpartservice/services/part/getChildrenPartsNew', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ isLocationDesignator: 'YES', input: { partVersionID: part.versionID, partView: 'PSView', partNumber: productCode }, pageInfo: { pageSize: 1000, curPage: 1 } })
      });
      const j = await r.json();
      items = (j.data || []).map(x => {
        const raw = toStr(x.childrenPartNumber);
        return { code: raw, base: normalizeForCompare(raw).replace(/-\d{2,3}$/, ''), qty: parseFloat(toStr(x.count)) || 0, unit: toStr(x.unit).toUpperCase(), desc: toStr(x.description) };
      });
    }
    __pdmBomCache.set(productCode, items);
    return items;
  }
  // 履历"物料产品编码"取BOM比对用基础码：与主核对同一套清洗（用户left规则+冒号取后段+剥字母前缀 E13-/J2-/M1-/S3-…），再去尾部-NNN版本后缀；P90行left为空时从PSN取
  function bomKeyOf(leftText, psn) {
    let s = toStr(leftText);
    if (s) s = extractLeftCodeSmart(s).replace(/-\d{2,3}$/, '');
    if (!s && /^P90/i.test(toStr(psn))) s = toStr(psn).replace(/^P/i, '').replace(/[^0-9].*$/, '');
    return s;
  }

  // ===== 主逻辑 =====
  function boot() {
    const codeCache = new Map();
    async function getCode(psn) {
      if (codeCache.has(psn)) return codeCache.get(psn);
      const q = await queryCodeHybrid(psn);
      const c = q.code ? (extractCodeSmart(q.code) || q.code) : '';
      if (c) codeCache.set(psn, c); // 查失败不缓存，重新核对时会重查（防临时失败被锁死）
      return c;
    }

    function findCols() {
      const tables = Array.from(document.querySelectorAll('table'));
      // 1) 数据表：可见表里"非空行"最多的那张，并记下它的格数 n
      let bodyTable = null, bestRows = 0, n = 0;
      for (const t of tables) {
        const r = t.getBoundingClientRect();
        if (r.width < 50 || r.height < 20) continue;
        const trs = Array.from(t.querySelectorAll('tbody tr'));
        const real = trs.filter(tr => tr.cells && tr.cells.length > 2 && tr.innerText.trim());
        if (real.length > bestRows) { bestRows = real.length; bodyTable = t; n = real[0].cells.length; }
      }
      if (!bodyTable || !n) return null;
      // 2) 表头：只取 thead 的 th（该页面 thead 里有 th+td 双行，取 td 会把列位顶到 23 之后）
      //    列位必须小于数据行格数 n（表头与数据格一一对应）
      for (const t of tables) {
        const names = Array.from(t.querySelectorAll('thead th')).map(th => toStr(th.innerText));
        if (!names.length) continue;
        let i = -1;
        for (let k = 0; k < names.length && k < n; k++) { if (names[k] === '物料PSN') { i = k; break; } }
        if (i < 0) continue;
        let j = -1;
        for (let k = 0; k < names.length && k < n; k++) { if (names[k] === '物料产品编码') { j = k; break; } }
        let p = -1;
        for (let k = 0; k < names.length && k < n; k++) { if (names[k] === '产品编码') { p = k; break; } }
        let sb = -1;
        for (let k = 0; k < names.length && k < n; k++) { if (names[k] === '产品条码') { sb = k; break; } }
        return { idxPsn: i, idxCode: j >= 0 ? j : i - 1, idxProduct: p >= 0 ? p : i - 3, idxSb: sb, bodyTable: bodyTable };
      }
      return null;
    }

    function badge(td, text, cls) {
      const old = td.querySelector('.fa-badge');
      if (old && old.parentNode) old.parentNode.removeChild(old);
      const b = document.createElement('span');
      b.className = 'fa-badge fa-' + cls;
      b.textContent = text;
      td.style.position = 'relative';
      td.appendChild(b);
    }
    function clearMarks() {
      document.querySelectorAll('.fa-badge').forEach(b => { if (b.parentNode) b.parentNode.removeChild(b); });
      document.querySelectorAll('tr.fa-dup-row').forEach(tr => { tr.classList.remove('fa-dup-row'); tr.style.backgroundColor = ''; });
    }

    let pillStatus = null;
    function getProductBarcode() {
      try {
        const f = findCols();
        if (f && f.idxSb >= 0) {
          const rows = Array.from(f.bodyTable.querySelectorAll('tbody tr')).filter(tr => tr.cells && tr.cells.length > f.idxSb && toStr(tr.cells[f.idxSb].innerText).trim());
          if (rows.length) return toStr(rows[0].cells[f.idxSb].innerText).trim();
        }
        for (const x of document.querySelectorAll('input.hae-ui-input')) {
          let el = x.parentElement, label = '';
          for (let d = 0; d < 4 && el; d++) {
            const t = el.innerText ? el.innerText.trim().replace(/\s+/g, ' ').slice(0, 30) : '';
            if (t) { label = t; break; }
            el = el.parentElement;
          }
          if (label.indexOf('产品条码') >= 0 && toStr(x.value).trim()) return toStr(x.value).trim();
        }
      } catch (e) {}
      return '';
    }

    function buildPill() {
      const pill = document.createElement('div');
      pill.id = 'fa-pill';
      const btn = document.createElement('button');
      btn.textContent = '重新核对';
      btn.onclick = function () { verifyAll(true); };
      const btnTest = document.createElement('button');
      btnTest.textContent = '测试记录';
      btnTest.title = '重查当前产品条码的HUMEP R1测试记录';
      btnTest.onclick = function () {
        const sb = getProductBarcode();
        if (sb) {
          postHumepQuery(sb);
        } else {
          pillStatus.textContent = '未找到产品条码';
        }
      };
      pillStatus = document.createElement('span');
      pillStatus.id = 'fa-pill-status';
      pillStatus.textContent = '查询后自动核对';
      pill.appendChild(document.createTextNode('首件辅助 '));
      pill.appendChild(pillStatus);
      pill.appendChild(btn);
      pill.appendChild(btnTest);
      document.body.appendChild(pill);
      makeDraggable(pill);
    }
    function setStatus(t) { if (pillStatus) pillStatus.textContent = t; }

    function makeDraggable(el) {
      let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
      el.addEventListener('mousedown', function (e) {
        if (e.target.tagName === 'BUTTON') return;
        if (e.target.id === 'fa-bom-close') return;
        const r = el.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        drag = true;
        el.style.left = ox + 'px';
        el.style.top = oy + 'px';
        el.style.right = 'auto';
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!drag) return;
        el.style.left = (ox + e.clientX - sx) + 'px';
        el.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      });
      document.addEventListener('mouseup', function () { drag = false; });
    }

    // ===== BOM数量核对 =====
    let bomResult = null;
    let bomCheckedSig = '';
    let bomCard = null;
    let bomDismissedFor = '';
    let lastMainStatus = '';
    let lastRecs = [];

    // ===== 测试记录（GM_xmlhttpRequest 跨域直连HUMEP：油猴后台代理，免CORS，不新开窗口） =====
    let testResult = null;
    function humepFetchJson(body) {
      return new Promise(function (resolve, reject) {
        try {
          GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://humep.huawei.com/ic/service-proxy/humep-data/v1/fwl-ft-r1-sn-query-t-p',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(body),
            timeout: 30000,
            onerror: function (r) {
              var st = (r && r.status) || 0;
              var hint = (st === 0) ? '（疑似油猴后台offscreen文档被占用，请让opencode执行"修复油猴"后刷新页面重查）' : '';
              reject(new Error('HUMEP请求失败 status=' + st + hint));
            },
            ontimeout: function () { reject(new Error('HUMEP请求超时')); },
            onload: function (r) {
              try { resolve(JSON.parse(r.response)); } catch (e) { reject(new Error('HUMEP响应非JSON(未登录?)')); }
            }
          });
        } catch (e) { reject(e); }
      });
    }
    async function postHumepQuery(sn) {
      sn = toStr(sn).replace(/\s+/g, '').toUpperCase();
      if (!sn) return;
      testResult = { sn: sn, recs: [], error: '', loading: true };
      renderBomCard();
      try {
        const d = new Date();
        const end = d.toISOString().slice(0, 10);
        const start = new Date(d.getTime() - 365 * 86400000).toISOString().slice(0, 10);
        const j = await humepFetchJson({
          filter: "sn='" + sn + "'", pageNo: 1, pageSize: 60, isReplaceSensitiveInfo: true,
          startDate: start, endDate: end,
          orderBy: [{ sort: 'asc', column: 'sn', type: 'String' }, { sort: 'desc', column: 'starttime', type: 'Date' }]
        });
        const recs = (((j && j.result) || {}).data || []).map(function (x) {
          return {
            st: toStr(x.starttime), et: toStr(x.stoptime),
            pass: Number(x.result) === 0,
            tps: toStr(x.softname), step: toStr(x.operationsequencename),
            ws: toStr(x.wsname), board: toStr(x.boardcode), wo: toStr(x.workorder)
          };
        });
        testResult = { sn: sn, recs: recs, error: '' };
      } catch (e) {
        testResult = { sn: sn, recs: [], error: toStr(e && e.message) };
      }
      renderBomCard();
    }
    function humepTpsRows(re) {
      const byTps = new Map();
      for (const rc of re.recs) {
        const k = rc.tps || '-';
        if (!byTps.has(k)) byTps.set(k, []);
        byTps.get(k).push(rc);
      }
      const rows = [];
      byTps.forEach(function (list, k) {
        list.sort(function (a, b) { return a.st < b.st ? 1 : -1; });
        rows.push({ k: k, last: list[0], cnt: list.length });
      });
      rows.sort(function (a, b) { return (a.last.pass ? 1 : 0) - (b.last.pass ? 1 : 0); });
      return rows;
    }
    function testSuffix() {
      if (!testResult) return '';
      if (testResult.error) return ' 测试?';
      if (testResult.loading) return ' 测试中';
      if (!testResult.recs.length) return ' 测试无';
      const bad = humepTpsRows(testResult).filter(t => !t.last.pass).length;
      return bad ? ' 测试失败' + bad : ' 测试✓';
    }

    function bomSuffix() {
      if (!bomResult) return '';
      if (bomResult.error) return ' BOM?';
      if (bomResult.empty) return ' BOM无';
      if (!bomResult.miss.length && !bomResult.extra.length) return ' BOM✓';
      return ' BOM缺' + bomResult.miss.length + ' 多' + bomResult.extra.length;
    }
    async function bomCheck(productCode, collected, sig, force) {
      productCode = toStr(productCode);
      if (!productCode) return;
      if (!force && bomCheckedSig === sig && bomResult) return;
      bomCheckedSig = sig;
      try {
        const items = await getPdmBom(productCode);
        if (!items.length) {
          bomResult = { product: productCode, empty: true };
        } else {
          const miss = [], extra = [], seenBase = new Set(), all = [];
          for (const it of items) {
            seenBase.add(it.base);
            const got = collected.get(it.base) || 0;
            const isPcs = (it.unit === 'PCS' || !it.unit);
            // 整数数量PCS才按件数核（缺N/多）；小数PCS(0.42等)和重量/容量单位都按辅料：采1条即齐，0条=缺1
            const auxLike = !(isPcs && Number.isInteger(it.qty) && it.qty >= 1);
            all.push({ code: it.code, base: it.base, qty: it.qty, unit: it.unit, desc: it.desc, got: got, isPcs: isPcs, auxLike: auxLike });
            if (!auxLike) {
              if (it.qty > 0 && got < it.qty) miss.push({ code: it.code, qty: it.qty, got: got });
              else if (it.qty > 0 && got > it.qty) extra.push({ code: it.code, qty: it.qty, got: got });
            } else if (got === 0) {
              miss.push({ code: it.code, qty: it.qty, got: 0 });
            }
          }
          for (const it of all) {
            try {
              let p = null;
              if (it.code !== it.base) { p = await getPdmPart(it.code); if (!p) p = await getPdmPart(it.base); }
              else { p = await getPdmPart(it.code); }
              if (p && p.name) it.name = p.name;
            } catch (e) {}
          }
          const notInBom = new Map();
          collected.forEach(function (got, k) { if (!seenBase.has(k) && k) notInBom.set(k, got); });
          bomResult = { product: productCode, total: items.length, all: all, miss: miss, extra: extra, notInBom: notInBom };
        }
      } catch (e) {
        console.error('[首件辅助] BOM核对失败', e);
        bomResult = { product: productCode, error: toStr(e && e.message) };
      }
      renderBomCard();
      renderBomBadges(sig);
    }
    function renderBomCard() {
      if (!bomResult) return;
      if (pillStatus && lastMainStatus) setStatus(lastMainStatus + bomSuffix() + testSuffix());
      if (bomDismissedFor === bomResult.product) return;
      if (!bomCard) {
        bomCard = document.createElement('div');
        bomCard.id = 'fa-bom-card';
        const head = document.createElement('div');
        head.id = 'fa-bom-head';
        const title = document.createElement('span');
        title.id = 'fa-bom-title';
        const close = document.createElement('span');
        close.id = 'fa-bom-close';
        close.textContent = '×';
        close.title = '关闭BOM核对';
        close.onclick = function () {
          if (bomCard && bomCard.parentNode) bomCard.parentNode.removeChild(bomCard);
          bomCard = null;
          bomDismissedFor = bomResult ? bomResult.product : '';
        };
        head.appendChild(title);
        head.appendChild(close);
        const body = document.createElement('div');
        body.id = 'fa-bom-body';
        bomCard.appendChild(head);
        bomCard.appendChild(body);
        document.body.appendChild(bomCard);
        makeDraggable(bomCard);
      }
      const R = bomResult;
      const title = bomCard.querySelector('#fa-bom-title');
      const body = bomCard.querySelector('#fa-bom-body');
      if (!title || !body) return;
      body.textContent = '';
      const line = function (cls, text) {
        const d = document.createElement('div');
        d.className = 'fa-bom-line ' + cls;
        d.textContent = text;
        body.appendChild(d);
      };
      // —— 测试记录区块（置顶）——
      if (testResult) {
        const box = document.createElement('div');
        box.className = 'fa-testbox';
        const tb = document.createElement('div');
        tb.className = 'fa-test-title';
        tb.textContent = '测试记录 · ' + testResult.sn;
        box.appendChild(tb);
        const tline = function (cls, text) {
          const d = document.createElement('div');
          d.className = 'fa-test-line ' + cls;
          d.textContent = text;
          box.appendChild(d);
        };
        if (testResult.error) {
          tline('miss', '查询失败: ' + testResult.error);
        } else if (testResult.loading) {
          tline('gray', '查询中...');
        } else if (!testResult.recs.length) {
          tline('gray', '未查到R1测试记录（近1年）');
        } else {
          const passCnt = testResult.recs.filter(r => r.pass).length;
          tline('sum', '共' + testResult.recs.length + '条 · 通过' + passCnt + ' · 失败' + (testResult.recs.length - passCnt) + '（每个TPS看最后一次）');
          const tRows = humepTpsRows(testResult);
          for (const t of tRows) {
            tline(t.last.pass ? 'ok' : 'miss', (t.last.pass ? 'PASS✓ ' : 'FAIL✗ ') + t.k + ' 最后' + t.last.st);
          }
          if (tRows.some(t => !t.last.pass)) {
            tline('tip', '有TPS最后一次测试未通过，首件前请确认');
          }
        }
        body.appendChild(box);
      }
      if (R.error) {
        title.textContent = 'BOM核对 · ' + R.product;
        line('miss', 'BOM核对失败: ' + (R.error || '未知错误'));
        return;
      }
      if (R.empty) {
        title.textContent = 'BOM核对 · ' + R.product;
        line('gray', 'PDM未查到该产品的BOM');
        return;
      }
      title.textContent = 'BOM核对 · ' + R.product + ' · ' + R.total + '项';
      // 行序：绿✓ → 采齐的小数辅料(0.几PCS，排在绿组末尾) → 红缺/多(含辅料缺1) → 灰重量/容量辅料
      const grp = function (it) {
        if (it.auxLike) { if (it.got === 0) return 2; return it.isPcs ? 1 : 3; }
        return it.got !== it.qty ? 2 : 0;
      };
      const sorted = R.all.slice().sort(function (a, b) { return grp(a) - grp(b); });
      for (const it of sorted) {
        let cls = 'ok', mark = '✓';
        if (it.auxLike) {
          if (it.got === 0) { cls = 'miss'; mark = '缺1'; }
          else if (!it.isPcs) { cls = 'gray'; mark = '辅料'; }
        } else {
          if (it.got < it.qty) { cls = 'miss'; mark = '缺' + (it.qty - it.got); }
          else if (it.got > it.qty) { cls = 'extra'; mark = '多'; }
        }
        const row = document.createElement('div');
        row.className = 'fa-bom-row ' + cls;
        const l1 = document.createElement('div');
        l1.className = 'fa-bom-main';
        const c = document.createElement('span');
        c.className = 'fa-bom-code';
        c.textContent = it.code;
        const u = it.unit || 'PCS';
        const q = document.createElement('span');
        q.className = 'fa-bom-q';
        q.textContent = 'pdm' + it.qty + u + ' 已采' + it.got + u;
        const st = document.createElement('span');
        st.className = 'fa-bom-st';
        st.textContent = mark;
        l1.appendChild(c);
        l1.appendChild(q);
        l1.appendChild(st);
        row.appendChild(l1);
        if (it.name) {
          const tip = document.createElement('span');
          tip.className = 'fa-bom-tip';
          tip.textContent = it.name;
          row.appendChild(tip);
          row.title = it.name;
        }
        body.appendChild(row);
      }
      R.notInBom.forEach(function (got, k) {
        line('gray', k + ' ×' + got + ' 不在BOM（通用料）');
      });
      if (R.miss.length) {
        line('tip', '未采满的可能是下工序采集的，请核对该工序物料');
      }
    }
    function renderBomBadges(sig) {
      if (sig !== lastSig) return;
      if (!bomResult || !bomResult.all) return;
      const byRaw = new Map(), byBase = new Map();
      for (const it of bomResult.all) { byRaw.set(normalizeForCompare(it.code), it); byBase.set(it.base, it); }
      for (const r of lastRecs) {
        const td = r.tdPsn;
        if (!td || !td.parentNode) continue;
        const old = td.querySelector('.fa-bomb');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        if (/^P90/i.test(r.psn)) continue;
        const key = bomKeyOf(r.left, r.psn);
        const raw = extractCodeSmart(r.left);
        const hit = byRaw.get(raw) || byBase.get(key);
        if (!hit) continue;
        const nm = toStr(hit.name);
        let label = nm ? (nm.split(/[-—,，、]/)[0] || nm) : '';
        if (label.length > 12) label = label.slice(0, 12) + '…';
        if (!label) label = hit.code;
        const b = document.createElement('span');
        b.className = 'fa-badge fa-bomb';
        b.textContent = label;
        b.title = (nm ? nm + ' · ' : '') + 'pdm' + hit.qty + (hit.unit || 'PCS') + ' 已采' + hit.got + (hit.unit || 'PCS');
        td.appendChild(b);
      }
    }

    let running = false;
    let lastSig = '';
    async function verifyAll(force) {
      if (running) return;
      const f = findCols();
      if (!f) { if (pillStatus && pillStatus.textContent !== '等待表格...') setStatus('等待表格...'); return; }
      const rows = Array.from(f.bodyTable.querySelectorAll('tbody tr'));
      const dataRows = rows.filter(tr => tr.cells && tr.cells.length > f.idxPsn && toStr(tr.cells[f.idxPsn].innerText));
      if (!dataRows.length) { if (pillStatus && pillStatus.textContent !== '等待数据...') setStatus('等待数据...'); return; }
      const sig = dataRows.length + '|' + toStr(dataRows[0].cells[f.idxPsn].innerText) + '|' + toStr(dataRows[0].cells[f.idxCode].innerText);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      running = true;
      clearMarks();
      setStatus('核对中 ' + dataRows.length + ' 行...');
      try {
        const psnCount = new Map();
        const recs = [];
        for (const tr of dataRows) {
          const psn = normSn(tr.cells[f.idxPsn].innerText);
          const left = toStr(tr.cells[f.idxCode].innerText);
          if (!psn) continue;
          psnCount.set(psn, (psnCount.get(psn) || 0) + 1);
          recs.push({ tr: tr, psn: psn, left: left, tdPsn: tr.cells[f.idxPsn] });
        }
        lastRecs = recs;

        let ok = 0, bad = 0, aux = 0, none = 0, dup = 0;
        for (const r of recs) {
          const isDup = (psnCount.get(r.psn) || 0) > 1;
          if (isDup) { dup++; r.tr.classList.add('fa-dup-row'); r.tr.style.backgroundColor = '#fff1f0'; }

          if (/^P90/i.test(r.psn)) {
            // 辅料：查PDM物料主档（通用件能查到即可），物料描述绿气泡显示，超长自动换行
            aux++;
            const k = bomKeyOf(r.left, r.psn);
            let part = null;
            try { part = await getPdmPart(k); } catch (e) {}
            if (!part) {
              badge(r.tdPsn, 'PDM查无此码', 'err');
            } else {
              badge(r.tdPsn, part.name, 'ok');
              const bb = r.tdPsn.querySelector('.fa-badge');
              if (bb) bb.classList.add('fa-auxwrap');
              r.tdPsn.title = '物料描述: ' + part.name;
            }
            continue;
          }
          // TODO(EC): EC 编码解析规则，后续版本补充

          let code = '';
          try { code = await getCode(r.psn); } catch (e) { code = ''; }
          if (!code) {
            badge(r.tdPsn, '未查到编码', 'warn');
            none++;
          } else if (isCodeEqual(r.left, code)) {
            badge(r.tdPsn, '编码正确', 'ok');
            ok++;
          } else {
            badge(r.tdPsn, '编码不一致', 'err');
            r.tdPsn.title = '左侧:' + r.left + ' 查得:' + code;
            bad++;
          }
        }
        lastMainStatus = '共' + recs.length + ' 正确' + ok + ' 不一致' + bad + ' 未查' + none + ' 辅料' + aux + ' 重复' + dup;
        setStatus(lastMainStatus);
        console.log('[首件辅助]', { total: recs.length, ok: ok, bad: bad, none: none, aux: aux, dup: dup });

        // BOM数量核对：PDM的BOM每编码pcs vs 履历已采集
        const collected = new Map();
        for (const r of recs) {
          const k = bomKeyOf(r.left, r.psn);
          if (k) collected.set(k, (collected.get(k) || 0) + 1);
        }
        const pCode = toStr(dataRows[0].cells[f.idxProduct].innerText);
        bomCheck(pCode, collected, sig, force);
        const sb = getProductBarcode();
        if (sb) postHumepQuery(sb);
      } catch (e) {
        setStatus('核对出错，1秒后重试');
        console.error('[首件辅助] 核对异常', e);
      } finally {
        running = false;
      }
    }

    injectCss();
    buildPill();
    verifyAll(true);
    setInterval(function () { verifyAll(false); }, 1000);
  }

  function injectCss() {
    const s = document.createElement('style');
    s.textContent = [
      '#fa-pill{position:fixed;top:12px;right:16px;z-index:2147483000;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #d9d9d9;border-radius:18px;box-shadow:0 2px 8px rgba(0,0,0,.12);padding:6px 14px;font:13px/22px "Microsoft YaHei",sans-serif;cursor:move;}',
      '#fa-pill button{border:1px solid #91d5ff;background:#e6f7ff;color:#0958d9;border-radius:11px;padding:1px 10px;font-size:13px;cursor:pointer;line-height:20px;}',
      '#fa-pill button:hover{background:#bae7ff;}',
      '#fa-pill-status{color:#595959;}',
      '#fa-bom-card{position:fixed;top:56px;right:16px;z-index:2147483000;width:390px;max-height:60vh;overflow:auto;background:#fff;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.15);font:12px/19px "Microsoft YaHei",sans-serif;}',
      '#fa-bom-head{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:#1f1f1f;color:#fff;border-bottom:1px solid #d9d9d9;font-weight:bold;cursor:move;position:sticky;top:0;z-index:2;}',
      '#fa-bom-close{cursor:pointer;color:#bbb;font-size:15px;padding:0 5px;border-radius:4px;}',
      '#fa-bom-close:hover{color:#cf1322;background:#fff1f0;}',
      '#fa-bom-body{padding:8px 10px;}',
      '.fa-bom-line{padding:3px 0;font-size:12px;}',
      '.fa-bom-line.miss{color:#cf1322;}',
      '.fa-bom-line.extra{color:#d48806;}',
      '.fa-bom-line.ok{color:#389e0d;}',
      '.fa-bom-line.gray{color:#8c8c8c;}',
      '.fa-bom-line.tip{color:#d48806;font-weight:bold;}',
      '.fa-testbox{background:#f0f5ff;border:1px solid #adc6ff;border-radius:6px;padding:6px 8px;margin-bottom:8px;}',
      '.fa-test-title{font-weight:bold;color:#1d39c4;margin-bottom:3px;}',
      '.fa-test-line{padding:2px 8px;border-left:3px solid #d9d9d9;background:#fafafa;border-radius:2px;margin:2px 0;}',
      '.fa-test-line.sum{border-left-color:#1d39c4;background:#fff;color:#1d39c4;font-weight:bold;}',
      '.fa-test-line.ok{border-left-color:#52c41a;background:#f6ffed;color:#389e0d;font-weight:bold;}',
      '.fa-test-line.miss{border-left-color:#ff4d4f;background:#fff1f0;color:#cf1322;font-weight:bold;}',
      '.fa-test-line.gray{color:#8c8c8c;}',
      '.fa-test-line.tip{border-left-color:#faad14;color:#d48806;font-weight:bold;background:#fffbe6;}',
      '.fa-bom-row{position:relative;padding:4px 8px;margin:3px 0;border-left:3px solid #d9d9d9;background:#fafafa;border-radius:3px;}',
      '.fa-bom-row.ok{border-left-color:#52c41a;background:#f6ffed;}',
      '.fa-bom-row.miss{border-left-color:#ff4d4f;background:#fff1f0;}',
      '.fa-bom-row.extra{border-left-color:#faad14;background:#fffbe6;}',
      '.fa-bom-row.gray{border-left-color:#d9d9d9;background:#fafafa;}',
      '.fa-bom-main{display:flex;align-items:baseline;}',
      '.fa-bom-code{font-family:Consolas,"Courier New",monospace;font-weight:bold;font-size:12px;color:#262626;}',
      '.fa-bom-row.miss .fa-bom-code{color:#cf1322;}',
      '.fa-bom-row.extra .fa-bom-code{color:#d48806;}',
      '.fa-bom-q{color:#595959;margin:0 8px;font-size:11px;flex:1;}',
      '.fa-bom-st{font-weight:bold;font-size:12px;}',
      '.fa-bom-row.ok .fa-bom-st{color:#389e0d;}',
      '.fa-bom-row.miss .fa-bom-st{color:#cf1322;}',
      '.fa-bom-row.extra .fa-bom-st{color:#d48806;}',
      '.fa-bom-row.gray .fa-bom-st{color:#8c8c8c;}',
      '.fa-bom-tip{display:none;position:absolute;left:0;right:0;top:100%;margin-top:1px;background:rgba(0,0,0,.85);color:#fff;font-size:11px;line-height:16px;padding:4px 8px;border-radius:0 0 4px 4px;z-index:10;white-space:normal;word-break:break-all;pointer-events:none;}',
      '.fa-bom-row:hover .fa-bom-tip{display:block;}',
      '.fa-badge{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:inline-block;padding:0 6px;border-radius:9px;font-size:12px;line-height:16px;white-space:nowrap;pointer-events:none;}',
      '.fa-bomb{right:76px;font-size:11px;background:#e6f7ff;color:#0958d9;border:1px solid #91d5ff;pointer-events:auto;cursor:default;}',
      '.fa-auxwrap{white-space:normal;text-align:right;max-width:calc(100% - 165px);}',
      '.fa-ok{background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;}',
      '.fa-err{background:#fff1f0;color:#cf1322;border:1px solid #ffa39e;}',
      '.fa-warn{background:#fffbe6;color:#d48806;border:1px solid #ffe58f;}',
      '.fa-aux{background:#f5f5f5;color:#8c8c8c;border:1px solid #d9d9d9;}'
    ].join('\n');
    document.head.appendChild(s);
  }
})();
