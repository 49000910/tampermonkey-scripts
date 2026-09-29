// ==UserScript==
// @name         自建页面-采集导出-答案导入-批量点选-跳过存疑版
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  采集导出，支持TXT答案导入、高亮当前题答案、批量点选；存疑/留空题只跳过，不点击存疑；采集题型（单选/多选/判断）；iexam 考试页防切屏屏蔽（onblur/onfocus 赋值拦截 + 切屏上报接口拦截）
// @match        http://*/*
// @match        https://*/*
// @match        file:///*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  console.log('[AE] userscript loaded:', location.href, document.readyState);

  // ===== 防切屏屏蔽（仅 iexam 考试页；合并自"考试防切屏屏蔽"v1.0，2026-08-23）=====
  if (location.href.indexOf('/iexam/') >= 0) {
    var AE_BLOCK_KEYS = ['updateSwitchScreenTimes', 'cheatdetect/v1/leavepage', '/front/open/log'];

    function aeBlocked(u) {
      u = String(u || '');
      for (var i = 0; i < AE_BLOCK_KEYS.length; i++) {
        if (u.indexOf(AE_BLOCK_KEYS[i]) >= 0) return true;
      }
      return false;
    }

    // 1) 拦截 window.onblur/onfocus 赋值：考试 app 靠 initSwitchScreen 的 onblur=fn 启动切屏计时→计数→本地自动交卷，
    //    defineProperty 影子属性吞掉赋值（同时清掉已装上的旧处理器）
    function aeTrapOn(name) {
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: true,
          get: function () { return null; },
          set: function () { /* 吞掉赋值，防切屏计时器永远装不上 */ }
        });
      } catch (e) {
        console.warn('[AE] defineProperty(' + name + ') 失败:', e && e.message);
      }
    }
    aeTrapOn('onblur');
    aeTrapOn('onfocus');
    // 兜底：属性若被恢复则重装
    setInterval(function () {
      try {
        var d1 = Object.getOwnPropertyDescriptor(window, 'onblur');
        var d2 = Object.getOwnPropertyDescriptor(window, 'onfocus');
        if (!d1 || !d1.set) aeTrapOn('onblur');
        if (!d2 || !d2.set) aeTrapOn('onfocus');
      } catch (e) {}
    }, 1000);

    // 2) 拦截切屏上报接口（fetch + XHR）：leavepage / updateSwitchScreenTimes / front/open/log
    var AE_FAKE = '{"result":true,"success":true,"code":200,"data":null,"message":"ok"}';

    var aeFetch = window.fetch;
    if (aeFetch) {
      window.fetch = function (input, init) {
        var u = '';
        try { u = typeof input === 'string' ? input : ((input && input.url) || ''); } catch (e) {}
        if (aeBlocked(u)) {
          return Promise.resolve(new Response(AE_FAKE, { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return aeFetch.apply(this, arguments);
      };
    }

    var aeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__aeBlocked = aeBlocked(url); } catch (e) { this.__aeBlocked = false; }
      return aeOpen.apply(this, arguments);
    };

    var aeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (this.__aeBlocked) {
        var x = this;
        try {
          Object.defineProperty(x, 'status', { get: function () { return 200; }, configurable: true });
          Object.defineProperty(x, 'responseText', { get: function () { return AE_FAKE; }, configurable: true });
          Object.defineProperty(x, 'response', { get: function () { return AE_FAKE; }, configurable: true });
        } catch (e) {}
        setTimeout(function () {
          try {
            Object.defineProperty(x, 'readyState', { get: function () { return 4; }, configurable: true });
            if (x.onreadystatechange) x.onreadystatechange();
            if (x.onload) x.onload();
            x.dispatchEvent && x.dispatchEvent(new Event('load'));
            x.dispatchEvent && x.dispatchEvent(new Event('loadend'));
          } catch (e) {}
        }, 0);
        return;
      }
      return aeSend.apply(this, arguments);
    };

    console.log('[AE] 防切屏屏蔽已激活 (onblur/onfocus 陷阱 + 上报接口拦截)');
  }

  // ===== 选择器配置 =====
  var CFG = {
    questionRoot: '.right-subjects-inner .right-main',
    questionNo: '.subtitle .subtitle_index',
    stem: '.subtitle .main-title .markdown-body p, .subtitle .main-title .markdown-viewer-program .content',

    // 兼容 subect-label 和 subject-label
    option: '.subect-label .option-list-item .option-content .markdown-body p, .subject-label .option-list-item .option-content .markdown-body p, .subect-label .option-list-item .option-content .markdown-viewer-program .content, .subject-label .option-list-item .option-content .markdown-viewer-program .content',

    // 选项外层，用于高亮/点选
    optionItem: '.subect-label .option-list-item, .subject-label .option-list-item',

    answer: '',

    // 下一题：排除上一题 prv，排除存疑 quest
    nextBtn: '.subject-btns .subject-btn:not(.prv):not(.quest)',

    stepDelay: 900,
    maxSteps: 200
  };

  var state = {
    running: false,
    stopRequested: false,
    rows: [],
    seen: {},
    answerBank: {},
    skipBank: {}
  };

  var ANSWER_IMPORT = {
    autoSelect: false
  };

  function q(sel, root) {
    try {
      return (root || document).querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  function qa(sel, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }

  function txt(el) {
    return ((el && (el.innerText || el.textContent)) || '').trim();
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function parseNo(noRaw) {
    var m = String(noRaw || '').match(/\d+/);
    return m ? Number(m[0]) : null;
  }

  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function stripTailNoise(s) {
    return String(s || '')
      .replace(/\s*(上一题|下一题|存疑|取消存疑|收藏|标记|交卷|提交|查看解析)\s*$/g, '')
      .trim();
  }

  function cleanOptionText(s) {
    return stripTailNoise(String(s || ''))
      .replace(/^([A-F])[\.、\s]*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactText(s) {
    return cleanOptionText(s)
      .replace(/[。．.、\s]/g, '')
      .toLowerCase();
  }

  function toast(msg, err) {
    var el = document.getElementById('__ae_toast__');

    if (!el) {
      el = document.createElement('div');
      el.id = '__ae_toast__';
      el.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'background:#222;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.25);';
      document.body.appendChild(el);
    }

    el.style.background = err ? '#b00020' : '#222';
    el.textContent = msg;

    clearTimeout(el._t);
    el._t = setTimeout(function () {
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }, 2200);
  }

  function setStatus(msg) {
    var el = q('#__ae_status__');
    if (el) {
      el.textContent = msg;
    }
  }

  function buildKey(no, stem) {
    if (no !== undefined && no !== null && no !== '') {
      return 'NO_' + String(no).trim();
    }

    return 'STEM_' + normText(stem).slice(0, 120);
  }

  // ===== 文本兜底解析 =====
  function parseMergedBlockText(s) {
    s = normText(s);

    var stem = s;
    var m1 = s.match(/^(.*?)(A[\.、\s]|B[\.、\s]|正确|错误)/);

    if (m1) {
      stem = m1[1].trim();
    }

    stem = stem.replace(/^\d+[、\.\s]*/, '').trim();

    var options = [];
    var abcd = s.match(/([A-F][\.、\s].*)$/);

    if (abcd) {
      var parts = abcd[1].split(/(?=[A-F][\.、\s])/).filter(function (x) {
        return !!x;
      });

      options = parts.map(function (p, i) {
        var mm = p.match(/^([A-F])[\.、\s]*(.*)$/);

        return {
          key: mm ? mm[1] : String.fromCharCode(65 + i),
          text: cleanOptionText(mm ? mm[2] : p)
        };
      });
    } else {
      var ci = s.indexOf('正确');
      var wi = s.indexOf('错误');

      if (ci >= 0 && wi >= 0) {
        if (ci < wi) {
          options.push({ key: 'A', text: '正确' });
          options.push({ key: 'B', text: '错误' });
        } else {
          options.push({ key: 'A', text: '错误' });
          options.push({ key: 'B', text: '正确' });
        }
      }
    }

    return {
      stem: stem,
      options: options
    };
  }

  // ===== 选择器提取 =====
  function getCurrentBySelector() {
    var root = q(CFG.questionRoot);

    if (!root) {
      return null;
    }

    var noRaw = CFG.questionNo ? txt(q(CFG.questionNo, root)) : '';
    var no = parseNo(noRaw);

    var stem = txt(q(CFG.stem, root));

    var opts = qa(CFG.option, root).map(function (el, i) {
      return {
        key: String.fromCharCode(65 + i),
        text: cleanOptionText(txt(el))
      };
    });

    var answer = CFG.answer ? txt(q(CFG.answer, root)) : '';

    if (!stem || !opts.length) {
      return null;
    }

    return {
      key: buildKey(no, stem),
      no: no,
      stem: stem,
      options: opts,
      answer: answer,
      source: 'selector'
    };
  }

  // ===== 兜底文本提取 =====
  function getCurrentByFallback() {
    var root = q(CFG.questionRoot);

    if (!root) {
      return null;
    }

    var noRaw = CFG.questionNo ? txt(q(CFG.questionNo, root)) : '';
    var no = parseNo(noRaw);

    var answer = CFG.answer ? txt(q(CFG.answer, root)) : '';

    var parsed = parseMergedBlockText(txt(root));

    if (!parsed.stem || !parsed.options.length) {
      return null;
    }

    return {
      key: buildKey(no, parsed.stem),
      no: no,
      stem: parsed.stem,
      options: parsed.options,
      answer: answer,
      source: 'fallback'
    };
  }

  function scoreCandidate(cur) {
    if (!cur) {
      return -9999;
    }

    var score = 0;
    var stem = normText(cur.stem);
    var opts = cur.options || [];

    if (stem) {
      score += 30;
    } else {
      score -= 100;
    }

    if (opts.length) {
      score += opts.length * 10;
    } else {
      score -= 100;
    }

    if (opts.length === 2) {
      score += 15;
    }

    if (opts.length === 4) {
      score += 18;
    }

    if (cur.source === 'selector') {
      score += 4;
    }

    return score;
  }

  function getCurrentQuestion() {
    var a = getCurrentBySelector();
    var b = getCurrentByFallback();

    if (a) {
      a._aeScore = scoreCandidate(a);
    }

    if (b) {
      b._aeScore = scoreCandidate(b);
    }

    if (a && b) {
      if (a._aeScore >= b._aeScore - 6) {
        return a;
      }

      return b;
    }

    return a || b || null;
  }

  function getOptionItems(root) {
    var items = [];

    if (CFG.optionItem) {
      items = qa(CFG.optionItem, root);
    }

    if (!items.length) {
      items = qa(CFG.option, root).map(function (el) {
        return el.closest('.option-list-item') || el;
      });
    }

    return items;
  }

  // ===== 题型识别 =====
  // ① 左侧题卡列表：当前题 li.active 所在分组的标题（判断题/单选题/多选题）
  // ② 兜底：当前题选项的 input 类型（checkbox→多选，radio→单选/判断）
  function getQuestionType() {
    try {
      var activeLi = q('.left-list-detail li.active') || q('li.active');

      if (activeLi) {
        var ul = activeLi.parentElement;
        var secBox = ul ? ul.parentElement : null;

        if (secBox) {
          var p = secBox.querySelector('p');

          if (p) {
            var t = (p.innerText || p.textContent || '').trim();

            if (t.indexOf('多选') >= 0) {
              return '多选';
            }

            if (t.indexOf('单选') >= 0) {
              return '单选';
            }

            if (t.indexOf('判断') >= 0) {
              return '判断';
            }

            if (t.indexOf('不定项') >= 0) {
              return '不定项';
            }
          }
        }
      }
    } catch (e) {
      // 继续走兜底
    }

    try {
      var root = q(CFG.questionRoot);

      if (root) {
        var items = getOptionItems(root);
        var hasCheckbox = false;
        var hasRadio = false;
        var optTexts = [];

        items.forEach(function (it) {
          if (q('input[type=checkbox]', it)) {
            hasCheckbox = true;
          }

          if (q('input[type=radio]', it)) {
            hasRadio = true;
          }

          optTexts.push(cleanOptionText(txt(it)).replace(/\s/g, '').toLowerCase());
        });

        if (hasCheckbox) {
          return '多选';
        }

        if (hasRadio) {
          if (optTexts.indexOf('正确') >= 0 && optTexts.indexOf('错误') >= 0) {
            return '判断';
          }

          return '单选';
        }
      }
    } catch (e) {
      // 忽略
    }

    return '';
  }

  function isVisible(el) {
    if (!el) {
      return false;
    }

    var rects = el.getClientRects && el.getClientRects();
    return !!(rects && rects.length);
  }

  function getClickableOptionElement(el) {
    if (!el) {
      return null;
    }

    return el.closest(
      'label,' +
      '.option-list-item,' +
      '.option-item,' +
      '.answer-item,' +
      '.choice-item,' +
      '.van-radio,' +
      '.van-checkbox,' +
      '.el-radio,' +
      '.el-checkbox,' +
      '[role="radio"],' +
      '[role="checkbox"],' +
      'li,' +
      'button'
    ) || el;
  }

  // 只扫描选项区域，不扫描题干 p/span/div，避免题干含关键词选错
  function findOptionElementByText(root, opt, idx, items, cur) {
    var target = compactText(opt && opt.text);
    var optionCount = ((cur && cur.options) || []).length;

    items = (items || []).filter(function (el) {
      return el && isVisible(el);
    });

    if (items[idx] && optionCount && items.length === optionCount) {
      return items[idx];
    }

    if (items[idx]) {
      var candidate = items[idx];
      var ct = compactText(txt(candidate));

      if (
        !target ||
        !ct ||
        ct === target ||
        ct.indexOf(target) >= 0 ||
        target.indexOf(ct) >= 0
      ) {
        return candidate;
      }
    }

    if (!target) {
      return null;
    }

    var candidates = [];

    if (items.length) {
      candidates = items.slice();
    }

    if (!candidates.length && CFG.optionItem) {
      candidates = qa(CFG.optionItem, root).filter(function (el) {
        return el && isVisible(el);
      });
    }

    if (!candidates.length && CFG.option) {
      qa(CFG.option, root).forEach(function (el) {
        if (!isVisible(el)) {
          return;
        }

        var item = el.closest(
          '.option-list-item,' +
          '.option-item,' +
          '.answer-item,' +
          '.choice-item,' +
          'label,' +
          'li,' +
          '[role="radio"],' +
          '[role="checkbox"],' +
          '.van-radio,' +
          '.van-checkbox,' +
          '.el-radio,' +
          '.el-checkbox'
        ) || el;

        if (item && candidates.indexOf(item) < 0 && isVisible(item)) {
          candidates.push(item);
        }
      });
    }

    if (!candidates.length) {
      return null;
    }

    var matches = [];

    candidates.forEach(function (item, pos) {
      var rawText = txt(item);
      var t = compactText(rawText);

      if (!t) {
        return;
      }

      if (
        t === target ||
        t.indexOf(target) >= 0 ||
        target.indexOf(t) >= 0
      ) {
        var score = 0;

        if (pos === idx) {
          score -= 1000;
        }

        score += Math.abs(normText(rawText).length - normText(opt.text || '').length);

        matches.push({
          el: item,
          score: score,
          len: normText(rawText).length
        });
      }
    });

    matches.sort(function (a, b) {
      if (a.score !== b.score) {
        return a.score - b.score;
      }

      return a.len - b.len;
    });

    return matches.length ? matches[0].el : null;
  }

  function clickOptionElement(item) {
    if (!item) {
      return false;
    }

    var input = q('input[type="radio"], input[type="checkbox"]', item);

    if (input) {
      if (!input.checked) {
        input.click();
      }

      return true;
    }

    var clickable = getClickableOptionElement(item) || item;

    if (clickable) {
      clickable.click();
      return true;
    }

    return false;
  }

  function makeAnswerKey(no, stem) {
    if (no) {
      return 'NO_' + Number(no);
    }

    return 'STEM_' + normText(stem).slice(0, 120);
  }

  function isSkipAnswer(ans) {
    ans = String(ans || '').trim();
    return !ans || /^(存疑|留空|空|skip|跳过|无|无答案|没有答案|暂无答案)$/i.test(ans);
  }

  function addAnswerToBank(row) {
    if (!row) {
      return false;
    }

    var no = row.no || row.index || row.id || row.questionNo;
    var stem = row.stem || row.question || row.title || '';
    var ans = row.answer || row.answers || row.correctAnswer || row.correct || row.key || '';

    if (Array.isArray(ans)) {
      ans = ans.join('');
    }

    ans = String(ans || '').trim();

    if (isSkipAnswer(ans)) {
      if (no) {
        state.skipBank['NO_' + Number(no)] = true;
        delete state.answerBank['NO_' + Number(no)];
        return true;
      }

      return false;
    }

    if (no) {
      state.answerBank['NO_' + Number(no)] = ans;
      delete state.skipBank['NO_' + Number(no)];
    }

    if (stem) {
      state.answerBank[makeAnswerKey(null, stem)] = ans;
    }

    return true;
  }

  // ===== 导入 TXT / JSON 答案 =====
  function parseAnswerImport(content) {
    var count = 0;

    content = String(content || '').replace(/^\uFEFF/, '');

    if (!content.trim()) {
      return 0;
    }

    // 每次导入清空旧答案和旧跳过
    state.answerBank = {};
    state.skipBank = {};

    // JSON
    try {
      var data = JSON.parse(content);

      if (Array.isArray(data)) {
        data.forEach(function (r) {
          if (addAnswerToBank(r)) {
            count++;
          }
        });

        return count;
      }

      if (data && typeof data === 'object') {
        var arr = data.rows || data.data || data.questions || [];

        if (Array.isArray(arr) && arr.length) {
          arr.forEach(function (r) {
            if (addAnswerToBank(r)) {
              count++;
            }
          });

          return count;
        }

        Object.keys(data).forEach(function (k) {
          var m = String(k).match(/^(?:NO_)?(\d+)$/i);

          if (m) {
            var no = Number(m[1]);
            var v = String(data[k] || '').trim();

            if (isSkipAnswer(v)) {
              state.skipBank['NO_' + no] = true;
              delete state.answerBank['NO_' + no];
            } else {
              state.answerBank['NO_' + no] = v;
              delete state.skipBank['NO_' + no];
            }

            count++;
          }
        });

        return count;
      }
    } catch (e) {
      // 非 JSON，继续按 TXT 解析
    }

    // TXT / CSV
    content.split(/\r?\n/).forEach(function (line) {
      line = line.replace(/^\uFEFF/, '').trim();

      if (!line) {
        return;
      }

      // 支持答案：
      // 1 A / 1.A / 1：A / 3B / 11 ABCD / 21 正确 / 22 错误
      var mAns = line.match(/^(\d+)\s*(?:[\.\、\:：,，])?\s*([A-F]+|正确|错误|对|错|true|false|是|否)\s*$/i);

      if (mAns) {
        var noAns = Number(mAns[1]);

        state.answerBank['NO_' + noAns] = String(mAns[2]).trim();
        delete state.skipBank['NO_' + noAns];

        count++;
        return;
      }

      // 支持跳过：
      // 2 / 2. / 2： / 2 存疑 / 2 留空 / 2 空 / 2 跳过
      var mSkip = line.match(/^(\d+)\s*(?:[\.\、\:：,，])?\s*(?:存疑|留空|空|skip|跳过|无|无答案|没有答案|暂无答案)?\s*$/i);

      if (mSkip) {
        var noSkip = Number(mSkip[1]);

        if (noSkip) {
          state.skipBank['NO_' + noSkip] = true;
          delete state.answerBank['NO_' + noSkip];
          count++;
        }
      }
    });

    return count;
  }

  function refillCollectedAnswers() {
    var n = 0;

    state.rows.forEach(function (r) {
      var ans = state.answerBank['NO_' + Number(r.no)];

      if (ans) {
        r.answer = ans;
        n++;
      }
    });

    return n;
  }

  function importAnswerText() {
    var ta = q('#__ae_answer_text__');

    if (!ta) {
      toast('未找到答案输入框', true);
      return;
    }

    var content = ta.value || '';

    if (!content.trim()) {
      toast('请先粘贴答案内容', true);
      return;
    }

    var n = parseAnswerImport(content);
    var filled = refillCollectedAnswers();

    toast('导入答案/跳过 ' + n + ' 条，回填 ' + filled + ' 条');

    setStatus(
      '答案库：' + Object.keys(state.answerBank).length +
      ' 条，跳过：' + Object.keys(state.skipBank).length + ' 题'
    );

    console.log('[AE] answerBank:', state.answerBank);
    console.log('[AE] skipBank:', state.skipBank);
    console.log('[AE] rows:', state.rows);
  }

  function getImportedAnswer(cur) {
    if (!cur) {
      return '';
    }

    if (cur.no !== undefined && cur.no !== null) {
      var byNo = state.answerBank['NO_' + Number(cur.no)];

      if (byNo) {
        return byNo;
      }
    }

    return state.answerBank[makeAnswerKey(null, cur.stem)] || '';
  }

  function isImportedSkip(cur) {
    if (!cur) {
      return false;
    }

    if (cur.no !== undefined && cur.no !== null) {
      return !!state.skipBank['NO_' + Number(cur.no)];
    }

    return false;
  }

  function answerToLetters(ans, cur) {
    var raw = String(ans || '').trim();

    if (!raw) {
      return [];
    }

    var compact = raw.replace(/[\s,，、|\/]+/g, '').toUpperCase();

    if (/^[A-F]+$/.test(compact)) {
      var out = [];

      compact.split('').forEach(function (x) {
        if (out.indexOf(x) < 0) {
          out.push(x);
        }
      });

      return out;
    }

    var clean = raw.replace(/[。．.、\s]/g, '').toLowerCase();
    var isTrue = /^(正确|对|true|是)$/i.test(clean);
    var isFalse = /^(错误|错|false|否)$/i.test(clean);

    var letters = [];

    (cur.options || []).forEach(function (o) {
      var t = String(o.text || '');

      var optClean = t
        .replace(/^([A-F])[\.、\s]*/i, '')
        .replace(/[。．.、\s]/g, '')
        .toLowerCase();

      if (isTrue && /^(正确|对|true|是)$/i.test(optClean)) {
        letters.push(o.key);
        return;
      }

      if (isFalse && /^(错误|错|false|否)$/i.test(optClean)) {
        letters.push(o.key);
        return;
      }

      if (!isTrue && !isFalse) {
        var nt = normText(t).toLowerCase();
        var nr = normText(raw).toLowerCase();

        if (nt === nr || nt.indexOf(nr) >= 0 || nr.indexOf(nt) >= 0) {
          letters.push(o.key);
        }
      }
    });

    return letters;
  }

  function clearAnswerMark(root) {
    qa('.__ae_answer_mark__', root).forEach(function (el) {
      el.classList.remove('__ae_answer_mark__');
      el.style.outline = '';
      el.style.background = '';
    });
  }

  function clearWrongCheckedOptions(items, answerIdxMap) {
    if (!items || !items.length) {
      return;
    }

    items.forEach(function (item, idx) {
      if (answerIdxMap[idx]) {
        return;
      }

      qa('input[type="checkbox"]', item).forEach(function (input) {
        if (input.checked) {
          input.click();
        }
      });
    });
  }

  function applyAnswerToPage(cur, letters, doClick) {
    var root = q(CFG.questionRoot);

    if (!root) {
      return {
        ok: false,
        reason: '未找到题目区域'
      };
    }

    var items = getOptionItems(root);

    clearAnswerMark(root);

    var answerIdxMap = {};
    letters.forEach(function (k) {
      answerIdxMap[k.charCodeAt(0) - 65] = true;
    });

    if (doClick) {
      clearWrongCheckedOptions(items, answerIdxMap);
    }

    var clicked = 0;
    var missing = [];

    letters.forEach(function (k) {
      var idx = k.charCodeAt(0) - 65;
      var opt = (cur.options || [])[idx] || {
        key: k,
        text: ''
      };

      var item = findOptionElementByText(root, opt, idx, items, cur);

      if (!item) {
        missing.push(k);
        return;
      }

      item.classList.add('__ae_answer_mark__');
      item.style.outline = '2px solid #ff9800';
      item.style.background = 'rgba(255,152,0,.16)';

      if (doClick) {
        if (clickOptionElement(item)) {
          clicked++;
        }
      }
    });

    return {
      ok: missing.length === 0 && (!doClick || clicked > 0),
      clicked: clicked,
      missing: missing,
      letters: letters,
      itemsCount: items.length
    };
  }

  // ===== 标记/点选当前题 =====
  function markOrSelectImportedAnswer() {
    var cur = getCurrentQuestion();

    if (!cur) {
      toast('未识别当前题目', true);
      return;
    }

    var ans = getImportedAnswer(cur);

    if (!ans) {
      if (isImportedSkip(cur)) {
        toast('当前题为存疑/留空，已跳过，不点选');
        console.log('[AE] skip current:', cur);
        return;
      }

      toast('答案库没有匹配到当前题', true);
      console.log('[AE] no answer matched:', cur, state.answerBank, state.skipBank);
      return;
    }

    var letters = answerToLetters(ans, cur);

 if (!letters.length) {
  toast('匹配到答案，但无法转成选项：' + ans, true);
  console.log('[AE] cannot convert answer:', ans, cur);
  return;
}


    var ret = applyAnswerToPage(cur, letters, ANSWER_IMPORT.autoSelect);

    if (!ret.ok) {
      toast('处理失败，缺少选项：' + ret.missing.join(','), true);
      console.warn('[AE] apply failed:', ret, cur);
      return;
    }

    toast((ANSWER_IMPORT.autoSelect ? '已点选答案：' : '已标记答案：') + letters.join(''));

    console.log('[AE] current answer:', {
      current: cur,
      answer: ans,
      letters: letters,
      autoSelect: ANSWER_IMPORT.autoSelect,
      result: ret
    });
  }

  function canClickNext(btn) {
    if (!btn) {
      return false;
    }

    if (btn.disabled) {
      return false;
    }

    if (/disabled/i.test(btn.className || '')) {
      return false;
    }

    if (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true') {
      return false;
    }

    return true;
  }

  // ===== 批量点选当前题到最后一题 =====
  async function batchSelectAllImportedAnswers() {
    if (state.running) {
      toast('正在执行中，请勿重复点击', true);
      return;
    }

    state.running = true;
    state.stopRequested = false;

    var selected = 0;
    var skipped = 0;
    var failed = 0;
    var seen = {};

    setStatus('批量点选中...');
    toast('开始批量点选，请勿操作页面');

    try {
      for (var i = 0; i < CFG.maxSteps; i++) {
        if (state.stopRequested) {
          toast('已手动停止');
          break;
        }

        var cur = getCurrentQuestion();

        if (!cur) {
          failed++;
          toast('未识别当前题，停止', true);
          break;
        }

        if (seen[cur.key]) {
          toast('检测到重复题目，停止');
          break;
        }

        seen[cur.key] = true;

        var ans = getImportedAnswer(cur);

        if (!ans) {
          if (isImportedSkip(cur)) {
            skipped++;
            console.log('[AE] 当前题为存疑/留空，跳过不点:', {
              no: cur.no,
              cur: cur
            });
          } else {
            failed++;
            console.warn('[AE] 当前题未匹配答案，也未标记跳过:', cur);
          }
        } else {
          var letters = answerToLetters(ans, cur);

          if (!letters.length) {
            failed++;
            console.warn('[AE] 答案无法转选项:', ans, cur);
          } else {
            var ret = applyAnswerToPage(cur, letters, true);

            if (ret.ok) {
              selected++;
              console.log('[AE] 已点选:', {
                no: cur.no,
                answer: ans,
                letters: letters,
                result: ret
              });
            } else {
              failed++;
              console.warn('[AE] 点选失败:', {
                no: cur.no,
                answer: ans,
                letters: letters,
                result: ret,
                cur: cur
              });
            }
          }
        }

        setStatus('批量点选：成功 ' + selected + '，跳过 ' + skipped + '，失败 ' + failed);

        var next = q(CFG.nextBtn);

        if (!canClickNext(next)) {
          toast('下一题不可点击，批量点选结束');
          break;
        }

        next.click();
        await sleep(CFG.stepDelay);
      }

      setStatus('批量点选完成：成功 ' + selected + '，跳过 ' + skipped + '，失败 ' + failed);
      toast('批量点选完成：成功 ' + selected + '，跳过 ' + skipped + '，失败 ' + failed);
    } catch (e) {
      console.error('[AE] 批量点选失败:', e);
      toast('批量点选失败：' + e.message, true);
      setStatus('批量点选失败');
    } finally {
      state.running = false;
      state.stopRequested = false;
    }
  }

  // ===== 自动采集 =====
  async function collectAll() {
    if (state.running) {
      toast('正在采集中，请勿重复点击');
      return;
    }

    state.running = true;
    state.stopRequested = false;
    state.rows = [];
    state.seen = {};

    setStatus('采集中...');
    toast('开始采集');

    try {
      for (var i = 0; i < CFG.maxSteps; i++) {
        if (state.stopRequested) {
          toast('已停止');
          break;
        }

        var cur = getCurrentQuestion();

        if (!cur) {
          toast('未识别到当前题目，停止', true);
          break;
        }

        if (state.seen[cur.key]) {
          toast('检测到重复题目，停止');
          break;
        }

        state.seen[cur.key] = true;

        var importedAns = getImportedAnswer(cur);

        state.rows.push({
          no: cur.no || state.rows.length + 1,
          type: getQuestionType(),
          stem: cur.stem,
          options: cur.options,
          answer: cur.answer || importedAns || '',
          source: cur.source
        });

        setStatus('已采集：' + state.rows.length + ' 题，来源：' + cur.source);
        toast('已采集 ' + state.rows.length + ' 题');

        var next = q(CFG.nextBtn);

        if (!canClickNext(next)) {
          toast('下一题不可点击，停止');
          break;
        }

        next.click();
        await sleep(CFG.stepDelay);
      }

      setStatus('完成，共 ' + state.rows.length + ' 题');
      toast('采集完成，共 ' + state.rows.length + ' 题');

      console.log('[AE] rows:', state.rows);
    } catch (e) {
      console.error('[AE] collect error:', e);
      toast('采集失败：' + e.message, true);
      setStatus('采集失败');
    } finally {
      state.running = false;
      state.stopRequested = false;
    }
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], {
      type: mime || 'text/plain;charset=utf-8'
    });

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');

    a.href = url;
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function exportJSON() {
    if (!state.rows.length) {
      toast('暂无数据可导出', true);
      return;
    }

    download(
      'questions_' + Date.now() + '.json',
      JSON.stringify(state.rows, null, 2),
      'application/json;charset=utf-8'
    );
  }

  function exportCSV() {
    if (!state.rows.length) {
      toast('暂无数据可导出', true);
      return;
    }

    function esc(v) {
      if (v === undefined || v === null) {
        v = '';
      }

      return '"' + String(v).replace(/"/g, '""') + '"';
    }

    var lines = ['no,stem,options,answer,source,type'];

    state.rows.forEach(function (r) {
      var opts = (r.options || []).map(function (o) {
        return o.key + '. ' + o.text;
      }).join(' | ');

      lines.push([
        esc(r.no),
        esc(r.stem),
        esc(opts),
        esc(r.answer),
        esc(r.source),
        esc(r.type || '')
      ].join(','));
    });

    download(
      'questions_' + Date.now() + '.csv',
      '\uFEFF' + lines.join('\n'),
      'text/csv;charset=utf-8'
    );
  }

  async function copyText() {
    if (!state.rows.length) {
      toast('暂无数据可复制', true);
      return;
    }

    refillCollectedAnswers();

    var s = state.rows.map(function (r) {
      var opts = (r.options || []).map(function (o) {
        return o.key + '. ' + o.text;
      }).join('\n');

      return String(r.no || '') + '. ' + String(r.stem || '') +
        '\n题型: ' + (r.type || '(未识别)') +
        '\n' + opts +
        '\n答案: ' + (r.answer || '(无)') +
        '\n来源: ' + (r.source || '');
    }).join('\n\n');

    try {
      await navigator.clipboard.writeText(s);
      toast('已复制，字符数：' + s.length);
    } catch (e) {
      console.error('[AE] copy error:', e);
      toast('复制失败：' + e.message, true);
    }
  }

  // ===== 面板 =====
  function injectPanel() {
    var old = document.getElementById('__ae_panel__');

    if (old) {
      old.parentNode.removeChild(old);
    }

    var p = document.createElement('div');
    p.id = '__ae_panel__';

    p.style.cssText =
      'position:fixed;top:100px;right:16px;z-index:2147483647;' +
      'background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px;width:250px;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.15);font-family:Arial,"Microsoft YaHei",sans-serif;' +
      'color:#222;font-size:12px;';

    p.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
        '<div style="font-weight:700;font-size:13px;">整卷采集导出</div>' +
        '<button id="__ae_close__" style="border:none;background:#eee;border-radius:4px;cursor:pointer;">×</button>' +
      '</div>' +

      '<div id="__ae_status__" style="margin-bottom:8px;color:#666;">待开始</div>' +

      '<button id="__ae_start__" style="width:100%;margin:4px 0;cursor:pointer;">开始自动采集</button>' +
      '<button id="__ae_stop__" style="width:100%;margin:4px 0;cursor:pointer;">停止采集/批量</button>' +

      '<hr style="border:none;border-top:1px solid #eee;margin:8px 0;">' +

      '<button id="__ae_json__" style="width:100%;margin:4px 0;cursor:pointer;">导出 JSON</button>' +
      '<button id="__ae_csv__" style="width:100%;margin:4px 0;cursor:pointer;">导出 CSV</button>' +
      '<button id="__ae_copy__" style="width:100%;margin:4px 0;cursor:pointer;">复制文本</button>' +
      '<button id="__ae_clear__" style="width:100%;margin:4px 0;cursor:pointer;">清空数据</button>' +

      '<hr style="border:none;border-top:1px solid #eee;margin:8px 0;">' +

      '<div style="margin:4px 0 2px;color:#666;">导入答案（TXT/JSON 直接粘贴）：</div>' +
      '<textarea id="__ae_answer_text__" style="width:100%;height:90px;box-sizing:border-box;margin:2px 0;font-size:12px;font-family:inherit;border:1px solid #ccc;border-radius:4px;padding:4px;resize:vertical;" placeholder="1 C&#10;2 ABCD&#10;3 正确&#10;4 存疑"></textarea>' +
      '<button id="__ae_import_answer__" style="width:100%;margin:2px 0 4px;cursor:pointer;">导入粘贴的答案</button>' +
      '<button id="__ae_mark_answer__" style="width:100%;margin:4px 0;cursor:pointer;">标记/点选当前题</button>' +
      '<button id="__ae_batch_select__" style="width:100%;margin:4px 0;cursor:pointer;background:#fff3e0;border:1px solid #ff9800;">批量点选全部</button>' +

      '<label style="display:flex;align-items:center;gap:4px;margin-top:6px;color:#666;cursor:pointer;">' +
        '<input id="__ae_autoselect__" type="checkbox">' +
        '<span>自动点选当前题</span>' +
      '</label>' +

      '<div style="margin-top:8px;color:#999;line-height:1.4;">' +
        'TXT格式：1 C / 2 ABCD / 3 正确。<br>' +
        '4 存疑 或单独 4：只跳过，不点存疑。<br>' +
        '批量点选会从当前题开始往后执行。<br>' +
        '要选全卷，请先回到第1题。' +
      '</div>';

    document.body.appendChild(p);

    q('#__ae_start__').onclick = collectAll;

    q('#__ae_stop__').onclick = function () {
      state.stopRequested = true;
      toast('正在停止...');
    };

    q('#__ae_json__').onclick = exportJSON;
    q('#__ae_csv__').onclick = exportCSV;
    q('#__ae_copy__').onclick = copyText;

    q('#__ae_clear__').onclick = function () {
      if (state.running) {
        toast('运行中，无法清空', true);
        return;
      }

      state.rows = [];
      state.seen = {};
      setStatus('已清空');
      toast('数据已清空');
    };

    q('#__ae_import_answer__').onclick = importAnswerText;
    q('#__ae_mark_answer__').onclick = markOrSelectImportedAnswer;
    q('#__ae_batch_select__').onclick = batchSelectAllImportedAnswers;

    q('#__ae_autoselect__').onchange = function () {
      ANSWER_IMPORT.autoSelect = this.checked;
      toast(this.checked ? '已开启自动点选当前题' : '已关闭自动点选，仅高亮');
    };

    q('#__ae_close__').onclick = function () {
      state.stopRequested = true;

      var panel = q('#__ae_panel__');

      if (panel && panel.parentNode) {
        panel.parentNode.removeChild(panel);
      }
    };
  }

  function init() {
    injectPanel();

    window.AutoExportQuestions = {
      cfg: CFG,
      state: state,
      answerImport: ANSWER_IMPORT,

      injectPanel: injectPanel,

      getCurrentQuestion: getCurrentQuestion,
      getQuestionType: getQuestionType,
      getCurrentBySelector: getCurrentBySelector,
      getCurrentByFallback: getCurrentByFallback,

      importAnswerText: importAnswerText,
      parseAnswerImport: parseAnswerImport,
      markOrSelectImportedAnswer: markOrSelectImportedAnswer,
      batchSelectAllImportedAnswers: batchSelectAllImportedAnswers,

      isImportedSkip: isImportedSkip,

      answerToLetters: answerToLetters,
      getImportedAnswer: getImportedAnswer,
      refillCollectedAnswers: refillCollectedAnswers,

      collectAll: collectAll,
      exportJSON: exportJSON,
      exportCSV: exportCSV,
      copyText: copyText
    };

    console.log('[AE] panel injected');
    toast('采集面板已加载');
  }

  function boot() {
    var tries = 0;

    var timer = setInterval(function () {
      tries++;

      if (document.body) {
        clearInterval(timer);

        try {
          init();
        } catch (e) {
          console.error('[AE] init error:', e);
          alert('AE脚本初始化失败：' + e.message);
        }

        return;
      }

      if (tries > 100) {
        clearInterval(timer);
        console.warn('[AE] document.body not found');
      }
    }, 200);
  }

  boot();
})();
