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
    population: 0,
    politicalPower: 0,
    stability: toFP(0.5),
    warSupport: toFP(0.5),
    legitimacy: toFP(0.5),
    resources: {},
    equipment: {},              // 装备库存：equipmentId -> 数量
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
    tech: {},                   // 已完成科技：techId -> true
    bonuses: { division: {}, factory: {}, resource: {}, misc: {} },
    unlockedTemplates: [],
    unlockedEquipment: [],
    unlockedAir: [],          // 已解锁的飞机型号
    unlockedShips: [],        // 已解锁的舰种
    warScore: 0,
};

function createCountry(tag, def) {
    const c = { tag, ...DEFAULT_COUNTRY, ...def };
    // 定点数字段强制转换，保证存档内为整数
    c.stability = toFP(c.stability);
    c.warSupport = toFP(c.warSupport);
    c.legitimacy = toFP(c.legitimacy);
    // 可变子对象重置为独立副本，避免引用共享
    c.resources = { ...(def.resources || {}) };
    c.equipment = { ...(def.equipment || {}) };
    c.buildings = { ...(def.buildings || {}) };
    c.occupied = { ...(def.occupied || {}) };
    c.relations = { ...(def.relations || {}) };
    c.garrison = { ...(def.garrison || {}) };
    c.flags = { ...(def.flags || {}) };
    c.research = { ...(def.research || {}) };
    c.tech = { ...(def.tech || {}) };
    c.bonuses = {
        division: { ...(def.bonuses?.division || {}) },
        factory: { ...(def.bonuses?.factory || {}) },
        resource: { ...(def.bonuses?.resource || {}) },
        misc: { ...(def.bonuses?.misc || {}) },
        terrain: { ...(def.bonuses?.terrain || {}) },
    };
    c.unlockedTemplates = [...(def.unlockedTemplates || [])];
    c.unlockedEquipment = [...(def.unlockedEquipment || [])];
    c.unlockedAir = [...(def.unlockedAir || [])];
    c.unlockedShips = [...(def.unlockedShips || [])];
    c.researchProgress = {};
    c.construction = [];
    c.production = [];
    c.activeFocus = null;
    c.warScore = def.warScore ?? 0;
    return c;
}

/**
 * 由剧本构建初始 WorldState。
 * @param {object} opts
 * @param {object} opts.scenario 已通过校验的剧本对象
 * @param {number} [opts.seed]
 * @param {Rng} [opts.rng] 已初始化的 PRNG（存档恢复时复用其状态）
 * @param {object} [opts.divisions] 部队模板（用于把剧本初始部队解析为实体）
 * @param {object} [opts.aircraft] 飞机型号（用于把剧本初始空军解析为实体）
 * @param {object} [opts.ships] 舰种（用于把剧本初始舰队解析为实体）
 */
export function createWorldState({ scenario, seed = 0x1936, rng, divisions, aircraft, ships }) {
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
        armies: [],          // 军队实体：{ id, owner, provinceId, template, strength, org, speed, order }
        airForces: [],       // 空军群：{ id, owner, provinceId, template, planes, role }
        fleets: [],          // 舰队：{ id, owner, provinceId, template, ships, speed, order }
        alliances: [],
        factionInvites: [],    // 待处理的阵营邀请 { id, faction, from, to, tick }
        peaceOffers: [],       // 待处理的和平提议 { id, warId, from, to, terms, tick }
        lendLease: {},         // tag -> { 受援方 -> { amount, tick } }
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
        nextArmyId: 1,
        nextAirId: 1,
        nextFleetId: 1,
        nextInviteId: 1,
        nextOfferId: 1,
        nextCmdSeq: 1,
        controllerVersion: 1,   // 省份控制权变更计数（派生索引用，不参与玩法）
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

    // 剧本初始部队：地图上开局的单位必须从一开始就是可指挥的 army 实体，
    // 而不是仅用于呈现的 garrison 计数。按模板兵力拆成若干支便于逐格推进。
    for (const init of scenario.initialArmies || []) {
        const tpl = divisions?.[init.template];
        const c = s.countries[init.country];
        if (!tpl || !c || !s.provinces[init.province] || !Number.isFinite(init.count)) continue;
        const total = Math.max(1, Math.floor(init.count));
        const perArmy = Math.max(1, Math.floor(init.divisionsPerArmy ?? 6));
        let remaining = total;
        while (remaining > 0) {
            const n = Math.min(perArmy, remaining);
            remaining -= n;
            s.armies.push({
                id: s.nextArmyId++,
                owner: init.country,
                provinceId: init.province,
                template: init.template,
                strength: tpl.baseStrength * n,
                org: tpl.org ?? 1,
                speed: tpl.speed,
                experience: 0,
                order: 'hold',
            });
        }
        // 已转为可指挥部队的驻军不再重复绘制
        if (c.garrison && init.province in c.garrison) delete c.garrison[init.province];
    }

    // 剧本初始空军：与初始陆军一样，开局即存在且可直接指挥
    for (const init of scenario.initialAirForces || []) {
        const ac = aircraft?.[init.template];
        const country = s.countries[init.country];
        if (!ac || !country || !s.provinces[init.province] || !Number.isFinite(init.count)) continue;
        const groups = Math.max(1, Math.floor(init.count));
        s.airForces.push({
            id: s.nextAirId++,
            owner: init.country,
            provinceId: init.province,
            template: init.template,
            planes: Math.max(1, Math.floor(ac.planes * groups)),
            role: ac.role,
        });
    }

    // 剧本初始舰队
    for (const init of scenario.initialFleets || []) {
        const sh = ships?.[init.template];
        const country = s.countries[init.country];
        if (!sh || !country || !s.provinces[init.province] || !Number.isFinite(init.count)) continue;
        const groups = Math.max(1, Math.floor(init.count));
        s.fleets.push({
            id: s.nextFleetId++,
            owner: init.country,
            provinceId: init.province,
            template: init.template,
            ships: Math.max(1, Math.floor(sh.ships * groups)),
            speed: sh.speed ?? 3,
            order: 'hold',
        });
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

    // 阵营（首个成员为领袖）
    for (const a of scenario.alliances || []) {
        s.alliances.push({
            id: a.id,
            name: a.name || a.id,
            members: [...(a.members || [])],
            leader: (a.members || [])[0] || null,
            invites: [],
        });
    }

    // 剧本预设战争（标记态，无战斗结算）
    for (const w of scenario.wars || []) {
        s.wars.push({
            id: s.nextWarId++,
            a: w.a, b: w.b,
            startedAt: w.startedAt ?? 0,
            justification: w.justification || '',
            warScore: 0,
            scoreA: 0,
            scoreB: 0,
            goals: [],
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
