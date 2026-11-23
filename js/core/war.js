/* ============================================================
 * 战役核心 · 军事结算（war.js）
 * 军队的完整闭环：
 *   部署（扣人力/装备）→ 移动（地形移动代价）→ 战斗（地形/组织度/宽度/空中支援）
 *   → 占领（setController）→ 州归属翻转 → 战争分数 → 议和 / 投降
 *   以及每 tick 的部队维持：补给网络、组织度恢复、补给切断后的流失。
 * 战斗结算在此完成；所有状态变更要么走命令管道，要么写入 pending 队列。
 * ============================================================ */

import { orderedKeys, orderedNumericIds } from './determinism.js';
import { applyCommand } from './commands.js';
import { recomputeVictoryPoints, clearAtWar } from './state.js';
import { divisionBonus, dateOf } from './economy.js';
import { airPowerByOwner, airSupportModifiers } from './airnavy.js';
import { clamp01, supplyFactorFor } from './supply.js';

/** 战争分数达到该值即自动议和 */
export const PEACE_SCORE = 100;

/**
 * 地形防御修正。
 * 注意：省份地形取值是 `plains`（复数），早期版本这里写成 `plain`，
 * 导致地形修正永远取不到、地形形同虚设——两个键都要保留。
 */
export const TERRAIN_DEFENSE = {
    plain: 0.0, plains: 0.0, hills: 0.15, forest: 0.3, mountain: 0.5,
    desert: 0.1, tundra: 0.2, ocean: 0.0, coast: 0.0, sea: 0.0,
};

/** 地形移动代价：进入该地形需要付出的组织度代价（>1 越大越难走） */
export const TERRAIN_MOVE_COST = {
    plain: 1.0, plains: 1.0, hills: 1.25, forest: 1.5, mountain: 2.2,
    desert: 1.3, tundra: 1.6, ocean: 1.0, coast: 1.0, sea: 1.0,
};

/** 省份战斗宽度基准（同时受基建影响） */
export const PROVINCE_BATTLE_WIDTH = 100;

/** 地形防御修正：基础地形 + 部队模板地形加成 + 国家科技地形加成 */
export function terrainDefense(terrain, templateId, ctx, c) {
    const base = TERRAIN_DEFENSE[terrain] ?? 0;
    const templateBonus = ctx.divisions?.[templateId]?.terrainBonus?.[terrain] || 0;
    const techBonus = c?.bonuses?.terrain?.[terrain] || 0;
    return base + templateBonus + techBonus;
}

/** 地形移动代价 */
export function terrainMoveCost(terrain) {
    return TERRAIN_MOVE_COST[terrain] ?? 1;
}

/** 省份战斗宽度：基建越高，能同时交战的部队越多 */
export function battleWidth(province) {
    if (!province) return PROVINCE_BATTLE_WIDTH;
    return PROVINCE_BATTLE_WIDTH + (province.infrastructure || 0) * 5;
}

/** 部队模板的战斗宽度 */
function templateWidth(ctx, templateId) {
    const w = ctx.divisions?.[templateId]?.width;
    return Number.isFinite(w) && w > 0 ? w : 10;
}

/**
 * 从一组部队中选出本轮可参战的单位：
 * 按兵力降序累加战斗宽度，超过省份宽度的部队留在预备队（本轮不交战、也不受损）。
 */
function pickFighters(list, ctx, width) {
    const sorted = list.slice().sort((a, b) => b.strength - a.strength || a.id - b.id);
    const out = [];
    let used = 0;
    for (const a of sorted) {
        const w = templateWidth(ctx, a.template);
        if (out.length > 0 && used + w > width) continue;
        out.push(a);
        used += w;
    }
    return out;
}

/** 军队战斗力：基础值 × 组织度系数 × 科技加成 × 随机扰动 */
function combatPower(s, army, ctx, stat) {
    const c = s.countries[army.owner];
    const tech = c ? divisionBonus(c, army.template, stat) : 0;
    const orgFactor = 0.4 + 0.6 * clamp01(army.org);
    const rnd = 0.85 + ctx.rng.nextFloat() * 0.3;
    return army.strength * orgFactor * (1 + tech) * rnd;
}

/**
 * 结算一个省份内的战斗。
 * 最强一方为进攻方，其余为防御方；受战斗宽度限制，超出宽度的部队留在预备队。
 * @returns {{killed: number, damage: number, attacker: string|null}}
 */
export function resolveBattle(s, ctx, provinceId, province) {
    const here = s.armies.filter((a) => a.provinceId === provinceId && a.strength > 0);
    const owners = new Set(here.map((a) => a.owner));
    if (here.length < 2 || owners.size < 2) return { killed: 0, damage: 0, attacker: null };

    // 战斗宽度：超出宽度的部队本轮不参战
    const fighters = pickFighters(here, ctx, battleWidth(province));
    if (fighters.length < 2 || new Set(fighters.map((a) => a.owner)).size < 2) {
        return { killed: 0, damage: 0, attacker: null };
    }

    // 进攻方 = 参战兵力最强的一支
    const sorted = fighters.slice().sort((a, b) => b.strength - a.strength || a.id - b.id);
    const attacker = sorted[0];
    const defenders = sorted.slice(1).filter((a) => a.owner !== attacker.owner);
    if (defenders.length === 0) return { killed: 0, damage: 0, attacker: null };

    const terrain = province?.terrain || 'plains';
    const terrainDef = terrainDefense(terrain, attacker.template, ctx, s.countries[attacker.owner]);
    const fortDef = (province?.fortLevel || 0) * 0.1;

    // 空中支援：制空权为进攻方/防御方分别提供修正
    const air = airPowerByOwner(s, ctx, provinceId);
    const airMod = airSupportModifiers(air, attacker.owner, defenders[0].owner);

    let killed = 0;
    let damage = 0;
    const destroyed = [];

    for (const def of defenders) {
        const atk = combatPower(s, attacker, ctx, 'attack') * (1 + airMod.attack);
        const defPow = combatPower(s, def, ctx, 'defense') * (1 + airMod.defense);
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
            // 分数达标 → 交由和平会议规则生成和平提议（不再直接停战）
            if (s.peaceOffers.some((o) => o.warId === war.id)) continue;
            s.pending.push({ kind: 'peaceProposed', payload: { warId: war.id } });
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
 * 部队维持：组织度恢复与补给切断后的流失。
 * 有补给且未参战的部队组织度向满值恢复；补给被切断的部队持续掉组织度与兵力。
 * @param {Set<number>} fought 本 tick 发生过战斗的省份（参战部队不恢复组织度）
 * @returns {object} 汇总
 */
export function settleArmies(s, ctx, fought = new Set()) {
    const summary = { supplied: 0, starved: 0, orgRecovered: 0 };

    for (const a of s.armies) {
        if (a.strength <= 0) continue;
        const factor = supplyFactorFor(s, ctx, a.provinceId);
        const tpl = ctx.divisions?.[a.template];
        const base = tpl?.baseStrength || 1;
        if (factor <= 0) {
            a.org = clamp01(a.org - 0.012);
            a.strength = Math.max(0, a.strength - base * 0.0008);
            summary.starved++;
        } else {
            if (!fought.has(a.provinceId)) {
                // 组织度向满值恢复，速度受补给系数影响
                a.org = clamp01(a.org + 0.02 * factor);
                summary.orgRecovered++;
            }
            if (a.org > 0.6 && !fought.has(a.provinceId)) {
                a.strength += base * 0.0006 * factor;   // 缓慢补员
            }
            summary.supplied++;
        }
    }
    return summary;
}

/**
 * 每 tick 的军事结算：战斗 → 占领 → 部队维持 → 州归属 → 战争分数。
 * @returns {object} 汇总（供日志/AI 评估）
 */
export function settleWar(s, ctx) {
    const summary = { battles: 0, killed: 0, occupied: 0, supplied: 0, starved: 0 };

    // 1) 战斗：只处理有军队的省份（军队数量少，遍历成本可控）
    const byProvince = new Map();
    for (const a of s.armies || []) {
        if (a.strength <= 0) continue;
        if (!byProvince.has(a.provinceId)) byProvince.set(a.provinceId, []);
        byProvince.get(a.provinceId).push(a);
    }

    const fought = new Set();
    for (const [pid, list] of byProvince) {
        const province = s.provinces[pid];
        if (!province) continue;
        const res = resolveBattle(s, ctx, pid, province);
        if (res.killed > 0) {
            fought.add(pid);
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

    // 2) 部队维持（组织度 / 补给）——本 tick 参战的部队不恢复
    const maintain = settleArmies(s, ctx, fought);
    summary.supplied = maintain.supplied;
    summary.starved = maintain.starved;

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
