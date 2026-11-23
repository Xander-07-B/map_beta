/* ============================================================
 * 战役核心 · 存档体系（save.js）
 * 两件事：
 *   1. 版本迁移：存档带 meta.version，读档时按迁移表逐级升级，
 *      老存档不会因为字段缺失而直接崩掉。
 *   2. 增量存档：以一份「基线快照」为基准，只保存自基线以来发生变化的
 *      字段（路径式补丁），基线按时间或补丁体积自动推进。
 * 补丁格式：
 *   { "a.b.c": 新值, "x.y": { __delete: true } }
 *   路径用点号分隔，数组整体替换（数组按下标路径写入）。
 * ============================================================ */

/** 当前存档版本 */
export const SAVE_VERSION = 4;

/** 增量存档的基线推进阈值：补丁条目数超过该值时把当前状态提升为新基线 */
export const PATCH_PROMOTE_ENTRIES = 400;

/** 增量存档的基线推进周期（tick）：超过该间隔也推进基线，避免补丁无限增长 */
export const PATCH_PROMOTE_TICKS = 180;

// ===================== 版本迁移 =====================

/** v1 → v2：早期存档把状态直接放在 data.state，且没有命令日志包装 */
function migrateV1ToV2(data) {
    const out = { ...data };
    if (out.state && !out.snapshot) {
        out.snapshot = out.state;
        delete out.state;
    }
    if (!Array.isArray(out.commands)) {
        out.commands = Array.isArray(out.log) ? out.log : [];
        delete out.log;
    }
    out.meta = { ...(out.meta || {}), version: 2 };
    return out;
}

/** v2 → v3：快照内的军队缺少 experience 字段，meta 缺 tick/date */
function migrateV3FromV2(data) {
    const out = { ...data, meta: { ...(data.meta || {}), version: 3 } };
    const snap = out.snapshot || {};
    const armies = Array.isArray(snap.armies)
        ? snap.armies.map((a) => (a && typeof a === 'object' ? { experience: 0, ...a } : a))
        : [];
    // 浅拷贝快照后再写回，避免修改调用方传入的对象
    out.snapshot = { ...snap, armies };
    if (out.meta.tick === undefined) out.meta.tick = snap.tick || 0;
    if (!out.meta.seed && snap.seed !== undefined) out.meta.seed = snap.seed;
    return out;
}

/** 地形加成字段的默认值辅助 */
function terrainBonusOf(c) {
    const b = c.bonuses && typeof c.bonuses === 'object' ? c.bonuses : { division: {}, factory: {}, resource: {}, misc: {} };
    return {
        ...b,
        terrain: b.terrain && typeof b.terrain === 'object' ? b.terrain : {},
    };
}

/** v3 → v4：引入空军 / 海军 / 阵营 / 租借 / 和平提议 / 部队指令等字段 */
function migrateV4FromV3(data) {
    const out = { ...data, meta: { ...(data.meta || {}), version: 4 } };
    const prev = out.snapshot || {};

    const snap = {
        ...prev,
        airForces: Array.isArray(prev.airForces) ? prev.airForces : [],
        fleets: Array.isArray(prev.fleets) ? prev.fleets : [],
        factionInvites: Array.isArray(prev.factionInvites) ? prev.factionInvites : [],
        peaceOffers: Array.isArray(prev.peaceOffers) ? prev.peaceOffers : [],
        lendLease: prev.lendLease && typeof prev.lendLease === 'object' ? prev.lendLease : {},
    };

    snap.armies = Array.isArray(prev.armies)
        ? prev.armies.map((a) => (a && typeof a === 'object' ? { order: 'hold', ...a } : a))
        : [];
    snap.alliances = Array.isArray(prev.alliances)
        ? prev.alliances.map((f) => {
            if (!f || typeof f !== 'object') return f;
            const members = Array.isArray(f.members) ? f.members : [];
            return {
                invites: [],
                leader: f.leader ?? members[0] ?? null,
                ...f,
                members: [...members],
            };
        })
        : [];
    if (prev.countries && typeof prev.countries === 'object') {
        const countries = {};
        for (const [tag, c] of Object.entries(prev.countries)) {
            if (!c || typeof c !== 'object') { countries[tag] = c; continue; }
            countries[tag] = {
                ...c,
                unlockedAir: Array.isArray(c.unlockedAir) ? c.unlockedAir : [],
                unlockedShips: Array.isArray(c.unlockedShips) ? c.unlockedShips : [],
                bonuses: terrainBonusOf(c),
            };
        }
        snap.countries = countries;
    }
    snap.wars = Array.isArray(prev.wars)
        ? prev.wars.map((w) => {
            if (!w || typeof w !== 'object') return w;
            return {
                goals: [],
                alliesA: [w.a],
                alliesB: [w.b],
                ...w,
            };
        })
        : [];

    for (const key of ['nextAirId', 'nextFleetId', 'nextInviteId', 'nextOfferId', 'controllerVersion']) {
        if (!Number.isFinite(snap[key])) snap[key] = 1;
    }
    out.snapshot = snap;
    return out;
}

/** 迁移表：key = 源版本 */
export const MIGRATIONS = {
    1: migrateV1ToV2,
    2: migrateV3FromV2,
    3: migrateV4FromV3,
};

/**
 * 按迁移表把存档升级到当前版本。
 * @returns {object} 升级后的存档（原对象不被修改）
 */
export function migrateSave(data) {
    if (!data || typeof data !== 'object') return data;
    const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    let version = Number.isFinite(meta.version) ? Math.floor(meta.version) : 1;
    let out = { ...data, meta: { ...meta } };
    while (version < SAVE_VERSION) {
        const fn = MIGRATIONS[version];
        if (!fn) { version = SAVE_VERSION; break; }
        out = fn(out);
        version += 1;
    }
    out.meta = { ...(out.meta || {}), version: SAVE_VERSION };
    return out;
}

/** 该存档是否需要迁移 */
export function needsMigration(data) {
    if (!data || typeof data !== 'object') return false;
    const v = Number.isFinite(data.meta?.version) ? data.meta.version : 1;
    return v < SAVE_VERSION;
}

// ===================== 增量补丁 =====================

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 计算两份状态之间的路径式补丁。
 * @returns {object} 路径 → 新值；删除的键写作 { __delete: true }
 */
export function diffState(base, next, prefix = '', out = {}) {
    if (Object.is(base, next)) return out;

    if (Array.isArray(base) || Array.isArray(next)) {
        const same = Array.isArray(base) && Array.isArray(next)
            && base.length === next.length
            && base.every((v, i) => Object.is(v, next[i]));
        if (!same) out[prefix || '__root__'] = next;
        return out;
    }

    if (isPlainObject(base) && isPlainObject(next)) {
        const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
        for (const k of [...keys].sort()) {
            const path = prefix ? `${prefix}.${k}` : k;
            if (!(k in base)) {
                out[path] = next[k];
            } else if (!(k in next)) {
                out[path] = { __delete: true };
            } else {
                diffState(base[k], next[k], path, out);
            }
        }
        return out;
    }

    out[prefix || '__root__'] = next;
    return out;
}

function setNested(target, path, value) {
    const keys = path.split('.');
    let node = target;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (!isPlainObject(node[k])) node[k] = {};
        node = node[k];
    }
    node[keys[keys.length - 1]] = value;
}

function deleteNested(target, path) {
    const keys = path.split('.');
    let node = target;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!isPlainObject(node[keys[i]])) return;
        node = node[keys[i]];
    }
    delete node[keys[keys.length - 1]];
}

/**
 * 把补丁应用到基线状态上，返回新状态（不修改入参）。
 * @param {object} base 基线状态
 * @param {object} patch diffState 产出的补丁
 */
export function applyPatch(base, patch) {
    const out = typeof structuredClone === 'function' ? structuredClone(base) : JSON.parse(JSON.stringify(base));
    for (const [path, value] of Object.entries(patch || {})) {
        if (value && typeof value === 'object' && value.__delete) {
            deleteNested(out, path);
        } else {
            setNested(out, path, typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
        }
    }
    return out;
}

/** 统计补丁条目数（用于判断是否推进基线） */
export function patchSize(patch) {
    return Object.keys(patch || {}).length;
}

/**
 * 组装增量存档。
 * @param {object} opts
 * @param {object} opts.meta 存档元信息
 * @param {object} opts.baseSnapshot 基线快照
 * @param {object} opts.baseCommands 基线命令日志
 * @param {object} opts.state 当前状态
 * @param {Array} opts.commands 当前命令日志
 */
export function buildIncrementalSave({ meta, baseSnapshot, baseCommands, state, commands }) {
    const patch = diffState(baseSnapshot, state);
    const baseTick = baseSnapshot?.tick ?? 0;
    const deltaTicks = (state?.tick ?? 0) - baseTick;
    // 补丁过大或间隔过久时，把当前状态提升为新基线
    const promote = patchSize(patch) > PATCH_PROMOTE_ENTRIES || deltaTicks >= PATCH_PROMOTE_TICKS;
    if (promote) {
        return {
            meta: { ...meta, incremental: false, baseTick: state?.tick ?? 0, baseDate: meta.date },
            base: { snapshot: state, commands },
            patch: {},
        };
    }
    return {
        meta: { ...meta, incremental: true, baseTick, deltaTicks, patchEntries: patchSize(patch) },
        base: { snapshot: baseSnapshot, commands: baseCommands },
        patch,
    };
}

/** 由增量存档还原出完整存档（可直接交给 Campaign.restore） */
export function resolveIncrementalSave(data) {
    if (!data || !data.base || !data.base.snapshot) return data;
    const snapshot = applyPatch(data.base.snapshot, data.patch || {});
    return { ...data, snapshot, commands: data.base.commands || data.commands || [] };
}
