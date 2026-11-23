// scripts/build-scenario.mjs — 生成全地图 1936 剧本
// 用法: node scripts/build-scenario.mjs
//
// 手写内容保存在 data/scenarios/1936.template.json（国家数值、欧洲省份细节、
// 州、任务、胜负条件、初始部队）。本脚本把模板与 data/index.json 合并：
//   - 为地图上全部 4,594 个省份补齐 province / owner 条目
//   - 为全部 250 个地图归属方补齐最小国家定义（非可玩，仅保证归属与外交查询有效）
//   - 为手写州之外的所有省份按国家生成州（每国一个），使占领、VP 与 AI 建造可用
// 输出 data/scenarios/1936.json。请勿直接编辑输出文件，改模板后重新运行本脚本。
import { readFileSync, writeFileSync } from "node:fs";

const TEMPLATE_PATH = "data/scenarios/1936.template.json";
const INDEX_PATH = "data/index.json";
const COUNTRIES_PATH = "data/ne_50m_admin_0_countries.geojson";
const OUT_PATH = "data/scenarios/1936.json";

// 地图 ISO3 → 战役国家 tag。只有可玩国家需要换算，其余直接使用 ISO3。
const ISO3_TO_TAG = { DEU: "GER", POL: "POL", FRA: "FRA" };

// Natural Earth 中不属于标准国家的归属码，保留为独立小国/地区。
const SPECIAL_NAMES = {
    CLP: "克利珀顿岛",
    CSI: "珊瑚海群岛",
    ESB: "德凯利亚",
    GIB: "直布罗陀",
    KAB: "拜科努尔",
    PGA: "南沙群岛",
    UMI: "美国本土外小岛屿",
    USG: "关塔那摩湾",
    WSB: "阿克罗蒂里",
};

// 1936 年语境下的少量显示名覆盖（其余沿用 Natural Earth 中文名）。
const NAME_OVERRIDES = {
    RUS: "苏联",
    CHN: "中国",
};

// coastal 取自 index.json（由弧段引用判定，见 build-index.mjs）；terrain 按省份 id 合成。
// 手写模板中的省份优先使用模板自身数值。

// Natural Earth 的省份属性里没有地形字段，这里按省份 id 做确定性合成：
// 以平原为主，掺入丘陵/森林/山地/沙漠/苔原，让地形防御、移动代价与
// 地形科技真正起作用（合成地形，不代表真实地貌）。
const TERRAIN_POOL = [
    { terrain: "plains", weight: 52 },
    { terrain: "hills", weight: 14 },
    { terrain: "forest", weight: 14 },
    { terrain: "desert", weight: 8 },
    { terrain: "mountain", weight: 6 },
    { terrain: "tundra", weight: 6 },
];
const TERRAIN_TOTAL = TERRAIN_POOL.reduce((sum, t) => sum + t.weight, 0);

function terrainOf(id) {
    let h = (id * 2654435761) >>> 0;
    let r = h % TERRAIN_TOTAL;
    for (const t of TERRAIN_POOL) {
        r -= t.weight;
        if (r < 0) return t.terrain;
    }
    return "plains";
}

const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
const geo = JSON.parse(readFileSync(COUNTRIES_PATH, "utf8"));

// ---------- 国家元数据：中文名 / ISO2（旗帜） ----------
const countryInfo = new Map();
for (const f of geo.features) {
    const p = f.properties || {};
    const info = {
        name: p.NAME_ZH || p.NAME_ZHT || p.NAME || p.ADMIN || null,
        iso2: p.ISO_A2 && /^[A-Z]{2}$/.test(p.ISO_A2) ? p.ISO_A2
            : (p.ISO_A2_EH && /^[A-Z]{2}$/.test(p.ISO_A2_EH) ? p.ISO_A2_EH : null),
    };
    for (const key of [p.ADM0_A3, p.ISO_A3, p.ISO_A3_EH, p.SOV_A3]) {
        if (key && key !== "-99" && !countryInfo.has(key)) countryInfo.set(key, info);
    }
}

function tagOf(iso3) {
    return ISO3_TO_TAG[iso3] || iso3;
}

function countryName(tag) {
    return NAME_OVERRIDES[tag] || SPECIAL_NAMES[tag] || countryInfo.get(tag)?.name || tag;
}

function flagOf(tag) {
    const iso2 = countryInfo.get(tag)?.iso2;
    if (!iso2) return "";
    return String.fromCodePoint(...[...iso2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// 与 map.js 的 countryColor 非可玩分支保持同一哈希，避免加入国家定义后地图变色。
function hashColor(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 32%, 42%)`;
}

const metaById = new Map(Object.values(index.meta).map((m) => [m.id, m]));
const manualProvinces = new Map((template.provinces || []).map((p) => [p.id, p]));
const manualOwners = new Map(Object.entries(template.owners || {}).map(([id, tag]) => [Number(id), tag]));

// ---------- 省份与归属 ----------
const provinces = [];
const owners = {};
const ownedBy = new Map(); // tag -> 省份 id[]

for (const m of Object.values(index.meta).sort((a, b) => a.id - b.id)) {
    const id = m.id;
    const manual = manualProvinces.get(id);
    const p = manual
        ? { ...manual, coastal: manual.coastal ?? !!m.coastal }
        : { id, terrain: terrainOf(id), coastal: !!m.coastal, supply: 0.5, infrastructure: 2 };
    const tag = manualOwners.get(id) || tagOf(m.owner || "UNK");
    provinces.push(p);
    owners[id] = tag;
    if (!ownedBy.has(tag)) ownedBy.set(tag, []);
    ownedBy.get(tag).push(id);
}

// 手写模板里若有地图索引不存在的省份，保留（例如未来新增的非地图逻辑格）。
for (const p of template.provinces || []) {
    if (metaById.has(p.id)) continue;
    provinces.push({ ...p });
    const tag = manualOwners.get(p.id) || "UNK";
    owners[p.id] = tag;
    if (!ownedBy.has(tag)) ownedBy.set(tag, []);
    ownedBy.get(tag).push(p.id);
}

// ---------- 国家定义 ----------
const playable = Array.isArray(template.playable) && template.playable.length
    ? template.playable.filter((tag) => tag in template.countries)
    : Object.keys(template.countries || {});

const countries = {};
for (const tag of playable) countries[tag] = { ...template.countries[tag] };

const allTags = [...ownedBy.keys()].sort();
for (const tag of allTags) {
    if (countries[tag]) continue;
    const ids = ownedBy.get(tag);
    // 首府：scalerank 最小（Natural Earth 中首都/主要城市更靠前），再按 id 稳定排序。
    const capital = ids.slice().sort((a, b) => {
        const ra = metaById.get(a)?.scalerank ?? 9;
        const rb = metaById.get(b)?.scalerank ?? 9;
        return ra - rb || a - b;
    })[0];
    countries[tag] = {
        name: countryName(tag),
        flag: flagOf(tag),
        color: hashColor(tag),
        ideology: "neutral",
        capital: capital ?? null,
        population: 0,
        manpower: 0,
        politicalPower: 0,
        stability: 0.6,
        warSupport: 0.4,
        legitimacy: 0.6,
        resources: {},
        equipment: {},
        civs: 0,
        mils: 0,
        docks: 0,
        relations: {},
        faction: null,
        researchSlots: 0,
        unlockedTemplates: [],
    };
}

// 模板中声明但地图上没有省份的国家也保留（避免引用失效）。
for (const [tag, def] of Object.entries(template.countries || {})) {
    if (!countries[tag]) countries[tag] = { ...def };
}

// ---------- 州 ----------
// 手写州原样保留；其余省份按国家各生成一个州。这样 1939 补丁只覆盖手写州时，
// 被覆盖的手写州与生成州不会互相包含，归属语义保持自洽。
const states = (template.states || []).map((st) => ({
    ...st,
    provinces: [...(st.provinces || [])],
}));
const covered = new Set(states.flatMap((st) => st.provinces));
let nextStateId = Math.max(1000, ...states.map((st) => st.id + 1));

for (const tag of allTags) {
    const ids = ownedBy.get(tag).filter((id) => !covered.has(id)).sort((a, b) => a - b);
    if (ids.length === 0) continue;
    const capital = ids.slice().sort((a, b) => {
        const ra = metaById.get(a)?.scalerank ?? 9;
        const rb = metaById.get(b)?.scalerank ?? 9;
        return ra - rb || a - b;
    })[0];
    states.push({
        id: nextStateId++,
        name: countryName(tag),
        owner: tag,
        core: tag,
        provinces: ids,
        capitalProvince: capital,
        population: 0,
        factories: 0,
        isCapital: false,
    });
}

// ---------- 初始部队引用校验（不阻断生成，只提示） ----------
for (const a of template.initialArmies || []) {
    if (!countries[a.country]) console.warn(`[build-scenario] 初始部队国家不存在: ${a.country}`);
    if (!owners[a.province]) console.warn(`[build-scenario] 初始部队省份不存在: ${a.province}`);
}

const scenario = {
    ...template,
    playable,
    countries,
    provinces,
    owners,
    states,
};

writeFileSync(OUT_PATH, JSON.stringify(scenario));
console.log(
    `scenario=${OUT_PATH} provinces=${provinces.length} countries=${Object.keys(countries).length} ` +
    `states=${states.length} playable=${playable.join("/")}`
);
