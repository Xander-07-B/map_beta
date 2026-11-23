/* ============================================================
 * 战役核心 · 外交深度（diplomacy.js）
 * 在基础的「宣战 / 议和 / 改善关系」之外补上：
 *   1. 阵营机制：阵营领袖、邀请、加入与退出；对阵营成员宣战会扩大为阵营战争
 *   2. 租借：向阵营盟友或高关系国家输送资源/装备（有月度额度与冷却）
 *   3. 战争目标：为战争声明目标（吞并州 / 索取资源），作为和平会议的条款来源
 *   4. 简化和平会议：战争分数达标后自动生成和平提议，败方接受后按条款执行
 * 所有变更都经命令管道，规则只入队不递归执行。
 * ============================================================ */

import { orderedKeys } from './determinism.js';
import { applyCommand } from './commands.js';
import { dateOf } from './economy.js';
import { PEACE_SCORE } from './war.js';

/** 租借的月度额度上限（按受援方计） */
export const LEND_LEASE_MONTHLY = 60;
/** 租借的冷却 tick 数 */
export const LEND_LEASE_COOLDOWN = 30;
/** 接受阵营邀请所需的最低关系 */
export const FACTION_INVITE_RELATION = -20;

// ===================== 阵营查询 =====================

export function factionOf(s, tag) {
    const c = s.countries[tag];
    return c?.faction || null;
}

export function factionById(s, factionId) {
    return s.alliances.find((a) => a.id === factionId) || null;
}

export function factionMembers(s, tag) {
    const fid = factionOf(s, tag);
    if (!fid) return [tag];
    const fac = factionById(s, fid);
    return fac ? fac.members.slice() : [tag];
}

export function factionLeader(s, factionId) {
    const fac = factionById(s, factionId);
    return fac?.leader || fac?.members?.[0] || null;
}

/**
 * 两国是否处于战争状态。
 * 除直接的战争记录外，阵营战争也计入：只要两国分属某场战争的双方阵营即为交战。
 */
export function areAtWar(s, a, b) {
    if (a === b) return false;
    for (const war of s.wars) {
        if (war.status !== 'active' && war.status !== 'peacePending') continue;
        const sideA = war.alliesA || [war.a];
        const sideB = war.alliesB || [war.b];
        if ((sideA.includes(a) && sideB.includes(b)) || (sideA.includes(b) && sideB.includes(a))) return true;
    }
    return false;
}

/** 战争的直接对手方（用于面板展示与议和按钮） */
export function warOpponents(s, tag) {
    const out = new Set();
    for (const war of s.wars) {
        if (war.status === 'ended') continue;
        const sideA = war.alliesA || [war.a];
        const sideB = war.alliesB || [war.b];
        if (sideA.includes(tag)) for (const t of sideB) if (t !== tag) out.add(t);
        if (sideB.includes(tag)) for (const t of sideA) if (t !== tag) out.add(t);
    }
    return [...out].sort();
}

// ===================== 战争目标与和平条款 =====================

/** 由战争目标生成和平条款（未控制的目标不会成为条款） */
export function termsFromGoals(s, war, winner) {
    const terms = [];
    for (const g of war.goals || []) {
        if (g.type === 'annexState') {
            const st = s.states[g.state];
            if (st && st.owner === winner) terms.push({ type: 'annexState', state: g.state });
        } else if (g.type === 'resources') {
            terms.push({ type: 'resources', resource: g.resource, amount: Math.floor((g.amount || 0) / 2) });
        }
    }
    if (terms.length === 0) terms.push({ type: 'ceasefire' });
    return terms;
}

/** 应用和平条款（经命令管道，保证日志与级联完整） */
export function applyPeaceTerms(s, ctx, terms, loser, winner) {
    for (const t of terms || []) {
        if (t.type === 'annexState') {
            applyCommand({ t: 'assignOwner', state: t.state, to: winner, reason: '和平会议' }, s, ctx);
        } else if (t.type === 'resources') {
            const from = s.countries[loser];
            const to = s.countries[winner];
            if (!from || !to) continue;
            const key = t.resource;
            if (key in (from.resources || {})) {
                const amt = Math.min(from.resources[key] || 0, t.amount || 0);
                from.resources[key] = (from.resources[key] || 0) - amt;
                to.resources[key] = (to.resources[key] || 0) + amt;
            } else if (key in (from.equipment || {})) {
                const amt = Math.min(from.equipment[key] || 0, t.amount || 0);
                from.equipment[key] = (from.equipment[key] || 0) - amt;
                to.equipment[key] = (to.equipment[key] || 0) + amt;
            }
        }
    }
}

// ===================== 规则 =====================

/**
 * 注册外交规则。由 rules.js 的 installCoreRules 调用。
 */
export function installDiplomacyRules(registerRule) {
    // 战争开始 → 阵营成员一并卷入（阵营战争）
    registerRule('warExpandFaction', ({ a, b }, s, ctx) => {
        const war = s.wars.find((w) => w.status === 'active' && (w.a === a || w.b === a) && (w.a === b || w.b === b));
        if (!war) return;
        war.alliesA = [...new Set([war.a, ...factionMembers(s, war.a)])];
        war.alliesB = [...new Set([war.b, ...factionMembers(s, war.b)])];
        for (const tag of [...war.alliesA, ...war.alliesB]) {
            if (s.countries[tag]) s.countries[tag].flags.atWar = true;
        }
        const extraA = war.alliesA.filter((t) => t !== war.a && t !== war.b);
        const extraB = war.alliesB.filter((t) => t !== war.a && t !== war.b);
        if (extraA.length || extraB.length) {
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `战争扩大：${[...extraA, ...extraB].join('、')} 作为阵营成员加入战争`,
            });
        }
    });

    // 战争分数达标 → 生成和平提议（简化和平会议）
    registerRule('peaceProposed', ({ warId }, s, ctx) => {
        const war = s.wars.find((w) => w.id === warId);
        if (!war || war.status !== 'active') return;
        if (s.peaceOffers.some((o) => o.warId === warId)) return;
        const winner = war.scoreA >= war.scoreB ? war.a : war.b;
        const loser = winner === war.a ? war.b : war.a;
        const terms = termsFromGoals(s, war, winner);
        const offer = {
            id: s.nextOfferId++,
            warId, from: winner, to: loser, terms,
            tick: s.tick,
        };
        war.status = 'peacePending';
        s.peaceOffers.push(offer);
        s.history.push({
            tick: s.tick, date: dateOf(s, s.tick),
            text: `${winner} 提出和平条件，等待 ${loser} 回应（战争分数 ${Math.round(winner === war.a ? war.scoreA : war.scoreB)}）`,
        });
        // 让 UI 弹出和平会议窗口（玩家是败方时由界面呈现）
        s.pending.push({ kind: 'peaceNotice', payload: { offerId: offer.id } });
    });

    // 和平通知：仅在玩家是败方时抛出事件，交由 UI 呈现
    registerRule('peaceNotice', ({ offerId }, s, ctx) => {
        const offer = s.peaceOffers.find((o) => o.id === offerId);
        if (!offer) return;
        const players = Object.keys(s.players || {});
        if (!players.includes(offer.to)) return;
        s.pending.push({ kind: 'peaceEvent', payload: { offerId } });
    });

    // 和平事件：把待回应的提议交给 Campaign（写在 ctx 上，不进存档）
    registerRule('peaceEvent', ({ offerId }, s, ctx) => {
        const offer = s.peaceOffers.find((o) => o.id === offerId);
        if (!offer) return;
        ctx.pendingPeace = offer.id;
    });
}

// ===================== 命令校验辅助 =====================

function err(message) {
    return { ok: false, err: message };
}

/** 阵营相关命令的校验（在 commands.js 中以同名 case 调用，保持校验与执行同源） */
export function validateDiplomacyCommand(cmd, s, ctx) {
    const countryExists = (tag) => s.countries[tag] !== undefined;
    switch (cmd.t) {
        case 'inviteFaction': {
            if (!countryExists(cmd.from)) return err(`国家不存在: ${cmd.from}`);
            const fac = factionById(s, cmd.faction);
            if (!fac) return err(`阵营不存在: ${cmd.faction}`);
            if (factionLeader(s, cmd.faction) !== cmd.from) return err('只有阵营领袖可以发出邀请');
            if (!countryExists(cmd.to)) return err(`国家不存在: ${cmd.to}`);
            if (factionOf(s, cmd.to)) return err(`${cmd.to} 已属于其他阵营`);
            if (s.factionInvites.some((i) => i.to === cmd.to && i.faction === cmd.faction)) {
                return err('已向该国发出邀请，等待回应');
            }
            const rel = s.countries[cmd.from].relations?.[cmd.to] ?? 0;
            if (rel < FACTION_INVITE_RELATION) return err(`关系过低，无法邀请（当前 ${rel}）`);
            return null;
        }
        case 'acceptFactionInvite':
        case 'rejectFactionInvite': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const invite = s.factionInvites.find((i) => i.id === cmd.inviteId);
            if (!invite) return err('邀请不存在');
            if (invite.to !== cmd.country) return err('该邀请不是发给这个国家的');
            return null;
        }
        case 'leaveFaction': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            if (!factionOf(s, cmd.country)) return err('该国不在任何阵营中');
            return null;
        }
        case 'setFactionLeader': {
            if (!countryExists(cmd.to)) return err(`国家不存在: ${cmd.to}`);
            const fac = factionById(s, cmd.faction);
            if (!fac) return err(`阵营不存在: ${cmd.faction}`);
            if (factionLeader(s, cmd.faction) !== cmd.from) return err('只有阵营领袖可以移交领导权');
            if (!fac.members.includes(cmd.to)) return err('目标不是阵营成员');
            return null;
        }
        case 'lendLease': {
            if (!countryExists(cmd.country) || !countryExists(cmd.to)) return err('国家不存在');
            if (cmd.country === cmd.to) return err('不能向自己租借');
            const c = s.countries[cmd.from ?? cmd.country];
            const amount = Math.floor(cmd.amount || 0);
            if (amount <= 0) return err('租借数量必须为正数');
            // 阵营盟友或高关系国家才可租借
            const sameFaction = !!factionOf(s, cmd.country) && factionOf(s, cmd.country) === factionOf(s, cmd.to);
            const rel = s.countries[cmd.country].relations?.[cmd.to] ?? 0;
            if (!sameFaction && rel < 50) return err('只有阵营盟友或关系 ≥ 50 的国家才能租借');
            const ls = s.lendLease[cmd.country]?.[cmd.to];
            if (ls && s.tick - ls.tick < LEND_LEASE_COOLDOWN) return err('租借冷却中');
            if (ls && (ls.amount || 0) >= LEND_LEASE_MONTHLY) return err('本月租借额度已用尽');
            const key = cmd.resource || 'supplies';
            const stock = key in (s.countries[cmd.country].resources || {})
                ? (s.countries[cmd.country].resources[key] || 0)
                : (s.countries[cmd.country].equipment?.[key] || 0);
            if (stock < amount) return err(`${key} 库存不足`);
            return null;
        }
        case 'proposePeace': {
            if (!countryExists(cmd.from) || !countryExists(cmd.to)) return err('国家不存在');
            const war = s.wars.find((w) => w.id === cmd.warId);
            if (!war) return err(`战争不存在: ${cmd.warId}`);
            if (war.status !== 'active') return err('该战争不在进行中');
            if (!Array.isArray(cmd.terms) || cmd.terms.length === 0) return err('和平条款不能为空');
            if (s.peaceOffers.some((o) => o.warId === war.id)) return err('该战争已有待回应的和平提议');
            return null;
        }
        case 'acceptPeace':
        case 'rejectPeace': {
            if (!countryExists(cmd.country)) return err(`国家不存在: ${cmd.country}`);
            const offer = s.peaceOffers.find((o) => o.id === cmd.offerId);
            if (!offer) return err('和平提议不存在');
            if (offer.to !== cmd.country) return err('该提议不是发给这个国家的');
            return null;
        }
        case 'addWarGoal': {
            if (!countryExists(cmd.from) || !countryExists(cmd.to)) return err('国家不存在');
            const war = s.wars.find((w) => w.status !== 'ended' &&
                ((w.a === cmd.from && w.b === cmd.to) || (w.a === cmd.to && w.b === cmd.from)));
            if (!war) return err('两国之间没有进行中的战争');
            const g = cmd.goal;
            if (!g || typeof g.type !== 'string') return err('战争目标缺少 type');
            if (g.type === 'annexState' && !s.states[g.state]) return err(`州不存在: ${g.state}`);
            if (g.type === 'resources' && (!g.resource || !(g.amount > 0))) return err('资源目标需要 resource 与 amount');
            if ((war.goals || []).some((x) => x.type === g.type &&
                (g.type !== 'annexState' || x.state === g.state) &&
                (g.type !== 'resources' || x.resource === g.resource))) {
                return err('已存在同类战争目标');
            }
            return null;
        }
        default:
            return err(`未知外交命令: ${cmd.t}`);
    }
}

/** 外交命令的执行 */
export function executeDiplomacyCommand(cmd, s, ctx) {
    switch (cmd.t) {
        case 'inviteFaction':
            s.factionInvites.push({
                id: s.nextInviteId++, faction: cmd.faction, from: cmd.from, to: cmd.to, tick: s.tick,
            });
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${cmd.from} 邀请 ${cmd.to} 加入阵营 ${cmd.faction}`,
            });
            break;

        case 'acceptFactionInvite': {
            const invite = s.factionInvites.find((i) => i.id === cmd.inviteId);
            s.factionInvites.splice(s.factionInvites.indexOf(invite), 1);
            const fac = factionById(s, invite.faction);
            if (fac && !fac.members.includes(cmd.country)) fac.members.push(cmd.country);
            s.countries[cmd.country].faction = invite.faction;
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${cmd.country} 接受了邀请，加入阵营 ${invite.faction}`,
            });
            // 阵营成员变化后，既有战争的阵营阵营需要重算
            for (const war of s.wars) {
                if (war.status === 'ended') continue;
                war.alliesA = [...new Set([war.a, ...factionMembers(s, war.a)])];
                war.alliesB = [...new Set([war.b, ...factionMembers(s, war.b)])];
            }
            break;
        }

        case 'rejectFactionInvite': {
            const invite = s.factionInvites.find((i) => i.id === cmd.inviteId);
            s.factionInvites.splice(s.factionInvites.indexOf(invite), 1);
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${cmd.country} 拒绝了加入阵营 ${invite.faction} 的邀请`,
            });
            break;
        }

        case 'leaveFaction': {
            const fid = factionOf(s, cmd.country);
            const fac = factionById(s, fid);
            if (fac) {
                fac.members = fac.members.filter((m) => m !== cmd.country);
                if (fac.leader === cmd.country) fac.leader = fac.members[0] || null;
                if (fac.members.length === 0) {
                    // 阵营成员全部退出则解散
                    s.alliances = s.alliances.filter((a) => a.id !== fid);
                }
            }
            s.countries[cmd.country].faction = null;
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${cmd.country} 退出阵营 ${fid}`,
            });
            for (const war of s.wars) {
                if (war.status === 'ended') continue;
                war.alliesA = [...new Set([war.a, ...factionMembers(s, war.a)])];
                war.alliesB = [...new Set([war.b, ...factionMembers(s, war.b)])];
            }
            break;
        }

        case 'setFactionLeader': {
            const fac = factionById(s, cmd.faction);
            fac.leader = cmd.to;
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `阵营 ${cmd.faction} 的领导权移交给 ${cmd.to}`,
            });
            break;
        }

        case 'lendLease': {
            const key = cmd.resource || 'supplies';
            const from = s.countries[cmd.country];
            const to = s.countries[cmd.to];
            const inResources = key in (from.resources || {});
            const container = inResources ? from.resources : from.equipment;
            const target = inResources ? to.resources : to.equipment;
            container[key] = (container[key] || 0) - cmd.amount;
            target[key] = (target[key] || 0) + cmd.amount;
            s.lendLease[cmd.country] || (s.lendLease[cmd.country] = {});
            const ls = s.lendLease[cmd.country][cmd.to] || { amount: 0, tick: 0 };
            ls.amount = (ls.amount || 0) + cmd.amount;
            ls.tick = s.tick;
            s.lendLease[cmd.country][cmd.to] = ls;
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${cmd.country} 向 ${cmd.to} 租借 ${cmd.amount} ${key}`,
            });
            break;
        }

        case 'proposePeace': {
            const war = s.wars.find((w) => w.id === cmd.warId);
            s.peaceOffers.push({
                id: s.nextOfferId++, warId: war.id, from: cmd.from, to: cmd.to,
                terms: cmd.terms, tick: s.tick,
            });
            war.status = 'peacePending';
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${cmd.from} 向 ${cmd.to} 提出和平条件`,
            });
            s.pending.push({ kind: 'peaceNotice', payload: { offerId: s.peaceOffers[s.peaceOffers.length - 1].id } });
            break;
        }

        case 'acceptPeace':
        case 'rejectPeace': {
            const offer = s.peaceOffers.find((o) => o.id === cmd.offerId);
            s.peaceOffers.splice(s.peaceOffers.indexOf(offer), 1);
            const war = s.wars.find((w) => w.id === offer.warId);
            if (cmd.t === 'acceptPeace') {
                applyPeaceTerms(s, ctx, offer.terms, offer.to, offer.from);
                applyCommand({ t: 'makePeace', from: offer.from, to: offer.to }, s, ctx);
                s.history.push({
                    tick: s.tick, date: dateOf(s, s.tick),
                    text: `${offer.to} 接受了和平条件，战争结束`,
                });
            } else {
                if (war) war.status = 'active';
                s.history.push({
                    tick: s.tick, date: dateOf(s, s.tick),
                    text: `${offer.to} 拒绝了和平条件，战争继续`,
                });
            }
            break;
        }

        case 'addWarGoal': {
            const war = s.wars.find((w) => w.status !== 'ended' &&
                ((w.a === cmd.from && w.b === cmd.to) || (w.a === cmd.to && w.b === cmd.from)));
            war.goals = war.goals || [];
            war.goals.push(cmd.goal);
            s.history.push({
                tick: s.tick, date: dateOf(s, s.tick),
                text: `${cmd.from} 为对 ${cmd.to} 的战争添加目标：${goalText(cmd.goal)}`,
            });
            break;
        }
    }
}

function goalText(g) {
    if (g.type === 'annexState') return `吞并州 ${g.state}`;
    if (g.type === 'resources') return `索取 ${g.amount} ${g.resource}`;
    return g.type;
}
