/* ============================================================
 * 战役核心 · 规则与效果（rules.js）
 * 命令执行后级联触发规则，统一用 pending 队列在 tick 末尾排空，
 * 避免递归改状态导致顺序不确定。
 * 效果（effects）是命令的宏：展开为 Command 走统一入口，保证日志完整。
 * ============================================================ */

import { applyCommand } from './commands.js';
import { recomputeVictoryPoints, clearAtWar } from './state.js';
import { FP_SCALE, fpAddClamp01, orderedKeys } from './determinism.js';
import { formatDate, parseDate } from './clock.js';

export const RULES = {};

/** 注册规则：kind -> fn(payload, s, ctx) */
export function registerRule(kind, fn) {
    RULES[kind] = fn;
}

/** 入队待处理规则 */
export function enqueue(s, kind, payload) {
    s.pending.push({ kind, payload });
}

/** 排空待处理队列（每个规则内部只改状态或继续入队） */
export function drainPending(s, ctx) {
    while (s.pending.length) {
        const job = s.pending.shift();
        const fn = RULES[job.kind];
        if (fn) fn(job.payload, s, ctx);
        else console.warn('[rules] 未注册的规则:', job.kind);
    }
}

/**
 * 效果展开：把声明式效果应用到状态。
 * 复合效果（annex / declareWar）展开为 Command，其余为状态字段修正。
 * @param {Array} effects
 * @param {object} opts { country } 效果作用对象
 */
export function applyEffects(effects, s, ctx, opts = {}) {
    // 兼容单效果对象（如任务奖励）与效果数组（如国策/事件选项）
    const list = Array.isArray(effects) ? effects : (effects ? [effects] : []);
    for (const e of list) {
        if (e.annex) {
            // { annex: [tag, stateId] } → assignOwner 命令
            const [tag, stateId] = e.annex;
            applyCommand({ t: 'assignOwner', state: stateId, to: tag, reason: 'effect:annex' }, s, ctx);
        } else if (e.declareWar) {
            const [a, b] = e.declareWar;
            applyCommand({ t: 'declareWar', from: a, to: b }, s, ctx);
        } else if (e.civs !== undefined) {
            s.countries[opts.country].civs += e.civs;
        } else if (e.mils !== undefined) {
            s.countries[opts.country].mils += e.mils;
        } else if (e.docks !== undefined) {
            s.countries[opts.country].docks += e.docks;
        } else if (e.manpower !== undefined) {
            s.countries[opts.country].manpower += e.manpower;
        } else if (e.politicalPower !== undefined) {
            s.countries[opts.country].politicalPower += e.politicalPower;
        } else if (e.stability !== undefined) {
            s.countries[opts.country].stability = fpAddClamp01(s.countries[opts.country].stability, Math.round(e.stability * FP_SCALE));
        } else if (e.warSupport !== undefined) {
            s.countries[opts.country].warSupport = fpAddClamp01(s.countries[opts.country].warSupport, Math.round(e.warSupport * FP_SCALE));
        } else if (e.legitimacy !== undefined) {
            s.countries[opts.country].legitimacy = fpAddClamp01(s.countries[opts.country].legitimacy, Math.round(e.legitimacy * FP_SCALE));
        } else if (e.relation) {
            const [from, to, amt] = e.relation;
            const rel = s.countries[from].relations[to] ?? 0;
            s.countries[from].relations[to] = Math.max(-100, Math.min(100, rel + amt));
        } else if (e.researchBonus) {
            const { techId, amount } = e.researchBonus;
            s.countries[opts.country].researchProgress[techId] =
                (s.countries[opts.country].researchProgress[techId] ?? 0) + amount;
        } else if (e.flags) {
            Object.assign(s.countries[opts.country].flags, e.flags);
        }
    }
}

/** 省份 → 所属州（线性查找，州数量少时足够；量大时建倒排索引） */
function stateOfProvince(s, pid) {
    for (const st of Object.values(s.states)) {
        if (st.provinces.includes(pid)) return st;
    }
    return null;
}

/** 该国家当前控制的省份数（用于 surrender 判定） */
function controlledProvinceCount(s, tag) {
    let n = 0;
    for (const p of Object.values(s.provinces)) {
        if (p.controller === tag) n++;
    }
    return n;
}

/** 胜负条件求值（只读，不产生副作用） */
export function checkVictoryCondition(s, cond, tag) {
    const tryType = (type) => {
        switch (type) {
            case 'controlVP': {
                const targets = cond.targets;
                if (!targets) return false;
                for (const [pid, need] of Object.entries(targets)) {
                    const st = stateOfProvince(s, Number(pid));
                    if (!st || st.owner !== tag || st.victoryPoints < need) return false;
                }
                return true;
            }
            case 'controlState': {
                const states = cond.states;
                if (!Array.isArray(states)) return false;
                return states.every((sid) => s.states[sid] && s.states[sid].owner === tag);
            }
            case 'survive': {
                if (!cond.until) return false;
                return s.tick >= ticksOf(s, cond.until);
            }
            case 'surrender': {
                // 任一其他玩家国家已无任何省份控制权 → 判定为该方获胜
                const players = Object.keys(s.players);
                return players.some((p) => p !== tag && controlledProvinceCount(s, p) === 0);
            }
            default:
                return false;
        }
    };
    if (tryType(cond.type)) return true;
    for (const alt of cond.or || []) {
        if (tryType(alt)) return true;
    }
    return false;
}

function ticksOf(s, dateStr) {
    return Math.round((parseDate(dateStr).getTime() - parseDate(s.startDate).getTime()) / (5 * 60000));
}

/** 任务目标求值：返回 'complete' | 'fail' | null */
function evalMissionObjective(s, objective, tag) {
    switch (objective.type) {
        case 'controlState':
            return s.states[objective.state]?.owner === tag ? 'complete' : null;
        case 'controlVP': {
            for (const [pid, need] of Object.entries(objective.targets || {})) {
                const st = stateOfProvince(s, Number(pid));
                if (!st || st.owner !== tag || st.victoryPoints < need) return null;
            }
            return 'complete';
        }
        case 'survive': {
            if (objective.until && s.tick >= ticksOf(s, objective.until)) return 'complete';
            if (objective.failAfter && s.tick >= ticksOf(s, objective.failAfter)) return 'fail';
            return null;
        }
        default:
            return null;
    }
}

function pushHistory(s, text) {
    s.history.push({ tick: s.tick, date: formatDate(new Date(parseDate(s.startDate).getTime() + s.tick * 5 * 60000)), text });
}

/** 内置规则集合 */
export function installCoreRules() {
    if (installCoreRules._done) return;
    installCoreRules._done = true;

    // 州归属变更 → 州内省份控制方同步转移 → 重算 VP → 任务重估 → 胜负重判
    registerRule('ownerChanged', ({ state, to, reason }, s, ctx) => {
        const st = s.states[state];
        if (!st) return;
        const from = st.owner;
        st.owner = to;
        // 无战斗结算的吞并语义：州归属变更时，州内省份的实际控制方同步转移
        for (const pid of st.provinces) {
            const p = s.provinces[pid];
            if (p) p.controller = to;
        }
        recomputeVictoryPoints(s);
        if (from !== to) {
            pushHistory(s, `州 ${state} 归属由 ${from || '无'} 变更为 ${to}${reason ? `（${reason}）` : ''}`);
        }
        enqueue(s, 'missionEval', {});
    });

    // 战争开始 → 历史记录 → 任务重估
    registerRule('warStarted', ({ a, b }, s) => {
        pushHistory(s, `${a} 对 ${b} 宣战，战争状态开始`);
        enqueue(s, 'missionEval', {});
    });

    // 国策完成 → 标记完成 → 应用效果 → 任务重估
    registerRule('focusCompleted', ({ tag, focusId }, s, ctx) => {
        const c = s.countries[tag];
        const tree = ctx.focusTrees?.[c.focusTree];
        const node = tree?.nodes?.[focusId];
        c.activeFocus = null;
        if (node) {
            if (!s.focuses[tag].done.includes(focusId)) s.focuses[tag].done.push(focusId);
            applyEffects(node.effects || [], s, ctx, { country: tag });
            pushHistory(s, `${tag} 完成国策：${focusId}`);
        }
        enqueue(s, 'missionEval', {});
    });

    // 任务评估：完成给奖励，超时失败
    registerRule('missionEval', (_, s, ctx) => {
        for (const tag of orderedKeys(s.missions)) {
            for (const m of s.missions[tag]) {
                if (m.status !== 'active') continue;
                // 超时失败（如 dateAfter）
                if (m.fail?.type === 'dateAfter' && s.tick >= ticksOf(s, m.fail.value)) {
                    m.status = 'failed';
                    pushHistory(s, `${tag} 任务失败：${m.id}（超过期限 ${m.fail.value}）`);
                    continue;
                }
                const verdict = evalMissionObjective(s, m.objective, tag);
                if (verdict === 'complete') {
                    m.status = 'completed';
                    if (m.reward) applyEffects(m.reward, s, ctx, { country: tag });
                    pushHistory(s, `${tag} 完成任务：${m.id}`);
                } else if (verdict === 'fail') {
                    m.status = 'failed';
                    pushHistory(s, `${tag} 任务失败：${m.id}`);
                }
            }
        }
        enqueue(s, 'victoryCheck', {});
    });

    // 胜负判定：每月随任务评估触发；结果写入 history，由 Campaign 暂停时钟
    registerRule('victoryCheck', (_, s, ctx) => {
        if (s.victory) return;
        const conds = ctx.scenario?.victoryConditions || {};
        for (const tag of orderedKeys(conds)) {
            if (checkVictoryCondition(s, conds[tag], tag)) {
                s.victory = { winner: tag, tick: s.tick, type: conds[tag].type };
                pushHistory(s, `胜负判定：${tag} 达成胜利条件（${conds[tag].type}）`);
                return;
            }
        }
    });
}
