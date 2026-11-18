/* ============================================================
 * 主程序集成测试（scripts/test-integration.mjs）
 * 在 Node 中用桩模拟浏览器环境（window/fetch/localStorage/rAF/MapView/UI），
 * 跑通 Game 门面 → Campaign → 命令 → 胜负 → 存档 的完整流程，
 * 验证主程序对接没有运行时 bug。
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

// ---------- 浏览器环境桩 ----------
const store = {};
const sandbox = {
    console,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    fetch: async (url) => {
        const raw = readFileSync(path.join(process.cwd(), url), 'utf8');
        return { ok: true, json: async () => JSON.parse(raw) };
    },
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
    },
    MapView: { invalidateFills: () => {}, requestDraw: () => {}, draw: () => {}, init: () => {} },
    UI: { showVictory: () => {}, showCampaignEvent: () => {}, refreshAll: () => {}, init: () => {} },
    window: null,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    Core,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
// 加载经典脚本（data.js 定义常量，game.js 定义门面）
vm.runInContext(readFileSync('js/data.js', 'utf8'), ctx, { filename: 'data.js' });
vm.runInContext(readFileSync('js/game.js', 'utf8'), ctx, { filename: 'game.js' });
const Game = sandbox.Game;

// ============================================================
section('1. 开局流程：加载剧本 → 选择国家 → 构建状态');
{
    await Game.prepareNewGame();
    assert(Game.campaign !== null, 'Campaign 实例已创建');
    assertEqual(Game.campaign.scenario.id, '1936', '剧本为 1936');

    Game.startWith('GER');
    assertEqual(Game.playerTag, 'GER', '玩家为 GER');
    assertEqual(Game.state.players.GER.isHuman, true, '玩家标记 isHuman');
    assertEqual(Object.keys(Game.state.countries).length, 3, '3 个国家就绪');
    assertEqual(Object.keys(Game.state.provinces).length, 20, '20 个省份就绪');
    assertEqual(Game.countryDisplayName('GER'), '德国', 'l10n 解析国家名');
    assertEqual(Game.countryDisplayName('POL'), '波兰', 'l10n 解析国家名');
}

// ============================================================
section('2. 省份视图：合并战役状态与地图元数据');
{
    // 注入地图索引（省份名称）
    Game.loadProvinceData({
        meta: {
            '1159312769': { name: '柏林', owner: 'DEU', bbox: [0, 0, 10, 10] },
            '1159314695': { name: '马佐夫舍省', owner: 'POL', bbox: [0, 0, 10, 10] },
        },
        neighbors: { '1159312769': [1159314695] },
    });
    const berlin = Game.provinceById(1159312769);
    assertEqual(berlin.name, '柏林', '省份名来自地图索引');
    assertEqual(berlin.controller, 'GER', '控制方来自战役状态');
    assertEqual(berlin.neighbors[0], 1159314695, '邻接来自地图索引');
    assertEqual(Game.ownerOf(1159312769), 'GER', 'ownerOf 读战役控制方');
    assertEqual(Game.ownerOf(999999), null, '非剧本省份 ownerOf 返回 null（地图回退）');

    const g = Game.garrisons();
    assertEqual(g.some(x => x.owner === 'GER' && x.provinceId === 1159312769), true, '驻军存在性可读');
}

// ============================================================
section('3. 命令与胜负闭环（经 Game 门面）');
{
    const r1 = Game.command({ t: 'declareWar', from: 'GER', to: 'POL' });
    assert(r1.ok, '经门面宣战成功');
    assertEqual(Game.state.wars.length, 1, '战争标记建立');
    assertEqual(Game.isWarFor('GER'), true, 'isWarFor 读 flags');
    assertEqual(Game.areAtWar('GER', 'POL'), true, 'areAtWar 读战争列表');

    const r2 = Game.command({ t: 'assignOwner', state: 102, to: 'GER' });
    assert(r2.ok, '经门面吞并成功');
    assertEqual(Game.state.states[102].owner, 'GER', '州归属变更');
    assertEqual(Game.state.states[102].victoryPoints, 6, 'VP 重算');

    const mission = Game.state.missions.GER.find(m => m.id === 'annex_poland');
    assertEqual(mission.status, 'completed', '任务完成');
    assert(Game.state.victory !== null, '胜负判定触发');
    assertEqual(Game.state.victory.winner, 'GER', '胜利方 GER');

    // 地图归属同步：波兰省份控制方已转移
    assertEqual(Game.ownerOf(1159314695), 'GER', '吞并后省份控制方同步');
}

// ============================================================
section('4. 按钮禁用态查询（canCommand 与 validate 同源）');
{
    // 已宣战，再次宣战应被拒
    const err = Game.canCommand({ t: 'declareWar', from: 'GER', to: 'POL' });
    assert(!err.ok, '重复宣战 → 禁用');
    // 政治点数不足的投资
    const err2 = Game.canCommand({ t: 'investPP', country: 'GER', target: 'stability', amount: 999999 });
    assert(!err2.ok, 'PP 不足 → 禁用');
    // 合法命令
    const ok = Game.canCommand({ t: 'improveRelations', from: 'GER', to: 'FRA', amount: 5 });
    assert(ok === null, '合法命令 → 可执行');
}

// ============================================================
section('5. 国策 / 决议可用性查询');
{
    const focuses = Game.availableFocuses('GER');
    assertEqual(focuses.length, 3, '国策树 3 个节点');
    const recon = focuses.find(f => f.id === 'reconstruction');
    assertEqual(recon.available, true, '重建国策可用');
    const rearm = focuses.find(f => f.id === 'rearmament');
    assertEqual(rearm.available, false, '重整军备前置未满足 → 不可用');

    const decisions = Game.availableDecisions('GER');
    assertEqual(decisions.length, 1, '1 个决议可用');
    assertEqual(decisions[0].id, 'war_bonds', '战争债券决议');
}

// ============================================================
section('6. 存档 / 读档（经 Game 门面 + localStorage）');
{
    const saved = Game.save();
    assert(saved, '存档写入 localStorage');
    assert(Game.hasSave(), 'hasSave 返回 true');

    // 新开局后读档恢复
    Game.startWith('POL');
    assertEqual(Game.playerTag, 'POL', '新开局为 POL');
    const loaded = Game.load();
    assert(loaded, '读档成功');
    assertEqual(Game.playerTag, 'GER', '读档恢复玩家为 GER');
    assertEqual(Game.state.states[102].owner, 'GER', '读档恢复州归属');
    assert(Game.state.victory !== null, '读档恢复胜负状态');
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
