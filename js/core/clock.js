/* ============================================================
 * 战役核心 · 逻辑时钟（clock.js）
 * 约定：1 tick = 5 游戏分钟。
 *   → 1 游戏日 = 24×60/5 = 288 tick
 *   → 日界：tick % 288 === 0；月界：日界且日历日期为 1 号
 * 真实时间换算：1x 速度下每 tick 消耗 TICK_REAL_MS 毫秒，
 * 倍速按 speed 线性缩放。用 requestAnimationFrame 的 dt 累加，
 * 不用 setInterval——后台标签页被节流后时间会错乱。
 * ============================================================ */

/** 每个 tick 代表的游戏分钟数 */
export const TICK_MINUTES = 5;

/** 一个游戏日对应的 tick 数 */
export const TICKS_PER_DAY = (24 * 60) / TICK_MINUTES; // 288

/** 1x 速度下，推进 1 个 tick 所需的真实毫秒（1 游戏日 ≈ 28.8 秒） */
export const TICK_REAL_MS = 100;

/** 单帧最大步进上限，防死亡螺旋（切回前台时累积过多） */
export const MAX_STEPS_PER_FRAME = 240;

/** 在日期上前进 n 个 tick（确定性：基于 UTC 毫秒的精确加法） */
export function addTicksToDate(date, n) {
    return new Date(date.getTime() + n * TICK_MINUTES * 60000);
}

/** 日期格式化：1936.01.01 */
export function formatDate(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}.${m}.${d}`;
}

/** 解析 '1936-01-01' 为 Date（UTC，避免时区偏移破坏确定性） */
export function parseDate(str) {
    return new Date(str + 'T00:00:00Z');
}

export class Clock {
    /**
     * @param {object} opts
     * @param {Date|string} opts.startDate 起始日期
     * @param {function} [opts.raf] requestAnimationFrame 实现（Worker/测试可注入）
     * @param {function} [opts.now] 高精度计时器（默认 performance.now）
     */
    constructor({ startDate, raf, now }) {
        this.startDate = startDate instanceof Date ? new Date(startDate.getTime()) : parseDate(startDate);
        this.tick = 0;
        this.speed = 0;      // 0 暂停 / 1~5 倍速
        this.acc = 0;        // 时间累加器（毫秒）
        this.step = TICK_REAL_MS;
        this.running = false;
        this.onStep = null;  // (tick, clock) => void
        this._raf = raf || (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame.bind(globalThis) : null);
        this._cancel = typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame.bind(globalThis) : null;
        this._now = now || (() => performance.now());
        this._frame = null;
        this._last = 0;
    }

    /** 当前游戏日期 */
    get date() {
        return addTicksToDate(this.startDate, this.tick);
    }

    /** 是否为日界（每 288 tick 一次） */
    get isDayStart() {
        return this.tick % TICKS_PER_DAY === 0;
    }

    /** 是否为月界（日界且日历日期为 1 号） */
    get isMonthStart() {
        return this.isDayStart && this.date.getUTCDate() === 1;
    }

    /** 推进真实时间 dtMs 毫秒，按速度折算出若干 tick */
    advance(dtMs) {
        if (this.speed <= 0) return;
        this.acc += dtMs * this.speed;
        let n = 0;
        while (this.acc >= this.step && n < MAX_STEPS_PER_FRAME) {
            this.acc -= this.step;
            this.tick++;
            if (this.onStep) this.onStep(this.tick, this);
            n++;
        }
    }

    setSpeed(speed) {
        this.speed = Math.max(0, Math.min(5, Math.floor(speed)));
    }

    /** 启动 rAF 循环（注入了 raf 时才生效） */
    start() {
        if (!this._raf || this.running) return;
        this.running = true;
        this._last = this._now();
        const loop = (t) => {
            if (!this.running) return;
            const dt = t - this._last;
            this._last = t;
            this.advance(dt);
            this._frame = this._raf(loop);
        };
        this._frame = this._raf(loop);
    }

    stop() {
        this.running = false;
        if (this._frame && this._cancel) this._cancel(this._frame);
        this._frame = null;
    }

    /** 序列化（存档中只存 tick 与起始日期，acc/running 是真实时间状态，不进存档） */
    toJSON() {
        return { tick: this.tick, startDate: this.startDate.toISOString(), speed: this.speed };
    }

    restore(data) {
        this.tick = data.tick || 0;
        this.startDate = parseDate(data.startDate);
        this.speed = data.speed || 0;
        this.acc = 0;
    }
}
