/* ============================================================
 * 战役核心 · 命令管道（commands.js）
 * 所有状态变更的唯一入口。UI 不得直接改字段。
 *   validateCommand —— 纯函数，UI 用它决定按钮禁用态
 *   executeCommand  —— 只改状态，可级联的规则只入队不递归执行
 *   applyCommand    —— validate → execute → 记日志 → 通知渲染层
 * ============================================================ */

import { TICKS_PER_DAY } from './clock.js';
import { FP_SCALE, fpAddClamp01, orderedKeys } from './determinism.js';
import { evalTrigger } from '../content/conditions.js';

/**
 * 命令联合类型（文档用，运行时无约束）：
 * assignOwner | setController | chooseFocus | cancelFocus | startConstruction
 * allocateFactory | startResearch | investPP | improveRelations | joinFaction
 * declareWar | makePeace | triggerEvent | executeDecision | debug
 */

/** 校验失败返回 { ok:false, err }，通过返回 null */
export function validateCommand(cmd, s, ctx) {
    if (!cmd || typeof cmd.t !== 'string') return { ok: false, err: '非法命令：缺少 t 字段' };

    const countryExists = (tag) => s.countries[tag] !== undefined;

    switch (cmd.t) {
        case 'assignOwner': {
            if (!s.states[cmd.state]) return err(`州不存在: ${cmd.state}`);
            if (!countryExists(cmd.to)) return err(`国家不存在: ${cmd.to}`);
            return null;
        }
        case 'setController': {
            if (!s.provinces[cmd.province]) return err(`省份不存在: ${cmd.province}`);
            if (!countryExists(cmd.to)) return err(`国家不存在: ${cmd.to}`);
            return null;
        }
        case 'chooseFocus': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const c = s.countries[cmd.country];
            if (!c.focusTree) return err(`国家 ${cmd.country} 无国策树`);
            const tree = ctx.focusTrees?.[c.focusTree];
            if (!tree) return err(`国策树缺失: ${c.focusTree}`);
            const node = tree.nodes?.[cmd.focusId];
            if (!node) return err(`国策节点不存在: ${cmd.focusId}`);
            if (c.activeFocus) return err(`国家 ${cmd.country} 已有进行中的国策`);
            for (const pre of node.prerequisites || []) {
                if (!(s.focuses[cmd.country]?.done || []).includes(pre)) {
                    return err(`国策前置未满足: ${pre}`);
                }
            }
            for (const [k, v] of Object.entries(node.requires || {})) {
                if ((c[k] ?? 0) < v) return err(`国策要求未满足: ${k} >= ${v}`);
            }
            if ((c.politicalPower ?? 0) < (node.cost ?? 0)) return err(`政治点数不足: 需要 ${node.cost}`);
            return null;
        }
        case 'cancelFocus': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            if (!s.countries[cmd.country].activeFocus) return err(`国家 ${cmd.country} 无进行中的国策`);
            return null;
        }
        case 'startConstruction': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            if (!cmd.kind || typeof cmd.kind !== 'string') return err('建造类型缺失');
            if (!s.states[cmd.state]) return err(`州不存在: ${cmd.state}`);
            return null;
        }
        case 'allocateFactory': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            if (!cmd.line || typeof cmd.line.equipment !== 'string') return err('生产线分配缺少 equipment');
            return null;
        }
        case 'startResearch': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const c = s.countries[cmd.country];
            if (!(cmd.techId in (c.research || {}))) return err(`科技不存在: ${cmd.techId}`);
            if ((s.research[cmd.country]?.researching || []).some((r) => r.techId === cmd.techId)) {
                return err(`科技已在研究中: ${cmd.techId}`);
            }
            if ((s.research[cmd.country]?.researching || []).length >= (c.researchSlots ?? 0)) {
                return err('研究槽已满');
            }
            return null;
        }
        case 'investPP': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const validTargets = ['stability', 'warSupport', 'legitimacy'];
            if (!validTargets.includes(cmd.target)) return err(`投资目标非法: ${cmd.target}`);
            if (!Number.isFinite(cmd.amount) || cmd.amount <= 0) return err('投资额度必须为正数');
            if ((s.countries[cmd.country].politicalPower ?? 0) < cmd.amount) return err('政治点数不足');
            return null;
        }
        case 'improveRelations': {
            if (!countryExists(cmd.from) || !countryExists(cmd.to)) return err('国家不存在');
            if (!Number.isFinite(cmd.amount) || cmd.amount === 0) return err('关系修正必须非零');
            return null;
        }
        case 'joinFaction': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            if (!s.alliances.some((a) => a.id === cmd.faction)) return err(`阵营不存在: ${cmd.faction}`);
            return null;
        }
        case 'declareWar': {
            if (!countryExists(cmd.from) || !countryExists(cmd.to)) return err('国家不存在');
            if (cmd.from === cmd.to) return err('不能对自己宣战');
            const already = s.wars.some((w) => w.status === 'active' &&
                ((w.a === cmd.from && w.b === cmd.to) || (w.a === cmd.to && w.b === cmd.from)));
            if (already) return err('两国已处于战争状态');
            return null;
        }
        case 'makePeace': {
            if (!countryExists(cmd.from) || !countryExists(cmd.to)) return err('国家不存在');
            const war = s.wars.find((w) => w.status === 'active' &&
                ((w.a === cmd.from && w.b === cmd.to) || (w.a === cmd.to && w.b === cmd.from)));
            if (!war) return err('两国之间没有进行中的战争');
            return null;
        }
        case 'triggerEvent': {
            if (!ctx.events?.[cmd.eventId]) return err(`事件不存在: ${cmd.eventId}`);
            const ev = ctx.events[cmd.eventId];
            if (cmd.option !== undefined && (cmd.option < 0 || cmd.option >= (ev.options?.length || 0))) {
                return err(`事件选项越界: ${cmd.option}`);
            }
            return null;
        }
        case 'executeDecision': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const dec = ctx.decisions?.[cmd.decisionId];
            if (!dec) return err(`决议不存在: ${cmd.decisionId}`);
            if (dec.scope !== 'any' && dec.scope !== cmd.country) return err('决议不适用于该国');
            if (!evalTrigger(dec.trigger, s, ctx, cmd.country)) return err('决议触发条件未满足');
            const cost = dec.cost?.politicalPower ?? 0;
            if ((s.countries[cmd.country].politicalPower ?? 0) < cost) return err('政治点数不足以执行决议');
            const ds = s.decisions[cmd.country];
            const lastTick = ds.lastExecuted[cmd.decisionId];
            const cooldownTicks = (dec.cooldown ?? 0) * TICKS_PER_DAY;
            if (lastTick !== undefined && s.tick - lastTick < cooldownTicks) return err('决议冷却中');
            if (!dec.repeatable && (ds.count[cmd.decisionId] ?? 0) > 0) return err('决议不可重复执行');
            return null;
        }
        case 'debug':
            return null;
        default:
            return err(`未知命令类型: ${cmd.t}`);
    }
}

function err(message) {
    return { ok: false, err: message };
}

/** 执行命令：只改状态。级联规则只入队（s.pending），由 drainPending 统一排空 */
export function executeCommand(cmd, s, ctx) {
    switch (cmd.t) {
        case 'assignOwner':
            // 实际归属变更由 ownerChanged 规则完成（级联：任务重估 → 胜负判定）
            s.pending.push({ kind: 'ownerChanged', payload: { state: cmd.state, to: cmd.to, reason: cmd.reason || '' } });
            break;

        case 'setController':
            s.provinces[cmd.province].controller = cmd.to;
            break;

        case 'chooseFocus': {
            const c = s.countries[cmd.country];
            const node = ctx.focusTrees[c.focusTree].nodes[cmd.focusId];
            c.politicalPower -= node.cost ?? 0;
            c.activeFocus = {
                id: cmd.focusId,
                progress: 0,
                totalTicks: (node.days ?? 0) * TICKS_PER_DAY,
            };
            break;
        }

        case 'cancelFocus':
            s.countries[cmd.country].activeFocus = null;
            break;

        case 'startConstruction':
            s.countries[cmd.country].construction.push({
                kind: cmd.kind, state: cmd.state, progress: 0,
            });
            break;

        case 'allocateFactory':
            s.countries[cmd.country].production = [{
                equipment: cmd.line.equipment,
                priority: cmd.line.priority ?? 1,
            }];
            break;

        case 'startResearch':
            s.research[cmd.country].researching.push({
                techId: cmd.techId,
                progress: s.countries[cmd.country].research[cmd.techId] ?? 0,
            });
            break;

        case 'investPP': {
            const c = s.countries[cmd.country];
            c.politicalPower -= cmd.amount;
            c[cmd.target] = fpAddClamp01(c[cmd.target], Math.round(cmd.amount));
            break;
        }

        case 'improveRelations': {
            const rel = s.countries[cmd.from].relations[cmd.to] ?? 0;
            s.countries[cmd.from].relations[cmd.to] = Math.max(-100, Math.min(100, rel + cmd.amount));
            break;
        }

        case 'joinFaction': {
            const c = s.countries[cmd.country];
            c.faction = cmd.faction;
            const fac = s.alliances.find((a) => a.id === cmd.faction);
            if (fac && !fac.members.includes(cmd.country)) fac.members.push(cmd.country);
            break;
        }

        case 'declareWar': {
            s.wars.push({
                id: s.nextWarId++,
                a: cmd.from, b: cmd.to,
                startedAt: s.tick,
                justification: cmd.justification || '',
                warScore: 0,
                status: 'active',
            });
            markAtWarFlags(s, cmd.from, cmd.to);
            s.pending.push({ kind: 'warStarted', payload: { a: cmd.from, b: cmd.to } });
            break;
        }

        case 'makePeace': {
            const war = s.wars.find((w) => w.status === 'active' &&
                ((w.a === cmd.from && w.b === cmd.to) || (w.a === cmd.to && w.b === cmd.from)));
            if (war) {
                war.status = 'ended';
                markAtWarFlags(s, cmd.from, cmd.to, false);
            }
            break;
        }

        case 'triggerEvent': {
            const ev = ctx.events[cmd.eventId];
            const opt = cmd.option !== undefined ? ev.options[cmd.option] : ev.options[0];
            if (opt?.effects && ctx.applyEffects) {
                ctx.applyEffects(opt.effects, s, ctx, { country: ev.scope });
            }
            if (ev.once && !s.events.triggered.includes(cmd.eventId)) {
                s.events.triggered.push(cmd.eventId);
            }
            break;
        }

        case 'executeDecision': {
            const dec = ctx.decisions[cmd.decisionId];
            const c = s.countries[cmd.country];
            c.politicalPower -= dec.cost?.politicalPower ?? 0;
            if (ctx.applyEffects) ctx.applyEffects(dec.effects || [], s, ctx, { country: cmd.country });
            const ds = s.decisions[cmd.country];
            ds.lastExecuted[cmd.decisionId] = s.tick;
            ds.count[cmd.decisionId] = (ds.count[cmd.decisionId] ?? 0) + 1;
            break;
        }

        case 'debug':
            if (cmd.payload?.effects && ctx.applyEffects) {
                ctx.applyEffects(cmd.payload.effects, s, ctx, { country: cmd.payload.country });
            }
            break;
    }
}

function markAtWarFlags(s, a, b, value = true) {
    if (s.countries[a]) s.countries[a].flags.atWar = value;
    if (s.countries[b]) s.countries[b].flags.atWar = value;
}

/**
 * 命令唯一入口：校验 → 执行 → 记日志 → 通知。
 * @returns {{ok: true} | {ok: false, err: string}}
 */
export function applyCommand(cmd, s, ctx) {
    const err = validateCommand(cmd, s, ctx);
    if (err) return err;
    executeCommand(cmd, s, ctx);
    s.log.push({ seq: s.nextCmdSeq++, tick: s.tick, cmd });
    if (ctx.onChange) ctx.onChange(cmd, s);
    return { ok: true };
}

/** 按顺序重放命令日志（回放/联机校正用） */
export function replayCommands(commands, s, ctx) {
    for (const entry of commands) {
        const r = applyCommand(entry.cmd ?? entry, s, ctx);
        if (!r.ok) return r;
    }
    return { ok: true };
}

export { orderedKeys };
