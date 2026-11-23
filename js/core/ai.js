/* ============================================================
 * 战役核心 · AI 决策（ai.js）
 * 月度一轮，对每个非玩家国家做效用打分，全部决策经 opts.command
 * 走统一命令管道——不开后门直接改状态，因此结果同样确定、可回放。
 * 结构：经济（产线/建造）→ 科研 → 军事（部署/推进/宣战）。
 * ============================================================ */

import { orderedKeys } from './determinism.js';

/** 国家综合实力（用于宣战目标选择） */
export function countryPower(s, tag) {
    const c = s.countries[tag];
    if (!c) return 0;
    let p = (c.civs || 0) * 3 + (c.mils || 0) * 4 + (c.docks || 0) * 5;
    p += (c.manpower || 0) / 1e6;
    for (const a of s.armies || []) {
        if (a.owner === tag) p += a.strength * 0.5;
    }
    for (const g of s.airForces || []) {
        if (g.owner === tag) p += g.planes * 0.1;
    }
    for (const f of s.fleets || []) {
        if (f.owner === tag) p += f.ships * 0.3;
    }
    return p;
}

/** 国家控制的省份（仅剧本内省份，地图其余部分不参与模拟） */
function controlledProvinces(s, tag) {
    return Object.values(s.provinces).filter((p) => p.controller === tag);
}

/** 该国拥有的州（用于建造选址） */
function ownedState(s, tag) {
    return Object.values(s.states).find((st) => st.owner === tag) || null;
}

/** 该国军队 */
function armiesOf(s, tag) {
    return (s.armies || []).filter((a) => a.owner === tag);
}

/** 与该国接壤的国家集合（基于省份邻接表） */
function borderCountries(s, ctx, tag) {
    const out = new Set();
    const neighbors = ctx.neighbors;
    if (!neighbors) return out;
    const mine = new Set(controlledProvinces(s, tag).map((p) => String(p.id)));
    for (const pid of mine) {
        for (const nid of neighbors[pid] || []) {
            const np = s.provinces[nid];
            if (np?.controller && np.controller !== tag) out.add(np.controller);
        }
    }
    return out;
}

/** 该国需要优先生产的装备：优先满足现有部队模板，其次空军/海军，否则步兵武器 */
function neededEquipment(s, ctx, tag) {
    const armies = armiesOf(s, tag);
    if (armies.length) {
        const tpl = ctx.divisions[armies[0].template];
        const keys = Object.keys(tpl?.cost?.equipment || {});
        if (keys.length) return keys[0];
    }
    const c = s.countries[tag];
    const air = (c.unlockedAir || []).find((t) => ctx.aircraft?.[t]);
    if (air) {
        const keys = Object.keys(ctx.aircraft[air].cost.equipment || {});
        if (keys.length) return keys[0];
    }
    const ship = (c.unlockedShips || []).find((t) => ctx.ships?.[t]);
    if (ship) {
        const keys = Object.keys(ctx.ships[ship].cost.equipment || {});
        if (keys.length) return keys[0];
    }
    return 'infantry_weapon';
}

/** 科技是否可研究：前置全部完成、未完成、未在研究中 */
function researchableTechs(s, ctx, tag) {
    const c = s.countries[tag];
    const rs = s.research[tag];
    const done = c.tech || {};
    const busy = new Set(rs.researching.map((r) => r.techId));
    const out = [];
    for (const [id, tech] of Object.entries(ctx.techs || {})) {
        if (done[id] || busy.has(id)) continue;
        const prereqOk = (tech.requires || []).every((pre) => done[pre]);
        if (!prereqOk) continue;
        out.push({ id, tech });
    }
    // 陆军科技优先（早期最划算），其余按耗时升序
    const rank = (t) => (t.cat === 'army' ? 0 : t.cat === 'industry' ? 1 : 2);
    out.sort((a, b) => rank(a.tech) - rank(b.tech) || a.tech.time - b.tech.time);
    return out;
}

// ===================== 经济 =====================

function aiEconomy(s, ctx, tag, command) {
    const c = s.countries[tag];

    // 生产线：没有产线且有军用工厂时，补一条当前最需要的装备
    if ((c.production || []).length === 0 && (c.mils || 0) > 0) {
        const eq = neededEquipment(s, ctx, tag);
        if (ctx.equipment?.[eq]) {
            command({ t: 'allocateFactory', country: tag, line: { equipment: eq, factories: 1, priority: 1 } });
        }
    }

    // 建造：队列不满且有民用工厂时，补工厂或基建
    if ((c.construction || []).length < 2 && (c.civs || 0) > 0) {
        const st = ownedState(s, tag);
        if (!st) return;
        let kind = null;
        if ((c.civs || 0) < 8) kind = 'civs';
        else if ((c.mils || 0) < 8) kind = 'mils';
        else if ((c.docks || 0) < 4) kind = 'docks';
        else kind = 'infrastructure';
        command({ t: 'startConstruction', country: tag, kind, state: st.id });
    }
}

// ===================== 科研 =====================

function aiResearch(s, ctx, tag, command) {
    const c = s.countries[tag];
    const rs = s.research[tag];
    const free = (c.researchSlots || 0) - rs.researching.length;
    if (free <= 0) return;
    const candidates = researchableTechs(s, ctx, tag);
    for (const { id } of candidates.slice(0, free)) {
        command({ t: 'startResearch', country: tag, techId: id });
    }
}

// ===================== 军事 =====================

function aiMilitary(s, ctx, tag, command) {
    const c = s.countries[tag];
    const atWar = !!c.flags.atWar;
    const armies = armiesOf(s, tag);

    // 空中与海上力量：有条件就补建
    aiAirNavy(s, ctx, tag, command);

    if (atWar) {
        // 1) 作战部队一律下达进攻指令，由每 tick 的指令结算自动推进
        for (const army of armies) {
            if (army.order !== 'advance') {
                command({ t: 'setArmyOrder', armyId: army.id, order: 'advance' });
            }
        }

        // 2) 没有部队时尝试部署
        if (armies.length === 0) {
            const prov = controlledProvinces(s, tag)[0];
            if (prov) {
                const tpl = pickTemplate(s, ctx, tag);
                if (tpl) command({ t: 'deployArmy', country: tag, province: prov.id, template: tpl, count: 1 });
            }
        }
        return;
    }

    // 和平：解除进攻指令，部队待机
    for (const army of armies) {
        if (army.order !== 'hold') {
            command({ t: 'setArmyOrder', armyId: army.id, order: 'hold' });
        }
    }

    // 和平：评估是否对接壤的弱国动手
    const myPower = countryPower(s, tag);
    let best = null;
    for (const other of borderCountries(s, ctx, tag)) {
        if (other === tag) continue;
        if (s.countries[other]?.flags.surrendered) continue;
        const rel = c.relations?.[other] ?? 0;
        const theirPower = countryPower(s, other);
        if (rel > -10) continue;
        // 只打有把握的仗：自身军力至少 1.5 倍且对方不比自己强
        if (myPower < theirPower * 1.5) continue;
        if (!best || theirPower < best.power) best = { tag: other, power: theirPower };
    }
    if (best) {
        command({ t: 'declareWar', from: tag, to: best.tag, justification: 'AI 扩张' });
    }
}

/**
 * 空中与海上力量建设：已解锁且装备充足时补建一个群/舰队。
 * 空军部署在首个控制省份，舰队需要沿海省份。
 */
function aiAirNavy(s, ctx, tag, command) {
    const c = s.countries[tag];
    const provinces = controlledProvinces(s, tag);
    if (provinces.length === 0) return;

    const airGroups = (s.airForces || []).filter((g) => g.owner === tag).length;
    const airTpl = (c.unlockedAir || []).find((t) => ctx.aircraft?.[t]);
    if (airTpl && airGroups < 4) {
        const tpl = ctx.aircraft[airTpl];
        const affordable = Object.entries(tpl.cost.equipment || {}).every(
            ([eqId, need]) => (c.equipment?.[eqId] || 0) >= need * tpl.planes
        );
        if (affordable) {
            command({ t: 'deployAirForce', country: tag, province: provinces[0].id, template: airTpl, count: 1 });
        }
    }

    const coastal = provinces.find((p) => p.coastal);
    if (!coastal) return;
    const fleets = (s.fleets || []).filter((f) => f.owner === tag).length;
    const shipTpl = (c.unlockedShips || []).find((t) => ctx.ships?.[t]);
    if (shipTpl && fleets < 3) {
        const tpl = ctx.ships[shipTpl];
        const affordable = Object.entries(tpl.cost.equipment || {}).every(
            ([eqId, need]) => (c.equipment?.[eqId] || 0) >= need * tpl.ships
        );
        if (affordable) {
            command({ t: 'deployFleet', country: tag, province: coastal.id, template: shipTpl, count: 1 });
        }
    }
}

/** 选择一个可用的部队模板：已解锁且装备/人力能负担 */
function pickTemplate(s, ctx, tag) {
    const c = s.countries[tag];
    const unlocked = c.unlockedTemplates || [];
    const order = ['armor', 'mechanized', 'infantry', 'cavalry', 'mountain'];
    for (const tpl of order) {
        if (!unlocked.includes(tpl)) continue;
        const def = ctx.divisions?.[tpl];
        if (!def) continue;
        if ((c.manpower || 0) < def.cost.manpower) continue;
        const ok = Object.entries(def.cost.equipment || {}).every(
            ([eqId, need]) => (c.equipment?.[eqId] || 0) >= need
        );
        if (ok) return tpl;
    }
    return null;
}

// ===================== 入口 =====================

/**
 * 月度 AI 决策轮。
 * @param {object} s 世界状态
 * @param {object} ctx 命令上下文
 * @param {object} opts { isHuman(tag), command(cmd) }
 */
export function runAITick(s, ctx, opts) {
    const { isHuman, command } = opts;
    for (const tag of orderedKeys(s.countries)) {
        if (isHuman(tag)) continue;
        const c = s.countries[tag];
        if (!c || c.flags.surrendered) continue;
        // 单个国家决策异常不应中断整轮模拟
        try {
            aiEconomy(s, ctx, tag, command);
            aiResearch(s, ctx, tag, command);
            aiMilitary(s, ctx, tag, command);
        } catch (err) {
            console.warn('[ai] 国家决策异常:', tag, err);
        }
    }
}
