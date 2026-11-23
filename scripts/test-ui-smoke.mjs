/* ============================================================
 * 渲染层冒烟测试（scripts/test-ui-smoke.mjs）
 * 用 DOM 桩在 Node 中加载 ui.js，逐个打开全部面板并刷新，
 * 验证渲染函数不会因缺字段/空队列而抛错——这是 Node 层测试
 * 覆盖不到、却又最容易出问题的一层。
 * ============================================================ */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import * as Core from '../js/core/index.js';

let passed = 0;
const failures = [];
function assert(cond, msg) {
    if (cond) passed++;
    else { failures.push(msg); console.error('  ✗ ' + msg); }
}
function section(name) { console.log('\n■ ' + name); }

// ---------- 极简 DOM 桩 ----------
function makeEl(id) {
    const el = {
        id,
        innerHTML: '',
        textContent: '',
        scrollTop: 0,
        disabled: false,
        title: '',
        dataset: {},
        style: {},
        _listeners: {},
        classList: {
            _set: new Set(),
            add(...c) { c.forEach((x) => this._set.add(x)); },
            remove(...c) { c.forEach((x) => this._set.delete(x)); },
            toggle(c, force) {
                const on = force === undefined ? !this._set.has(c) : force;
                if (on) this._set.add(c); else this._set.delete(c);
                return on;
            },
            contains(c) { return this._set.has(c); },
        },
        addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
        removeEventListener() {},
        querySelectorAll() { return []; },
        appendChild() {},
        setAttribute() {},
        getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
        getContext() { return null; },
    };
    return el;
}

const els = {};
const documentStub = {
    documentElement: makeEl('html'),
    getElementById(id) { return (els[id] ||= makeEl(id)); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
};

const store = {};
const sandbox = {
    console,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url) => {
        const raw = readFileSync(path.join(process.cwd(), url), 'utf8');
        return { ok: true, json: async () => JSON.parse(raw) };
    },
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
    },
    MapView: {
        init() {}, loadData: async () => {}, fitWorld() {}, draw() {},
        invalidateFills() {}, requestDraw() {}, setTheme() {}, resize() {},
    },
    document: documentStub,
    Core,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.alert = () => {};

const ctx = vm.createContext(sandbox);
for (const f of ['js/data.js', 'js/game.js', 'js/ui.js']) {
    vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
}
const Game = sandbox.Game;
const UI = sandbox.UI;

// ---------- 准备一局有内容的游戏 ----------
section('1. 初始化与面板渲染');
{
    await Game.prepareNewGame();
    Game.startWith('GER');

    // 注入地图索引（含邻接表），让省份名与部队移动可用
    Game.loadProvinceData({
        meta: {
            '1159312769': { name: '柏林', owner: 'DEU', bbox: [0, 0, 10, 10] },
            '1159314695': { name: '马佐夫舍省', owner: 'POL', bbox: [0, 0, 10, 10] },
            '1159314679': { name: '小波兰省', owner: 'POL', bbox: [0, 0, 10, 10] },
            '1159316799': { name: '巴黎', owner: 'FRA', bbox: [0, 0, 10, 10] },
        },
        neighbors: {
            '1159312769': [1159314695, 1159314679],
            '1159314695': [1159312769, 1159314679],
            '1159314679': [1159314695, 1159312769],
        },
    });

    // 推进一段时间，让经济/科研/建造产生实际数据
    Game.command({ t: 'allocateFactory', country: 'GER', line: { equipment: 'infantry_weapon', factories: 1 } });
    Game.command({ t: 'startConstruction', country: 'GER', kind: 'civs', state: 101 });
    Game.command({ t: 'startResearch', country: 'GER', techId: 'inf_weapons_1' });
    Game.campaign.fastForward(40);

    // 制造一支部队与一场战争，覆盖部队/外交面板的分支
    Game.command({ t: 'declareWar', from: 'GER', to: 'POL' });
    Game.command({ t: 'deployArmy', country: 'GER', province: 1159312769, template: 'infantry', count: 2 });
    Game.selectProvince(1159312769);

    UI.init(Game);

    const panels = ['overview', 'politics', 'economy', 'production', 'army', 'tech', 'diplomacy', 'intelligence', 'log'];
    for (const p of panels) {
        let threw = null;
        try { UI.openPanel(p); } catch (e) { threw = e; }
        assert(!threw, `面板 ${p} 渲染不抛错${threw ? '：' + threw.message : ''}`);
        const html = documentStub.getElementById('panelContent').innerHTML;
        assert(html.length > 0, `面板 ${p} 有渲染内容`);
        UI.closePanel();
    }
    assert(documentStub.getElementById('panelContent').innerHTML.length > 0, '面板关闭后内容仍可重建');
}

// ---------- 各面板在空态下也不应崩溃 ----------
section('2. 空态与边界渲染');
{
    // 新开局、无产线/无部队/无战争，全部面板仍需正常渲染
    Game.startWith('POL');
    Game.selectProvince(null);
    UI.refreshAll();
    const panels = ['overview', 'politics', 'economy', 'production', 'army', 'tech', 'diplomacy', 'intelligence', 'log'];
    for (const p of panels) {
        let threw = null;
        try { UI.openPanel(p); } catch (e) { threw = e; }
        assert(!threw, `空态面板 ${p} 渲染不抛错${threw ? '：' + threw.message : ''}`);
        UI.closePanel();
    }

    // 未选择省份时的情报面板
    UI.openPanel('intelligence');
    assert(documentStub.getElementById('panelContent').innerHTML.includes('请在地图上选择'), '未选省份时给出提示');
    UI.closePanel();
}

// ---------- 弹窗与事件 ----------
section('3. 弹窗、事件与胜负');
{
    Game.startWith('GER');
    Game.selectProvince(1159312769);

    UI.showModal('测试', '<p>正文</p>', [{ text: '确定', cls: 'primary', action: () => {} }]);
    assert(!documentStub.getElementById('modal').classList.contains('hidden'), '模态框可打开');
    UI.closeModal();
    assert(documentStub.getElementById('modal').classList.contains('hidden'), '模态框可关闭');

    // 战役事件弹窗（暂停 → 处理 → 恢复到事件前的速度）
    const ev = Game.campaign.content.events['danzig_demand'];

    // 场景一：玩家本就暂停，处理事件后应保持暂停（不会被强行拉到 1x）
    Game.speed = 0;
    UI.showCampaignEvent('danzig_demand', ev);
    assert(!documentStub.getElementById('eventOverlay').classList.contains('hidden'), '事件弹窗可打开');
    assert(Game.speed === 0, '事件弹窗出现时暂停时间');
    UI.resolveCampaignEvent('danzig_demand', 1);
    assert(documentStub.getElementById('eventOverlay').classList.contains('hidden'), '事件弹窗可关闭');
    assert(Game.speed === 0, '暂停中处理事件后仍保持暂停');

    // 场景二：玩家正在推进，处理事件后应恢复到原速度
    Game.speed = 3;
    UI.showCampaignEvent('danzig_demand', ev);
    assert(Game.speed === 0, '运行中弹出事件时暂停时间');
    UI.resolveCampaignEvent('danzig_demand', 1);
    assert(Game.speed === 3, '事件处理后恢复到原速度');

    // 胜负弹窗
    UI.showVictory({ winner: 'GER', type: 'controlState' });
    assert(!documentStub.getElementById('modal').classList.contains('hidden'), '胜负弹窗可打开');
    UI.closeModal();

    // 刷新主界面（顶部栏 + 底部状态栏）
    let threw = null;
    try { UI.refreshAll(); } catch (e) { threw = e; }
    assert(!threw, 'refreshAll 不抛错' + (threw ? '：' + threw.message : ''));

    // 暂停提示与速度按钮高亮随速度同步
    Game.speed = 0;
    UI.refreshAll();
    assert(!documentStub.getElementById('pauseHint').classList.contains('hidden'), '速度为 0 时显示暂停提示');
    Game.speed = 3;
    UI.refreshAll();
    assert(documentStub.getElementById('pauseHint').classList.contains('hidden'), '速度大于 0 时隐藏暂停提示');
    Game.speed = 0;
    UI.refreshAll();
    assert(!documentStub.getElementById('pauseHint').classList.contains('hidden'), '速度回到 0 时再次显示暂停提示');
}

// ---------- 部队交互：选中 / 移动 / 省份卡 / 快捷部署 ----------
section('4. 部队交互');
{
    Game.startWith('GER');
    Game.selectProvince(null);
    UI.refreshAll();

    const dr = Game.command({ t: 'deployArmy', country: 'GER', province: 1159312769, template: 'infantry', count: 1 });
    assert(dr.ok, '部署部队成功');
    const army = Game.allArmies()[0];
    assert(!!army, '部队已创建');

    Game.selectArmy(army.id);
    assert(Game.selectedArmy === army.id, 'selectArmy 记录选中部队');
    assert(Game.selectedProvince === 1159312769, 'selectArmy 同步选中省份');

    const opts = Game.moveOptionsFor(army.id);
    assert(opts.some((o) => o.id === 1159314695 && o.ok), '相邻省份解析为可移动');
    assert(opts.every((o) => typeof o.name === 'string'), '移动选项带省份名');

    Game.selectProvince(1159312769);
    const cardHtml = documentStub.getElementById('provinceCard').innerHTML;
    assert(!documentStub.getElementById('provinceCard').classList.contains('hidden'), '选中省份后速览卡显示');
    assert(cardHtml.includes('驻扎部队'), '速览卡显示驻扎部队');
    assert(cardHtml.includes('data-deploy-here'), '速览卡提供快捷部署');

    const before = Game.allArmies().length;
    const d = UI.deployAt('infantry', 1159312769, 1);
    assert(d.ok && Game.allArmies().length === before + 1, '速览卡快捷部署新增部队');
    assert(documentStub.getElementById('toast').textContent.includes('已部署'), '部署后显示提示条');

    const newest = Game.allArmies()[Game.allArmies().length - 1];
    assert(Game.selectedArmy === newest.id, '部署后自动选中新部队');
    // 1159314679 没有波兰初始部队，避免进入即有敌军的省份被战斗打光
    const mv = Game.moveSelectedArmy(1159314679);
    assert(mv.ok, '选中后移动到相邻省份成功');
    assert(Game.armyById(newest.id).provinceId === 1159314679, '部队位置已更新');
    Game.selectProvince(null);
    assert(documentStub.getElementById('provinceCard').classList.contains('hidden'), '取消选中后速览卡隐藏');
}

// ============================================================
console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
} else {
    console.log('全部通过 ✓');
}
