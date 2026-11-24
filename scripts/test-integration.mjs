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
vm.runInContext(readFileSync('js/render/data.js', 'utf8'), ctx, { filename: 'data.js' });
vm.runInContext(readFileSync('js/render/game.js', 'utf8'), ctx, { filename: 'game.js' });
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
    assertEqual(Game.campaign.scenario.playable.length, 250, '全量 250 个国家均可玩');
    assertEqual(Object.keys(Game.state.countries).length, 250, '250 个国家/归属方就绪');
    const landProvs = Object.keys(Game.state.provinces).filter((id) => Game.state.provinces[id].terrain !== 'ocean');
    assertEqual(landProvs.length, 4594, '4,594 个陆地省份就绪');
    assert(Object.keys(Game.state.provinces).length > 4594, '含海域省份供海军行动');
    assertEqual(Game.armiesOf('GER').length, 7, '德国初始部队已转为可指挥实体');
    assertEqual(Game.armiesOf('POL').length, 5, '波兰初始部队已转为可指挥实体');
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

    const berlinArmies = Game.armiesIn(1159312769);
    assert(berlinArmies.length > 0 && berlinArmies.every(a => a.owner === 'GER'), '柏林初始部队是可指挥实体');
    assertEqual(Game.garrisons().some(x => x.owner === 'GER' && x.provinceId === 1159312769), false, '驻军不再作为独立标记重复存在');
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
section('7. 经济与军事闭环（经 Game 门面）');
{
    // 邻接表：真实环境由 MapView.loadData 注入，这里手动注入
    Game.campaign.setMapIndex({
        neighbors: {
            '1159312769': [1159314695, 1159314679],
            '1159314695': [1159312769],
            '1159314679': [1159312769],
        },
    });

    const steel0 = Game.countryById('GER').resources.steel;

    // 经济：产线 / 建造 / 科研
    assert(Game.command({ t: 'allocateFactory', country: 'GER', line: { equipment: 'infantry_weapon', factories: 1 } }).ok, '经门面分配生产线');
    assert(Game.command({ t: 'startConstruction', country: 'GER', kind: 'civs', state: 101 }).ok, '经门面开始建造');
    assert(Game.command({ t: 'startResearch', country: 'GER', techId: 'inf_weapons_1' }).ok, '经门面开始科研');

    Game.campaign.fastForward(130);

    assert(Game.countryById('GER').resources.steel > steel0, '经济结算：资源随时间增长');
    assert(Game.countryById('GER').equipment.infantry_weapon > 0, '经济结算：生产线产出装备');
    assertEqual(Game.countryById('GER').civs, 21, '经济结算：建造完成 +1 民用工厂');
    assertEqual(Game.countryById('GER').tech.inf_weapons_1, true, '经济结算：科研完成');
    assert(Game.lastEconomy !== null, '门面暴露最近一次经济结算');

    // 军事：部署 → 移动 → 占领
    const armiesBefore = Game.allArmies().length;
    assert(Game.command({ t: 'deployArmy', country: 'GER', province: 1159312769, template: 'infantry', count: 1 }).ok, '经门面部署部队');
    assertEqual(Game.allArmies().length, armiesBefore + 1, '部队已创建');
    const army = Game.allArmies()[Game.allArmies().length - 1];
    // 1159314679 已在第 3 节随州归属转入 GER，且没有波兰初始部队驻扎
    assert(Game.command({ t: 'moveArmy', armyId: army.id, to: 1159314679 }).ok, '经门面移动部队');
    assertEqual(Game.ownerOf(1159314679), 'GER', '移动后控制该省份');

    // 生产队列：追加 / 调整 / 取消（全部走命令管道）
    assertEqual(Game.countryById('GER').production.length, 1, '产线为追加而非覆盖');
    assert(Game.command({ t: 'adjustProduction', country: 'GER', index: 0, factories: 2 }).ok, '调整产线工厂数');
    assertEqual(Game.countryById('GER').production[0].factories, 2, '产线工厂数已更新');
    assert(Game.command({ t: 'cancelProduction', country: 'GER', index: 0 }).ok, '取消产线');
    assertEqual(Game.countryById('GER').production.length, 0, '产线已移除');

    // 按钮禁用态与命令校验同源
    const badDeploy = Game.canCommand({ t: 'deployArmy', country: 'GER', province: 1159312769, template: 'armor', count: 1 });
    assert(!badDeploy.ok, '未解锁的部队模板 → 禁用');
    const badMove = Game.canCommand({ t: 'moveArmy', armyId: army.id, to: 1159316799 });
    assert(!badMove.ok, '移动到不相邻省份 → 禁用');
    const goodDeploy = Game.canCommand({ t: 'deployArmy', country: 'GER', province: 1159312769, template: 'infantry', count: 1 });
    assertEqual(goodDeploy, null, '合法部署命令 → 可执行');
}

// ============================================================
section('8. AI 接管与存档（含新增状态）');
{
    // AI 接管：所有国家交由 AI 决策
    Game.campaign.state.players = {};
    Game.setAI(true);
    assertEqual(Game.aiEnabled, true, 'AI 已开启');
    Game.campaign.fastForward(60);
    assert(Game.state.log.length > 0, 'AI 产生了命令');
    assert(Game.state.history.length > 0, 'AI 产生了历史记录');
    Game.setAI(false);
    assertEqual(Game.aiEnabled, false, 'AI 已关闭');

    // 存档需包含新增的军队 / 装备状态
    assert(Game.save(), '存档成功');
    const raw = JSON.parse(sandbox.localStorage.getItem('hoi4_campaign_save'));
    assert(Array.isArray(raw.snapshot.armies), '存档包含军队状态');
    assert(raw.snapshot.countries.GER.equipment !== undefined, '存档包含装备库存');
    assert(raw.snapshot.countries.GER.bonuses !== undefined, '存档包含科技加成');

    assert(Game.load(), '读档成功');
    assertEqual(Game.allArmies().length, raw.snapshot.armies.length, '读档恢复部队数量');
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
