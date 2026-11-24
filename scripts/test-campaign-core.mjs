/* ============================================================
 * 战役核心 · 确定性测试（scripts/test-campaign-core.mjs）
 * 运行：npm test（在项目根目录）
 * 覆盖：PRNG 确定性、时钟换算（1 tick = 30 真实秒 = 2 游戏日）、剧本加载校验、
 *       命令管道、国策/决议执行、宣战→吞并→胜负闭环、
 *       双跑一致（确定性）、快照+日志回放复现。
 * ============================================================ */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    Rng,
    Clock,
    TICK_GAME_DAYS,
    TICKS_PER_MONTH,
    MAX_SPEED,
    Campaign,
    loadScenario,
    validateScenario,
    validateFocusTree,
    applyCommand,
    canonicalStringify,
    deepMerge,
    settleEconomy,
    settleWar,
    isAdjacent,
    countryPower,
    terrainDefense,
    terrainMoveCost,
    battleWidth,
    settleArmies,
    resolveBattle,
    computeSupplyAccess,
    settleAirNavy,
    settleArmyOrders,
    nextStepTowardEnemy,
    planPath,
    airPowerByOwner,
    navalPowerByOwner,
    factionOf,
    factionMembers,
    factionLeader,
    areAtWar,
    warOpponents,
    termsFromGoals,
    applyPeaceTerms,
    diffState,
    applyPatch,
    buildIncrementalSave,
    resolveIncrementalSave,
    migrateSave,
    needsMigration,
    SAVE_VERSION,
} from '../js/core/index.js';

// ---------- 测试骨架 ----------
let passed = 0;
const failures = [];
function assert(cond, msg) {
    if (cond) { passed++; }
    else { failures.push(msg); console.error('  ✗ ' + msg); }
}
function assertEqual(a, b, msg) {
    assert(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}
function assertDeep(a, b, msg) {
    assert(canonicalStringify(a) === canonicalStringify(b), msg);
}
function section(name) { console.log('\n■ ' + name); }

// Node 环境的 fetchJson：从项目根目录读文件
const fetchJson = async (url) => JSON.parse(await readFile(path.join(process.cwd(), url), 'utf8'));

// ============================================================
section('1. PRNG 确定性（xoshiro256**）');
{
    const r1 = new Rng(12345);
    const r2 = new Rng(12345);
    const seq = (r, n) => Array.from({ length: n }, () => r.nextUint32());
    assertDeep(seq(r1, 200), seq(r2, 200), '同种子生成序列逐位一致');

    const r3 = new Rng(99999);
    r3.loadState(r1.getState());          // 从 r1 的当前状态恢复
    assertDeep(seq(r3, 100), seq(r1, 100), '存档状态恢复后序列继续一致');

    const r4 = new Rng(7);
    const r5 = new Rng(7);
    assertDeep(r4.shuffle([1, 2, 3, 4, 5, 6, 7, 8]), r5.shuffle([1, 2, 3, 4, 5, 6, 7, 8]), '洗牌确定性');
    assertEqual(r4.nextFloat() >= 0 && r4.nextFloat() < 1, true, 'nextFloat 落在 [0,1)');
}

// ============================================================
section('2. 逻辑时钟（1 tick = 1 游戏日）');
{
    const cl = new Clock({ startDate: '1936-01-01' });
    assertEqual(cl.date.toISOString(), '1936-01-01T00:00:00.000Z', 'tick 0 为开局日期');
    cl.tick = 1;
    assertEqual(cl.date.toISOString(), '1936-01-02T00:00:00.000Z', '1 tick = 1 游戏日');
    assertEqual(cl.gameDay, 1, 'gameDay = tick');
    cl.tick = TICKS_PER_MONTH;   // 30
    assertEqual(cl.date.toISOString(), '1936-01-31T00:00:00.000Z', '30 tick = 30 游戏日');
    assertEqual(cl.isMonthStart, true, '月界判定（30 游戏日）');

    // advance 用真实毫秒驱动（TICK_REAL_MS = 1000，1x 下 1 真实秒 = 1 tick）
    const cl2 = new Clock({ startDate: '1936-01-01' });
    cl2.setSpeed(1);
    cl2.advance(1000);   // 1 真实秒 = 1 tick
    assertEqual(cl2.tick, 1, 'advance 按 STEP（1s）折算 tick');
    cl2.advance(2000);   // 再 2 tick
    assertEqual(cl2.tick, 3, 'acc 累加跨帧折算');
    cl2.setSpeed(0);
    cl2.advance(600000);
    assertEqual(cl2.tick, 3, '速度 0 时不推进');

    // 倍速线性缩放
    const cl3 = new Clock({ startDate: '1936-01-01' });
    cl3.setSpeed(5);
    cl3.advance(1000);
    assertEqual(cl3.tick, 5, '5x 速度下 1 真实秒推进 5 tick');
    assertEqual(cl3.speed, 5, '速度上限为 MAX_SPEED');
}

// ============================================================
section('3. 剧本加载与校验');
{
    const loaded = await loadScenario('1936', { fetchJson });
    assertEqual(loaded.scenario.id, '1936', '1936 剧本加载成功');
    assertEqual(loaded.scenario.playable.length, 250, '全量 250 个国家均可玩（P1-6 全量剧本）');
    assertEqual(Object.keys(loaded.scenario.countries).length, 250, '全地图 250 个归属方');
    const seaProvs = loaded.scenario.provinces.filter((p) => p.terrain === 'ocean');
    assert(seaProvs.length > 0, `存在海域省份供海军行动（${seaProvs.length} 个）`);
    assertEqual(loaded.scenario.provinces.length, 4594 + seaProvs.length, '陆地省份 + 海域省份');
    assertEqual(Object.keys(loaded.scenario.owners).length, 4594, '所有陆地省份都有归属（海域无归属）');
    assertEqual(loaded.scenario.provinces.filter((p) => p.terrain !== 'ocean').length, 4594, '陆地省份仍为 4594 个');
    // 自动生成的国家也应有可运转的经济/军事底座（不再是空壳）
    const genTag = Object.keys(loaded.scenario.countries).find((t) => t !== 'GER' && t !== 'POL' && t !== 'FRA');
    const genDef = loaded.scenario.countries[genTag];
    assert(genDef.manpower > 0 && genDef.civs > 0, `生成国家 ${genTag} 有人力的工厂`);
    assert((genDef.unlockedTemplates || []).includes('infantry'), `生成国家 ${genTag} 解锁步兵模板`);
    assert(loaded.scenario.initialArmies.some((a) => a.country === genTag), `生成国家 ${genTag} 有初始部队`);
    assertEqual(Object.keys(loaded.focusTrees).length, 1, '国策树引用已解析');
    assertEqual(loaded.events['danzig_demand'] !== undefined, true, '事件引用已解析');
    assertEqual(loaded.decisions['war_bonds'] !== undefined, true, '决议引用已解析');

    // 派生剧本：1939 = 1936 + 补丁
    const d = await loadScenario('1939', { fetchJson });
    assertEqual(d.derivedFrom, '1936', '派生来源记录');
    assertEqual(d.scenario.startDate, '1939-09-01', '补丁覆盖起始日期');
    assertEqual(d.scenario.owners['1159314695'], 'GER', '补丁覆盖省份归属');
    assertEqual(d.scenario.states.find((s) => s.id === 102).owner, 'GER', '补丁覆盖州归属');
    assertEqual(d.scenario.wars.length, 1, '补丁注入预设战争');

    // 结构校验必须抓出具体 id
    const bad = JSON.parse(JSON.stringify(loaded.scenario));
    bad.owners['999'] = 'GER';
    const problems = validateScenario(bad);
    assert(problems.some((p) => p.includes('999')), '校验器报告不存在的省份 id');

    const cyclic = { id: 'x', nodes: { a: { prerequisites: ['b'] }, b: { prerequisites: ['a'] } } };
    assert(validateFocusTree(cyclic).some((p) => p.includes('环')), '国策树 DAG 环检测');

    // 深合并语义：数组整体替换
    const merged = deepMerge({ a: [1, 2], b: { x: 1 } }, { a: [9], b: { y: 2 } });
    assertDeep(merged, { a: [9], b: { x: 1, y: 2 } }, 'deepMerge 对象递归、数组替换');
}

// ============================================================
section('4. 命令管道：校验与日志');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;

    const r1 = applyCommand({ t: 'declareWar', from: 'GER', to: 'XXX' }, s, camp.ctx());
    assert(!r1.ok, '宣战目标国家不存在 → 拒绝');
    const r2 = applyCommand({ t: 'assignOwner', state: 999, to: 'GER' }, s, camp.ctx());
    assert(!r2.ok, '州不存在 → 拒绝');
    const r3 = applyCommand({ t: 'investPP', country: 'GER', target: 'stability', amount: 99999 }, s, camp.ctx());
    assert(!r3.ok, '政治点数不足 → 拒绝');
    assertEqual(s.log.length, 0, '被拒绝的命令不记日志');

    const r4 = applyCommand({ t: 'improveRelations', from: 'GER', to: 'POL', amount: 10 }, s, camp.ctx());
    assert(r4.ok, '合法命令通过');
    assertEqual(s.log.length, 1, '合法命令记入日志');
    assertEqual(s.log[0].seq, 1, '日志序号递增');
    assertEqual(s.countries.GER.relations.POL, -10, '关系修正生效（-20+10）');
}

// ============================================================
section('5. 国策链：选择 → 推进 → 完成 → 效果');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;

    // 前置/成本校验
    const bad = camp.command({ t: 'chooseFocus', country: 'GER', focusId: 'rearmament' });
    assert(!bad.ok, '前置国策未完成 → 拒绝');

    const ok = camp.command({ t: 'chooseFocus', country: 'GER', focusId: 'reconstruction' });
    assert(ok.ok, '选择 reconstruction 国策');
    assertEqual(s.countries.GER.politicalPower, 60, '国策成本扣除（80-20）');
    assertEqual(s.countries.GER.activeFocus.id, 'reconstruction', '国策进入进行态');

    camp.fastForward(Math.round(70 / TICK_GAME_DAYS));   // 70 天 = 35 tick
    assertEqual(s.countries.GER.activeFocus, null, '国策完成后清空进行态');
    assert(s.focuses.GER.done.includes('reconstruction'), '国策标记完成');
    assertEqual(s.countries.GER.civs, 22, '国策效果：civs +2');

    // 稳定度：经济系统会持续向基线漂移，用对照组分离国策的 +0.05 效果
    const ctrl = await Campaign.create('1936', { fetchJson });
    ctrl.newGame();
    ctrl.fastForward(35);
    const drifted = ctrl.state.countries.GER.stability;
    assert(s.countries.GER.stability > drifted, `国策效果：稳定度高于仅经济漂移的对照组（${s.countries.GER.stability} > ${drifted}）`);

    // 第二级国策（requires civs >= 5）
    assert(camp.command({ t: 'chooseFocus', country: 'GER', focusId: 'rearmament' }).ok, '前置满足后可选 rearmament');
    camp.fastForward(Math.round(70 / TICK_GAME_DAYS));
    assertEqual(s.countries.GER.mils, 16, '国策效果：mils +4');
    assertEqual(s.countries.GER.researchProgress['inf_weapons_1'], 100, '国策效果：科研加成');
}

// ============================================================
section('6. 决议：执行、成本、冷却');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;

    const r = camp.command({ t: 'executeDecision', country: 'GER', decisionId: 'war_bonds' });
    assert(r.ok, '执行战争债券决议');
    assertEqual(s.countries.GER.politicalPower, 60, '决议成本扣除（80-20）');
    assertEqual(s.countries.GER.manpower, 68200000, '决议效果：人力 +200000');
    assertEqual(s.countries.GER.stability, 420, '决议效果：稳定度 -0.03');
    assertEqual(s.decisions.GER.count['war_bonds'], 1, '决议执行次数记录');

    const r2 = camp.command({ t: 'executeDecision', country: 'GER', decisionId: 'war_bonds' });
    assert(!r2.ok, '冷却期内再次执行 → 拒绝');

    const r3 = camp.command({ t: 'executeDecision', country: 'POL', decisionId: 'war_bonds' });
    assert(r3.ok, '决议 scope=any 对其他国家同样可用');
}

// ============================================================
section('7. 闭环：宣战 → 吞并 → 任务完成 → 胜负判定');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;

    assert(camp.command({ t: 'declareWar', from: 'GER', to: 'POL', justification: '测试' }).ok, 'GER 对 POL 宣战');
    assertEqual(s.wars.length, 1, '战争标记建立');
    assertEqual(s.wars[0].status, 'active', '战争状态 active');
    assertEqual(s.countries.GER.flags.atWar, true, '交战方 flags.atWar');

    assert(camp.command({ t: 'assignOwner', state: 102, to: 'GER', reason: '吞并' }).ok, '吞并波兰州');
    assertEqual(s.states[102].owner, 'GER', '州归属变更');
    assertEqual(s.states[102].victoryPoints, 6, '州 VP 重算（6 省控制权一致）');

    const m = s.missions.GER.find((x) => x.id === 'annex_poland');
    assertEqual(m.status, 'completed', '任务 annex_poland 完成');
    assertEqual(s.countries.GER.politicalPower, 130, '任务奖励：PP +50（80-0+50）');
    assert(s.victory !== null, '胜负判定触发');
    assertEqual(s.victory.winner, 'GER', '胜利方为 GER');
    assert(s.history.some((h) => h.text.includes('胜负判定')), '胜负写入历史日志');

    // 事件选项 0：annex → 同样触发吞并闭环
    const camp2 = await Campaign.create('1936', { fetchJson });
    camp2.newGame();
    assert(camp2.command({ t: 'triggerEvent', eventId: 'danzig_demand', option: 0 }).ok, '触发事件选项 0');
    assertEqual(camp2.state.states[102].owner, 'GER', '事件效果展开为 assignOwner 命令');
    assertEqual(camp2.state.victory.winner, 'GER', '事件路径同样达成胜负');

    // 事件选项 1：declareWar
    const camp3 = await Campaign.create('1936', { fetchJson });
    camp3.newGame();
    assert(camp3.command({ t: 'triggerEvent', eventId: 'danzig_demand', option: 1 }).ok, '触发事件选项 1');
    assertEqual(camp3.state.wars.length, 1, '事件效果展开为 declareWar 命令');
    assertEqual(camp3.state.victory, null, '仅宣战不触发胜负');
}

// ============================================================
section('8. 确定性：同种子同命令序列 → 同结果');
{
    const cmds = [
        { t: 'declareWar', from: 'GER', to: 'POL' },
        { t: 'assignOwner', state: 102, to: 'GER' },
        { t: 'chooseFocus', country: 'GER', focusId: 'reconstruction' },
        { t: 'improveRelations', from: 'GER', to: 'FRA', amount: 5 },
        { t: 'executeDecision', country: 'GER', decisionId: 'war_bonds' },
    ];
    const run = async () => {
        const camp = await Campaign.create('1936', { fetchJson });
        camp.newGame();
        for (const c of cmds) camp.command(c);
        camp.fastForward(500);
        return camp;
    };
    const [a, b] = await Promise.all([run(), run()]);
    assertDeep(a.state, b.state, '两次独立运行状态逐位一致');
    assertEqual(a.state.log.length, b.state.log.length, '命令日志一致');
    assertEqual(canonicalStringify(a.state.rngState), canonicalStringify(b.state.rngState), 'RNG 状态一致');
}

// ============================================================
section('9. 回放：快照 + 命令日志 → 复现');
{
    const campA = await Campaign.create('1936', { fetchJson });
    campA.newGame();
    const snap0 = campA.save();                       // tick 0 快照
    campA.command({ t: 'declareWar', from: 'GER', to: 'POL' });
    campA.command({ t: 'assignOwner', state: 102, to: 'GER' });
    // 回放日志只取玩家/命令层产生的记录，不含快进期间自动生成的议和等命令
    const log = campA.state.log.slice();
    campA.fastForward(300);
    const finalState = canonicalStringify(campA.state);

    const campB = await Campaign.create('1936', { fetchJson });
    campB.newGame();
    const rr = campB.replay(snap0.snapshot, log);
    assert(rr.ok, '回放全部命令成功');
    campB.fastForward(300);   // 回放后推进相同 tick，验证时间轴复现
    assertDeep(campB.state, JSON.parse(finalState), '回放复现最终状态');
}

// ============================================================
section('10. 经济结算（资源 / 生产线 / 建造 / 科研 / 人力）');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;
    const ger = s.countries.GER;

    const steel0 = ger.resources.steel || 0;
    const mp0 = ger.manpower;

    assert(camp.command({ t: 'allocateFactory', country: 'GER', line: { equipment: 'infantry_weapon', factories: 1 } }).ok, '分配生产线');
    assert(camp.command({ t: 'startConstruction', country: 'GER', kind: 'civs', state: 101 }).ok, '开始建造民用工厂');
    assert(camp.command({ t: 'startResearch', country: 'GER', techId: 'inf_weapons_1' }).ok, '开始科研');

    camp.fastForward(130);   // 130 游戏日

    assert((ger.resources.steel || 0) > steel0, '资源随时间增长');
    assert((ger.equipment.infantry_weapon || 0) > 0, '生产线产出装备');
    assertEqual(ger.civs, 21, '建造完成：民用工厂 +1');
    assertEqual(ger.tech.inf_weapons_1, true, '科研完成并记录');
    assert(ger.manpower > mp0, '人力随时间增长');
    assert(ger.politicalPower <= 200, '政治点数不超过上限');
    assertEqual(s.research.GER.researching.length, 0, '科研完成后释放研究槽');
    assert(s.history.some((h) => h.text.includes('完成建造')), '建造写入历史播报');
    assert(s.history.some((h) => h.text.includes('完成科技')), '科研写入历史播报');
}

// ============================================================
section('11. 军事闭环（部署 → 移动 → 战斗 → 占领）');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;
    // 本段验证部署/战斗数值，先清空剧本初始部队，避免干扰兵力断言
    s.armies = [];
    // 渲染层注入真实邻接表；测试用剧本省份构造最小邻接
    camp.setMapIndex({
        neighbors: {
            '1159312769': [1159314695],
            '1159314695': [1159312769, 1159314679],
            '1159314679': [1159314695],
        },
    });

    assert(isAdjacent(camp.ctx(), 1159312769, 1159314695), '邻接判定：柏林 → 波兰省份');
    assert(!isAdjacent(camp.ctx(), 1159312769, 1159316799), '邻接判定：不相邻省份被拒');

    assert(camp.command({ t: 'declareWar', from: 'GER', to: 'POL' }).ok, '宣战');

    // 部署：扣人力与装备
    assert(camp.command({ t: 'deployArmy', country: 'GER', province: 1159312769, template: 'infantry', count: 2 }).ok, '部署两支步兵师');
    assertEqual(s.armies.length, 2, '两支部队就绪');
    assertEqual(s.countries.GER.manpower, 68000000 - 16, '部署扣除人力');
    assertEqual(s.countries.GER.equipment.infantry_weapon, 40 - 12, '部署扣除装备');

    // 移动到无敌军的相邻省份 → 直接占领
    const army = s.armies[0];
    assert(camp.command({ t: 'moveArmy', armyId: army.id, to: 1159314695 }).ok, '部队移动到相邻省份');
    assertEqual(s.provinces[1159314695].controller, 'GER', '移动后占领该省份');

    // 波兰部队进入同一省份 → 触发战斗
    assert(camp.command({ t: 'deployArmy', country: 'POL', province: 1159314679, template: 'infantry', count: 1 }).ok, '波兰部署部队');
    const polArmy = s.armies.find((a) => a.owner === 'POL');
    assert(polArmy, '波兰部队已就绪');
    assert(camp.command({ t: 'moveArmy', armyId: polArmy.id, to: 1159314695 }).ok, '波兰部队进入交战省份');

    camp.fastForward(15);

    assert(s.history.some((h) => h.text.includes('爆发战斗')), '同省多国部队触发战斗');
    assert(s.armies.some((a) => a.strength < 15), '战斗造成兵力损耗');
    assert(s.wars[0].scoreA > 0 || s.wars[0].scoreB > 0, '战斗计入战争分数');

    // 解散部队
    const remain = s.armies[0];
    assert(camp.command({ t: 'disbandArmy', armyId: remain.id }).ok, '解散部队');
    assertEqual(s.armies.some((a) => a.id === remain.id), false, '解散后部队移除');
}

// ============================================================
section('12. AI 决策与确定性（AI-only 压测 600 天）');
{
    const neighbors = {
        '1159312769': [1159314695],
        '1159314695': [1159312769, 1159316799],
        '1159316799': [1159314695],
    };
    const run = async () => {
        const camp = await Campaign.create('1936', { fetchJson });
        camp.newGame();
        camp.setMapIndex({ neighbors });
        camp.state.players = {};      // 全部国家由 AI 接管
        camp.setAI(true);
        camp.fastForward(600);        // 600 游戏日
        return camp;
    };
    const [a, b] = await Promise.all([run(), run()]);

    assertDeep(a.state, b.state, 'AI 两轮独立运行状态逐位一致');
    assert(a.state.log.length > 0, 'AI 产生了命令');
    assert(a.state.history.some((h) => h.text.includes('完成建造')), 'AI 会自主建造');
    assert(a.state.countries.GER.tech && Object.keys(a.state.countries.GER.tech).length > 0, 'AI 会自主科研');
    assert(a.state.wars.length > 0, 'AI 会主动宣战');

    // 压测：数值不出现异常
    for (const c of Object.values(a.state.countries)) {
        assert(Number.isFinite(c.manpower) && c.manpower >= 0, `${c.tag} 人力为有限非负数`);
        assert(Number.isFinite(c.politicalPower), `${c.tag} 政治点数有限`);
        assert(c.resources.steel === undefined || Number.isFinite(c.resources.steel), `${c.tag} 资源数值有限`);
    }
    assertEqual(a.state.armies.length, b.state.armies.length, 'AI 部队数量可复现');
}

// ============================================================
section('13. 军事深化：地形 / 战斗宽度 / 组织度 / 补给 / 寻路');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;
    const ctx = camp.ctx();

    // 地形防御 = 基础地形 + 部队模板地形加成 + 科技加成
    assertEqual(terrainDefense('mountain', 'infantry', ctx, s.countries.GER), 0.5, '山地地形防御 +0.5');
    assertEqual(terrainDefense('plains', 'infantry', ctx, s.countries.GER), 0, '平原无地形防御');
    assertEqual(terrainDefense('forest', 'mountain', ctx, s.countries.GER), 0.6, '山地师森林模板加成叠加（0.3+0.3）');
    assert(Math.abs(terrainDefense('forest', 'infantry', ctx, { bonuses: { terrain: { forest: 0.35 } } }) - 0.65) < 1e-9, '科技地形加成叠加');

    // 地形移动代价
    assertEqual(terrainMoveCost('mountain'), 2.2, '山地移动代价 2.2');
    assertEqual(terrainMoveCost('plains'), 1, '平原移动代价 1');
    assertEqual(terrainMoveCost('unknown'), 1, '未知地形退回 1');

    // 战斗宽度：基础 100 + 基建 ×5
    assertEqual(battleWidth({ infrastructure: 0 }), 100, '基础战斗宽度 100');
    assertEqual(battleWidth({ infrastructure: 4 }), 120, '基建提升战斗宽度');
    assertEqual(battleWidth(null), 100, '无省份时退回基准宽度');

    // 战斗宽度限制参战部队：超宽部队留作预备队，本轮不受损
    const battleState = {
        provinces: { 1: { id: 1, terrain: 'plains', controller: 'B', fortLevel: 0, infrastructure: 0 } },
        countries: {
            A: { tag: 'A', bonuses: { division: {}, misc: {} } },
            B: { tag: 'B', bonuses: { division: {}, misc: {} } },
        },
        armies: [], airForces: [], history: [],
    };
    for (let id = 1; id <= 2; id++) {
        battleState.armies.push({ id, owner: 'A', provinceId: 1, template: 'infantry', strength: 50, org: 1 });
    }
    for (let id = 11; id <= 20; id++) {
        battleState.armies.push({ id, owner: 'B', provinceId: 1, template: 'infantry', strength: 20, org: 1 });
    }
    const bctx = { divisions: camp.content.divisions, aircraft: camp.content.aircraft, rng: new Rng(1) };
    const res = resolveBattle(battleState, bctx, 1, battleState.provinces[1]);
    assertEqual(res.attacker, 'A', '兵力最强的一方作为进攻方');
    assert(res.killed > 0 || res.damage > 0, '战斗产生伤害');
    const fullB = battleState.armies.filter((a) => a.owner === 'B' && a.strength === 20);
    assertEqual(fullB.length, 2, '超出战斗宽度的 2 支预备队未受损');

    // 组织度自然恢复（有补给）
    const a = s.armies.find((x) => x.owner === 'GER');
    const pa = s.provinces[a.provinceId];
    pa.supply = 1; pa.controller = 'GER';
    a.org = 0.5;
    const recover = settleArmies(s, ctx);
    assert(a.org > 0.5, '有补给的部队组织度自然恢复');
    assert(recover.orgRecovered > 0, '组织度恢复计入汇总');

    // 补给切断：组织度与兵力持续下降（补给网里没有该省 → 系数 0）
    const b = s.armies.find((x) => x.owner === 'GER' && x.provinceId !== a.provinceId);
    const pb = s.provinces[b.provinceId];
    pb.supply = 0; pb.controller = 'GER';
    b.org = 0.9;
    const strBefore = b.strength;
    const cutCtx = { ...ctx, supply: new Map([[a.provinceId, 1]]) };
    const starve = settleArmies(s, cutCtx);
    assert(b.org < 0.9, '断补给的部队组织度下降');
    assert(b.strength < strBefore, '断补给的部队兵力流失');
    assert(starve.starved > 0, '断补给计入汇总');

    // 补给网络：从补给枢纽沿己方控制省份扩散，受损降低补给
    const supplyState = {
        provinces: {
            1: { id: 1, controller: 'A', supply: 0.8, damage: 0 },
            2: { id: 2, controller: 'A', supply: 0.2, damage: 0 },
            3: { id: 3, controller: 'B', supply: 0.8, damage: 0 },
        },
        armies: [{ owner: 'A', strength: 10, provinceId: 1 }],
        fleets: [], airForces: [], alliances: [],
    };
    const net = computeSupplyAccess(supplyState, { neighbors: { '1': [2, 3], '2': [1], '3': [1] } });
    assert(Math.abs(net.get(1) - 0.88) < 1e-9, '补给枢纽的补给系数 = 0.4 + 0.6×供给');
    assert(Math.abs(net.get(2) - 0.52) < 1e-9, '沿己方控制省份扩散可达');
    assertEqual(net.has(3), false, '敌方控制省份不在补给网内');

    supplyState.provinces[2].damage = 60;
    const damaged = computeSupplyAccess(supplyState, { neighbors: { '1': [2, 3], '2': [1], '3': [1] } });
    assert(Math.abs(damaged.get(2) - 0.208) < 1e-9, '省份受损按比例折损补给');

    const noHub = {
        provinces: { 1: { id: 1, controller: 'C', supply: 0.1, damage: 0 } },
        armies: [{ owner: 'C', strength: 10, provinceId: 1 }],
        fleets: [], airForces: [], alliances: [],
    };
    assertEqual(computeSupplyAccess(noHub, { neighbors: { '1': [] } }).size, 0, '没有补给枢纽的国家补给网为空');

    const allied = {
        provinces: {
            1: { id: 1, controller: 'A', supply: 0.8, damage: 0 },
            2: { id: 2, controller: 'B', supply: 0.2, damage: 0 },
        },
        armies: [{ owner: 'A', strength: 10, provinceId: 1 }, { owner: 'B', strength: 10, provinceId: 2 }],
        fleets: [], airForces: [], alliances: [{ id: 'x', members: ['A', 'B'] }],
    };
    const alliedNet = computeSupplyAccess(allied, { neighbors: { '1': [2], '2': [1] } });
    assert(alliedNet.has(2), '同阵营盟友共用补给网');

    // 自动寻路与部队指令
    camp.setMapIndex({ neighbors: { '1': [2], '2': [1, 3], '3': [2] } });
    s.provinces[1] = { id: 1, terrain: 'plains', controller: 'GER', supply: 0.5, damage: 0, infrastructure: 0, fortLevel: 0 };
    s.provinces[2] = { id: 2, terrain: 'hills', controller: 'GER', supply: 0.5, damage: 0, infrastructure: 0, fortLevel: 0 };
    s.provinces[3] = { id: 3, terrain: 'mountain', controller: 'POL', supply: 0.5, damage: 0, infrastructure: 0, fortLevel: 0 };
    s.armies.push({ id: 9001, owner: 'GER', provinceId: 1, template: 'infantry', strength: 15, org: 1, speed: 2, experience: 0, order: 'hold' });

    assertDeep(planPath(s, camp.ctx(), 1, 3, 'GER'), [1, 2, 3], '寻路沿己方省份推进，最后一步进入敌方');
    assertEqual(planPath(s, camp.ctx(), 1, 3, 'POL'), null, '穿越非己方省份的路径不存在');
    assertEqual(nextStepTowardEnemy(s, camp.ctx(), 1, 'GER'), 2, 'BFS 找到向敌方推进的下一格');
    assertEqual(nextStepTowardEnemy(s, camp.ctx(), 2, 'GER'), 3, '相邻敌方省份直接作为目标');

    const testArmy = s.armies.find((x) => x.id === 9001);
    assert(camp.command({ t: 'moveArmyTo', armyId: 9001, to: 3, steps: 5 }).ok, '自动寻路移动命令成功');
    assertEqual(testArmy.provinceId, 2, '推进到敌方边境的己方省份后停下');
    assert(Math.abs(testArmy.org - 0.945) < 1e-9, '移动消耗组织度：基础 0.05 + 丘陵 0.005 → 0.945');

    assert(!camp.command({ t: 'setArmyOrder', armyId: 9001, order: 'charge' }).ok, '非法部队指令被拒绝');
    assert(camp.command({ t: 'setArmyOrder', armyId: 9001, order: 'advance' }).ok, '设置进攻指令');
    const orders = settleArmyOrders(s, camp.ctx());
    assertEqual(testArmy.provinceId, 3, '进攻指令自动推进一格进入敌方');
    assertEqual(orders.advanced, 1, '进攻推进计入汇总');

    assert(camp.command({ t: 'setArmyOrder', armyId: 9001, order: 'retreat' }).ok, '设置撤退指令');
    const retreat = settleArmyOrders(s, camp.ctx());
    assertEqual(testArmy.provinceId, 2, '撤退指令退回己方补给省份');
    assertEqual(retreat.retreated, 1, '撤退计入汇总');
}

// ============================================================
section('14. 空军与海军：部署 / 移动 / 空战 / 海战 / 轰炸');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;

    // 剧本初始空军与舰队已存在
    const gerAir = s.airForces.find((g) => g.owner === 'GER');
    assert(!!gerAir, '剧本初始空军已就绪');
    assertEqual(gerAir.role, 'fighter', '战斗机群角色正确');
    assert(s.fleets.some((f) => f.owner === 'GER'), '剧本初始舰队已就绪');

    // 部署：20 架飞机消耗 20 件战斗机装备
    const eqBefore = s.countries.GER.equipment.fighter;
    const airCount = s.airForces.length;
    assert(camp.command({ t: 'deployAirForce', country: 'GER', province: gerAir.provinceId, template: 'fighter', count: 1 }).ok, '部署空军');
    assertEqual(s.countries.GER.equipment.fighter, eqBefore - 20, '部署空军按每架 1 件装备扣减');
    assertEqual(s.airForces.length, airCount + 1, '空军群 +1');
    assertEqual(s.airForces[s.airForces.length - 1].planes, 20, '一个编组 20 架飞机');

    // 空军战力与制空权统计
    assert(airPowerByOwner(s, camp.ctx(), gerAir.provinceId).get('GER') > 0, '制空权统计包含该省空军');

    // 移动（需要邻接表）
    const other = s.armies.find((x) => x.owner === 'GER' && x.provinceId !== gerAir.provinceId).provinceId;
    camp.setMapIndex({ neighbors: { [String(gerAir.provinceId)]: [other], [String(other)]: [gerAir.provinceId] } });
    assert(camp.command({ t: 'moveAirForce', airId: gerAir.id, to: other }).ok, '空军移动到相邻省份');
    assertEqual(s.airForces.find((g) => g.id === gerAir.id).provinceId, other, '空军位置已更新');

    // 解散
    const before = s.airForces.length;
    assert(camp.command({ t: 'disbandAirForce', airId: gerAir.id }).ok, '解散空军');
    assertEqual(s.airForces.length, before - 1, '解散后空军群移除');

    // 舰队：只能在己方沿海省份部署（3 艘/编组）
    const coastal = Object.values(s.provinces).find((p) => p.controller === 'GER' && p.coastal);
    const inland = Object.values(s.provinces).find((p) => p.controller === 'GER' && !p.coastal);
    assert(!!coastal && !!inland, '找到德国沿海与非沿海省份');
    const shipBefore = s.countries.GER.equipment.destroyer;
    assert(camp.command({ t: 'deployFleet', country: 'GER', province: coastal.id, template: 'destroyer', count: 1 }).ok, '沿海省份部署舰队');
    assertEqual(s.countries.GER.equipment.destroyer, shipBefore - 3, '一个驱逐舰编组消耗 3 件装备');
    assert(!camp.command({ t: 'deployFleet', country: 'GER', province: inland.id, template: 'destroyer', count: 1 }).ok, '非沿海省份拒绝部署舰队');
    assert(!camp.command({ t: 'deployFleet', country: 'GER', province: coastal.id, template: 'battleship', count: 1 }).ok, '未解锁舰种拒绝部署');

    // 海域省份：海军可在海面行动，陆军不可进入海域
    {
        const idxData = await fetchJson('data/index.json');
        camp.setMapIndex(idxData);
        const isSea = (id) => s.provinces[id] && (s.provinces[id].terrain === 'ocean' || s.provinces[id].terrain === 'sea');
        const coastalWithSea = Object.values(s.provinces).find((p) =>
            p.controller === 'GER' && p.coastal &&
            (idxData.neighbors[String(p.id)] || []).some(isSea));
        assert(!!coastalWithSea, '找到有海域邻接的沿海省份');
        const seaNb = (idxData.neighbors[String(coastalWithSea.id)] || []).find(isSea);

        // 舰队可从沿海移入海域
        assert(camp.command({ t: 'deployFleet', country: 'GER', province: coastalWithSea.id, template: 'destroyer', count: 1 }).ok, '沿海部署舰队（海域测试）');
        const fleet = s.fleets.filter((f) => f.owner === 'GER').pop();
        assert(camp.command({ t: 'moveFleet', fleetId: fleet.id, to: seaNb }).ok, '舰队移入海域');
        assertEqual(s.fleets.find((f) => f.id === fleet.id).provinceId, seaNb, '舰队位于海域省份');

        // 陆军不可进入海域
        assert(camp.command({ t: 'deployArmy', country: 'GER', province: coastalWithSea.id, template: 'infantry', count: 1 }).ok, '沿海部署陆军（海域测试）');
        const army = s.armies.filter((a) => a.owner === 'GER').pop();
        const r = camp.command({ t: 'moveArmy', armyId: army.id, to: seaNb });
        assert(!r.ok && /海域/.test(r.err || ''), '陆军被拒绝进入海域');

        // 海域为中立水域，舰队可直接在海域部署
        const seaProv = Object.values(s.provinces).find((p) => p.terrain === 'ocean');
        assert(camp.command({ t: 'deployFleet', country: 'GER', province: seaProv.id, template: 'destroyer', count: 1 }).ok, '海域直接部署舰队');
    }

    // 空战：劣势方损失更多飞机
    const airState = {
        tick: 0, startDate: '1936-01-01', history: [],
        provinces: { 1: { id: 1, controller: 'A', supply: 1, damage: 0, coastal: false } },
        countries: { A: { tag: 'A', bonuses: { misc: {} } }, B: { tag: 'B', bonuses: { misc: {} } } },
        airForces: [
            { id: 1, owner: 'A', provinceId: 1, template: 'fighter', planes: 20 },
            { id: 2, owner: 'B', provinceId: 1, template: 'fighter', planes: 10 },
        ],
        fleets: [],
    };
    const airSummary = settleAirNavy(airState, { aircraft: camp.content.aircraft, ships: camp.content.ships });
    assertEqual(airSummary.airBattles, 1, '同省多国空军触发空战');
    const lossA = 20 - airState.airForces[0].planes;
    const lossB = 10 - airState.airForces[1].planes;
    assert(lossA > 0 && lossB > 0, '空战双方都有损失');
    assert(lossB > lossA, '制空劣势方损失更多飞机');

    // 海战：劣势方损失更多舰船
    const navalState = {
        tick: 0, startDate: '1936-01-01', history: [],
        provinces: { 1: { id: 1, controller: 'A', supply: 1, damage: 0, coastal: true } },
        countries: { A: { tag: 'A', bonuses: { misc: {} } }, B: { tag: 'B', bonuses: { misc: {} } } },
        airForces: [],
        fleets: [
            { id: 1, owner: 'A', provinceId: 1, template: 'destroyer', ships: 30 },
            { id: 2, owner: 'B', provinceId: 1, template: 'destroyer', ships: 10 },
        ],
    };
    const navalSummary = settleAirNavy(navalState, { aircraft: camp.content.aircraft, ships: camp.content.ships });
    assertEqual(navalSummary.navalBattles, 1, '同省多国舰队触发海战');
    assert(navalState.fleets[1].ships < 10, '制海劣势方损失舰船');
    assert(navalState.fleets[0].ships > navalState.fleets[1].ships, '优势方保留更多舰船');

    // 战略轰炸：取得制空权后增加省份受损
    const bombState = {
        tick: 0, startDate: '1936-01-01', history: [],
        provinces: { 1: { id: 1, controller: 'B', supply: 0.5, damage: 0, coastal: false } },
        countries: { A: { tag: 'A', bonuses: { misc: {} } }, B: { tag: 'B', bonuses: { misc: {} } } },
        airForces: [{ id: 1, owner: 'A', provinceId: 1, template: 'strategic', planes: 120 }],
        fleets: [],
    };
    settleAirNavy(bombState, { aircraft: camp.content.aircraft, ships: camp.content.ships });
    assert(bombState.provinces[1].damage > 0, '战略轰炸造成省份受损');

    // 舰队炮击沿岸
    const shoreState = {
        tick: 0, startDate: '1936-01-01', history: [],
        provinces: { 1: { id: 1, controller: 'B', supply: 0.5, damage: 0, coastal: true } },
        countries: { A: { tag: 'A', bonuses: { misc: {} } }, B: { tag: 'B', bonuses: { misc: {} } } },
        airForces: [],
        fleets: [{ id: 1, owner: 'A', provinceId: 1, template: 'battleship', ships: 20 }],
    };
    settleAirNavy(shoreState, { aircraft: camp.content.aircraft, ships: camp.content.ships });
    assert(shoreState.provinces[1].damage > 0, '舰队炮击沿岸省份造成受损');

    // 受损自然修复
    const repairState = {
        tick: 0, startDate: '1936-01-01', history: [],
        provinces: { 1: { id: 1, controller: 'A', supply: 0.5, damage: 1, coastal: false } },
        countries: { A: { tag: 'A', bonuses: { misc: {} } } },
        airForces: [], fleets: [],
    };
    settleAirNavy(repairState, { aircraft: camp.content.aircraft, ships: camp.content.ships });
    assert(Math.abs(repairState.provinces[1].damage - 0.8) < 1e-9, '省份受损每 tick 修复 0.2');
}

// ============================================================
section('15. 外交深度：阵营 / 邀请 / 租借 / 战争目标 / 和平会议');
{
    const camp = await Campaign.create('1936', { fetchJson });
    camp.newGame();
    const s = camp.state;

    // 阵营查询
    assertEqual(factionOf(s, 'GER'), 'axis', '德国属于轴心阵营');
    assertEqual(factionLeader(s, 'axis'), 'GER', '首个成员为阵营领袖');
    assertDeep(factionMembers(s, 'GER'), ['GER', 'ITA'], '阵营成员列表');

    // 邀请 → 接受 → 退出
    assert(camp.command({ t: 'inviteFaction', from: 'GER', faction: 'axis', to: 'POL' }).ok, '阵营领袖发出邀请');
    assertEqual(s.factionInvites.length, 1, '邀请进入待处理队列');
    assert(!camp.command({ t: 'inviteFaction', from: 'ITA', faction: 'axis', to: 'FRA' }).ok, '非领袖不能发出邀请');
    assert(!camp.command({ t: 'inviteFaction', from: 'GER', faction: 'axis', to: 'POL' }).ok, '重复邀请被拒绝');

    const invite = s.factionInvites[0];
    assert(!camp.command({ t: 'acceptFactionInvite', country: 'FRA', inviteId: invite.id }).ok, '其他国家的邀请不能被代接');
    assert(camp.command({ t: 'acceptFactionInvite', country: 'POL', inviteId: invite.id }).ok, '受邀国接受邀请');
    assertEqual(factionOf(s, 'POL'), 'axis', '接受后加入阵营');
    assert(factionMembers(s, 'GER').includes('POL'), '成员列表包含新成员');
    assert(camp.command({ t: 'leaveFaction', country: 'POL' }).ok, '成员可以退出阵营');
    assertEqual(factionOf(s, 'POL'), null, '退出后阵营为空');
    assertEqual(factionMembers(s, 'GER').includes('POL'), false, '成员列表同步移除');

    // 租借：关系 ≥ 50 才可
    assert(!camp.command({ t: 'lendLease', country: 'GER', to: 'POL', amount: 10, resource: 'steel' }).ok, '关系过低拒绝租借');
    s.countries.GER.relations.POL = 60;
    const gerSteel = s.countries.GER.resources.steel;
    const polSteel = s.countries.POL.resources.steel;
    assert(camp.command({ t: 'lendLease', country: 'GER', to: 'POL', amount: 10, resource: 'steel' }).ok, '高关系国家可租借');
    assertEqual(s.countries.GER.resources.steel, gerSteel - 10, '租借方扣减资源');
    assertEqual(s.countries.POL.resources.steel, polSteel + 10, '受援方获得资源');
    assertEqual(s.lendLease.GER.POL.amount, 10, '租借额度记录');
    assert(!camp.command({ t: 'lendLease', country: 'GER', to: 'POL', amount: 5, resource: 'steel' }).ok, '冷却期内拒绝租借');

    // 宣战：阵营战争自动扩大
    assert(camp.command({ t: 'declareWar', from: 'GER', to: 'POL', justification: '测试' }).ok, '对波兰宣战');
    const war = s.wars.find((w) => w.a === 'GER' && w.b === 'POL');
    assert(!!war, '战争记录已创建');
    assertEqual(war.goals.length, 0, '新战争没有预设目标');
    assert(areAtWar(s, 'GER', 'POL'), '直接交战方进入战争状态');
    assert(areAtWar(s, 'ITA', 'POL'), '阵营成员自动卷入战争');
    assertDeep(warOpponents(s, 'ITA'), ['POL'], '阵营成员的直接对手方');
    assertEqual(areAtWar(s, 'GER', 'ITA'), false, '同阵营不互相交战');

    // 战争目标
    assert(camp.command({ t: 'addWarGoal', from: 'GER', to: 'POL', goal: { type: 'annexState', state: 102 } }).ok, '添加吞并州目标');
    assertEqual(war.goals.length, 1, '战争目标已记录');
    assert(!camp.command({ t: 'addWarGoal', from: 'GER', to: 'POL', goal: { type: 'annexState', state: 102 } }).ok, '重复目标被拒绝');
    assert(!camp.command({ t: 'addWarGoal', from: 'GER', to: 'POL', goal: { type: 'annexState', state: 999999 } }).ok, '不存在的州被拒绝');
    assertDeep(termsFromGoals(s, war, 'GER'), [{ type: 'ceasefire' }], '未控制的目标只生成停火条款');

    s.states[102].owner = 'GER';
    assertDeep(termsFromGoals(s, war, 'GER'), [{ type: 'annexState', state: 102 }], '已控制的目标转为吞并条款');
    const ctx = camp.ctx();
    applyPeaceTerms(s, ctx, [{ type: 'annexState', state: 102 }], 'POL', 'GER');
    assertEqual(s.states[102].owner, 'GER', '和平条款执行州归属变更');

    // 简化和平会议：提议 → 拒绝 → 再提议 → 接受
    assert(camp.command({ t: 'proposePeace', from: 'GER', to: 'POL', warId: war.id, terms: [{ type: 'ceasefire' }] }).ok, '提出和平条件');
    assertEqual(war.status, 'peacePending', '战争进入等待回应状态');
    assertEqual(s.peaceOffers.length, 1, '和平提议进入队列');
    assert(!camp.command({ t: 'proposePeace', from: 'GER', to: 'POL', warId: war.id, terms: [{ type: 'ceasefire' }] }).ok, '同一战争不能重复提议');
    const offer1 = s.peaceOffers[0];
    assert(!camp.command({ t: 'acceptPeace', country: 'GER', offerId: offer1.id }).ok, '非受方不能接受提议');
    assert(camp.command({ t: 'rejectPeace', country: 'POL', offerId: offer1.id }).ok, '受方拒绝和平');
    assertEqual(war.status, 'active', '拒绝后战争继续');
    assertEqual(s.peaceOffers.length, 0, '拒绝后提议移除');

    assert(camp.command({ t: 'proposePeace', from: 'GER', to: 'POL', warId: war.id, terms: [{ type: 'ceasefire' }] }).ok, '再次提出和平条件');
    const offer2 = s.peaceOffers[0];
    assert(camp.command({ t: 'acceptPeace', country: 'POL', offerId: offer2.id }).ok, '受方接受和平');
    assertEqual(war.status, 'ended', '接受后战争结束');
    assertEqual(areAtWar(s, 'GER', 'POL'), false, '和平后不再处于战争状态');
    assertEqual(s.countries.POL.flags.atWar, false, '战争标记清除');
}

// ============================================================
section('16. 存档体系：版本迁移与增量补丁');
{
    // v3 → v4 迁移补齐新字段
    const v3 = {
        meta: { version: 3, tick: 5, seed: 7 },
        snapshot: {
            tick: 5,
            armies: [{ id: 1, owner: 'A', provinceId: 1, template: 'infantry', strength: 10, org: 1, speed: 2 }],
            countries: { A: { tag: 'A', manpower: 100 } },
            wars: [{ id: 1, a: 'A', b: 'B', status: 'active' }],
            alliances: [{ id: 'x', members: ['A', 'B'] }],
            provinces: {}, states: {},
        },
        commands: [],
    };
    assertEqual(needsMigration(v3), true, 'v3 存档需要迁移');
    const v4 = migrateSave(v3);
    assertEqual(v4.meta.version, SAVE_VERSION, '迁移到当前版本');
    assertEqual(v3.meta.version, 3, '迁移不修改原入参');
    assertEqual(v3.snapshot.armies[0].order, undefined, '原快照未被写入默认值');
    assertEqual(v4.snapshot.armies[0].order, 'hold', '部队默认待机指令');
    assertDeep(v4.snapshot.airForces, [], '补齐空军数组');
    assertDeep(v4.snapshot.fleets, [], '补齐舰队数组');
    assertDeep(v4.snapshot.factionInvites, [], '补齐阵营邀请数组');
    assertDeep(v4.snapshot.peaceOffers, [], '补齐和平提议数组');
    assertDeep(v4.snapshot.lendLease, {}, '补齐租借表');
    assertEqual(v4.snapshot.alliances[0].leader, 'A', '阵营补齐领袖');
    assertDeep(v4.snapshot.alliances[0].invites, [], '阵营补齐邀请列表');
    assertDeep(v4.snapshot.wars[0].goals, [], '战争补齐目标数组');
    assertDeep(v4.snapshot.wars[0].alliesA, ['A'], '战争补齐阵营列表');
    assertDeep(v4.snapshot.countries.A.unlockedAir, [], '国家补齐空军解锁');
    assertDeep(v4.snapshot.countries.A.unlockedShips, [], '国家补齐海军解锁');
    assertDeep(v4.snapshot.countries.A.bonuses.terrain, {}, '国家补齐地形加成');
    assertEqual(v4.snapshot.nextAirId, 1, '补齐实体 id 计数器');
    assertEqual(v4.snapshot.controllerVersion, 1, '补齐控制权版本号');
    assertEqual(needsMigration(v4), false, '当前版本无需迁移');

    // v1（更早的包装）一路升级到 v4
    const v1 = { meta: { version: 1 }, state: { tick: 0, armies: [] }, log: [{ t: 'declareWar' }] };
    const upgraded = migrateSave(v1);
    assert(!!upgraded.snapshot && upgraded.state === undefined, 'v1 的 state 迁移为 snapshot');
    assertDeep(upgraded.commands, [{ t: 'declareWar' }], 'v1 的 log 迁移为 commands');
    assertEqual(upgraded.meta.version, SAVE_VERSION, 'v1 升级到当前版本');

    // 路径式差异 → 补丁 → 还原
    const base = { a: 1, b: { c: 2, d: [1, 2, 3] }, e: 'x' };
    const next = { a: 1, b: { c: 3, d: [1, 2] }, f: true };
    const patch = diffState(base, next);
    assertEqual(patch['b.c'], 3, '嵌套字段差异');
    assertEqual(patch['e'].__delete, true, '删除字段写作 __delete');
    assertDeep(patch['b.d'], [1, 2], '数组整体替换');
    assertEqual(patch.f, true, '新增字段');
    assertEqual(patch.a, undefined, '未变化字段不进补丁');
    assertDeep(applyPatch(base, patch), next, '补丁还原出目标状态');
    assertDeep(base, { a: 1, b: { c: 2, d: [1, 2, 3] }, e: 'x' }, '还原不修改基线');

    // 增量存档：小改动 → 增量；补丁过大/过久 → 推进基线
    const meta = { version: SAVE_VERSION, date: '1936-01-02', seed: 7 };
    const baseSnapshot = { tick: 0, countries: { A: { manpower: 100 } }, armies: [] };
    const state = { tick: 10, countries: { A: { manpower: 110 } }, armies: [] };
    const inc = buildIncrementalSave({ meta, baseSnapshot, baseCommands: [], state, commands: [{ t: 'x' }] });
    assertEqual(inc.meta.incremental, true, '小改动生成增量存档');
    assertEqual(inc.meta.deltaTicks, 10, '记录相对基线的 tick 差');
    assertEqual(inc.patch['countries.A.manpower'], 110, '增量补丁只含变化字段');
    const resolved = resolveIncrementalSave(inc);
    assertDeep(resolved.snapshot, state, '增量存档还原完整状态');

    const promoted = buildIncrementalSave({
        meta, baseSnapshot, baseCommands: [], state: { ...state, tick: 200 }, commands: [],
    });
    assertEqual(promoted.meta.incremental, false, '超过基线推进周期后转为新基线');
    assertEqual(promoted.meta.baseTick, 200, '新基线记录当前 tick');
    assertDeep(promoted.patch, {}, '推进基线后补丁为空');
    assertDeep(resolveIncrementalSave(promoted).snapshot, { ...state, tick: 200 }, '新基线还原状态');

    const full = resolveIncrementalSave({ snapshot: { tick: 1 }, commands: [] });
    assertDeep(full.snapshot, { tick: 1 }, '全量存档原样返回');
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
