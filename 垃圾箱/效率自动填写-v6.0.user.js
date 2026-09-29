// ==UserScript==
// @name         效率自动填写
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  自动抓取出勤+预填计划+定时提交+保持登录
// @match        *://login.huawei.com/*
// @match        https://ge.make.huawei.com/ie/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    var EFF_API = 'https://ge.make.huawei.com/panguGateway/com.huawei.flowchart:panguIeSvc/panguIeSvc';
    var ATTEND_API = 'https://w3.huawei.com/mes/msmgw/app_0000000000034454:mesmehrservice/mes/mesmehrservice/services/attend/self/searchSelfCardData';
    var KEEPALIVE_URL = 'https://w3.huawei.com/mespmm/gateway/com.huawei.supply.mes.mesplus.pspw:mespmmsystemservice/mespmm/sys/only4ssoTimeUpdate.do';
    var W3_LOGIN_API = 'https://login.huawei.com/login1/rest/hwidcenter/login?x_app_id=';
    var W3_FINGER = {version:'1.7.4',cid:'56b37a93-042a-4def-af21-de3fcd6961cc',data:{canvas:'e5be1b8915cb93ea6dbe82001f074eca',webgl:'19c6344f0c6f54fb469b9557e5fbd4ac',ips:[],devs:[],epl:5,ep:'8405646e6ff161c831d2fc83d02ade96',epls:'P5ca3db898597f5b8f9538650160a1f4f,Cb'}};
    var DAY_NAMES = ['周日','周一','周二','周三','周四','周五','周六'];

    function pad(n) { return n < 10 ? '0'+n : ''+n; }
    function fmtDate(d) { return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
    function fmtTime(dt) { if (!dt) return ''; var d = new Date(dt); return pad(d.getHours())+':'+pad(d.getMinutes()); }

    function calcAttendance(earliest, latest) {
        if (!earliest || !latest) return 0;
        var e = new Date(earliest), l = new Date(latest);
        var eH = e.getHours() + e.getMinutes()/60, lH = l.getHours() + l.getMinutes()/60;
        if (eH >= 8 && eH <= 8.5) {
            if (lH <= 18.5) return 8; if (lH <= 19.5) return 8; return Math.min(8+(lH-19),10);
        }
        if (eH >= 20.5 && eH <= 21) {
            if (lH <= 7.5) return 9; if (lH <= 8) return 9; return Math.min(9+(lH-7.5),10);
        }
        return 0;
    }

    function shiftLabel(name, earliest) {
        if (name === 'DAYA') return '白班'; if (name === 'SFT4') return '夜班';
        if (!earliest) return '休息';
        var d = new Date(earliest); var h = d.getHours()+d.getMinutes()/60;
        if (h>=8&&h<=8.5) return '白班'; if (h>=20.5&&h<=21) return '夜班'; return '未知';
    }

    var _ep_logs = [];
    function log(text, cls) {
        _ep_logs.push('<span class="'+(cls||'')+'">'+text+'</span><br>');
        if(_ep_logs.length>50) _ep_logs.shift();
        var el = document.getElementById('_ep_log');
        if (el) { el.innerHTML = _ep_logs.join(''); el.scrollTop = el.scrollHeight; }
    }

    // ===== CSS =====
    var css = document.createElement('style');
    css.textContent = '#_ep_{position:fixed;z-index:999999;width:400px;height:560px;background:#fff;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.15);font:12px/1.5 "Microsoft YaHei",sans-serif;color:#333;display:flex;flex-direction:column;overflow:hidden;user-select:none}' +
    '#_ep_ .hd{display:flex;align-items:center;padding:0 12px;height:36px;background:#1890ff;color:#fff;cursor:move;flex-shrink:0;gap:6px}' +
    '#_ep_ .hd .dot{width:10px;height:10px;border-radius:50%;background:#bbb;flex-shrink:0}' +
    '#_ep_ .hd .dot.on{background:#52c41a;box-shadow:0 0 6px #52c41a}' +
    '#_ep_ .hd .dot.off{background:#f5222d;box-shadow:0 0 6px #f5222d}' +
    '#_ep_ .hd b{flex:1;font-size:13px}' +
    '#_ep_ .hd button{background:none;border:1px solid rgba(255,255,255,.4);color:#fff;padding:1px 8px;border-radius:4px;cursor:pointer;font-size:11px}' +
    '#_ep_[data-mini="1"]{width:40px;height:40px;border-radius:50%;background:#1890ff;opacity:0.7;overflow:hidden}' +
    '#_ep_[data-mini="1"]:hover{opacity:1}' +
    '#_ep_[data-mini="1"] .hd{height:40px;border-radius:50%;cursor:grab;justify-content:center;padding:0;background:transparent}' +
    '#_ep_[data-mini="1"] .hd *{display:none}' +
    '#_ep_[data-mini="1"] .hd::after{content:"效率";color:#fff;font-size:10px;font-weight:bold}' +
    '#_ep_ .bd{flex:1;overflow-y:auto;padding:0}' +
    '#_ep_ .tabs{display:flex;border-bottom:1px solid #f0f0f0;flex-shrink:0}' +
    '#_ep_ .tab{flex:1;padding:7px 4px;text-align:center;font-size:11px;cursor:pointer;color:#888;border-bottom:2px solid transparent}' +
    '#_ep_ .tab.active{color:#1890ff;border-bottom-color:#1890ff;font-weight:bold}' +
    '#_ep_ .tab-page{display:none;padding:8px 10px}' +
    '#_ep_ .tab-page.active{display:block}' +
    '#_ep_ .row{display:flex;align-items:center;margin-bottom:5px}' +
    '#_ep_ .row label{width:72px;flex-shrink:0;font-size:11px;color:#888}' +
    '#_ep_ .row input,#_ep_ .row select{flex:1;border:1px solid #d9d9d9;border-radius:3px;padding:2px 5px;font-size:11px;outline:none;height:24px}' +
    '#_ep_ .row input:focus,#_ep_ .row select:focus{border-color:#1890ff}' +
    '#_ep_ .row input[readonly]{background:#f5f5f5;color:#666}' +
    '#_ep_ .sep{border-top:1px dashed #e8e8e8;margin:5px 0;font-size:10px;color:#bbb;text-align:center}' +
    '#_ep_ .cks{display:flex;gap:10px;margin-bottom:4px;flex-wrap:wrap}' +
    '#_ep_ .cks label{display:flex;align-items:center;gap:2px;font-size:11px;color:#666}' +
    '#_ep_ .cks input{width:auto}' +
    '#_ep_ .acts{display:flex;gap:5px;margin:5px 0;flex-wrap:wrap}' +
    '#_ep_ .btn{padding:4px 10px;border:1px solid #d9d9d9;border-radius:4px;background:#fff;cursor:pointer;font-size:11px;color:#333}' +
    '#_ep_ .btn:hover{border-color:#1890ff;color:#1890ff}' +
    '#_ep_ .btn.p{background:#1890ff;color:#fff;border-color:#1890ff}' +
    '#_ep_ .btn.p:hover{background:#40a9ff}' +
    '#_ep_ .btn:disabled{opacity:.5}' +
    '#_ep_ .btn.w{background:#faad14;color:#fff}' +
    '#_ep_ .log{padding:4px 8px;background:#f9f9f9;border-top:1px solid #e8e8e8;font:11px/1.5 Consolas,monospace;max-height:120px;overflow-y:auto;color:#888;flex-shrink:0;user-select:text}' +
    '#_ep_ .log .ok{color:#52c41a}#_ep_ .log .er{color:#f5222d}#_ep_ .log .i{color:#1890ff}#_ep_ .log .w{color:#faad14}' +
    '#_ep_ .tbl{width:100%;border-collapse:collapse;margin:4px 0;font-size:11px}' +
    '#_ep_ .tbl th,#_ep_ .tbl td{border:1px solid #e8e8e8;padding:2px 4px;text-align:center}' +
    '#_ep_ .tbl th{background:#f0f5ff;color:#1890ff;font-weight:normal}' +
    '#_ep_ .eff-bar{display:flex;align-items:center;gap:6px;margin:4px 0}' +
    '#_ep_ .eff-bar .bar{flex:1;height:12px;background:#f0f0f0;border-radius:6px;overflow:hidden}' +
    '#_ep_ .eff-bar .bar .fill{height:100%;border-radius:6px}' +
    '#_ep_ .info{padding:3px 8px;background:#e6f7ff;border:1px solid #91d5ff;border-radius:3px;font-size:11px;color:#1890ff;margin:4px 0}';
    document.head.appendChild(css);

    var isLoginPage = location.href.indexOf('/login1/') > -1 && location.host === 'login.huawei.com';

    if (isLoginPage) {
        // 登录页：自动填账号密码并点击登录
        setTimeout(function() {
            var acct = GM_getValue('w3Account',''), pwd = GM_getValue('w3Password','');
            if (!acct || !pwd) return;
            var uidInput = document.querySelector('input[name="uid"],input[name="loginAccount"],input[placeholder*="账号"],input[placeholder*="工号"]');
            var pwdInput = document.querySelector('input[type="password"]');
            var loginBtn = document.querySelector('button[type="submit"],input[type="submit"],a:has(span:contains("登录")),button:contains("登录")');
            if (uidInput && pwdInput) {
                uidInput.value = acct; uidInput.dispatchEvent(new Event('input',{bubbles:true})); uidInput.dispatchEvent(new Event('change',{bubbles:true}));
                pwdInput.value = pwd; pwdInput.dispatchEvent(new Event('input',{bubbles:true})); pwdInput.dispatchEvent(new Event('change',{bubbles:true}));
                setTimeout(function() {
                    if (loginBtn) loginBtn.click();
                    else {
                        var btns = document.querySelectorAll('button');
                        for (var i=0;i<btns.length;i++) { if (btns[i].textContent.indexOf('登录')>=0||btns[i].textContent.indexOf('登入')>=0) { btns[i].click(); break; } }
                    }
                }, 500);
            }
        }, 2000);
        return;
    }

    // ===== Panel =====
    var pos = GM_getValue('panelPos', { left: 10, top: 60 });
    var mini = GM_getValue('panelMini', false);
    var P = document.createElement('div'); P.id = '_ep_';
    P.style.left = pos.left+'px'; P.style.top = pos.top+'px';
    if (mini) P.dataset.mini = '1';
    P.innerHTML = '<div class="hd"><span class="dot" id="_ep_dot"></span><b>效率</b><button data-a="min">_</button></div><div class="bd" id="_ep_bd"></div>';
    if (!isLoginPage) document.body.appendChild(P);
    var drag = false, ox, oy;
    P.querySelector('.hd').addEventListener('mousedown', function(e) { if (e.target.tagName==='BUTTON') return; drag=true; ox=e.clientX-P.offsetLeft; oy=e.clientY-P.offsetTop; });
    document.addEventListener('mousemove', function(e) { if (!drag) return; P.style.left=Math.max(0,e.clientX-ox)+'px'; P.style.top=Math.max(0,e.clientY-oy)+'px'; P.style.right='auto'; });
    document.addEventListener('mouseup', function() { if (drag) { drag=false; GM_setValue('panelPos', {left:P.offsetLeft,top:P.offsetTop}); } });
    function restore() { P.dataset.mini=''; P.style.width='400px'; P.style.height='560px'; P.style.borderRadius='8px'; P.querySelector('.bd').style.display=''; GM_setValue('panelMini',false); }
    function doMin() { P.dataset.mini='1'; P.style.width='40px'; P.style.height='40px'; P.style.borderRadius='50%'; P.querySelector('.bd').style.display='none'; GM_setValue('panelMini',true); }
    P.addEventListener('click', function(e) { if (e.target.dataset.a==='min') { if (P.dataset.mini==='1') restore(); else doMin(); } });
    P.addEventListener('dblclick', function() { if (P.dataset.mini==='1') restore(); });
    var bd = P.querySelector('.bd');

    function setDot(s) { var d=document.getElementById('_ep_dot'); if(d) d.className='dot '+(s||''); }

    // ===== Panel HTML =====
    bd.innerHTML =
    '<div class="tabs"><div class="tab active" data-tab="quick">快速提交</div><div class="tab" data-tab="auto">自动模式</div><div class="tab" data-tab="prefill">预填计划</div><div class="tab" data-tab="set">设置</div></div>' +
    '<div class="tab-page active" id="_ep_quick">' +
    '<div class="row"><label>提交日期</label><input type="date" id="_ep_qd"/></div>' +
    '<div class="row"><label>出勤时间</label><select id="_ep_qh" style="flex:0 0 56px"><option value="8">8h</option><option value="9">9h</option><option value="10" selected>10h</option><option value="11">11h</option><option value="16">16h</option></select>' +
    '<button class="btn" data-qh="8" style="margin-left:4px">8h</button><button class="btn" data-qh="9">9h</button><button class="btn" data-qh="10">10h</button></div>' +
    '<div class="eff-bar"><span>月效率</span><div class="bar"><div class="fill" id="_ep_eff_fill" style="width:0%;background:#1890ff"></div></div><span id="_ep_eff_pct">0%</span></div>' +
    '<button class="btn p" data-a="quickSubmit" style="width:100%;margin-top:4px">立即提交</button></div>' +

    '<div class="tab-page" id="_ep_auto">' +
    '<div class="info">从出勤API抓取打卡数据，自动提交</div>' +
    '<div class="cks"><label><input type="checkbox" id="_ep_skip" checked />跳过已填</label><label><input type="checkbox" id="_ep_auto" checked />定时自动提交</label></div>' +
    '<div class="acts"><button class="btn" data-a="fetchAtt">获取出勤</button><button class="btn p" data-a="submit">提交未填</button></div>' +
    '<div class="sep">出勤数据</div><table class="tbl" id="_ep_atbl"><tr><th>日期</th><th>班次</th><th>最早</th><th>最晚</th><th>出勤</th></tr></table></div>' +

    '<div class="tab-page" id="_ep_prefill">' +
    '<div class="info">整月排班，白班21:00提交，夜班次日6:50提交</div>' +
    '<div class="cks"><label><input type="checkbox" id="_ep_pfen" />启用预填</label><label>下次提交: <span id="_ep_nextsub" style="color:#1890ff;font-weight:bold">--</span></label></div>' +
    '<div class="row"><label>选择月份</label><input type="month" id="_ep_pfmonth"/></div>' +
    '<div class="row"><label>班次</label><select id="_ep_pfshift"><option value="day">白班</option><option value="night">夜班</option><option value="rest">休息</option></select></div>' +
    '<div class="row"><label>出勤时间H</label><input type="number" id="_ep_pfhours" value="10" min="0" max="16" step="0.5" style="width:60px"/><label><input type="checkbox" id="_ep_pfskipw" checked />跳过周日</label></div>' +
    '<div class="acts"><button class="btn p" data-a="applyMonth" style="flex:1">填充该月</button><button class="btn w" data-a="clearMonth">清空</button></div>' +
    '<div class="sep">当月预填预览</div><table class="tbl" id="_ep_pftbl"><tr><th>日期</th><th>星期</th><th>班次</th><th>出勤</th><th>提交时间</th></tr></table></div>' +

    '<div class="tab-page" id="_ep_set">' +
    '<div class="row"><label>用户ID</label><input id="_ep_uid" readonly/></div>' +
    '<div class="row"><label>用户账号</label><input id="_ep_uac" readonly/></div>' +
    '<div class="sep">W3登录配置</div>' +
    '<div class="row"><label>W3账号</label><input id="_ep_w3id"/></div>' +
    '<div class="row"><label>W3密码</label><input id="_ep_w3pw" type="password"/></div>' +
    '<div class="row"><label>W3状态</label><span id="_ep_w3status">检测中...</span><button class="btn" data-a="checkW3" style="margin-left:4px">检测</button><button class="btn p" data-a="loginW3">登录</button></div>' +
    '<div class="sep">工序配置</div>' +
    '<div class="row"><label>工段</label><select id="_ep_sec"><option>--获取中--</option></select></div>' +
    '<div class="row"><label>工序</label><select id="_ep_ws"><option>--先选工段--</option></select></div>' +
    '<div class="row"><label>岗位</label><select id="_ep_pid"><option>--先选工序--</option></select></div>' +
    '<div class="row"><label>标杆工时(分)</label><input id="_ep_wh" readonly/></div>' +
    '<div class="sep">效率设置</div>' +
    '<div class="row"><label>目标效率%</label><input type="number" id="_ep_tgt" value="70" min="65" max="75" step="0.5" style="width:60px"/></div>' +
    '<div class="row"><label>刷新频率</label><select id="_ep_rf" style="width:100px"><option value="30">30分钟</option><option value="60" selected>1小时</option><option value="120">2小时</option><option value="240">4小时</option></select></div></div>' +

    '<div class="log" id="_ep_log"></div>';

    // ===== Tab switching =====
    bd.querySelector('.tabs').addEventListener('click', function(e) {
        if (!e.target.dataset.tab) return;
        bd.querySelectorAll('.tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab===e.target.dataset.tab); });
        bd.querySelectorAll('.tab-page').forEach(function(p) { p.classList.toggle('active', p.id==='_ep_'+e.target.dataset.tab); });
        if (e.target.dataset.tab==='prefill') renderPreFillPreview();
    });

    // ===== State =====
    var postsCache = GM_getValue('postsCache', []);
    var curWH = GM_getValue('selectedWorkingHours', 0);
    var attendanceCache = GM_getValue('attendanceData', []);
    var prefillSchedule = GM_getValue('prefillSchedule', {});
    var prefillEnabled = GM_getValue('prefillEnabled', false);
    var quickDone = GM_getValue('quickDone', {});

    var today = new Date();
    document.getElementById('_ep_qd').value = fmtDate(today);
    document.getElementById('_ep_pfen').checked = prefillEnabled;
    document.getElementById('_ep_w3id').value = GM_getValue('w3Account', '');
    document.getElementById('_ep_w3pw').value = GM_getValue('w3Password', '');
    document.getElementById('_ep_tgt').value = GM_getValue('targetEfficiency', 70);
    document.getElementById('_ep_rf').value = String(GM_getValue('refreshFreq', 60));

    // ===== Keep alive + auto login =====
    function keepAliveOnce() {
        GM_xmlhttpRequest({
            method:'GET', url:KEEPALIVE_URL, withCredentials:true,
            onload:function(r) { setDot(r.status!==200?'off':'on'); },
            onerror:function() { setDot(''); }
        });
    }

    function w3Login(acct, pwd) {
        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method:'POST', url:W3_LOGIN_API, withCredentials:true,
                headers:{'Content-Type':'application/json; charset=UTF-8'},
                data:JSON.stringify({headers:{'Content-Type':'application/json; charset=UTF-8'},loginAccount:acct,uid:acct,password:pwd,lang:'zh_CN',cid:'',targetUrl:encodeURIComponent('https://w3.huawei.com/next/indexa.html'),fingerPrint:W3_FINGER}),
                onload:function(r){ try{var j=JSON.parse(r.responseText); resolve(j.statusCode===0); } catch(e){resolve(false);} },
                onerror:function(){resolve(false);}
            });
        });
    }

    function checkW3AndLogin() {
        GM_xmlhttpRequest({
            method:'POST', url:ATTEND_API, headers:{'Content-Type':'application/json'}, data:'{}', withCredentials:true,
            onload:function(r) {
                if (r.status === 200) { setDot('on'); return; }
                setDot('off');
                var acct = GM_getValue('w3Account',''), pwd = GM_getValue('w3Password','');
                if (!acct||!pwd) return;
                w3Login(acct, pwd).then(function(ok) {
                    if(ok) {
                        log('W3自动登录成功','ok'); setDot('on');
                        GM_xmlhttpRequest({method:'GET', url:'https://w3.huawei.com/next/indexa.html', withCredentials:true, onload:function(){}, onerror:function(){}});
                    } else { log('W3自动登录失败','er'); }
                });
            },
            onerror:function(){ setDot(''); }
        });
    }

    setInterval(checkW3AndLogin, 120000);
    setTimeout(checkW3AndLogin, 3000);

    // ===== API =====
    function fetchAtt() {
        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method:'POST', url:ATTEND_API, headers:{'Content-Type':'application/json'}, data:'{}', withCredentials:true,
                onload:function(r) {
                    try {
                        var j=JSON.parse(r.responseText);
                        if (j.status===403||(j.message&&j.message.indexOf('not logged in')>=0)) { resolve([]); return; }
                        var items = j.resultObjVO||j.result||j.data||[];
                        var arr = Array.isArray(items)?items:[];
                        var map={}, order=[], out=[];
                        arr.forEach(function(it) {
                            var date = it.shiftDate||it.date||it.day||'';
                            if (!date) return;
                            var earliest=it.cardIn||'', latest=it.cardOut||'';
                            var att=calcAttendance(earliest,latest);
                            var shift=shiftLabel(it.shiftName,earliest);
                            if (!map[date]) { map[date]={date:date,attendance:0,earliest:earliest,latest:latest,shifts:[]}; order.push(date); }
                            var m=map[date]; m.attendance=Math.min(m.attendance+att,16); m.shifts.push(shift);
                            if (earliest&&(!m.earliest||earliest<m.earliest)) m.earliest=earliest;
                            if (latest&&(!m.latest||latest>m.latest)) m.latest=latest;
                        });
                        order.forEach(function(d){var m=map[d];m.shift=m.shifts.filter(function(v,i,a){return a.indexOf(v)===i}).join('+');delete m.shifts;out.push(m);});
                        resolve(out);
                    } catch(e) { resolve([]); }
                },
                onerror:function(){resolve([]);}
            });
        });
    }

    function effApi(path, m, body) {
        return new Promise(function(resolve, reject) {
            var o = { method: m || 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
            if (body) o.body = JSON.stringify(body);
            fetch(EFF_API + path, o).then(function(r) { return r.json(); }).then(function(d) { resolve(d); }).catch(function(e) { reject(e); });
        });
    }

    var pageCfg = function() { return {total:9999,pageSize:5000,currentPage:1,pageSizes:[100,200,500,1000,5000],layout:'total, prev, pager, next, jumper, sizes',curPage:1}; };

    function getMonthRange(y,m) {
        var f=new Date(y,m,1), l=new Date(y,m+1,0);
        return {begin:f.getFullYear()+'-'+pad(f.getMonth()+1)+'-'+pad(f.getDate()), end:l.getFullYear()+'-'+pad(l.getMonth()+1)+'-'+pad(l.getDate())};
    }

    async function getMonthRecords() {
        var uid = GM_getValue('userId','');
        if (!uid) return [];
        var all=[], ms=new Set();
        var now=new Date(); ms.add(now.getFullYear()+'-'+now.getMonth());
        if (attendanceCache.length) attendanceCache.forEach(function(d){var dt=new Date(d.date);ms.add(dt.getFullYear()+'-'+dt.getMonth());});
        for (var mk of ms) {
            var p=mk.split('-'), rng=getMonthRange(parseInt(p[0]),parseInt(p[1]));
            try { var res=await effApi('/personalEfficiency/page/list','POST',{query:{postId:null,userId:uid,beginDate:rng.begin,endDate:rng.end},page:pageCfg()}); all=all.concat(res.data?.result||res.result?.rows||res.data?.rows||[]); } catch(e) {}
        }
        return all;
    }

    // ===== Quick submit =====
    async function doQuickSubmit() {
        var qd = document.getElementById('_ep_qd').value;
        var qh = parseInt(document.getElementById('_ep_qh').value)||10;
        if (!qd) { log('请选择日期','er'); return; }
        var uid = GM_getValue('userId',''), uac = GM_getValue('userAccount','');
        var ws = document.getElementById('_ep_ws').value;
        var pid = parseInt(GM_getValue('selectedPostId','0'))||null;
        if (!uid||!ws||!curWH) { log('请先在设置页完成工序配置','er'); return; }
        var op = Math.max(1, Math.round(0.7*qh*60/curWH));
        try {
            var r = await effApi('/personalEfficiency/save','POST',{items2Create:[{userId:uid,userAccount:uac,state:'1',workingDate:qd,attendanceTime:qh,workstep:ws,outputPcs:op,workingHours:curWH,outputTime:String((op*curWH).toFixed(1)),_RID:'q_'+qd,postId:pid}],items2Update:[]});
            if (r.code===200||r.code==='200') {
                log(qd+' 快速提交成功','ok');
                var qd2 = GM_getValue('quickDone',{}); qd2[qd]=1; GM_setValue('quickDone',qd2);
            } else log(qd+' 失败:'+(r.msg||r.message||''),'er');
        } catch(e) { log(qd+' 错误:'+e.message,'er'); }
    }

    // ===== Fetch + submit auto =====
    async function doFetchAtt() {
        log('获取出勤数据...','i');
        var data = await fetchAtt();
        if (!data.length) { log('出勤API返回空，可能未登录','er'); return; }
        attendanceCache = data; GM_setValue('attendanceData',data);
        renderAttTbl(data);
        log('获取 '+data.length+' 天数据','ok');
    }

    function renderAttTbl(data) {
        var tbl = document.getElementById('_ep_atbl');
        if (!tbl) return;
        tbl.innerHTML = '<tr><th>日期</th><th>班次</th><th>最早</th><th>最晚</th><th>出勤</th></tr>';
        data.forEach(function(d) {
            tbl.innerHTML += '<tr><td>'+d.date+'</td><td>'+d.shift+'</td><td>'+fmtTime(d.earliest)+'</td><td>'+fmtTime(d.latest)+'</td><td>'+d.attendance+'h</td></tr>';
        });
    }

    async function doAutoSubmit() {
        var existing = await getMonthRecords();
        var existDates = new Set(existing.map(function(e){return e.workingDate;}));
        var skip = document.getElementById('_ep_skip').checked;
        var newDays = attendanceCache.filter(function(d){return d.attendance>0&&(!skip||!existDates.has(d.date));});
        if (!newDays.length) { log('无新数据','i'); return; }
        var uid = GM_getValue('userId',''), uac = GM_getValue('userAccount','');
        var ws = document.getElementById('_ep_ws').value;
        var pid = parseInt(GM_getValue('selectedPostId','0'))||null;
        if (!uid||!ws||!curWH) { log('请先设置工序','er'); return; }
        for (var i=0;i<newDays.length;i++) {
            var d=newDays[i], op=Math.max(1,Math.round(0.7*d.attendance*60/curWH));
            try {
                var r=await effApi('/personalEfficiency/save','POST',{items2Create:[{userId:uid,userAccount:uac,state:'1',workingDate:d.date,attendanceTime:d.attendance,workstep:ws,outputPcs:op,workingHours:curWH,outputTime:String((op*curWH).toFixed(1)),_RID:'a_'+d.date,postId:pid}],items2Update:[]});
                if (r.code===200||r.code==='200') log(d.date+' '+d.attendance+'h ✓','ok');
                else log(d.date+' ✗'+(r.msg||r.message||''),'er');
            } catch(e) { log(d.date+' ✗'+e.message,'er'); }
            await new Promise(function(r){setTimeout(r,300);});
        }
    }

    // ===== Prefill =====
    function renderPreFillPreview() {
        var tbl = document.getElementById('_ep_pftbl'); if(!tbl) return;
        var mel = document.getElementById('_ep_pfmonth'); if(!mel) return;
        if (!mel.value) { var n=new Date(); mel.value=n.getFullYear()+'-'+pad(n.getMonth()+1); }
        var p=mel.value.split('-'), y=parseInt(p[0]), m=parseInt(p[1])-1, days=new Date(y,m+1,0).getDate();
        var todayS = fmtDate(new Date()), qdone = GM_getValue('quickDone',{});
        var html = '<tr><th>日期</th><th>星期</th><th>班次</th><th>出勤</th><th>状态/提交时间</th></tr>';
        for (var d=1;d<=days;d++) {
            var dt=new Date(y,m,d), ds=fmtDate(dt), dow=dt.getDay();
            var s=prefillSchedule[ds]||{shift:'none',hours:0}, sh=s.shift||'none';
            var shiftSel='<select data-pfdate="'+ds+'" data-pff="shift" style="height:22px;font-size:10px;padding:1px">'+
                '<option value="none"'+(sh==='none'?' selected':'')+'>-</option>'+
                '<option value="day"'+(sh==='day'?' selected':'')+'>白班</option>'+
                '<option value="night"'+(sh==='night'?' selected':'')+'>夜班</option>'+
                '<option value="rest"'+(sh==='rest'?' selected':'')+'>休息</option></select>';
            var hoursIn='<input type="number" data-pfdate="'+ds+'" data-pff="hours" value="'+(s.hours||0)+'" min="0" max="16" step="0.5" style="width:40px;height:22px;font-size:10px;text-align:center;padding:1px"/>';
            var submitTime='--'; if (sh==='day') submitTime='21:00'; else if (sh==='night') submitTime='次日6:50';
            var status = qdone[ds] ? '<span style="color:#52c41a">已快提</span>' : (sh!=='none'&&sh!=='rest'?submitTime:'');
            var rs = ds===todayS ? ' style="background:#fffbe6"' : '';
            html += '<tr'+rs+'><td>'+ds+'</td><td>'+DAY_NAMES[dow]+'</td><td>'+shiftSel+'</td><td>'+hoursIn+'</td><td style="font-size:10px">'+status+'</td></tr>';
        }
        tbl.innerHTML = html;
        updateNextSubmitTime();
    }

    function applyMonthSchedule() {
        var mel=document.getElementById('_ep_pfmonth'), shift=document.getElementById('_ep_pfshift').value, hours=parseFloat(document.getElementById('_ep_pfhours').value)||0, skipW=document.getElementById('_ep_pfskipw').checked;
        var p=mel.value.split('-'), y=parseInt(p[0]), m=parseInt(p[1])-1, days=new Date(y,m+1,0).getDate(), cnt=0;
        for (var d=1;d<=days;d++) {
            var dt=new Date(y,m,d); if (skipW&&dt.getDay()===0) continue;
            prefillSchedule[fmtDate(dt)]={shift:shift,hours:hours}; cnt++;
        }
        GM_setValue('prefillSchedule',prefillSchedule);
        log('填充 '+cnt+'天','ok'); renderPreFillPreview();
    }

    function clearMonthSchedule() {
        var mel=document.getElementById('_ep_pfmonth');
        var p=mel.value.split('-'), y=parseInt(p[0]), m=parseInt(p[1])-1, days=new Date(y,m+1,0).getDate(), cnt=0;
        for (var d=1;d<=days;d++) { var ds=fmtDate(new Date(y,m,d)); if (prefillSchedule[ds]) { delete prefillSchedule[ds]; cnt++; } }
        GM_setValue('prefillSchedule',prefillSchedule);
        log('清空 '+cnt+'天','w'); renderPreFillPreview();
    }

    function updateNextSubmitTime() {
        var el=document.getElementById('_ep_nextsub'); if(!el) return;
        if (!prefillEnabled) { el.textContent='预填未启用'; return; }
        var qdone=GM_getValue('quickDone',{});
        for (var i=0;i<31;i++) {
            var d=new Date(Date.now()+i*86400000), ds=fmtDate(d), s=prefillSchedule[ds];
            if (qdone[ds]) continue;
            if (s&&s.shift==='day') { el.textContent=ds+' 21:00'; return; }
            if (s&&s.shift==='night') { el.textContent=fmtDate(new Date(d.getTime()+86400000))+' 06:50'; return; }
        }
        el.textContent='无计划';
    }

    async function checkScheduledSubmit() {
        var qdone=GM_getValue('quickDone',{});
        if (!prefillEnabled) return;
        var now=new Date(), hour=now.getHours(), minute=now.getMinutes();
        var today=fmtDate(now), yesterday=fmtDate(new Date(now.getTime()-86400000));
        var submitted=GM_getValue('lastSchedSubmit',''), key='';
        if (hour===21&&minute===0) { var ts=prefillSchedule[today]; if (ts&&ts.shift==='day'&&!qdone[today]) key='day_'+today; }
        if (hour===6&&minute===50) { var ys=prefillSchedule[yesterday]; if (ys&&ys.shift==='night'&&!qdone[yesterday]) key='night_'+yesterday; }
        if (key&&submitted!==key) {
            log('[定时] '+key,'i');
            var date=key.startsWith('day_')?today:yesterday;
            var schedule=prefillSchedule[date];
            var hours=schedule.hours;
            var uid=GM_getValue('userId',''), uac=GM_getValue('userAccount','');
            var ws=document.getElementById('_ep_ws').value;
            var pid=parseInt(GM_getValue('selectedPostId','0'))||null;
            if (!uid||!ws||!curWH) { log('定时提交失败：未配置','er'); return; }
            var op=Math.max(1,Math.round(0.7*hours*60/curWH));
            try {
                var r=await effApi('/personalEfficiency/save','POST',{items2Create:[{userId:uid,userAccount:uac,state:'1',workingDate:date,attendanceTime:hours,workstep:ws,outputPcs:op,workingHours:curWH,outputTime:String((op*curWH).toFixed(1)),_RID:'s_'+date,postId:pid}],items2Update:[]});
                if (r.code===200||r.code==='200') log(date+' 定时提交OK','ok');
                else log(date+' 定时失败:'+(r.msg||r.message||''),'er');
            } catch(e) { log(date+' 定时错误:'+e.message,'er'); }
            GM_setValue('lastSchedSubmit',key);
        }
        updateNextSubmitTime();
    }

    // ===== Load sections =====
    async function loadSections() {
        try {
            var res = await effApi('/personalEfficiencyPost/findAllSection');
            var items = res.data||[];
            var sel = document.getElementById('_ep_sec');
            sel.innerHTML = '<option value="">-- 请选择工段 --</option>';
            items.forEach(function(s){sel.innerHTML+='<option value="'+s+'">'+s+'</option>';});
            var saved = GM_getValue('selectedSection','');
            if (saved&&items.indexOf(saved)>=0) { sel.value=saved; await loadPosts(saved); }
        } catch(e) { log('工段加载失败','er'); }
    }

    async function loadPosts(section) {
        try {
            log('loadPosts section='+section,'i');
            var allRows=[], page=1, totalPages=1;
            while(page <= totalPages) {
                var cfg={total:9999,pageSize:100,currentPage:page,pageSizes:[100,200,500,1000,5000],layout:'total, prev, pager, next, jumper, sizes',curPage:page};
                var res=await effApi('/personalEfficiencyPost/page/list','POST',{query:{section},page:cfg});
                var rows=res.data?.result||res.result?.rows||res.data?.rows||[];
                allRows=allRows.concat(rows);
                totalPages=res.data?.pageVO?.totalPages||res.pageVO?.totalPages||1;
                page++;
                if(page>50) break;
            }
            postsCache=allRows; GM_setValue('postsCache',allRows);
            var wset=new Set(); allRows.forEach(function(r){if(r.workstep)wset.add(r.workstep);});
            var sel=document.getElementById('_ep_ws');
            sel.innerHTML='<option value="">-- 请选择工序 --</option>';
            var wsList=[]; wset.forEach(function(w){wsList.push(w);});
            wsList.sort().forEach(function(w){sel.innerHTML+='<option value="'+w+'">'+w+'</option>';});
            log('工序下拉框加载了 '+wsList.length+' 项','ok');
            var sws=GM_getValue('selectedWorkstep','');
            if (sws&&wset.has(sws)) { sel.value=sws; filterPosts(sws); }
        } catch(e) { log('岗位加载失败: '+e.message,'er'); }
    }

    function filterPosts(ws) {
        var sel=document.getElementById('_ep_pid');
        sel.innerHTML='<option value="">-- 请选择岗位 --</option>';
        var filtered=postsCache.filter(function(p){return p.workstep===ws;});
        filtered.forEach(function(p){
            var wh=p.workingHours||p.workHours||0;
            sel.innerHTML+='<option value="'+(p.postId||p.id)+'" data-wh="'+wh+'">'+(p.postName||p.name||p.workstep)+' (标杆'+wh+'分)</option>';
        });
        var savedPid=GM_getValue('selectedPostId','');
        if (savedPid) {
            var match=filtered.find(function(p){return String(p.postId||p.id)===savedPid;});
            if (match) { sel.value=savedPid; curWH=GM_getValue('selectedWorkingHours',0)||parseFloat(match.workingHours||match.workHours||0); document.getElementById('_ep_wh').value=curWH; }
        }
    }

    // ===== Event listeners =====
    document.getElementById('_ep_sec').addEventListener('change',function(){GM_setValue('selectedSection',this.value);if(this.value)loadPosts(this.value);});
    document.getElementById('_ep_ws').addEventListener('change',function(){GM_setValue('selectedWorkstep',this.value);GM_setValue('selectedPostId','');GM_setValue('selectedWorkingHours',0);filterPosts(this.value);});
    document.getElementById('_ep_pid').addEventListener('change',function(){var opt=this.selectedOptions[0];curWH=parseFloat(opt?.dataset.wh||0);document.getElementById('_ep_wh').value=curWH;GM_setValue('selectedPostId',this.value);GM_setValue('selectedWorkingHours',curWH);});
    document.getElementById('_ep_tgt').addEventListener('change',function(){GM_setValue('targetEfficiency',parseFloat(this.value));});
    document.getElementById('_ep_rf').addEventListener('change',function(){GM_setValue('refreshFreq',parseInt(this.value));});
    document.getElementById('_ep_pfen').addEventListener('change',function(){prefillEnabled=this.checked;GM_setValue('prefillEnabled',prefillEnabled);log('预填:'+(prefillEnabled?'开':'关'),prefillEnabled?'ok':'w');renderPreFillPreview();});
    document.getElementById('_ep_w3id').addEventListener('change',function(){GM_setValue('w3Account',this.value);});
    document.getElementById('_ep_w3pw').addEventListener('change',function(){GM_setValue('w3Password',this.value);});

    bd.addEventListener('click', async function(e) {
        var a=e.target.dataset.a, qh=e.target.dataset.qh;
        if (qh) { document.getElementById('_ep_qh').value=qh; return; }
        if (a==='quickSubmit') { var btn=e.target; btn.disabled=true; btn.textContent='提交中...'; await doQuickSubmit(); btn.disabled=false; btn.textContent='立即提交'; }
        if (a==='fetchAtt') { await doFetchAtt(); }
        if (a==='submit') { var btn2=e.target; btn2.disabled=true; btn2.textContent='提交中...'; await doAutoSubmit(); btn2.disabled=false; btn2.textContent='提交未填'; }
        if (a==='applyMonth') { applyMonthSchedule(); }
        if (a==='clearMonth') { clearMonthSchedule(); }
        if (a==='checkW3') {
            log('检测W3...','i');
            GM_xmlhttpRequest({method:'GET',url:KEEPALIVE_URL,withCredentials:true,onload:function(r){log('W3:'+(r.status===200?'在线':'掉线'),r.status===200?'ok':'er');setDot(r.status===200?'on':'off');},onerror:function(){log('W3:网络异常','er');}});
        }
        if (a==='loginW3') {
            var acct=document.getElementById('_ep_w3id').value, pwd=document.getElementById('_ep_w3pw').value;
            if (!acct||!pwd) { log('请填账号密码','er'); return; }
            GM_setValue('w3Account',acct); GM_setValue('w3Password',pwd);
            log('登录中...','i');
            var ok=await w3Login(acct,pwd);
            log(ok?'登录成功':'登录失败',ok?'ok':'er');
            if (ok) { setDot('on'); GM_xmlhttpRequest({method:'GET', url:'https://w3.huawei.com/next/indexa.html', withCredentials:true, onload:function(){log('Cookie已同步','ok');}, onerror:function(){}}); }
        }
    });

    bd.addEventListener('change', function(e) {
        if (e.target.dataset.pfdate) {
            var ds=e.target.dataset.pfdate, field=e.target.dataset.pff;
            if (!prefillSchedule[ds]) prefillSchedule[ds]={shift:'none',hours:0};
            if (field==='shift') { prefillSchedule[ds].shift=e.target.value; if (e.target.value==='rest') prefillSchedule[ds].hours=0; }
            else if (field==='hours') prefillSchedule[ds].hours=parseFloat(e.target.value)||0;
            GM_setValue('prefillSchedule',prefillSchedule);
            updateNextSubmitTime();
        }
    });

    // ===== Boot =====
    setTimeout(async function() {
        try { var raw=localStorage.getItem('aurora-user'); if (raw) { var obj=JSON.parse(raw), key=Object.keys(obj)[0]; var u2=obj[key]; if (u2) { GM_setValue('userId',String(u2.i||u2.p||'')); GM_setValue('userAccount',u2.u||''); } } } catch(e) {}
        var u=GM_getValue('userId',''), uac=GM_getValue('userAccount','');
        if (u) { document.getElementById('_ep_uid').value=u; document.getElementById('_ep_uac').value=uac; log('用户: '+u+' / '+uac,'ok'); }

        var mel=document.getElementById('_ep_pfmonth');
        if (mel&&!mel.value) { var n=new Date(); mel.value=n.getFullYear()+'-'+pad(n.getMonth()+1); }
        await loadSections();
        attendanceCache=GM_getValue('attendanceData',[]);
        if (attendanceCache.length) renderAttTbl(attendanceCache);
        renderPreFillPreview();

        var rf=parseInt(document.getElementById('_ep_rf').value)||60;
        setInterval(async function() {
            await doFetchAtt();
            if (document.getElementById('_ep_auto').checked&&attendanceCache.length) await doAutoSubmit();
        }, rf*60000);
        setInterval(checkScheduledSubmit, 30000);

        log('脚本加载完成','i');
    }, 2000);

    GM_registerMenuCommand('显示/隐藏面板', function() {
        var b=P.querySelector('.bd'); b.style.display=b.style.display==='none'?'':'none';
    });
})();
