/* ============================================================
 * 战役核心 · 世界状态模型（state.js）
 * 全部为普通对象 + 数值/短字符串 id：可结构化克隆、可 diff、可增量存档。
 * 不含几何（渲染层从 TopoJSON 取形状）、不含 DOM、不含函数。
 * ============================================================ */

import { Rng } from './rng.js';
import { toFP } from './determinism.js';

const DEFAULT_COUNTRY = {
    name: '',
    ideology: 'neutral',
    rulingParty: '',
    leader: '',
    capital: null,
    manpower: 0,
    politicalPower: 0,
    stability: toFP(0.5),
    warSupport: toFP(0.5),
    legitimacy: toFP(0.5),
    resources: {},
    civs: 0,
    mils: 0,
    docks: 0,
    buildings: {},
    occupied: {},
    focusTree: null,
    activeFocus: null,
    researchSlots: 0,
    research: {},
    relations: {},
    faction: null,
    garrison: {},
    flags: {},
    construction: [],
    production: [],
    researchProgress: {},
};

function createCountry(tag, def) {
    const c = { tag, ...DEFAULT_COUNTRY, ...def };
    // 定点数字段强制转换，保证存档内为整数
    c.stability = toFP(c.stability);
    c.warSupport = toFP(c.warSupport);
    c.legitimacy = toFP(c.legitimacy);
    // 可变子对象重置为独立副本，避免引用共享
    c.resources = { ...(def.resources || {}) };
    c.buildings = { ...(def.buildings || {}) };
    c.occupied = { ...(def.occupied || {}) };
    c.relations = { ...(def.relations || {}) };
    c.garrison = { ...(def.garrison || {}) };
    c.flags = { ...(def.flags || {}) };
    c.research = { ...(def.research || {}) };
    c.researchProgress = {};
    c.construction = [];
    c.production = [];
    c.activeFocus = null;
    return c;
}

/**
 * 由剧本构建初始 WorldState。
 * @param {object} opts
 * @param {object} opts.scenario 已通过校验的剧本对象
 * @param {number} [opts.seed]
 * @param {Rng} [opts.rng] 已初始化的 PRNG（存档恢复时复用其状态）
 */
export function createWorldState({ scenario, seed = 0x1936, rng }) {
    const r = rng || new Rng(seed);

    const s = {
        tick: 0,
        startDate: scenario.startDate,
        seed,
        rngState: r.getState(),
        scenarioId: scenario.id,
        mapVersion: scenario.map,
        players: {},
        countries: {},
        provinces: {},
        states: {},
        wars: [],
        alliances: [],
        events: {
            enabled: [...(scenario.events?.enabled || [])],
            triggered: [],
            cooldown: {},
        },
        focuses: {},        // tag -> { done: [focusId] }
        decisions: {},      // tag -> { lastExecuted: {decisionId: tick}, count: {decisionId: n} }
        missions: {},       // tag -> [{ id, status, objective, reward, fail }]
        research: {},       // tag -> { researching: [{techId, progress}], completed: [] }
        log: [],            // 命令日志（确定性回放的关键）
        history: [],        // 新闻播报/复盘
        pending: [],        // 规则级联待处理队列
        victory: null,      // { winner, tick, conditions }
        nextWarId: 1,
        nextCmdSeq: 1,
    };

    // 国家
    for (const [tag, def] of Object.entries(scenario.countries || {})) {
        s.countries[tag] = createCountry(tag, def || {});
        s.focuses[tag] = { done: [] };
        s.decisions[tag] = { lastExecuted: {}, count: {} };
        s.research[tag] = { researching: [], completed: [] };
    }

    // 省份（逻辑格，不含几何）
    for (const p of scenario.provinces || []) {
        const owner = scenario.owners?.[String(p.id)] ?? null;
        s.provinces[p.id] = {
            id: p.id,
            terrain: p.terrain || 'plains',
            coastal: !!p.coastal,
            supply: p.supply ?? 0,
            infrastructure: p.infrastructure ?? 0,
            fortLevel: p.fortLevel ?? 0,
            damage: 0,
            controller: owner,
        };
    }

    // 州
    for (const st of scenario.states || []) {
        const capitalOwner = scenario.owners?.[String(st.capitalProvince)] ?? null;
        s.states[st.id] = {
            id: st.id,
            owner: st.owner ?? capitalOwner,
            core: st.core ?? null,
            provinces: [...(st.provinces || [])],
            population: st.population ?? 0,
            factories: st.factories ?? 0,
            isCapital: !!st.isCapital,
            victoryPoints: 0,
        };
    }
    recomputeVictoryPoints(s);

    // 阵营
    for (const a of scenario.alliances || []) {
        s.alliances.push({ id: a.id, name: a.name || a.id, members: [...(a.members || [])] });
    }

    // 剧本预设战争（标记态，无战斗结算）
    for (const w of scenario.wars || []) {
        s.wars.push({
            id: s.nextWarId++,
            a: w.a, b: w.b,
            startedAt: w.startedAt ?? 0,
            justification: w.justification || '',
            warScore: 0,
            status: 'active',
        });
        markAtWar(s, w.a, w.b);
    }

    // 玩家
    if (scenario.defaultPlayer) {
        s.players[scenario.defaultPlayer] = { tag: scenario.defaultPlayer, isHuman: true };
    }

    // 任务
    for (const m of scenario.missions || []) {
        (s.missions[m.scope] = s.missions[m.scope] || []).push({
            id: m.id,
            status: 'active',
            objective: m.objective,
            reward: m.reward || null,
            fail: m.fail || null,
        });
    }

    return s;
}

/** 标记两国进入战争状态（flags 供条件求值） */
export function markAtWar(s, a, b) {
    if (s.countries[a]) s.countries[a].flags.atWar = true;
    if (s.countries[b]) s.countries[b].flags.atWar = true;
}

export function clearAtWar(s, a, b) {
    if (s.countries[a]) s.countries[a].flags.atWar = false;
    if (s.countries[b]) s.countries[b].flags.atWar = false;
}

/**
 * 重算州的 victoryPoints：州内控制权与州归属一致的省份各计 1 VP。
 * 胜负判定与任务进度都读这里，保证口径统一。
 */
export function recomputeVictoryPoints(s) {
    for (const st of Object.values(s.states)) {
        let vp = 0;
        for (const pid of st.provinces) {
            const p = s.provinces[pid];
            if (p && p.controller === st.owner) vp += 1;
        }
        st.victoryPoints = vp;
    }
}
