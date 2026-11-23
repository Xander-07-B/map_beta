/* ============================================================
 * 战役核心 · 补给网络 / 空军 / 海军（airnavy.js）
 * 在陆军最小闭环之外补上三件事：
 *   1. 补给网络：部队只有与己方补给枢纽连通才有补给，被切断则组织度与兵力持续流失
 *   2. 空中力量：夺取制空权、为地面部队提供空中支援、战略轰炸摧毁省份补给
 *   3. 海上力量：舰队决战、炮击沿岸省份、为运输提供海路
 * 所有结算均为确定性纯函数：只读状态 + ctx.rng，不碰 DOM。
 * ============================================================ */

import { applyCommand } from './commands.js';
import { dateOf } from './economy.js';
import {
    clamp01, SUPPLY_HUB, supplyFactorOf, supplyFactorFor,
    damageSupplyPenalty, MAX_PROVINCE_DAMAGE, controllerIndex,
} from './supply.js';

/** 制空权对地面战斗的加成上限 */
export const AIR_SUPPORT_MAX = 0.25;

/**
 * 受损省份集合（派生缓存，不进存档）。
 * 省份总数为数千，逐 tick 全表扫描只为修复已受损省份太浪费；
 * 受损只可能由本模块的轰炸写入，因此这里惰性建表并增量维护。
 * 读档 / 恢复会替换 state 对象，WeakMap 自动失效，首次使用时重建。
 */
const _damaged = new WeakMap();

function damageSet(s) {
    let set = _damaged.get(s);
    if (!set) {
        set = new Set();
        for (const p of Object.values(s.provinces)) if (p.damage > 0) set.add(p.id);
        _damaged.set(s, set);
    }
    return set;
}

// ===================== 补给网络 =====================

/**
 * 计算各省驻军的补给可达系数。
 * 从每个拥有武装力量的国家出发：以该国（含阵营盟友）控制的补给枢纽为源，
 * 沿邻接表在己方控制省份中扩散，能到达的省份视为有补给。
 * 复杂度：每个国家的 BFS 只覆盖它（与盟友）控制的省份，
 * 全量合计不超过省份总数，逐 tick 调用可接受。
 * @returns {Map<number, number>} provinceId → 0~1
 */
export function computeSupplyAccess(s, ctx) {
    const out = new Map();
    const hasForces = (s.armies && s.armies.length) || (s.fleets && s.fleets.length) || (s.airForces && s.airForces.length);
    if (!hasForces) return out;

    // 需要计算的国家：拥有任何武装力量
    const needed = new Set();
    for (const a of s.armies || []) if (a.strength > 0) needed.add(a.owner);
    for (const f of s.fleets || []) if (f.ships > 0) needed.add(f.owner);
    for (const a of s.airForces || []) if (a.planes > 0) needed.add(a.owner);
    if (needed.size === 0) return out;

    // 同一阵营的盟友共用一张补给网，按阵营分组只做一次 BFS
    const factionOfTag = new Map();
    for (const fac of s.alliances || []) {
        for (const m of fac.members || []) factionOfTag.set(m, fac);
    }
    const groups = new Map();   // gid -> { friendly: Set<tag> }
    for (const tag of [...needed].sort()) {
        const fac = factionOfTag.get(tag);
        const gid = fac ? fac.id : `#${tag}`;
        let g = groups.get(gid);
        if (!g) {
            g = { friendly: new Set(fac ? fac.members : [tag]) };
            groups.set(gid, g);
        }
        g.friendly.add(tag);
    }

    // 控制方索引有派生缓存：只有控制权变化时才重建
    const byOwner = controllerIndex(s);
    const neighbors = ctx.neighbors;
    for (const g of groups.values()) {
        // 补给枢纽（己方/盟友控制的高供给省份）
        const hubs = [];
        for (const t of [...g.friendly].sort()) {
            for (const pid of byOwner.get(t) || []) {
                const p = s.provinces[pid];
                if (p && (p.supply || 0) >= SUPPLY_HUB) hubs.push(pid);
            }
        }
        if (hubs.length === 0) continue;   // 无补给源：该阵营所有部队都被切断

        const visited = new Set(hubs);
        const queue = hubs;
        let head = 0;
        while (head < queue.length) {
            const pid = queue[head++];
            out.set(pid, supplyFactorOf(s.provinces[pid]));
            for (const nid of neighbors?.[pid] || []) {
                if (visited.has(nid)) continue;
                const np = s.provinces[nid];
                if (!np || !np.controller) continue;
                if (!g.friendly.has(np.controller)) continue;
                visited.add(nid);
                queue.push(nid);
            }
        }
    }

    // 运输机群提升所在省份的补给系数（海路/空运补给）
    for (const a of s.airForces || []) {
        if (a.planes <= 0) continue;
        const tpl = ctx.aircraft?.[a.template];
        const bonus = tpl?.supplyBonus || 0;
        if (bonus <= 0) continue;
        const cur = out.get(a.provinceId) ?? 0;
        if (cur > 0) out.set(a.provinceId, clamp01(cur + bonus));
    }

    // 省份受损降低补给
    for (const [pid, factor] of out) {
        const p = s.provinces[pid];
        if (p && p.damage > 0) out.set(pid, clamp01(factor * (1 - damageSupplyPenalty(p.damage))));
    }
    return out;
}

/** 取一支部队的补给系数（无补给网络数据时退化为按省份供给估算）——见 supply.js */

// ===================== 空中力量 =====================

/** 空军战力：架数 × 科技加成 × 机型系数 */
export function airPower(s, ctx, group) {
    const c = s.countries[group.owner];
    const bonus = 1 + (c?.bonuses?.misc?.airBuild || 0);
    const tpl = ctx.aircraft?.[group.template];
    const role = tpl?.airCombat ?? 0;
    return group.planes * bonus * (0.6 + 0.4 * role);
}

/** 某省各方的空中力量：Map<owner, power> */
export function airPowerByOwner(s, ctx, provinceId) {
    const map = new Map();
    for (const g of s.airForces || []) {
        if (g.provinceId !== provinceId || g.planes <= 0) continue;
        map.set(g.owner, (map.get(g.owner) || 0) + airPower(s, ctx, g));
    }
    return map;
}

/**
 * 制空权对地面战斗的修正：攻击方与防御方的空中力量之比，
 * 优势方获得最多 AIR_SUPPORT_MAX 的攻击/防御加成。
 * @returns {{attack: number, defense: number}}
 */
export function airSupportModifiers(airByOwner, attacker, defender) {
    const atk = airByOwner.get(attacker) || 0;
    const def = airByOwner.get(defender) || 0;
    const out = { attack: 0, defense: 0 };
    if (atk > def && def >= 0) {
        out.attack = Math.min(AIR_SUPPORT_MAX, (atk - def) / Math.max(1, atk) * 1.5);
    }
    if (def > atk && atk >= 0) {
        out.defense = Math.min(AIR_SUPPORT_MAX, (def - atk) / Math.max(1, def) * 1.5);
    }
    return out;
}

// ===================== 海上力量 =====================

/** 舰队战力：舰数 × 科技加成 × 舰种系数 */
export function navalPower(s, ctx, fleet) {
    const c = s.countries[fleet.owner];
    const bonus = 1 + (c?.bonuses?.misc?.navyBuild || 0);
    const tpl = ctx.ships?.[fleet.template];
    const role = tpl?.navalCombat ?? 1;
    return fleet.ships * bonus * role;
}

/** 某省各方的海上力量：Map<owner, power> */
export function navalPowerByOwner(s, ctx, provinceId) {
    const map = new Map();
    for (const f of s.fleets || []) {
        if (f.provinceId !== provinceId || f.ships <= 0) continue;
        map.set(f.owner, (map.get(f.owner) || 0) + navalPower(s, ctx, f));
    }
    return map;
}

// ===================== 每 tick 结算 =====================

/**
 * 空中与海上的每 tick 结算：
 *   1. 同省多国空军 → 空战，劣势方损失飞机
 *   2. 同省多国舰队 → 海战，劣势方损失舰船
 *   3. 取得制空/制海的一方轰炸省份（增加省份受损，折损敌方补给）
 * @returns {object} 汇总
 */
export function settleAirNavy(s, ctx) {
    const summary = { airBattles: 0, navalBattles: 0, bombed: 0 };

    // ---------- 空战 ----------
    const airByProvince = new Map();
    for (const g of s.airForces || []) {
        if (g.planes <= 0) continue;
        if (!airByProvince.has(g.provinceId)) airByProvince.set(g.provinceId, []);
        airByProvince.get(g.provinceId).push(g);
    }
    for (const [pid, groups] of airByProvince) {
        const owners = new Set(groups.map((g) => g.owner));
        if (owners.size < 2) continue;
        const powerByOwner = new Map();
        for (const g of groups) powerByOwner.set(g.owner, (powerByOwner.get(g.owner) || 0) + airPower(s, ctx, g));
        let topTag = null;
        let topPower = 0;
        for (const [tag, p] of [...powerByOwner.entries()].sort((a, b) => b[1] - a[1])) {
            if (p > topPower) { topPower = p; topTag = tag; }
        }
        summary.airBattles++;

        for (const g of groups) {
            const mine = powerByOwner.get(g.owner) || 0;
            let lost;
            if (g.owner === topTag) {
                // 优势方只付出少量损耗
                const enemyTotal = [...powerByOwner.values()].reduce((a, b) => a + b, 0) - topPower;
                lost = g.planes * 0.01 * (1 + enemyTotal / Math.max(1, topPower));
            } else {
                lost = g.planes * 0.06 * (1 + (topPower - mine) / Math.max(1, topPower));
            }
            g.planes = Math.max(0, g.planes - lost);
        }
        for (let i = s.airForces.length - 1; i >= 0; i--) {
            if (s.airForces[i].planes <= 0) s.airForces.splice(i, 1);
        }
        s.history.push({
            tick: s.tick, date: dateOf(s, s.tick),
            text: `省份 ${pid} 发生空战，${topTag} 取得制空权`,
        });
    }

    // ---------- 海战 ----------
    const navByProvince = new Map();
    for (const f of s.fleets || []) {
        if (f.ships <= 0) continue;
        if (!navByProvince.has(f.provinceId)) navByProvince.set(f.provinceId, []);
        navByProvince.get(f.provinceId).push(f);
    }
    for (const [pid, fleets] of navByProvince) {
        const owners = new Set(fleets.map((f) => f.owner));
        if (owners.size < 2) continue;
        const powerByOwner = new Map();
        for (const f of fleets) powerByOwner.set(f.owner, (powerByOwner.get(f.owner) || 0) + navalPower(s, ctx, f));
        let topTag = null;
        let topPower = 0;
        for (const [tag, p] of [...powerByOwner.entries()].sort((a, b) => b[1] - a[1])) {
            if (p > topPower) { topPower = p; topTag = tag; }
        }
        summary.navalBattles++;
        for (const f of fleets) {
            const mine = powerByOwner.get(f.owner) || 0;
            const lost = f.owner === topTag
                ? f.ships * 0.01
                : f.ships * 0.07 * (1 + (topPower - mine) / Math.max(1, topPower));
            f.ships = Math.max(0, f.ships - lost);
        }
        for (let i = s.fleets.length - 1; i >= 0; i--) {
            if (s.fleets[i].ships <= 0) s.fleets.splice(i, 1);
        }
        s.history.push({
            tick: s.tick, date: dateOf(s, s.tick),
            text: `海域 ${pid} 发生海战，${topTag} 取得制海权`,
        });
    }

    // ---------- 轰炸 ----------
    const bombersByProvince = new Map();
    for (const g of s.airForces || []) {
        if (g.planes <= 0) continue;
        const tpl = ctx.aircraft?.[g.template];
        if (!tpl || !tpl.bombing) continue;
        if (!bombersByProvince.has(g.provinceId)) bombersByProvince.set(g.provinceId, []);
        bombersByProvince.get(g.provinceId).push(g);
    }
    for (const [pid, groups] of bombersByProvince) {
        const province = s.provinces[pid];
        if (!province || !province.controller) continue;
        if (province.controller === groups[0].owner) continue;   // 不炸自己
        // 需要取得制空权才能轰炸
        const air = airPowerByOwner(s, ctx, pid);
        const topTag = [...air.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (topTag !== groups[0].owner) continue;

        const defCountry = s.countries[province.controller];
        const airDefense = 1 - clamp01((defCountry?.bonuses?.misc?.airDefense || 0) * 0.5);
        const power = groups.reduce((sum, g) => {
            const tpl = ctx.aircraft?.[g.template];
            return sum + g.planes * (tpl?.bombing || 0);
        }, 0);
        const dmg = power * 0.02 * airDefense;
        if (dmg <= 0) continue;
        province.damage = Math.min(MAX_PROVINCE_DAMAGE, (province.damage || 0) + dmg);
        damageSet(s).add(province.id);
        summary.bombed++;
        // 受损跨过整十才写一条播报，避免历史被轰炸记录淹没
        const before = Math.floor((province.damage - dmg) / 10);
        const after = Math.floor(province.damage / 10);
        if (after > before) {
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${groups[0].owner} 的战略轰炸摧毁了 ${province.controller} 的省份 ${pid}（受损 ${Math.round(province.damage)}）`,
            });
        }
    }

    // ---------- 舰队炮击沿岸 ----------
    for (const f of s.fleets || []) {
        if (f.ships <= 0) continue;
        const province = s.provinces[f.provinceId];
        if (!province || !province.coastal) continue;
        if (!province.controller || province.controller === f.owner) continue;
        const nav = navalPowerByOwner(s, ctx, f.provinceId);
        const topTag = [...nav.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (topTag !== f.owner) continue;
        const tpl = ctx.ships?.[f.template];
        const dmg = f.ships * (tpl?.bombardment || 0) * 0.5;
        if (dmg <= 0) continue;
        province.damage = Math.min(MAX_PROVINCE_DAMAGE, (province.damage || 0) + dmg);
        damageSet(s).add(province.id);
        summary.bombed++;
    }

    // ---------- 受损自然修复（未被轰炸的省份缓慢恢复） ----------
    const damaged = damageSet(s);
    for (const pid of damaged) {
        const p = s.provinces[pid];
        if (!p) { damaged.delete(pid); continue; }
        p.damage = Math.max(0, p.damage - 0.2);
        if (p.damage <= 0) damaged.delete(pid);
    }

    return summary;
}

// ===================== 部队指令（进攻 / 待机 / 撤退） =====================

/** 该省是否有敌方控制（对指定国家而言） */
function enemyAdjacent(s, ctx, provinceId, tag) {
    const list = ctx.neighbors?.[String(provinceId)] || [];
    for (const nid of list) {
        const p = s.provinces[nid];
        if (p && p.controller && p.controller !== tag) return true;
    }
    return false;
}

/**
 * 向最近的敌人推进的下一步：
 * 相邻省份已是敌方 → 直接进入；否则沿己方控制省份的最短路径前进一步。
 * @returns {number|null} 目标省份 id
 */
export function nextStepTowardEnemy(s, ctx, provinceId, tag) {
    const neighbors = ctx.neighbors;
    if (!neighbors) return null;
    const list = neighbors[String(provinceId)] || [];
    // 1) 相邻敌方省份：直接进攻
    const enemy = list.map(Number)
        .filter((id) => { const p = s.provinces[id]; return p && p.controller && p.controller !== tag; })
        .sort((a, b) => a - b)[0];
    if (enemy !== undefined) return enemy;

    // 2) BFS：在己方控制省份中寻找最靠近敌方的省份
    const visited = new Set([provinceId]);
    const queue = [provinceId];
    const prev = new Map();
    let head = 0;
    while (head < queue.length) {
        const pid = queue[head++];
        for (const nid of neighbors[String(pid)] || []) {
            if (visited.has(nid)) continue;
            const np = s.provinces[nid];
            if (!np) continue;
            // 邻接的敌方省份 → 当前省份即为推进目标
            if (np.controller && np.controller !== tag) return pid;
            if (np.controller === tag) {
                visited.add(nid);
                prev.set(nid, pid);
                queue.push(nid);
            }
        }
    }
    return null;
}

/**
 * 部队指令结算：执行「进攻 / 撤退」指令的部队自动移动。
 * 指令存放在军队实体上（order 字段），玩家与 AI 共用。
 */
export function settleArmyOrders(s, ctx) {
    const summary = { advanced: 0, retreated: 0 };
    const armies = (s.armies || []).filter((a) => a.strength > 0 && a.order && a.order !== 'hold');
    for (const a of armies.sort((x, y) => x.id - y.id)) {
        if (a.org <= 0.2) continue;   // 组织度崩溃的部队不执行指令
        if (a.order === 'advance') {
            const to = nextStepTowardEnemy(s, ctx, a.provinceId, a.owner);
            if (to != null && to !== a.provinceId) {
                const r = applyCommand({ t: 'moveArmy', armyId: a.id, to, country: a.owner }, s, ctx);
                if (r.ok) summary.advanced++;
            }
        } else if (a.order === 'retreat') {
            const options = (ctx.neighbors?.[String(a.provinceId)] || []).map(Number)
                .filter((id) => {
                    const p = s.provinces[id];
                    return p && p.controller === a.owner;
                })
                .sort((x, y) => (s.provinces[y].supply || 0) - (s.provinces[x].supply || 0) || x - y);
            if (options.length > 0) {
                const r = applyCommand({ t: 'moveArmy', armyId: a.id, to: options[0], country: a.owner }, s, ctx);
                if (r.ok) summary.retreated++;
            }
        }
    }
    return summary;
}

/** 注册空中/海上相关规则（供 rules.js 调用，避免循环依赖）
 *  空中与海上力量的结算集中在每 tick 的 settleAirNavy 中完成，
 *  不需要额外的级联规则——部队移动后的当 tick 结算由 onTick 统一驱动。
 */
export function installAirNavyRules(_registerRule) {
    // 保留入口：后续若需要「轰炸机场」「舰队封锁」等级联规则在此注册
}
