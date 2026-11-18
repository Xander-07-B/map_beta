/* ============================================================
 * 内容层 · 条件求值（conditions.js）
 * 供决议执行校验与（后续 W3）事件触发判定共用。
 * 求值必须纯且快：只读状态，不产生副作用、不消耗 RNG。
 * ============================================================ */

import { parseDate, TICK_MINUTES } from '../core/clock.js';

const TICK_MS = TICK_MINUTES * 60000;

/** 日期字符串 → 自开局起的 tick 数 */
export function dateToTicks(s, dateStr) {
    return Math.round((parseDate(dateStr).getTime() - parseDate(s.startDate).getTime()) / TICK_MS);
}

function compare(v, arg) {
    const [op, n] = arg;
    switch (op) {
        case '>=': return v >= n;
        case '<=': return v <= n;
        case '>': return v > n;
        case '<': return v < n;
        case '==': return v === n;
        case '!=': return v !== n;
        default: return false;
    }
}

/**
 * 求值单个条件节点。
 * 支持的叶子形式：
 *   { civs: [">=", 8] }                国家数值比较（作用于 scopeTag）
 *   { relation: ["GER","POL","<",0] }  两国关系比较
 *   { atWar: ["GER","POL"] }           处于战争状态
 *   { focusDone: ["GER","x"] }         国策已完成
 *   { hasFocus: "x" }                  （scopeTag）已完成某国策
 *   { dateAfter: "1939-08-01" }        游戏日期已过
 *   { dateBefore: "1939-08-01" }
 * 组合：{ all: [...] } / { any: [...] } / { not: {...} }
 */
export function evalCond(c, s, ctx, scopeTag) {
    if (!c || typeof c !== 'object') return false;
    if (Array.isArray(c.all)) return c.all.every((x) => evalCond(x, s, ctx, scopeTag));
    if (Array.isArray(c.any)) return c.any.some((x) => evalCond(x, s, ctx, scopeTag));
    if (c.not) return !evalCond(c.not, s, ctx, scopeTag);

    const country = s.countries[scopeTag];
    for (const [key, arg] of Object.entries(c)) {
        switch (key) {
            case 'civs':
            case 'mils':
            case 'docks':
            case 'manpower':
            case 'politicalPower':
                return compare((country && country[key]) ?? 0, arg);
            case 'relation': {
                const [a, b, op, v] = arg;
                return compare((s.countries[a]?.relations?.[b]) ?? 0, [op, v]);
            }
            case 'atWar': {
                const [a, b] = arg;
                return s.wars.some((w) => w.status === 'active' &&
                    ((w.a === a && w.b === b) || (w.a === b && w.b === a)));
            }
            case 'focusDone': {
                const [tag, focusId] = arg;
                return (s.focuses[tag]?.done || []).includes(focusId);
            }
            case 'hasFocus':
                return (s.focuses[scopeTag]?.done || []).includes(arg);
            case 'dateAfter':
                return s.tick >= dateToTicks(s, arg);
            case 'dateBefore':
                return s.tick <= dateToTicks(s, arg);
            default:
                // 未知条件视为不满足，并在开发模式提示（避免静默放行）
                if (ctx?.strict) console.warn('[conditions] 未知条件字段:', key, arg);
                return false;
        }
    }
    return false;
}

/** 求值完整 trigger（可为空 = 恒真） */
export function evalTrigger(trigger, s, ctx, scopeTag) {
    if (!trigger) return true;
    return evalCond(trigger, s, ctx, scopeTag);
}
