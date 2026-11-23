/* ============================================================
 * 战役核心 · 命令管道（commands.js）
 * 所有状态变更的唯一入口。UI 不得直接改字段。
 *   validateCommand —— 纯函数，UI 用它决定按钮禁用态
 *   executeCommand  —— 只改状态，可级联的规则只入队不递归执行
 *   applyCommand    —— validate → execute → 记日志 → 通知渲染层
 * ============================================================ */

import { TICK_GAME_DAYS } from './clock.js';
import { FP_SCALE, fpAddClamp01, orderedKeys } from './determinism.js';
import { evalTrigger } from '../content/conditions.js';
import { CONSTRUCTION } from './economy.js';
import { terrainMoveCost } from './war.js';

/** 合法的建造类型（与 economy.js 的 CONSTRUCTION 定义同源） */
export const CONSTRUCTION_KINDS = Object.keys(CONSTRUCTION);

/** 部队指令 */
export const ARMY_ORDERS = ['hold', 'advance', 'retreat'];

/** 邻接判定：目标省份是否与当前省份相邻（同省视为可移动） */
export function isAdjacent(ctx, fromId, toId) {
    if (Number(fromId) === Number(toId)) return true;
    const neighbors = ctx.neighbors;
    if (!neighbors) return false;
    const list = neighbors[String(fromId)] ?? neighbors[fromId];
    if (!list) return false;
    return list.some((n) => Number(n) === Number(toId));
}

/**
 * BFS 寻路：沿己方控制的省份向目标推进，最后一步允许进入非己方省份（进攻）。
 * 返回省份 id 数组（含起点与终点）；无通路时返回 null。
 */
export function planPath(s, ctx, fromId, toId, tag) {
    const neighbors = ctx.neighbors;
    if (!neighbors) return null;
    if (Number(fromId) === Number(toId)) return [fromId];
    const visited = new Set([fromId]);
    const prev = new Map();
    const queue = [fromId];
    let head = 0;
    while (head < queue.length) {
        const pid = queue[head++];
        for (const nid of neighbors[String(pid)] || []) {
            if (visited.has(nid)) continue;
            const isTarget = Number(nid) === Number(toId);
            if (!isTarget) {
                const p = s.provinces[nid];
                // 只能在己方控制的省份中穿行
                if (!p || p.controller !== tag) continue;
            }
            visited.add(nid);
            prev.set(nid, pid);
            if (isTarget) {
                const path = [nid];
                let cur = pid;
                while (cur !== undefined) { path.unshift(cur); cur = prev.get(cur); }
                return path;
            }
            queue.push(nid);
        }
    }
    return null;
}

/** 执行一次移动（含地形移动代价），并把战斗结算排入 pending 队列 */
function applyMove(s, ctx, army, to) {
    army.provinceId = to;
    const province = s.provinces[to];
    const cost = terrainMoveCost(province?.terrain);
    if (cost > 1) {
        // 进入山地/森林/沙漠等复杂地形要付出组织度代价
        army.org = Math.max(0, Math.min(1, army.org - 0.02 * (cost - 1)));
    }
    s.pending.push({ kind: 'battleAt', payload: { provinceId: to } });
}

/** 命令联合类型（文档用，运行时无约束）：
 *  assignOwner | setController | chooseFocus | cancelFocus | startConstruction
 *  allocateFactory | startResearch | investPP | improveRelations | joinFaction
 *  declareWar | makePeace | triggerEvent | executeDecision | debug
 *  deployArmy | moveArmy | disbandArmy | setArmyOrder | moveArmyTo
 *  deployAirForce | moveAirForce | disbandAirForce
 *  deployFleet | moveFleet | disbandFleet
 *  toggleProduction | cancelConstruction | lendLease
 *  inviteFaction | acceptFactionInvite | rejectFactionInvite | leaveFaction | setFactionLeader
 *  proposePeace | addWarGoal
 */

/** 校验失败返回 { ok:false, err }，通过返回 null */
export function validateCommand(cmd, s, ctx) {
    if (!cmd || typeof cmd.t !== 'string') return { ok: false, err: '非法命令：缺少 t 字段' };

    // 外交命令由 diplomacy.js 提供校验（通过注册钩子注入）
    if (DIPLOMACY_COMMAND_TYPES.includes(cmd.t)) {
        if (!diplomacyHook) return diplomacyError(cmd);
        return diplomacyHook.validate(cmd, s, ctx);
    }

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
            if (!CONSTRUCTION_KINDS.includes(cmd.kind)) return err(`未知建造类型: ${cmd.kind}`);
            if (cmd.state !== undefined && !s.states[cmd.state]) return err(`州不存在: ${cmd.state}`);
            if (cmd.province !== undefined && !s.provinces[cmd.province]) return err(`省份不存在: ${cmd.province}`);
            return null;
        }
        case 'allocateFactory': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            if (!cmd.line || typeof cmd.line.equipment !== 'string') return err('生产线分配缺少 equipment');
            if (!ctx.equipment?.[cmd.line.equipment]) return err(`装备不存在: ${cmd.line.equipment}`);
            return null;
        }
        case 'startResearch': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const c = s.countries[cmd.country];
            if (!ctx.techs?.[cmd.techId]) return err(`科技不存在: ${cmd.techId}`);
            if ((c.tech || {})[cmd.techId]) return err(`科技已完成: ${cmd.techId}`);
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
            const war = s.wars.find((w) => (w.status === 'active' || w.status === 'peacePending') &&
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
            const cooldownTicks = Math.round((dec.cooldown ?? 0) / TICK_GAME_DAYS);
            if (lastTick !== undefined && s.tick - lastTick < cooldownTicks) return err('决议冷却中');
            if (!dec.repeatable && (ds.count[cmd.decisionId] ?? 0) > 0) return err('决议不可重复执行');
            return null;
        }
        case 'cancelProduction': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const queue = s.countries[cmd.country].production || [];
            if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= queue.length) {
                return err('生产线序号越界');
            }
            return null;
        }
        case 'adjustProduction': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const queue = s.countries[cmd.country].production || [];
            if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= queue.length) {
                return err('生产线序号越界');
            }
            const factories = Math.floor(cmd.factories);
            if (factories < 1 || factories > (s.countries[cmd.country].mils || 0)) {
                return err('分配工厂数超出军用工厂数量');
            }
            return null;
        }
        case 'deployArmy': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const c = s.countries[cmd.country];
            const tpl = ctx.divisions?.[cmd.template];
            if (!tpl) return err(`部队模板不存在: ${cmd.template}`);
            if (!(c.unlockedTemplates || []).includes(cmd.template)) return err(`未解锁该部队模板: ${cmd.template}`);
            if (!s.provinces[cmd.province]) return err(`省份不存在: ${cmd.province}`);
            if (s.provinces[cmd.province].controller !== cmd.country) return err('只能在控制的省份部署部队');
            const count = Math.floor(cmd.count || 1);
            if (count < 1) return err('部署数量必须为正数');
            if ((c.manpower || 0) < tpl.cost.manpower * count) return err('人力不足');
            for (const [eqId, need] of Object.entries(tpl.cost.equipment || {})) {
                if ((c.equipment?.[eqId] || 0) < need * count) return err(`装备不足: ${eqId}`);
            }
            return null;
        }
        case 'moveArmy': {
            if (!s.armies?.some((a) => a.id === cmd.armyId)) return err(`部队不存在: ${cmd.armyId}`);
            const army = s.armies.find((a) => a.id === cmd.armyId);
            if (cmd.country && army.owner !== cmd.country) return err('部队不属于该国');
            if (!s.provinces[cmd.to]) return err(`目标省份不存在: ${cmd.to}`);
            if (!isAdjacent(ctx, army.provinceId, cmd.to)) return err('目标省份不相邻');
            return null;
        }
        case 'disbandArmy': {
            if (!s.armies?.some((a) => a.id === cmd.armyId)) return err(`部队不存在: ${cmd.armyId}`);
            return null;
        }
        case 'setArmyOrder': {
            if (!s.armies?.some((a) => a.id === cmd.armyId)) return err(`部队不存在: ${cmd.armyId}`);
            if (!ARMY_ORDERS.includes(cmd.order)) return err(`非法部队指令: ${cmd.order}`);
            return null;
        }
        case 'moveArmyTo': {
            if (!s.armies?.some((a) => a.id === cmd.armyId)) return err(`部队不存在: ${cmd.armyId}`);
            if (!s.provinces[cmd.to]) return err(`目标省份不存在: ${cmd.to}`);
            const army = s.armies.find((a) => a.id === cmd.armyId);
            const path = planPath(s, ctx, army.provinceId, cmd.to, army.owner);
            if (!path || path.length < 2) return err('目标不可达（中间需经过己方控制省份）');
            return null;
        }
        case 'deployAirForce': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const c = s.countries[cmd.country];
            const tpl = ctx.aircraft?.[cmd.template];
            if (!tpl) return err(`飞机型号不存在: ${cmd.template}`);
            if (!(c.unlockedAir || []).includes(cmd.template)) return err(`未解锁该飞机型号: ${cmd.template}`);
            if (!s.provinces[cmd.province]) return err(`省份不存在: ${cmd.province}`);
            if (s.provinces[cmd.province].controller !== cmd.country) return err('只能在控制的省份部署空军');
            const count = Math.floor(cmd.count || 1);
            if (count < 1) return err('部署数量必须为正数');
            const need = equipmentNeed(tpl, count);
            for (const [eqId, n] of Object.entries(need)) {
                if ((c.equipment?.[eqId] || 0) < n) return err(`装备不足: ${eqId}`);
            }
            return null;
        }
        case 'moveAirForce': {
            if (!s.airForces?.some((g) => g.id === cmd.airId)) return err(`空军不存在: ${cmd.airId}`);
            if (!s.provinces[cmd.to]) return err(`目标省份不存在: ${cmd.to}`);
            if (!isAdjacent(ctx, s.airForces.find((g) => g.id === cmd.airId).provinceId, cmd.to)) {
                return err('目标省份不相邻');
            }
            return null;
        }
        case 'disbandAirForce': {
            if (!s.airForces?.some((g) => g.id === cmd.airId)) return err(`空军不存在: ${cmd.airId}`);
            return null;
        }
        case 'deployFleet': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const c = s.countries[cmd.country];
            const tpl = ctx.ships?.[cmd.template];
            if (!tpl) return err(`舰种不存在: ${cmd.template}`);
            if (!(c.unlockedShips || []).includes(cmd.template)) return err(`未解锁该舰种: ${cmd.template}`);
            if (!s.provinces[cmd.province]) return err(`省份不存在: ${cmd.province}`);
            const prov = s.provinces[cmd.province];
            if (!prov.coastal) return err('舰队只能部署在沿海省份');
            if (prov.controller !== cmd.country) return err('只能在控制的沿海省份部署舰队');
            const count = Math.floor(cmd.count || 1);
            if (count < 1) return err('部署数量必须为正数');
            const need = equipmentNeed(tpl, count);
            for (const [eqId, n] of Object.entries(need)) {
                if ((c.equipment?.[eqId] || 0) < n) return err(`装备不足: ${eqId}`);
            }
            return null;
        }
        case 'moveFleet': {
            if (!s.fleets?.some((f) => f.id === cmd.fleetId)) return err(`舰队不存在: ${cmd.fleetId}`);
            if (!s.provinces[cmd.to]) return err(`目标省份不存在: ${cmd.to}`);
            const target = s.provinces[cmd.to];
            if (!target.coastal && target.terrain !== 'sea' && target.terrain !== 'ocean') {
                return err('舰队只能进入沿海或海域省份');
            }
            const fleet = s.fleets.find((f) => f.id === cmd.fleetId);
            if (!isAdjacent(ctx, fleet.provinceId, cmd.to)) return err('目标省份不相邻');
            return null;
        }
        case 'disbandFleet': {
            if (!s.fleets?.some((f) => f.id === cmd.fleetId)) return err(`舰队不存在: ${cmd.fleetId}`);
            return null;
        }
        case 'toggleProduction': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const queue = s.countries[cmd.country].production || [];
            if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= queue.length) {
                return err('生产线序号越界');
            }
            return null;
        }
        case 'cancelConstruction': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const queue = s.countries[cmd.country].construction || [];
            if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= queue.length) {
                return err('建造队列序号越界');
            }
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

/** 计算一次部署所需的装备总量：单件消耗 × 每编组数量 × 编组数 */
function equipmentNeed(tpl, count) {
    const out = {};
    const perGroup = tpl.planes ?? tpl.ships ?? 1;
    for (const [eqId, per] of Object.entries(tpl.cost?.equipment || {})) {
        out[eqId] = per * perGroup * count;
    }
    return out;
}

/**
 * 外交命令的挂载点。
 * 外交命令的校验与执行在 diplomacy.js 中实现，为避免 commands ↔ diplomacy 的
 * 循环依赖，这里只保留一个注册钩子，由 rules.js 在初始化时注入。
 */
let diplomacyHook = null;

/** 注册外交命令处理器（由 diplomacy.js 调用） */
export function registerDiplomacyHook(handlers) {
    diplomacyHook = handlers;
}

/** 外交命令类型（校验与执行都走挂载的钩子） */
export const DIPLOMACY_COMMAND_TYPES = [
    'inviteFaction', 'acceptFactionInvite', 'rejectFactionInvite', 'leaveFaction',
    'setFactionLeader', 'lendLease', 'proposePeace', 'acceptPeace', 'rejectPeace',
    'addWarGoal',
];

function diplomacyError(cmd) {
    return { ok: false, err: `外交命令未注册: ${cmd.t}` };
}

/** 执行命令：只改状态。级联规则只入队（s.pending），由 drainPending 统一排空 */
export function executeCommand(cmd, s, ctx) {
    // 外交命令由 diplomacy.js 执行（校验已在 validateCommand 中委托）
    if (DIPLOMACY_COMMAND_TYPES.includes(cmd.t)) {
        if (!diplomacyHook) return;
        diplomacyHook.execute(cmd, s, ctx);
        return;
    }
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
                totalTicks: Math.round((node.days ?? 0) / TICK_GAME_DAYS),
            };
            break;
        }

        case 'cancelFocus':
            s.countries[cmd.country].activeFocus = null;
            break;

        case 'startConstruction':
            s.countries[cmd.country].construction.push({
                kind: cmd.kind, state: cmd.state ?? null, province: cmd.province ?? null,
                progress: 0, total: 0,
            });
            break;

        case 'allocateFactory': {
            // 追加到生产线队列（而非覆盖），保留已有的生产线
            const queue = s.countries[cmd.country].production;
            const existing = queue.find((l) => l.equipment === cmd.line.equipment);
            if (existing) {
                existing.factories = (existing.factories || 1) + (cmd.line.factories || 1);
            } else {
                queue.push({
                    equipment: cmd.line.equipment,
                    priority: cmd.line.priority ?? 1,
                    factories: cmd.line.factories || 1,
                    progress: 0,
                    disabled: false,
                });
            }
            break;
        }

        case 'cancelProduction': {
            s.countries[cmd.country].production.splice(cmd.index, 1);
            break;
        }

        case 'adjustProduction': {
            s.countries[cmd.country].production[cmd.index].factories = Math.floor(cmd.factories);
            break;
        }

        case 'deployArmy': {
            const c = s.countries[cmd.country];
            const tpl = ctx.divisions[cmd.template];
            const count = Math.floor(cmd.count || 1);
            c.manpower -= tpl.cost.manpower * count;
            for (const [eqId, need] of Object.entries(tpl.cost.equipment || {})) {
                c.equipment[eqId] = (c.equipment[eqId] || 0) - need * count;
            }
            for (let i = 0; i < count; i++) {
                s.armies.push({
                    id: s.nextArmyId++,
                    owner: cmd.country,
                    provinceId: cmd.province,
                    template: cmd.template,
                    strength: tpl.baseStrength,
                    org: tpl.org ?? 1,
                    speed: tpl.speed,
                    experience: 0,
                    order: 'hold',
                });
            }
            break;
        }

        case 'moveArmy': {
            const army = s.armies.find((a) => a.id === cmd.armyId);
            applyMove(s, ctx, army, cmd.to);
            break;
        }

        case 'setArmyOrder': {
            const army = s.armies.find((a) => a.id === cmd.armyId);
            army.order = cmd.order;
            break;
        }

        case 'moveArmyTo': {
            // 沿寻路结果连续推进，每步都走正式命令（保留日志与战斗结算）
            const army = s.armies.find((a) => a.id === cmd.armyId);
            const path = planPath(s, ctx, army.provinceId, cmd.to, army.owner);
            if (!path || path.length < 2) break;
            const steps = Math.max(1, Math.min(8, Math.floor(cmd.steps ?? 5)));
            for (let i = 1; i < path.length && i <= steps; i++) {
                // 进入非己方省份后停止推进（进入即交战，由 battleAt 结算）
                if (i > 1) {
                    const p = s.provinces[path[i]];
                    if (!p || p.controller !== army.owner) break;
                }
                applyCommand({ t: 'moveArmy', armyId: army.id, to: path[i], country: army.owner }, s, ctx);
            }
            break;
        }

        case 'disbandArmy': {
            const i = s.armies.findIndex((a) => a.id === cmd.armyId);
            if (i >= 0) s.armies.splice(i, 1);
            break;
        }

        case 'deployAirForce': {
            const c = s.countries[cmd.country];
            const tpl = ctx.aircraft[cmd.template];
            const count = Math.floor(cmd.count || 1);
            const need = equipmentNeed(tpl, count);
            for (const [eqId, n] of Object.entries(need)) {
                c.equipment[eqId] = (c.equipment[eqId] || 0) - n;
            }
            s.airForces.push({
                id: s.nextAirId++,
                owner: cmd.country,
                provinceId: cmd.province,
                template: cmd.template,
                planes: tpl.planes * count,
                role: tpl.role,
            });
            break;
        }

        case 'moveAirForce': {
            const g = s.airForces.find((x) => x.id === cmd.airId);
            g.provinceId = cmd.to;
            break;
        }

        case 'disbandAirForce': {
            const i = s.airForces.findIndex((x) => x.id === cmd.airId);
            if (i >= 0) s.airForces.splice(i, 1);
            break;
        }

        case 'deployFleet': {
            const c = s.countries[cmd.country];
            const tpl = ctx.ships[cmd.template];
            const count = Math.floor(cmd.count || 1);
            const need = equipmentNeed(tpl, count);
            for (const [eqId, n] of Object.entries(need)) {
                c.equipment[eqId] = (c.equipment[eqId] || 0) - n;
            }
            s.fleets.push({
                id: s.nextFleetId++,
                owner: cmd.country,
                provinceId: cmd.province,
                template: cmd.template,
                ships: tpl.ships * count,
                speed: tpl.speed ?? 3,
                order: 'hold',
            });
            break;
        }

        case 'moveFleet': {
            const f = s.fleets.find((x) => x.id === cmd.fleetId);
            f.provinceId = cmd.to;
            break;
        }

        case 'disbandFleet': {
            const i = s.fleets.findIndex((x) => x.id === cmd.fleetId);
            if (i >= 0) s.fleets.splice(i, 1);
            break;
        }

        case 'toggleProduction': {
            s.countries[cmd.country].production[cmd.index].disabled = !!cmd.disabled;
            break;
        }

        case 'cancelConstruction': {
            s.countries[cmd.country].construction.splice(cmd.index, 1);
            break;
        }

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
                goals: [],
                status: 'active',
            });
            markAtWarFlags(s, cmd.from, cmd.to);
            s.pending.push({ kind: 'warStarted', payload: { a: cmd.from, b: cmd.to } });
            break;
        }

        case 'makePeace': {
            const war = s.wars.find((w) => (w.status === 'active' || w.status === 'peacePending') &&
                ((w.a === cmd.from && w.b === cmd.to) || (w.a === cmd.to && w.b === cmd.from)));
            if (war) {
                war.status = 'ended';
                // 阵营战争：双方阵营成员一并退出战争
                for (const tag of [...(war.alliesA || [war.a]), ...(war.alliesB || [war.b])]) {
                    if (s.countries[tag]) s.countries[tag].flags.atWar = false;
                }
                // 附带条款（和平会议的简化形式）：直接执行
                if (Array.isArray(cmd.terms) && cmd.terms.length && ctx.applyPeaceTerms) {
                    ctx.applyPeaceTerms(cmd.terms, cmd.to, cmd.from, s, ctx);
                }
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
