/* ============================================================
 * 战役核心 · 军事结算（war.js）
 * 军队只保留存在性与数量（指南界定），但需要一条可玩的最小闭环：
 *   部署（扣人力/装备）→ 移动（沿邻接表）→ 战斗（地形/组织度/科技修正）
 *   → 占领（setController）→ 州归属翻转 → 战争分数 → 议和 / 投降
 * 战斗结算在此完成；所有状态变更要么走命令管道，要么写入 pending 队列。
 * ============================================================ */

import { orderedKeys, orderedNumericIds } from './determinism.js';
import { applyCommand } from './commands.js';
import { recomputeVictoryPoints, clearAtWar } from './state.js';
import { divisionBonus, dateOf } from './economy.js';

/** 战争分数达到该值即自动议和 */
export const PEACE_SCORE = 100;

/** 地形防御修正（与 data.js 的 TERRAIN 一致，此处为结算用的纯数值） */
export const TERRAIN_DEFENSE = {
    plain: 0.0, forest: 0.3, mountain: 0.5, desert: 0.1,
    tundra: 0.2, hills: 0.15, ocean: 0.0, coast: 0.0,
};

export function terrainDefense(terrain, templateId, ctx) {
    const base = TERRAIN_DEFENSE[terrain] ?? 0;
    const templateBonus = ctx.divisions?.[templateId]?.terrainBonus?.[terrain] || 0;
    return base + templateBonus;
}

/** 军队战斗力：基础值 × 组织度系数 × 科技加成 × 随机扰动 */
function combatPower(s, army, ctx, stat) {
    const c = s.countries[army.owner];
    const tech = c ? divisionBonus(c, army.template, stat) : 0;
    const orgFactor = 0.4 + 0.6 * clamp01(army.org);
    const rnd = 0.85 + ctx.rng.nextFloat() * 0.3;
    return army.strength * orgFactor * (1 + tech) * rnd;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/**
 * 结算一个省份内的战斗。
 * 最强一方为进攻方，其余为防御方；进攻方对每个防御方分别计算伤害。
 * @returns {{killed: number, damage: number, attacker: string|null}}
 */
export function resolveBattle(s, ctx, provinceId, province) {
    const here = s.armies.filter((a) => a.provinceId === provinceId && a.strength > 0);
    const owners = new Set(here.map((a) => a.owner));
    if (here.length < 2 || owners.size < 2) return { killed: 0, damage: 0, attacker: null };

    // 进攻方 = 兵力最强的一支
    const sorted = here.slice().sort((a, b) => b.strength - a.strength);
    const attacker = sorted[0];
    const defenders = sorted.slice(1).filter((a) => a.owner !== attacker.owner);
    if (defenders.length === 0) return { killed: 0, damage: 0, attacker: null };

    const terrain = province?.terrain || 'plains';
    const terrainDef = TERRAIN_DEFENSE[terrain] ?? 0;
    const fortDef = (province?.fortLevel || 0) * 0.1;

    let killed = 0;
    let damage = 0;
    const destroyed = [];

    for (const def of defenders) {
        const atk = combatPower(s, attacker, ctx, 'attack');
        const defPow = combatPower(s, def, ctx, 'defense');
        const dmg = Math.max(1, atk * 0.55 - defPow * (0.25 + terrainDef + fortDef) * 0.6);
        def.strength -= dmg;
        def.org = clamp01(def.org - 0.01);
        damage += dmg;

        // 进攻方也付代价（组织度下降）
        attacker.strength -= Math.max(1, defPow * 0.12);
        attacker.org = clamp01(attacker.org - 0.005);

        if (def.strength <= 0) {
            killed++;
            destroyed.push(def.id);
        }
    }

    for (const id of destroyed) {
        const i = s.armies.findIndex((a) => a.id === id);
        if (i >= 0) s.armies.splice(i, 1);
    }
    if (attacker.strength <= 0) {
        const i = s.armies.findIndex((a) => a.id === attacker.id);
        if (i >= 0) s.armies.splice(i, 1);
        return { killed, damage, attacker: null };
    }

    return { killed, damage, attacker: attacker.owner };
}

/**
 * 占领判定：省份内只剩一国军队且控制方不是该国时，移交控制权。
 * 用 setController 走命令管道（只改省份控制方，不动州归属）。
 */
export function applyOccupation(s, ctx, provinceId, province) {
    const here = s.armies.filter((a) => a.provinceId === provinceId && a.strength > 0);
    if (here.length === 0) return null;
    const owners = new Set(here.map((a) => a.owner));
    if (owners.size !== 1) return null;
    const owner = [...owners][0];
    if (province.controller === owner) return null;

    const r = applyCommand({ t: 'setController', province: provinceId, to: owner }, s, ctx);
    if (r.ok) {
        s.history.push({ tick: s.tick, date: dateOf(s, s.tick), text: `${owner} 占领了省份 ${provinceId}` });
    }
    return r.ok ? owner : null;
}

/**
 * 州归属翻转：州内省份全部由同一国家控制且与州归属不一致时，整体移交。
 * 走 assignOwner（级联：任务重估 → 胜负判定）。
 */
export function checkStateOwnership(s, ctx) {
    for (const st of Object.values(s.states)) {
        if (st.provinces.length === 0) continue;
        const controllers = new Set();
        for (const pid of st.provinces) {
            const p = s.provinces[pid];
            if (!p) continue;
            if (p.controller) controllers.add(p.controller);
            if (controllers.size > 1) break;
        }
        if (controllers.size !== 1) continue;
        const only = [...controllers][0];
        if (st.owner === only) continue;
        s.pending.push({ kind: 'ownerChanged', payload: { state: st.id, to: only, reason: '军事占领' } });
    }
}

/** 战争分数与议和 / 投降判定 */
export function settleWarScore(s, ctx) {
    for (const war of s.wars) {
        if (war.status !== 'active') continue;
        if (war.scoreA === undefined) { war.scoreA = 0; war.scoreB = 0; }

        // 战争分数按双方控制省份数与军队规模估算，避免长时间无战斗时分数停滞
        const aProvs = controlledCount(s, war.a);
        const bProvs = controlledCount(s, war.b);
        war.scoreA += (bProvs === 0 ? 2 : 0) + aProvs * 0.05;
        war.scoreB += (aProvs === 0 ? 2 : 0) + bProvs * 0.05;

        if (war.scoreA >= PEACE_SCORE || war.scoreB >= PEACE_SCORE) {
            const winner = war.scoreA >= PEACE_SCORE ? war.a : war.b;
            const loser = winner === war.a ? war.b : war.a;
            applyCommand({ t: 'makePeace', from: winner, to: loser }, s, ctx);
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${winner} 与 ${loser} 达成停战（战争分数 ${Math.round(winner === war.a ? war.scoreA : war.scoreB)}）`,
            });
        }
    }

    // 投降：无省份且仍在交战的国家退出所有战争
    for (const tag of orderedKeys(s.countries)) {
        const c = s.countries[tag];
        if (!c.flags.atWar) continue;
        if (controlledCount(s, tag) > 0) continue;
        for (const war of s.wars.filter((w) => w.status === 'active' && (w.a === tag || w.b === tag))) {
            const other = war.a === tag ? war.b : war.a;
            applyCommand({ t: 'makePeace', from: other, to: tag }, s, ctx);
        }
        c.flags.atWar = false;
        c.flags.surrendered = true;
        s.history.push({ tick: s.tick, date: dateOf(s, s.tick), text: `${tag} 已无任何省份，宣告投降` });
    }
}

function controlledCount(s, tag) {
    let n = 0;
    for (const p of Object.values(s.provinces)) {
        if (p.controller === tag) n++;
    }
    return n;
}

/**
 * 每 tick 的军事结算：战斗 → 占领 → 州归属 → 战争分数。
 * @returns {object} 汇总（供日志/AI 评估）
 */
export function settleWar(s, ctx) {
    const summary = { battles: 0, killed: 0, occupied: 0 };

    // 只处理有军队的省份（军队数量少，遍历成本可控）
    const byProvince = new Map();
    for (const a of s.armies || []) {
        if (a.strength <= 0) continue;
        if (!byProvince.has(a.provinceId)) byProvince.set(a.provinceId, []);
        byProvince.get(a.provinceId).push(a);
    }

    for (const [pid, list] of byProvince) {
        const province = s.provinces[pid];
        if (!province) continue;
        const res = resolveBattle(s, ctx, pid, province);
        if (res.killed > 0) {
            summary.battles++;
            summary.killed += res.killed;
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `省份 ${pid} 爆发战斗，击毁 ${res.killed} 支部队`,
            });
            // 战斗得分计入战争分数
            const war = findWar(s, res.attacker, null);
            if (war && res.attacker) {
                if (war.a === res.attacker) war.scoreA = (war.scoreA || 0) + res.killed * 5;
                else war.scoreB = (war.scoreB || 0) + res.killed * 5;
            }
        }
        if (applyOccupation(s, ctx, pid, province)) summary.occupied++;
    }

    checkStateOwnership(s, ctx);
    settleWarScore(s, ctx);
    recomputeVictoryPoints(s);
    return summary;
}

function findWar(s, tag, _unused) {
    return s.wars.find((w) => w.status === 'active' && (w.a === tag || w.b === tag)) || null;
}

/**
 * 注册军事规则。由 rules.js 的 installCoreRules 调用，
 * 传入 registerRule 以避免模块循环依赖。
 */
export function installWarRules(registerRule) {
    // 部队进入省份后立即结算战斗与占领
    registerRule('battleAt', ({ provinceId }, s, ctx) => {
        const province = s.provinces[provinceId];
        if (!province) return;
        const res = resolveBattle(s, ctx, provinceId, province);
        if (res.killed > 0) {
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `省份 ${provinceId} 爆发战斗，击毁 ${res.killed} 支部队`,
            });
        }
        applyOccupation(s, ctx, provinceId, province);
    });
}

export { orderedNumericIds, clearAtWar };
