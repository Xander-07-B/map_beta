/* ============================================================
 * 战役核心 · 补给网络基础（supply.js）
 * 补给系数的计算与查询。被经济结算（补给消耗）与军事结算
 * （组织度维持）共用，单独成模块以避免 economy / airnavy 之间的循环依赖。
 * ============================================================ */

export function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/** 补给枢纽阈值：供给值达到该值的省份才视为补给源 */
export const SUPPLY_HUB = 0.5;

/** 省份供给 → 补给系数（0~1）：供给越高，驻军补给越充足 */
export function supplyFactorOf(province) {
    if (!province) return 0;
    return clamp01(0.4 + 0.6 * (province.supply || 0));
}

/** 省份受损对补给的折损比例 */
export const MAX_PROVINCE_DAMAGE = 60;

export function damageSupplyPenalty(damage) {
    return clamp01((damage || 0) / MAX_PROVINCE_DAMAGE) * 0.6;
}

/**
 * 取一支部队的补给系数。
 * 优先使用本 tick 预计算的补给网络（ctx.supply）；没有网络数据时
 * 退化为按省份供给估算，保证单独调用（如经济结算）也能工作。
 */
export function supplyFactorFor(s, ctx, provinceId) {
    const map = ctx?.supply;
    if (map && map.size) {
        const v = map.get(provinceId);
        return v === undefined ? 0 : v;
    }
    return supplyFactorOf(s?.provinces?.[provinceId]);
}

// ===================== 控制方索引（派生缓存） =====================

/**
 * 控制方 → 省份 id 列表。
 * 补给网络、战争分数等每 tick 都要按控制方统计省份；全表扫描数千省份太浪费。
 * 控制权只经命令管道变更（命令会递增 s.controllerVersion），版本变化时重建。
 * WeakMap 以状态对象为键：读档 / 回放产生新对象时自动失效。
 */
const _controllerIndex = new WeakMap();

export function controllerIndex(s) {
    const version = s.controllerVersion || 0;
    const cached = _controllerIndex.get(s);
    if (cached && cached.version === version) return cached.byOwner;
    const byOwner = new Map();
    for (const p of Object.values(s.provinces || {})) {
        if (!p.controller) continue;
        let arr = byOwner.get(p.controller);
        if (!arr) { arr = []; byOwner.set(p.controller, arr); }
        arr.push(p.id);
    }
    _controllerIndex.set(s, { version, byOwner });
    return byOwner;
}
