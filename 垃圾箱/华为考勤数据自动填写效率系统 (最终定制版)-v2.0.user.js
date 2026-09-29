// ==UserScript==
// @name         华为考勤数据自动填写效率系统 (最终定制版)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  自动计算考勤工时，跨域携带数据，并模拟人类操作双击、输入、保存到效率系统
// @author       AI Assistant
// @match        https://w3.huawei.com/mes/mesmehrweb/*
// @match        https://ge.make.huawei.com/ie/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function() {
    'use strict';

    const currentUrl = window.location.href;

    // ==========================================
    // 场景 1：在考勤页面 (提取并计算数据)
    // ==========================================
    if (currentUrl.includes("w3.huawei.com/mes/mesmehrweb")) {
        setTimeout(() => {
            const btn = document.createElement('button');
            btn.innerText = "🚀 提取考勤并去填效率";
            btn.style.cssText = `
                position: fixed; top: 10px; right: 10px; z-index: 99999;
                padding: 10px 15px; background-color: #007DFF; color: white;
                border: none; border-radius: 5px; cursor: pointer; font-weight: bold;
                box-shadow: 0 4px 6px rgba(0,0,0,0.3);`;
            document.body.appendChild(btn);

            btn.onclick = function() {
                btn.innerText = "正在分析考勤...";

                // 根据你提供的结构，抓取所有的日期区块
                const items = document.querySelectorAll('li.grid-content-item');
                let attendanceData = [];

                items.forEach(li => {
                    const divs = li.querySelectorAll('div');
                    if (divs.length >= 3) {
                        const dateStr = divs[0].innerText.trim(); // 如 2026-07-21

                        // 第三个 div 里包含了最早和最晚打卡记录
                        const spans = divs[2].querySelectorAll('span');
                        if (spans.length >= 2 && dateStr.match(/\d{4}-\d{2}-\d{2}/)) {
                            const startStr = spans[0].innerText.trim(); // 如 2026-07-21 08:12
                            const endStr = spans[1].innerText.trim();   // 如 2026-07-21 18:42

                            let hours = 0;
                            // 计算工时逻辑
                            if (startStr && endStr) {
                                const startTime = new Date(startStr);
                                const endTime = new Date(endStr);
                                if (!isNaN(startTime) && !isNaN(endTime)) {
                                    hours = (endTime - startTime) / (1000 * 60 * 60);
                                    hours = parseFloat(hours.toFixed(1)); // 保留1位小数
                                }
                            }

                            attendanceData.push({
                                date: dateStr,
                                hours: hours,
                                start: startStr.split(' ')[1] || '',
                                end: endStr.split(' ')[1] || ''
                            });
                        }
                    }
                });

                if (attendanceData.length === 0) {
                    alert("未提取到考勤数据！请确保考勤记录已加载完毕。");
                    btn.innerText = "🚀 提取考勤并去填效率";
                    return;
                }

                // 保存数据并跳转
                GM_setValue('huawei_temp_data', JSON.stringify(attendanceData));
                btn.innerText = "提取成功，正在跳转...";
                window.location.href = 'https://ge.make.huawei.com/ie/#/ie/personalEfficiencyView';
            };
        }, 3000);
    }

    // ==========================================
    // 场景 2：在效率页面 (模拟人工自动填写)
    // ==========================================
    else if (currentUrl.includes("ge.make.huawei.com/ie")) {

        const savedData = GM_getValue('huawei_temp_data');
        if (!savedData) return;

        const dataToFill = JSON.parse(savedData);

        // 延迟等待表格渲染
        setTimeout(() => {
            // 找到效率系统的数据行 (根据你提供的结构)
            const rows = document.querySelectorAll('table.aui-grid-body__table tr');
            if (rows.length === 0) {
                console.log("效率系统表格未加载，等待中...");
                return;
            }

            // 创建一个悬浮提示框，告诉你进度
            const progressBox = document.createElement('div');
            progressBox.style.cssText = `
                position: fixed; top: 10px; right: 10px; z-index: 99999;
                padding: 15px; background: rgba(0,0,0,0.8); color: #00FF00;
                border-radius: 8px; font-size: 14px; font-family: monospace;`;
            document.body.appendChild(progressBox);
            progressBox.innerText = "🤖 正在匹配数据...";

            let filledCount = 0;
            let processIndex = 0;

            // 使用异步循环，因为模拟点击和输入需要时间间隔
            async function processRows() {
                for (let item of dataToFill) {
                    if (item.hours === 0) continue; // 工时为0则跳过

                    let foundRow = false;

                    // 遍历表格寻找对应日期 (col_4 是日期列)
                    for (let row of rows) {
                        const dateCell = row.querySelector('.col_4 .aui-grid-cell');
                        if (dateCell && dateCell.innerText.trim() === item.date) {
                            foundRow = true;
                            progressBox.innerText = `⏳ 匹配到 ${item.date}，正在尝试输入 ${item.hours} H...`;

                            // 找到了对应的行，准备操作 col_6 (当天出勤_H)
                            const targetCell = row.querySelector('.col_6 .aui-grid-cell');
                            if (targetCell) {
                                // 1. 模拟双击单元格，激活编辑模式
                                targetCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

                                // 2. 等待 200 毫秒，让 Vue 把 div 变成 input
                                await new Promise(r => setTimeout(r, 200));

                                // 3. 找到刚刚弹出来的 input 输入框
                                const inputElement = row.querySelector('.col_6 input');
                                if (inputElement) {
                                    // 清空原值并填入新值
                                    setNativeValue(inputElement, item.hours.toString());

                                    // 4. 模拟按下回车键或者点击页面其他地方，让系统保存这个值
                                    inputElement.dispatchEvent(new KeyboardEvent('keydown', { 'key': 'Enter', bubbles: true }));
                                    // 也可以触发失焦事件
                                    inputElement.dispatchEvent(new Event('blur', { bubbles: true }));

                                    filledCount++;
                                    progressBox.innerText = `✅ ${item.date} 填写完成！`;
                                    await new Promise(r => setTimeout(r, 500)); // 操作间隔
                                } else {
                                    progressBox.innerText = `❌ ${item.date} 双击后未找到输入框，可能需要单击。`;
                                }
                            }
                            break; // 找到并处理完该行，跳出内层循环
                        }
                    }
                    if (!foundRow) {
                         console.log(`未在效率表格中找到日期：${item.date}`);
                    }
                }

                // 全部处理完毕
                progressBox.innerText = `🎉 全部处理完毕！共自动填写 ${filledCount} 条记录。\n请务必核对无误后再点击保存！`;
                progressBox.style.color = "#FFD700";

                // 清理缓存
                GM_deleteValue('huawei_temp_data');
            }

            // 开始执行异步任务
            processRows();

        }, 24000); // 给予 4 秒的页面加载时间
    }

    // ==========================================
    // 核心辅助函数：让 Vue/React 能够识别输入的值
    // ==========================================
    function setNativeValue(element, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;

        if (valueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else {
            valueSetter.call(element, value);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

})();
