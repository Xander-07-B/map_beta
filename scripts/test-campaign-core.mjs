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
    assertEqual(Object.keys(loaded.scenario.countries).length, 3, '3 个国家');
    assertEqual(loaded.scenario.provinces.length, 20, '20 个省份');
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
console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
} else {
    console.log('全部通过 ✓');
}
