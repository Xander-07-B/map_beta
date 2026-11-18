/* ============================================================
 * 战役核心 · 确定性测试（scripts/test-campaign-core.mjs）
 * 运行：npm test（在项目根目录）
 * 覆盖：PRNG 确定性、时钟换算（1 tick = 5 分钟）、剧本加载校验、
 *       命令管道、国策/决议执行、宣战→吞并→胜负闭环、
 *       双跑一致（确定性）、快照+日志回放复现。
 * ============================================================ */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    Rng,
    Clock,
    TICKS_PER_DAY,
    Campaign,
    loadScenario,
    validateScenario,
    validateFocusTree,
    applyCommand,
    canonicalStringify,
    deepMerge,
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
section('2. 逻辑时钟（1 tick = 5 游戏分钟）');
{
    const cl = new Clock({ startDate: '1936-01-01' });
    assertEqual(cl.date.toISOString(), '1936-01-01T00:00:00.000Z', 'tick 0 为开局日期');
    cl.tick = 1;
    assertEqual(cl.date.toISOString(), '1936-01-01T00:05:00.000Z', '1 tick = 5 分钟');
    cl.tick = TICKS_PER_DAY;
    assertEqual(cl.date.toISOString(), '1936-01-02T00:00:00.000Z', '288 tick = 1 游戏日');
    assertEqual(cl.isDayStart, true, '日界判定');
    cl.tick = 31 * TICKS_PER_DAY;
    assertEqual(cl.isMonthStart, true, '月界判定（1936-02-01）');

    // advance 用注入的 now 驱动
    let now = 0;
    const cl2 = new Clock({ startDate: '1936-01-01', now: () => now });
    cl2.setSpeed(1);
    cl2.advance(250);   // 250ms / 100ms 每 tick = 2 tick
    assertEqual(cl2.tick, 2, 'advance 按 STEP 折算 tick');
    now = 1000;
    cl2.advance(1000);  // 再 10 tick
    assertEqual(cl2.tick, 12, 'acc 累加跨帧折算');
    cl2.setSpeed(0);
    cl2.advance(5000);
    assertEqual(cl2.tick, 12, '速度 0 时不推进');
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

    camp.fastForward(70 * TICKS_PER_DAY);   // 70 天 = 20160 tick
    assertEqual(s.countries.GER.activeFocus, null, '国策完成后清空进行态');
    assert(s.focuses.GER.done.includes('reconstruction'), '国策标记完成');
    assertEqual(s.countries.GER.civs, 22, '国策效果：civs +2');
    assertEqual(s.countries.GER.stability, 500, '国策效果：稳定度 +0.05（定点 500）');

    // 第二级国策（requires civs >= 5）
    assert(camp.command({ t: 'chooseFocus', country: 'GER', focusId: 'rearmament' }).ok, '前置满足后可选 rearmament');
    camp.fastForward(70 * TICKS_PER_DAY);
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
    campA.fastForward(300);
    const finalState = canonicalStringify(campA.state);
    const log = campA.state.log.slice();

    const campB = await Campaign.create('1936', { fetchJson });
    campB.newGame();
    const rr = campB.replay(snap0.snapshot, log);
    assert(rr.ok, '回放全部命令成功');
    campB.fastForward(300);   // 回放后推进相同 tick，验证时间轴复现
    assertDeep(campB.state, JSON.parse(finalState), '回放复现最终状态');
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
