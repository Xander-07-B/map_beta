/* ============================================================
 * 内容层 · 剧本结构校验（schema.js）
 * 纯手写校验器（项目无 zod/ajv 依赖）。报错必须指出具体 id，
 * 否则后期调试是噩梦。CI 中对所有剧本 json 跑本校验。
 * ============================================================ */

const IDEOLOGIES = ['fascist', 'communist', 'democratic', 'neutral'];
const TERRAINS = ['plains', 'plain', 'hills', 'mountain', 'forest', 'desert', 'tundra', 'sea', 'ocean', 'coast'];

/**
 * 校验剧本结构。返回问题列表（空数组 = 通过）。
 * 只做结构与内部引用一致性检查；地图版本、外部内容引用由 loader 校验。
 */
export function validateScenario(raw) {
    const problems = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return ['剧本必须是 JSON 对象'];
    }
    for (const f of ['id', 'startDate', 'map', 'countries', 'owners']) {
        if (!(f in raw)) problems.push(`缺少必填字段: ${f}`);
    }
    if (raw.startDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(raw.startDate)) {
        problems.push(`startDate 必须为 YYYY-MM-DD 格式: ${raw.startDate}`);
    }

    // 国家
    const countryTags = new Set();
    if (raw.countries) {
        if (typeof raw.countries !== 'object' || Array.isArray(raw.countries)) {
            problems.push('countries 必须是对象');
        } else {
            for (const [tag, def] of Object.entries(raw.countries)) {
                countryTags.add(tag);
                if (!def || typeof def !== 'object') {
                    problems.push(`countries.${tag}: 必须是对象`);
                    continue;
                }
                if (def.capital !== undefined && typeof def.capital !== 'number') {
                    problems.push(`countries.${tag}.capital: 必须是省份 id（数字）`);
                }
                if (def.ideology !== undefined && !IDEOLOGIES.includes(def.ideology)) {
                    problems.push(`countries.${tag}.ideology: 非法值 ${def.ideology}`);
                }
                for (const [res, v] of Object.entries(def.resources || {})) {
                    if (typeof v !== 'number') problems.push(`countries.${tag}.resources.${res}: 必须是数字`);
                }
            }
        }
    }

    // 省份
    const provinceIds = new Set();
    if (raw.provinces) {
        if (!Array.isArray(raw.provinces)) {
            problems.push('provinces 必须是数组');
        } else {
            for (const p of raw.provinces) {
                if (!p || typeof p.id !== 'number') {
                    problems.push('provinces: 每项必须含数字 id');
                    continue;
                }
                if (provinceIds.has(p.id)) problems.push(`provinces: 省份 id 重复: ${p.id}`);
                provinceIds.add(p.id);
                if (!TERRAINS.includes(p.terrain)) {
                    problems.push(`provinces[${p.id}].terrain: 非法值 ${p.terrain}`);
                }
                if (p.coastal !== undefined && typeof p.coastal !== 'boolean') {
                    problems.push(`provinces[${p.id}].coastal: 必须是布尔值`);
                }
            }
        }
    }

    // owners 引用
    if (raw.owners) {
        if (typeof raw.owners !== 'object' || Array.isArray(raw.owners)) {
            problems.push('owners 必须是对象（省份 id → 国家 tag）');
        } else {
            for (const [pid, tag] of Object.entries(raw.owners)) {
                if (!provinceIds.has(Number(pid))) {
                    problems.push(`owners: 省份 id 不存在: ${pid}`);
                }
                if (!countryTags.has(tag)) {
                    problems.push(`owners: 国家 tag 不存在: ${tag}（省份 ${pid}）`);
                }
            }
        }
    }

    // 州
    if (raw.states) {
        if (!Array.isArray(raw.states)) {
            problems.push('states 必须是数组');
        } else {
            const stateIds = new Set();
            for (const st of raw.states) {
                if (!st || typeof st.id !== 'number') {
                    problems.push('states: 每项必须含数字 id');
                    continue;
                }
                if (stateIds.has(st.id)) problems.push(`states: 州 id 重复: ${st.id}`);
                stateIds.add(st.id);
                if (!Array.isArray(st.provinces)) {
                    problems.push(`states[${st.id}].provinces: 必须是数组`);
                    continue;
                }
                for (const pid of st.provinces) {
                    if (!provinceIds.has(pid)) {
                        problems.push(`states[${st.id}]: 引用了不存在的省份 ${pid}`);
                    }
                }
                if (st.capitalProvince !== undefined && !provinceIds.has(st.capitalProvince)) {
                    problems.push(`states[${st.id}].capitalProvince: 省份不存在 ${st.capitalProvince}`);
                }
                // 州归属必须与首府省份归属一致
                if (st.capitalProvince !== undefined && raw.owners && st.owner) {
                    const capOwner = raw.owners[String(st.capitalProvince)];
                    if (capOwner !== undefined && capOwner !== st.owner) {
                        problems.push(`states[${st.id}].owner(${st.owner}) 与首府省份归属(${capOwner})不一致`);
                    }
                }
            }
        }
    }

    // 任务
    if (raw.missions) {
        if (!Array.isArray(raw.missions)) {
            problems.push('missions 必须是数组');
        } else {
            for (const m of raw.missions) {
                if (!m || typeof m.id !== 'string' || typeof m.scope !== 'string') {
                    problems.push('missions: 每项必须含 id 与 scope');
                    continue;
                }
                if (!m.objective || typeof m.objective.type !== 'string') {
                    problems.push(`missions[${m.id}].objective.type: 缺失`);
                }
                if (m.objective?.state !== undefined && raw.states &&
                    !raw.states.some((x) => x.id === m.objective.state)) {
                    problems.push(`missions[${m.id}]: 引用了不存在的州 ${m.objective.state}`);
                }
            }
        }
    }

    // 胜负条件
    if (raw.victoryConditions) {
        if (typeof raw.victoryConditions !== 'object' || Array.isArray(raw.victoryConditions)) {
            problems.push('victoryConditions 必须是对象');
        } else {
            for (const [tag, cond] of Object.entries(raw.victoryConditions)) {
                if (!countryTags.has(tag)) {
                    problems.push(`victoryConditions: 国家 tag 不存在: ${tag}`);
                }
                if (!cond || typeof cond.type !== 'string') {
                    problems.push(`victoryConditions.${tag}.type: 缺失`);
                    continue;
                }
                if (!['controlVP', 'controlState', 'survive', 'surrender'].includes(cond.type) &&
                    !Array.isArray(cond.or)) {
                    problems.push(`victoryConditions.${tag}.type: 非法值 ${cond.type}`);
                }
                if (cond.type === 'controlVP' && cond.targets) {
                    for (const pid of Object.keys(cond.targets)) {
                        if (!provinceIds.has(Number(pid))) {
                            problems.push(`victoryConditions.${tag}: 目标省份不存在 ${pid}`);
                        }
                    }
                }
                if (cond.type === 'controlState' && cond.states) {
                    for (const sid of cond.states) {
                        if (!raw.states || !raw.states.some((x) => x.id === sid)) {
                            problems.push(`victoryConditions.${tag}: 目标州不存在 ${sid}`);
                        }
                    }
                }
                if (cond.until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(cond.until)) {
                    problems.push(`victoryConditions.${tag}.until: 必须为 YYYY-MM-DD`);
                }
            }
        }
    }

    return problems;
}

/**
 * 校验国策树：节点存在、前置引用存在、DAG 无环。
 * 返回问题列表（空数组 = 通过）。
 */
export function validateFocusTree(tree) {
    const problems = [];
    if (!tree || typeof tree !== 'object' || !tree.nodes) {
        return ['国策树必须是含 nodes 的对象'];
    }
    const nodes = tree.nodes;

    for (const [id, n] of Object.entries(nodes)) {
        if (!n || typeof n !== 'object') {
            problems.push(`focusTree.${id}: 必须是对象`);
            continue;
        }
        for (const pre of n.prerequisites || []) {
            if (!(pre in nodes)) problems.push(`focusTree.${id}: 前置节点不存在: ${pre}`);
        }
        if (n.days !== undefined && (typeof n.days !== 'number' || n.days <= 0)) {
            problems.push(`focusTree.${id}.days: 必须为正数`);
        }
    }

    // DFS 三色标记查环
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = {};
    const dfs = (id, stack) => {
        color[id] = GRAY;
        for (const pre of nodes[id]?.prerequisites || []) {
            if (color[pre] === GRAY) {
                problems.push(`focusTree: 存在环 ${[...stack, id, pre].join(' -> ')}`);
            } else if (!color[pre]) {
                dfs(pre, [...stack, id]);
            }
        }
        color[id] = BLACK;
    };
    for (const id of Object.keys(nodes)) {
        if (!color[id]) dfs(id, []);
    }
    return problems;
}

/** 校验事件文件结构（W1 只做静态结构检查，触发判定在 W3） */
export function validateEvent(ev) {
    const problems = [];
    if (!ev || typeof ev.id !== 'string') problems.push('事件缺少 id');
    if (!Array.isArray(ev.options) || ev.options.length === 0) {
        problems.push(`事件 ${ev?.id}: options 必须为非空数组`);
    }
    for (const [i, opt] of (ev?.options || []).entries()) {
        if (!opt || !Array.isArray(opt.effects)) {
            problems.push(`事件 ${ev?.id} 选项 ${i}: 缺少 effects 数组`);
        }
    }
    return problems;
}

/** 校验决议文件结构 */
export function validateDecision(dec) {
    const problems = [];
    if (!dec || typeof dec.id !== 'string') problems.push('决议缺少 id');
    if (dec?.cost?.politicalPower !== undefined && typeof dec.cost.politicalPower !== 'number') {
        problems.push(`决议 ${dec?.id}.cost.politicalPower: 必须是数字`);
    }
    if (!Array.isArray(dec?.effects)) {
        problems.push(`决议 ${dec?.id}: effects 必须是数组`);
    }
    return problems;
}

export class ScenarioError extends Error {
    constructor(message, problems) {
        super(message + (problems?.length ? `:\n- ${problems.join('\n- ')}` : ''));
        this.name = 'ScenarioError';
        this.problems = problems || [];
    }
}
