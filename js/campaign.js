/* ============================================================
 * 战役核心 · 模拟层门面（campaign.js）
 * 串联 Clock + WorldState + Command 管道 + Rules + 剧本加载。
 * 不碰 DOM、不产生渲染副作用——后续可整体搬进 Web Worker。
 * ============================================================ */

import { Clock, formatDate, parseDate } from './core/clock.js';
import { Rng } from './core/rng.js';
import { createWorldState } from './core/state.js';
import { applyCommand } from './core/commands.js';
import { drainPending, enqueue, installCoreRules, applyEffects } from './core/rules.js';
import { cloneState, orderedKeys } from './core/determinism.js';
import { evalTrigger } from './content/conditions.js';
import { loadScenario } from './content/loader.js';
import { settleEconomy } from './core/economy.js';
import { settleWar } from './core/war.js';
import { computeSupplyAccess, settleAirNavy, settleArmyOrders } from './core/airnavy.js';
import {
    migrateSave, buildIncrementalSave, resolveIncrementalSave, SAVE_VERSION,
} from './core/save.js';
import { applyPeaceTerms } from './core/diplomacy.js';
import { TICKS_PER_MONTH } from './core/clock.js';
import { runAITick } from './core/ai.js';

export class Campaign {
    /**
     * @param {object} loaded loadScenario 的返回值
     * @param {object} [opts] { seed }
     */
    constructor(loaded, opts = {}) {
        this.scenario = loaded.scenario;
        this.derivedFrom = loaded.derivedFrom;
        this.content = {
            focusTrees: loaded.focusTrees,
            events: loaded.events,
            decisions: loaded.decisions,
            equipment: loaded.equipment,
            techs: loaded.techs,
            divisions: loaded.divisions,
            aircraft: loaded.aircraft,
            ships: loaded.ships,
        };
        this.seed = opts.seed ?? 0x1936;
        this.rng = new Rng(this.seed);
        this.clock = new Clock({ startDate: this.scenario.startDate });
        this.clock.onStep = (tick) => this.onTick(tick);
        this.state = null;
        this._listeners = {};
        this._mapIndex = null;   // 地图索引（邻接表），由渲染层注入，供部队移动判定
        this._supply = null;     // 本 tick 的补给网络（Map<provinceId, 系数>），不进存档
        this._base = null;       // 增量存档的基线快照
        this._lastAutosave = 0;  // 上次自动存档的 tick
        this.storage = opts.storage || null;   // 存档读写接口（模拟层不直接碰 localStorage）
        this.autosaveEnabled = opts.autosave !== false;
        this.aiEnabled = false;  // AI 决策开关（AI-only 模式 / 压测）
        this.lastAirNavy = null; // 最近一次空中/海上结算结果（供面板展示）
    }

    /** 开关 AI 决策（所有非玩家国家由 AI 接管） */
    setAI(enabled) {
        this.aiEnabled = !!enabled;
        return this.aiEnabled;
    }

    /** 注入地图索引：省份 id → 邻接省份 id 列表 */
    setMapIndex(index) {
        this._mapIndex = index || null;
    }

    /** 异步创建：加载并校验剧本 */
    static async create(scenarioId, opts = {}) {
        const loaded = await loadScenario(scenarioId, opts);
        return new Campaign(loaded, opts);
    }

    /** 由剧本构建初始状态 */
    newGame() {
        installCoreRules();
        this.rng = new Rng(this.seed);
        this.state = createWorldState({
            scenario: this.scenario,
            seed: this.seed,
            rng: this.rng,
            divisions: this.content.divisions,
            aircraft: this.content.aircraft,
            ships: this.content.ships,
        });
        this.clock.tick = 0;
        this.clock.acc = 0;
        return this.state;
    }

    /** 命令上下文：模拟层内部使用，UI 不直接构造 */
    ctx() {
        return {
            rng: this.rng,
            focusTrees: this.content.focusTrees,
            events: this.content.events,
            decisions: this.content.decisions,
            equipment: this.content.equipment,
            techs: this.content.techs,
            divisions: this.content.divisions,
            aircraft: this.content.aircraft,
            ships: this.content.ships,
            neighbors: this._mapIndex?.neighbors || null,
            scenario: this.scenario,
            applyEffects,
            applyPeaceTerms,
            strict: true,
            supply: this._supply || null,
            onChange: (cmd) => this.emit('command', { cmd, state: this.state }),
        };
    }

    // ===================== 时间推进 =====================

    /** 每个 tick 的结算入口（单一函数，内部按频率分派） */
    onTick(tick) {
        const s = this.state;
        s.tick = tick;
        const ctx = this.ctx();

        // 每 tick：国策进度推进
        this.advanceFocuses();

        // 每 tick = 1 游戏日：政治/经济/军事日结算
        this.dailySettlement();

        // 补给网络：经济（补给消耗）与军事（组织度维持）共用同一份可达性
        this._supply = computeSupplyAccess(s, ctx);
        ctx.supply = this._supply;

        // 经济结算（资源 / 生产线 / 建造 / 科研 / 人力 / 政治点数）
        this.lastEconomy = settleEconomy(s, ctx);

        // 军事结算（战斗 / 占领 / 部队维持 / 州归属翻转 / 战争分数）
        this.lastWar = settleWar(s, ctx);

        // 空中与海上结算（空战 / 海战 / 轰炸）+ 部队指令（进攻 / 撤退）
        this.lastAirNavy = {
            ...settleAirNavy(s, ctx),
            ...settleArmyOrders(s, ctx),
        };

        // 月界（每 30 tick = 30 游戏日）：任务/胜负月度评估 + AI 决策
        if (this.clock.isMonthStart) {
            enqueue(s, 'missionEval', {});
            if (this.aiEnabled) this.aiTick();
        }

        // 排空规则级联队列
        drainPending(s, ctx);

        // 和平会议：玩家是败方时弹出和平条件窗口
        if (ctx.pendingPeace != null) {
            const offer = s.peaceOffers.find((o) => o.id === ctx.pendingPeace);
            ctx.pendingPeace = null;
            if (offer) this.emit('peace', { offer, state: s });
        }

        if (s.victory) {
            this.clock.setSpeed(0);
            this.emit('victory', { state: s, victory: s.victory });
        }
        this.emit('tick', { tick, state: s });

        // 每月自动存档（写入独立存档位，不覆盖玩家手动存档）
        this.maybeAutosave();
    }

    /** 到达月界时自动存档；返回是否写入了存档 */
    maybeAutosave() {
        if (!this.autosaveEnabled || !this.storage || !this.state) return false;
        if (this.state.tick - this._lastAutosave < TICKS_PER_MONTH) return false;
        this._lastAutosave = this.state.tick;
        const data = this.saveAuto();
        return !!data;
    }

    /** 存档元信息（全量与增量存档共用） */
    saveMeta() {
        return {
            version: SAVE_VERSION,
            scenarioId: this.scenario.id,
            mapVersion: this.scenario.map,
            seed: this.seed,
            tick: this.clock.tick,
            derivedFrom: this.derivedFrom,
            date: formatDate(this.clock.date),
        };
    }

    /**
     * AI 决策：每月对每个 AI 国家做一轮效用打分，全部走命令管道。
     * 关闭时（默认）零开销，不产生任何状态变更。
     */
    aiTick() {
        if (!this.aiEnabled) return;
        const s = this.state;
        runAITick(s, this.ctx(), {
            players: s.players,
            isHuman: (tag) => !!s.players[tag]?.isHuman,
            command: (cmd) => this.command(cmd),
        });
    }

    /** 国策进度：每 tick 推进，完成时入队 focusCompleted 规则 */
    advanceFocuses() {
        const s = this.state;
        for (const tag of orderedKeys(s.countries)) {
            const c = s.countries[tag];
            if (!c.activeFocus) continue;
            c.activeFocus.progress += 1;
            if (c.activeFocus.progress >= c.activeFocus.totalTicks) {
                enqueue(s, 'focusCompleted', { tag, focusId: c.activeFocus.id });
            }
        }
    }

    /**
     * 日结算：事件触发判定（每日对启用的事件做条件求值）。
     * 政治/经济日结算（W2）在此接入。
     */
    dailySettlement() {
        const s = this.state;
        for (const eventId of s.events.enabled) {
            if (s.events.triggered.includes(eventId)) continue;
            const ev = this.content.events[eventId];
            if (!ev) continue;
            if (evalTrigger(ev.trigger, s, this.ctx(), ev.scope)) {
                s.events.triggered.push(eventId);
                this.emit('event', { eventId, event: ev });
            }
        }
    }

    /** 快进 n 个 tick（演示/测试用，等价于连续 onTick，并同步推进时钟以触发月界） */
    fastForward(n) {
        for (let i = 0; i < n; i++) {
            this.clock.tick += 1;
            this.onTick(this.clock.tick);
        }
    }

    // ===================== 命令入口 =====================

    /** 提交命令：校验 → 执行 → 记日志 → 排空级联 */
    command(cmd) {
        const s = this.state;
        const r = applyCommand(cmd, s, this.ctx());
        if (r.ok) drainPending(s, this.ctx());
        this.emit('change', { state: s });
        return r;
    }

    // ===================== 存档 / 回放 =====================

    /** 存档：全量快照 + 命令日志（后续可换二进制序列化） */
    /** 全量存档：整份状态快照 + 命令日志 */
    save() {
        const s = this.state;
        s.rngState = this.rng.getState();   // RNG 状态必须进存档
        s.tick = this.clock.tick;
        const snapshot = cloneState(s);
        const data = {
            meta: this.saveMeta(),
            snapshot,
            commands: s.log.slice(),
        };
        this._base = { snapshot, commands: data.commands };
        return data;
    }

    /**
     * 增量存档：以基线快照为基准，只保存变化字段。
     * 补丁过大或间隔过久时自动把当前状态提升为新基线（此时等价于全量存档）。
     */
    saveIncremental() {
        const s = this.state;
        s.rngState = this.rng.getState();
        s.tick = this.clock.tick;
        const base = this._base || this.save();
        const data = buildIncrementalSave({
            meta: this.saveMeta(),
            baseSnapshot: base.snapshot,
            baseCommands: base.commands,
            state: s,
            commands: s.log.slice(),
        });
        if (!data.meta.incremental) {
            // 已提升为新基线：记住它，后续增量以它为基准
            this._base = data.base;
        }
        return data;
    }

    /** 自动存档：写入独立存档位（不覆盖玩家手动存档） */
    saveAuto() {
        if (!this.storage) return null;
        const data = this.saveIncremental();
        try {
            this.storage.write('hoi4_campaign_autosave', JSON.stringify(data));
            return data;
        } catch {
            return null;
        }
    }

    /** 读取自动存档 */
    loadAuto() {
        if (!this.storage) return null;
        try {
            const raw = this.storage.read('hoi4_campaign_autosave');
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    /** 从存档恢复（快照即全量状态，命令日志保留用于回放） */
    restore(saveData) {
        // 增量存档先还原成完整存档，再走版本迁移（保证老存档字段补齐）
        const data = migrateSave(resolveIncrementalSave(saveData));
        this.rng = new Rng(data.meta.seed ?? this.seed);
        this.rng.loadState(data.snapshot.rngState);
        this.state = cloneState(data.snapshot);
        this.clock.restore({ tick: data.snapshot.tick, startDate: this.scenario.startDate, speed: 0 });
        this._base = { snapshot: cloneState(data.snapshot), commands: data.commands || [] };
        this._lastAutosave = this.state.tick;
        installCoreRules();
        return this.state;
    }

    /**
     * 回放：快照 + 命令日志顺序重放，复现同一结果。
     * 每条日志携带当时 tick，重放时先恢复 tick 再应用命令并排空级联，
     * 保证与原始执行路径逐位一致。用于调试与战后复盘。
     */
    replay(snapshot, commands) {
        this.restore({ meta: { seed: this.seed }, snapshot });
        const ctx = this.ctx();
        for (const entry of commands) {
            this.state.tick = entry.tick ?? this.state.tick;
            const r = applyCommand(entry.cmd ?? entry, this.state, ctx);
            if (!r.ok) return r;
            drainPending(this.state, ctx);
        }
        return { ok: true };
    }

    // ===================== 事件订阅 =====================

    on(event, cb) {
        (this._listeners[event] = this._listeners[event] || []).push(cb);
        return this;
    }

    emit(event, payload) {
        for (const cb of this._listeners[event] || []) cb(payload);
    }
}

export { formatDate, parseDate };

if (typeof window !== 'undefined') {
    window.Campaign = Campaign;
}
