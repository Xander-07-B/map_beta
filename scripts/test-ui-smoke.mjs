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
function assertEqual(a, b, msg) {
    assert(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}
function section(name) { console.log('\n■ ' + name); }

// ---------- 极简 DOM 桩 ----------
function makeEl(id) {
    const el = {
        id,
        textContent: '',
        scrollTop: 0,
        disabled: false,
        title: '',
        dataset: {},
        style: {},
        children: [],
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
        appendChild(child) { this.children.push(child); return child; },
        setAttribute() {},
        getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
        getContext() { return null; },
    };
    // innerHTML 赋值时清空子节点（模拟真实 DOM 行为，供区域筛选测试统计卡片数）
    let _html = '';
    Object.defineProperty(el, 'innerHTML', {
        get() { return _html; },
        set(v) { _html = v; el.children.length = 0; },
    });
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
    addEventListener: () => {},
    removeEventListener: () => {},
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
for (const f of ['js/render/data.js', 'js/render/game.js', 'js/render/ui.js', 'js/render/main.js']) {
    vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
}
const Game = sandbox.Game;
const UI = sandbox.UI;
const App = sandbox.App;

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

    const panels = ['overview', 'politics', 'economy', 'production', 'army', 'tech', 'diplomacy', 'war', 'intelligence', 'notices', 'log'];
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
    const panels = ['overview', 'politics', 'economy', 'production', 'army', 'tech', 'diplomacy', 'war', 'intelligence', 'notices', 'log'];
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

// ---------- 空中 / 海上 / 外交 / 战争面板 ----------
section('5. 空军、海军、外交与战争面板');
{
    Game.startWith('GER');
    Game.selectProvince(null);
    UI.refreshAll();

    // 解锁并备足装备，覆盖空态 → 有态的渲染分支
    const c = Game.countryById('GER');
    c.unlockedAir = ['fighter', 'strategic'];
    c.unlockedShips = ['destroyer'];
    c.equipment.fighter = 100;
    c.equipment.bomber = 100;
    c.equipment.destroyer = 30;
    c.resources.supplies = 200;

    // 空军：部署 → 面板渲染 → 移动 → 解散
    const airBefore = Game.allAirForces().length;
    assert(Game.command({ t: 'deployAirForce', country: 'GER', province: 1159312769, template: 'fighter', count: 1 }).ok, '部署空军群');
    assertEqual(Game.allAirForces().length, airBefore + 1, '空军群已创建');
    const group = Game.allAirForces()[Game.allAirForces().length - 1];
    assert(group.planes > 0, '空军群有飞机数量');
    UI.openPanel('army');
    assert(documentStub.getElementById('panelContent').innerHTML.includes('空军'), '部队面板渲染空军区块');
    UI.closePanel();

    assert(Game.command({ t: 'moveAirForce', airId: group.id, to: 1159314679 }).ok, '空军移动到相邻省份');
    assertEqual(Game.airForceById(group.id).provinceId, 1159314679, '空军位置已更新');
    assert(Game.command({ t: 'disbandAirForce', airId: group.id }).ok, '解散空军群');
    assertEqual(Game.allAirForces().some((g) => g.id === group.id), false, '解散后空军群移除');

    // 海军：只能在沿海省份部署
    const coastal = Game.provincesOf('GER').filter((p) => p.coastal);
    if (coastal.length > 0) {
        const fleetBefore = Game.allFleets().length;
        assert(Game.command({ t: 'deployFleet', country: 'GER', province: coastal[0].id, template: 'destroyer', count: 1 }).ok, '在沿海省份部署舰队');
        assertEqual(Game.allFleets().length, fleetBefore + 1, '舰队已创建');
        const fleet = Game.allFleets()[Game.allFleets().length - 1];
        UI.openPanel('army');
        assert(documentStub.getElementById('panelContent').innerHTML.includes('海军'), '部队面板渲染海军区块');
        UI.closePanel();
        assert(Game.command({ t: 'disbandFleet', fleetId: fleet.id }).ok, '解散舰队');
    } else {
        assert(true, '当前剧本德国无沿海省份，跳过舰队部署');
    }
    // 非沿海省份部署舰队必须被拒
    assert(!Game.command({ t: 'deployFleet', country: 'GER', province: 1159312769, template: 'destroyer', count: 1 }).ok, '非沿海省份部署舰队被拒');

    // 部队指令：进攻 / 待机
    const army = Game.armiesOf('GER')[0];
    assert(Game.command({ t: 'setArmyOrder', armyId: army.id, order: 'advance' }).ok, '下达进攻指令');
    assertEqual(Game.armyById(army.id).order, 'advance', '指令已写入部队');
    assert(!Game.command({ t: 'setArmyOrder', armyId: army.id, order: 'fly' }).ok, '非法指令被拒');
    assert(Game.command({ t: 'setArmyOrder', armyId: army.id, order: 'hold' }).ok, '取消指令');

    // 外交：宣战 → 战争面板 → 战争目标 → 阵营邀请 → 租借
    assert(Game.command({ t: 'declareWar', from: 'GER', to: 'POL', justification: '测试' }).ok, '宣战');
    UI.openPanel('war');
    const warHtml = documentStub.getElementById('panelContent').innerHTML;
    assert(warHtml.includes('进行中的战争'), '战争面板渲染战争列表');
    assert(warHtml.includes('我方军事力量'), '战争面板渲染军事力量');
    UI.closePanel();

    const war = Game.state.wars.find((w) => w.status !== 'ended' && (w.a === 'GER' || w.b === 'GER'));
    assert(war, '战争记录存在');
    assert(Game.command({ t: 'addWarGoal', from: 'GER', to: 'POL', goal: { type: 'annexState', state: 102 } }).ok, '添加吞并州的战争目标');
    assert(Game.command({ t: 'addWarGoal', from: 'GER', to: 'POL', goal: { type: 'resources', resource: 'steel', amount: 50 } }).ok, '添加资源战争目标');
    assertEqual(war.goals.length, 2, '战争目标已记录');
    assert(!Game.command({ t: 'addWarGoal', from: 'GER', to: 'POL', goal: { type: 'annexState', state: 102 } }).ok, '重复目标被拒');

    // 阵营：德国是轴心国领袖，可邀请未加入阵营的国家
    const candidates = Object.keys(Game.state.countries)
        .filter((t) => t !== 'GER' && !Game.factionOf(t) && t !== 'POL' && t !== 'FRA');
    if (candidates.length > 0) {
        const target = candidates[0];
        assert(Game.command({ t: 'inviteFaction', from: 'GER', faction: 'axis', to: target }).ok, '阵营领袖发出邀请');
        const invite = Game.factionInvites().find((i) => i.to === target);
        assert(invite, '邀请已记录');
        assert(Game.command({ t: 'acceptFactionInvite', country: target, inviteId: invite.id }).ok, '受邀国接受邀请');
        assertEqual(Game.factionOf(target), 'axis', '受邀国已加入阵营');
        assert(Game.command({ t: 'leaveFaction', country: target }).ok, '退出阵营');
        assertEqual(Game.factionOf(target), null, '退出后无阵营');
    }
    assert(!Game.command({ t: 'inviteFaction', from: 'POL', faction: 'axis', to: candidates[0] || 'XXX' }).ok, '非领袖无法发出邀请');

    // 租借：同阵营或高关系国家
    const leaseTarget = Object.keys(Game.state.countries)
        .find((t) => t !== 'GER' && Game.factionOf(t) === Game.factionOf('GER'));
    if (leaseTarget) {
        assert(Game.command({ t: 'lendLease', country: 'GER', to: leaseTarget, amount: 10, resource: 'supplies' }).ok, '向阵营盟友租借补给');
        assert((Game.lendLeaseOf('GER')[leaseTarget]?.amount || 0) >= 10, '租借额度已记录');
    }
    assert(!Game.command({ t: 'lendLease', country: 'GER', to: 'POL', amount: 10, resource: 'supplies' }).ok, '对交战国租借被拒');

    // 和平会议：提出 → 接受
    assert(Game.command({ t: 'proposePeace', from: 'GER', to: 'POL', warId: war.id, terms: [{ type: 'ceasefire' }] }).ok, '提出和平条件');
    const offer = Game.peaceOffers().find((o) => o.warId === war.id);
    assert(offer, '和平提议已记录');
    assert(Game.command({ t: 'acceptPeace', country: 'POL', offerId: offer.id }).ok, '败方接受和平条件');
    assertEqual(Game.peaceOffers().some((o) => o.id === offer.id), false, '接受后提议移除');
    assertEqual(Game.state.wars.find((w) => w.id === war.id).status, 'ended', '接受后战争结束');

    // 通知中心：筛选切换不抛错
    UI._noticeFilter = 'war';
    UI.openPanel('notices');
    assert(documentStub.getElementById('panelContent').innerHTML.includes('播报'), '通知中心渲染播报列表');
    UI.closePanel();
    UI._noticeFilter = 'all';

    // 生产：暂停产线与取消建造
    assert(Game.command({ t: 'allocateFactory', country: 'GER', line: { equipment: 'infantry_weapon', factories: 1 } }).ok, '分配生产线');
    assertEqual(Game.countryById('GER').production.length, 1, '产线已建立');
    assert(Game.command({ t: 'toggleProduction', country: 'GER', index: 0, disabled: true }).ok, '暂停产线');
    assertEqual(Game.countryById('GER').production[0].disabled, true, '产线已暂停');
    assert(Game.command({ t: 'startConstruction', country: 'GER', kind: 'civs', state: 101 }).ok, '开始建造');
    assertEqual(Game.countryById('GER').construction.length, 1, '建造项目已入队');
    assert(Game.command({ t: 'cancelConstruction', country: 'GER', index: 0 }).ok, '取消建造');
    assertEqual(Game.countryById('GER').construction.length, 0, '建造项目已移除');
}

// ============================================================
section('6. 国家选择：区域筛选与搜索');
{
    // renderCountryList 需要 campaign.scenario；用已加载的 Game.campaign
    App.renderCountryList(Game.campaign);
    const filters = els.countryFilters;
    const list = els.countryList;
    assertEqual(filters.children.length, 7, '区域筛选标签 7 个（全部 + 6 大洲）');
    assertEqual(list.children.length, 250, '默认「全部」展示 250 个国家');

    const countRegion = (region) =>
        Object.values(Game.campaign.scenario.countries).filter((c) => c.region === region).length;

    // 切到欧洲
    App._countryRegion = 'europe';
    App.renderCountryCards();
    assertEqual(list.children.length, countRegion('europe'), `欧洲区域筛选出 ${countRegion('europe')} 国`);

    // 切到南美洲
    App._countryRegion = 'south_america';
    App.renderCountryCards();
    assertEqual(list.children.length, countRegion('south_america'), `南美洲筛选出 ${countRegion('south_america')} 国`);

    // 搜索：按名称子串
    App._countryRegion = 'all';
    App._countrySearch = '德';
    App.renderCountryCards();
    const htmls = list.children.map((c) => c.innerHTML);
    assert(htmls.some((h) => h.includes('德国')), '搜索「德」命中德国');

    // 无匹配时显示空态
    App._countrySearch = 'zzzz不存在的国家';
    App.renderCountryCards();
    assert(list.innerHTML.includes('没有匹配'), '无匹配时显示空态提示');
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
