/* ============================================================
 * 内容层 · 剧本加载（loader.js）
 * 加载流程：fetch → 结构校验 →（有 base 时）深合并补丁 → 引用校验。
 * 引用校验：focusTree / events / decisions 引用的外部内容文件必须存在且结构合法，
 * 国策树必须通过 DAG 无环校验。地图版本不一致时给出迁移提示而非崩溃。
 * ============================================================ */

import { validateScenario, validateFocusTree, validateEvent, validateDecision, ScenarioError } from './schema.js';

/** 默认 fetchJson：浏览器环境 */
export async function fetchJsonBrowser(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} 加载 ${url} 失败`);
    return res.json();
}

/**
 * 深合并：对象递归合并，数组整体替换（补丁语义：数组以补丁为准）。
 * 返回新对象，不修改入参。
 */
export function deepMerge(base, patch) {
    if (patch === undefined) return base;
    if (Array.isArray(patch)) return patch.slice();
    if (patch && typeof patch === 'object') {
        const out = { ...(base && typeof base === 'object' ? base : {}) };
        for (const [k, v] of Object.entries(patch)) {
            out[k] = deepMerge(base?.[k], v);
        }
        return out;
    }
    return patch;
}

/**
 * 加载剧本文件：优先 `{id}.json`，不存在时回退 `{id}.patch.json`（派生剧本补丁）。
 */
async function fetchScenarioFile(fetchJson, base, id) {
    try {
        return await fetchJson(`${base}/${id}.json`);
    } catch (firstErr) {
        return await fetchJson(`${base}/${id}.patch.json`);
    }
}

/**
 * 加载全局内容（不随剧本变化）：装备、科技、部队模板。
 * 单独成函数，失败即抛错——这些是经济与军事系统的底座，缺一个整个模拟层都无法结算。
 */
async function loadCoreContent(fetchJson, contentBase) {
    const load = async (name) => {
        const raw = await fetchJson(`${contentBase}/${name}`);
        if (!raw || typeof raw !== 'object') throw new Error(`${name} 内容文件格式非法`);
        return raw;
    };
    const [eqRaw, techRaw, divRaw] = await Promise.all([
        load('equipment.json'),
        load('techs.json'),
        load('divisions.json'),
    ]);
    const equipment = eqRaw.equipment || {};
    const techs = techRaw.techs || {};
    const divisions = divRaw.divisions || {};

    const problems = [];
    for (const [id, eq] of Object.entries(equipment)) {
        if (typeof eq.cost !== 'number' || eq.cost <= 0) problems.push(`equipment.${id}.cost 必须为正数`);
    }
    for (const [id, t] of Object.entries(techs)) {
        if (typeof t.time !== 'number' || t.time <= 0) problems.push(`techs.${id}.time 必须为正数`);
        for (const pre of t.requires || []) {
            if (!(pre in techs)) problems.push(`techs.${id}: 前置科技不存在: ${pre}`);
        }
    }
    for (const [id, d] of Object.entries(divisions)) {
        if (typeof d.baseStrength !== 'number') problems.push(`divisions.${id}.baseStrength 缺失`);
        if (!d.cost || typeof d.cost.manpower !== 'number') problems.push(`divisions.${id}.cost.manpower 缺失`);
    }
    if (problems.length) throw new Error(`核心内容校验失败:\n- ${problems.join('\n- ')}`);

    return { equipment, techs, divisions };
}

/**
 * 加载剧本。
 * @param {string} id 剧本 id（如 '1936'）
 * @param {object} [opts]
 * @param {function} [opts.fetchJson] 自定义加载函数（测试/Node 用）
 * @param {string} [opts.base] 剧本目录基址，默认 'data/scenarios'
 * @param {string} [opts.contentBase] 内容目录基址，默认 'data'
 */
export async function loadScenario(id, opts = {}) {
    const fetchJson = opts.fetchJson || fetchJsonBrowser;
    const base = opts.base ?? 'data/scenarios';
    const contentBase = opts.contentBase ?? 'data';

    const content = await loadCoreContent(fetchJson, contentBase);
    const raw = await fetchScenarioFile(fetchJson, base, id);

    if (raw.base) {
        // 补丁文件：只做最小形状检查，合并后整体校验
        if (typeof raw.base !== 'string') {
            throw new ScenarioError(`剧本 ${id} 的 base 字段必须是字符串`);
        }
        if (raw.patch !== undefined && (typeof raw.patch !== 'object' || raw.patch === null || Array.isArray(raw.patch))) {
            throw new ScenarioError(`剧本 ${id} 的 patch 字段必须是对象`);
        }
    } else {
        const problems = validateScenario(raw);
        if (problems.length) throw new ScenarioError(`剧本 ${id} 结构校验失败`, problems);
    }

    let sc = raw;
    let derivedFrom = null;

    // 剧本派生：基础剧本 + 差异补丁
    if (raw.base) {
        const baseRaw = await fetchScenarioFile(fetchJson, base, raw.base);
        const baseProblems = validateScenario(baseRaw);
        if (baseProblems.length) throw new ScenarioError(`基础剧本 ${raw.base} 校验失败`, baseProblems);
        // 补丁文件的顶层标量字段（如 startDate）与 patch 对象一并合并
        const { base: _b, patch: _p, id: _i, ...topOverrides } = raw;
        sc = deepMerge(baseRaw, { ...raw.patch, ...topOverrides });
        sc.id = raw.id || raw.base;
        derivedFrom = raw.base;
        // 派生剧本整体重新校验（合并结果可能引入新的不一致）
        const mergeProblems = validateScenario(sc);
        if (mergeProblems.length) throw new ScenarioError(`派生剧本 ${sc.id}（源自 ${raw.base}）合并后校验失败`, mergeProblems);
    }

    // 引用校验：国策树 / 事件 / 决议
    const refProblems = [];
    const focusTrees = {};
    for (const c of Object.values(sc.countries || {})) {
        if (!c.focusTree) continue;
        try {
            focusTrees[c.focusTree] = await fetchJson(`${contentBase}/focuses/${c.focusTree}.json`);
        } catch {
            refProblems.push(`国策树文件缺失: ${c.focusTree}`);
        }
    }
    for (const [treeId, tree] of Object.entries(focusTrees)) {
        for (const p of validateFocusTree(tree)) refProblems.push(`focuses/${treeId}: ${p}`);
    }

    const events = {};
    for (const eid of sc.events?.enabled || []) {
        try {
            events[eid] = await fetchJson(`${contentBase}/events/${eid}.json`);
        } catch {
            refProblems.push(`事件文件缺失: ${eid}`);
        }
    }
    for (const [eid, ev] of Object.entries(events)) {
        for (const p of validateEvent(ev)) refProblems.push(`events/${eid}: ${p}`);
    }

    const decisions = {};
    for (const did of sc.decisions || []) {
        try {
            decisions[did] = await fetchJson(`${contentBase}/decisions/${did}.json`);
        } catch {
            refProblems.push(`决议文件缺失: ${did}`);
        }
    }
    for (const [did, dec] of Object.entries(decisions)) {
        for (const p of validateDecision(dec)) refProblems.push(`decisions/${did}: ${p}`);
    }

    if (refProblems.length) throw new ScenarioError(`剧本 ${sc.id} 引用校验失败`, refProblems);

    return {
        scenario: sc,
        derivedFrom,
        focusTrees,
        events,
        decisions,
        ...content,
    };
}
