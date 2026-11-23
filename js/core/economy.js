/* ============================================================
 * 战役核心 · 经济与科技结算（economy.js）
 * 每 tick（1 游戏日）对全部国家做一次确定性结算：
 *   资源产出 → 生产线装备 → 建造队列 → 科研 → 人力 / 政治点数 / 稳定度
 * 只改状态，不产生渲染副作用；需要走命令管道的变更（如占领）在 war.js 中处理。
 * 所有随机都来自 ctx.rng，保证同种子同命令序列可复现。
 * ============================================================ */

import { FP_SCALE, fpAddClamp01, orderedKeys } from './determinism.js';
import { formatDate, parseDate, TICK_GAME_DAYS } from './clock.js';
import { supplyFactorFor } from './supply.js';

/** 全局经济默认值：剧本可用 economy 字段部分覆盖 */
export const DEFAULT_ECONOMY = {
    /** 工厂总数达到该值时产能为 1.0（20 厂 = 满产能） */
    factoryBaseline: 20,
    /** 满产能下的每日基础产量 */
    income: {
        steel: 3.0, iron: 2.0, oil: 1.0, rubber: 0.6,
        energy: 1.5, aluminium: 0.8, supplies: 2.5, munitions: 1.2, rare: 0.3,
    },
    /** 人力每日增长占人口的比例 */
    manpowerGrowth: 0.0015,
    /** 每日政治点数增长（满产能时） */
    ppGrowth: 1.2,
    /** 政治点数上限 */
    maxPoliticalPower: 200,
    /** 稳定度 / 战争支持每日向基线靠拢的比例 */
    driftRate: 0.01,
    /** 每个师每日消耗的补给 */
    supplyPerArmy: 0.15,
};

/** 建造项目定义：baseDays 为基准工期（天），supplies 为每日补给消耗 */
export const CONSTRUCTION = {
    civs:          { name: '民用工厂', baseDays: 30, supplies: 0.5, effect: { civs: 1 } },
    mils:          { name: '军用工厂', baseDays: 35, supplies: 0.5, effect: { mils: 1 } },
    docks:         { name: '船坞',     baseDays: 45, supplies: 0.6, effect: { docks: 1 } },
    infrastructure: { name: '基建',     baseDays: 25, supplies: 0.4, effect: { infrastructure: 1 } },
    fort:          { name: '要塞',     baseDays: 20, supplies: 0.3, effect: { fort: 1 } },
    radar:         { name: '雷达站',   baseDays: 30, supplies: 0.4, effect: { radar: 1 } },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 读取剧本经济配置（与默认值深合并） */
export function economyOf(scenario) {
    const eco = { ...DEFAULT_ECONOMY, ...(scenario?.economy || {}) };
    eco.income = { ...DEFAULT_ECONOMY.income, ...((scenario?.economy || {}).income || {}) };
    return eco;
}

/** 产能：工厂总数相对基准的比值，0.25 ~ 1.5 */
export function capacityOf(c, eco) {
    const total = (c.civs || 0) + (c.mils || 0) + (c.docks || 0);
    return clamp(total / (eco.factoryBaseline || DEFAULT_ECONOMY.factoryBaseline), 0.25, 1.5);
}

/** 科技加成读取：division[type][stat] / factory[key] / resource[key] / misc[key] */
export function divisionBonus(c, type, stat) {
    const d = c.bonuses?.division || {};
    const all = d.all?.[stat] || 0;
    const specific = d[type]?.[stat] || 0;
    return all + specific;
}

// ===================== 科技效果应用 =====================

/**
 * 应用一项科技的效果到国家状态。
 * 支持的 effect 形态见 data/techs.json：
 *   divisionBonus / factoryBonus / resourceBonus / unlockTemplate /
 *   unlockEquipment / construction / researchSpeed / navyBuild / airBuild /
 *   airDefense / intelligence / nuclear
 */
export function applyTechEffects(c, tech, ctx) {
    const b = c.bonuses || (c.bonuses = { division: {}, factory: {}, resource: {}, misc: {}, terrain: {} });
    c.unlockedTemplates || (c.unlockedTemplates = []);
    c.unlockedEquipment || (c.unlockedEquipment = []);
    c.unlockedAir || (c.unlockedAir = []);
    c.unlockedShips || (c.unlockedShips = []);

    for (const e of tech.effects || []) {
        if (e.divisionBonus) {
            for (const [type, stats] of Object.entries(e.divisionBonus)) {
                const key = type === 'all' ? 'all' : type;
                b.division[key] || (b.division[key] = {});
                for (const [stat, val] of Object.entries(stats)) {
                    b.division[key][stat] = (b.division[key][stat] || 0) + val;
                }
            }
        } else if (e.factoryBonus) {
            for (const [key, val] of Object.entries(e.factoryBonus)) {
                b.factory[key] = (b.factory[key] || 0) + val;
            }
        } else if (e.resourceBonus) {
            for (const [key, val] of Object.entries(e.resourceBonus)) {
                b.resource[key] = (b.resource[key] || 0) + val;
            }
        } else if (e.unlockTemplate && !c.unlockedTemplates.includes(e.unlockTemplate)) {
            c.unlockedTemplates.push(e.unlockTemplate);
        } else if (e.unlockEquipment && !c.unlockedEquipment.includes(e.unlockEquipment)) {
            c.unlockedEquipment.push(e.unlockEquipment);
        } else if (e.construction !== undefined) {
            b.misc.construction = (b.misc.construction || 0) + e.construction;
        } else if (e.researchSpeed !== undefined) {
            b.misc.researchSpeed = (b.misc.researchSpeed || 0) + e.researchSpeed;
        } else if (e.navyBuild !== undefined) {
            b.misc.navyBuild = (b.misc.navyBuild || 0) + e.navyBuild;
        } else if (e.airBuild !== undefined) {
            b.misc.airBuild = (b.misc.airBuild || 0) + e.airBuild;
        } else if (e.airDefense !== undefined) {
            b.misc.airDefense = (b.misc.airDefense || 0) + e.airDefense;
        } else if (e.intelligence !== undefined) {
            b.misc.intelligence = (b.misc.intelligence || 0) + e.intelligence;
        } else if (e.terrainDefense) {
            // 地形防御修正：按地形累加（如山地作战 +0.5 山地防御）
            b.terrain || (b.terrain = {});
            for (const [terrain, val] of Object.entries(e.terrainDefense)) {
                b.terrain[terrain] = (b.terrain[terrain] || 0) + val;
            }
        } else if (e.unlockAir && !c.unlockedAir.includes(e.unlockAir)) {
            c.unlockedAir.push(e.unlockAir);
        } else if (e.unlockShip && !c.unlockedShips.includes(e.unlockShip)) {
            c.unlockedShips.push(e.unlockShip);
        } else if (e.nuclear) {
            c.flags.nuclear = true;
        }
    }
}

/** 完成科技：标记完成 → 应用效果 → 推进后续可研究项 */
export function completeTech(s, ctx, tag, techId) {
    const c = s.countries[tag];
    const tech = ctx.techs?.[techId];
    if (!tech) return;
    if (!c.tech) c.tech = {};
    c.tech[techId] = true;
    applyTechEffects(c, tech, ctx);
    const rs = s.research[tag];
    const idx = rs.researching.findIndex((r) => r.techId === techId);
    if (idx >= 0) rs.researching.splice(idx, 1);
    if (!rs.completed.includes(techId)) rs.completed.push(techId);
}

// ===================== 生产线 =====================

/**
 * 推进一条生产线。
 * 产出速率 = 分配工厂数 / 装备成本（1 厂造 1 个 cost=3 的装备需 3 天）。
 * 资源不足时按最小可用比例整体缩放，保证不会出现负库存。
 */
function tickProductionLine(c, line, ctx, cap) {
    const eq = ctx.equipment?.[line.equipment];
    if (!eq) return { produced: 0, consumed: {} };
    const rate = (line.factories || 1) / eq.cost;
    let produce = rate * cap;
    if (produce <= 0) return { produced: 0, consumed: {} };

    // 资源瓶颈：按各资源可支撑比例缩放
    let scale = 1;
    const consumed = {};
    for (const [res, perUnit] of Object.entries(eq.usesResources || {})) {
        const need = perUnit * produce;
        const have = c.resources[res] || 0;
        if (have <= 0) return { produced: 0, consumed: {} };
        scale = Math.min(scale, have / need);
    }
    if (scale <= 0) return { produced: 0, consumed: {} };
    produce *= scale;

    for (const [res, perUnit] of Object.entries(eq.usesResources || {})) {
        const amt = perUnit * produce;
        c.resources[res] = (c.resources[res] || 0) - amt;
        consumed[res] = amt;
    }

    let produced = 0;
    line.progress = (line.progress || 0) + produce;
    line.produced = (line.produced || 0) + produce;
    while (line.progress >= 1) {
        produced++;
        line.progress -= 1;
        c.equipment || (c.equipment = {});
        c.equipment[line.equipment] = (c.equipment[line.equipment] || 0) + 1;
    }
    return { produced, consumed };
}

// ===================== 建造队列 =====================

function tickConstruction(c, proj, ctx, eco, s) {
    const def = CONSTRUCTION[proj.kind];
    if (!def) return;
    // 同类型项目越多越慢（模拟工业摊薄）
    const siblings = (c.construction || []).filter((x) => x.kind === proj.kind).length;
    const speedBonus = 1 + (c.bonuses?.misc?.construction || 0);
    const total = Math.max(5, Math.round((def.baseDays * (1 + 0.15 * (siblings - 1))) / speedBonus));
    if (!proj.total) proj.total = total;

    // 补给消耗
    const supply = c.resources.supplies || 0;
    if (supply <= 0) return;
    const use = Math.min(supply, def.supplies);
    c.resources.supplies = supply - use;

    proj.progress = (proj.progress || 0) + (100 / proj.total);
    if (proj.progress >= 100) {
        for (const [k, v] of Object.entries(def.effect)) {
            if (k === 'infrastructure' || k === 'fort' || k === 'radar') {
                // 基建类作用在省份上（无省份目标时计入国家建筑计数）
                if (proj.province && s.provinces[proj.province]) {
                    if (k === 'infrastructure') s.provinces[proj.province].infrastructure = (s.provinces[proj.province].infrastructure || 0) + 1;
                    if (k === 'fort') s.provinces[proj.province].fortLevel = (s.provinces[proj.province].fortLevel || 0) + 1;
                    if (k === 'radar') s.provinces[proj.province].radar = (s.provinces[proj.province].radar || 0) + 1;
                } else {
                    c.buildings[k] = (c.buildings[k] || 0) + 1;
                }
            } else {
                c[k] = (c[k] || 0) + v;
            }
        }
        return 'done';
    }
    return null;
}

// ===================== 主结算 =====================

/**
 * 每 tick 的经济结算。
 * @returns {object} 汇总信息（供日志/历史使用）：{ produced, constructed, researched }
 */
export function settleEconomy(s, ctx) {
    const eco = economyOf(ctx.scenario);
    const summary = { produced: {}, constructed: 0, researched: 0, days: 1 };

    for (const tag of orderedKeys(s.countries)) {
        const c = s.countries[tag];
        const cap = capacityOf(c, eco);
        c.resources || (c.resources = {});

        // 1) 资源产出（含科技资源加成）
        const resBonus = c.bonuses?.resource || {};
        for (const [res, base] of Object.entries(eco.income)) {
            const amt = base * cap * (1 + (resBonus[res] || 0));
            if (amt > 0) c.resources[res] = (c.resources[res] || 0) + amt;
        }

        // 2) 生产线
        for (const line of c.production || []) {
            if (line.disabled) continue;
            const r = tickProductionLine(c, line, ctx, cap);
            if (r.produced > 0) {
                summary.produced[line.equipment] = (summary.produced[line.equipment] || 0) + r.produced;
            }
        }

        // 3) 建造队列（从后往前删，避免跳序）
        for (let i = (c.construction || []).length - 1; i >= 0; i--) {
            const proj = c.construction[i];
            const done = tickConstruction(c, proj, ctx, eco, s);
            if (done) {
                c.construction.splice(i, 1);
                summary.constructed++;
                s.history.push({
                    tick: s.tick,
                    date: dateOf(s, s.tick),
                    text: `${tag} 完成建造：${CONSTRUCTION[proj.kind]?.name || proj.kind}`,
                });
            }
        }

        // 4) 科研
        const rs = s.research[tag];
        if (rs && rs.researching.length) {
            const speed = 1 + (c.bonuses?.misc?.researchSpeed || 0);
            for (let i = rs.researching.length - 1; i >= 0; i--) {
                const item = rs.researching[i];
                const tech = ctx.techs?.[item.techId];
                if (!tech) { rs.researching.splice(i, 1); continue; }
                item.progress = (item.progress || 0) + speed;
                if (item.progress >= tech.time) {
                    completeTech(s, ctx, tag, item.techId);
                    summary.researched++;
                    s.history.push({
                        tick: s.tick,
                        date: dateOf(s, s.tick),
                        text: `${tag} 完成科技：${tech.name}`,
                    });
                }
            }
        }

        // 5) 人力增长（向人口上限靠拢）
        if (c.population > 0) {
            const growth = eco.manpowerGrowth * c.population * cap;
            c.manpower = Math.min(c.population * 1.15, c.manpower + growth);
        }

        // 6) 政治点数
        if (c.politicalPower < eco.maxPoliticalPower) {
            c.politicalPower = Math.min(eco.maxPoliticalPower, c.politicalPower + eco.ppGrowth * cap);
        }

        // 7) 补给消耗（军队维持）——按补给网络折算，被切断的部队不消耗补给
        const forces = s.armies || [];
        let supplyUnits = 0;
        for (const a of forces) {
            if (a.owner !== tag || a.strength <= 0) continue;
            supplyUnits += Math.max(0, Math.min(1, supplyFactorFor(s, ctx, a.provinceId)));
        }
        for (const g of s.airForces || []) {
            if (g.owner !== tag || g.planes <= 0) continue;
            const tpl = ctx.aircraft?.[g.template];
            supplyUnits += (tpl?.cost?.supplies || 0) * (g.planes / Math.max(1, tpl?.planes || 1));
        }
        for (const f of s.fleets || []) {
            if (f.owner !== tag || f.ships <= 0) continue;
            const tpl = ctx.ships?.[f.template];
            supplyUnits += (tpl?.cost?.supplies || 0) * (f.ships / Math.max(1, tpl?.ships || 1));
        }
        if (supplyUnits > 0) {
            const need = eco.supplyPerArmy * supplyUnits;
            const have = c.resources.supplies || 0;
            if (have >= need) {
                c.resources.supplies = have - need;
            } else if (have > 0) {
                c.resources.supplies = 0;
            } else {
                // 补给耗尽：维持赤字并惩罚稳定度（稳定度有下限，不会无限下滑）
                c.resources.supplies = Math.max(-need, (c.resources.supplies || 0) - need);
                c.stability = fpAddClamp01(c.stability, -2);
            }
        } else if ((c.resources.supplies || 0) < 0) {
            c.resources.supplies = 0;
        }

        // 8) 稳定度 / 战争支持 / 合法性向基线漂移
        const baseline = c.flags.atWar ? 0.55 : 0.7;
        const drift = eco.driftRate * cap;
        c.stability = fpAddClamp01(c.stability, Math.round((baseline - c.stability / FP_SCALE) * drift * FP_SCALE));
        c.warSupport = fpAddClamp01(c.warSupport, Math.round(((c.flags.atWar ? 0.75 : 0.55) - c.warSupport / FP_SCALE) * drift * FP_SCALE));
    }

    return summary;
}

/** 由 tick 求游戏日期字符串（与 Clock.date 一致） */
export function dateOf(s, tick) {
    const ms = parseDate(s.startDate).getTime() + tick * TICK_GAME_DAYS * 86400000;
    return formatDate(new Date(ms));
}
