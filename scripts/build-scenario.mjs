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

// ---------- 国家元数据：中文名 / ISO2（旗帜）/ 大洲 ----------
const countryInfo = new Map();
for (const f of geo.features) {
    const p = f.properties || {};
    const info = {
        name: p.NAME_ZH || p.NAME_ZHT || p.NAME || p.ADMIN || null,
        iso2: p.ISO_A2 && /^[A-Z]{2}$/.test(p.ISO_A2) ? p.ISO_A2
            : (p.ISO_A2_EH && /^[A-Z]{2}$/.test(p.ISO_A2_EH) ? p.ISO_A2_EH : null),
        continent: p.CONTINENT || null,
    };
    for (const key of [p.ADM0_A3, p.ISO_A3, p.ISO_A3_EH, p.SOV_A3]) {
        if (key && key !== "-99" && !countryInfo.has(key)) countryInfo.set(key, info);
    }
}

// 大洲 → 区域 key（供国家选择菜单按区域筛选）。开放海域归入大洋洲。
const CONTINENT_TO_REGION = {
    "North America": "north_america",
    "South America": "south_america",
    "Europe": "europe",
    "Africa": "africa",
    "Asia": "asia",
    "Oceania": "oceania",
    "Seven seas (open ocean)": "oceania",
};
// 无大洲属性的特殊领地/地区，按地理位置就近归类
const SPECIAL_REGION = {
    CLP: "north_america",   // 克利珀顿岛（太平洋，近北美）
    CSI: "oceania",         // 珊瑚海群岛（大洋洲附近）
    ESB: "europe",          // 德凯利亚（地中海，欧洲）
    GIB: "europe",          // 直布罗陀
    KAB: "asia",            // 拜科努尔（哈萨克斯坦，亚洲）
    PGA: "asia",            // 南沙群岛（亚洲）
    UMI: "north_america",   // 美国本土外小岛屿
    USG: "north_america",   // 关塔那摩湾（古巴，北美）
    WSB: "europe",          // 阿克罗蒂里（地中海，欧洲）
};
// tag（GER/POL/FRA 或 ISO3）→ 大洲
const tagToContinent = new Map();
for (const [iso3, info] of countryInfo) {
    tagToContinent.set(tagOf(iso3), info.continent);
}
/** 取国家的区域 key */
function regionOf(tag) {
    if (SPECIAL_REGION[tag]) return SPECIAL_REGION[tag];
    return CONTINENT_TO_REGION[tagToContinent.get(tag)] || "other";
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

// index.meta 以省份 id 为键（值里不再重复存 id）
const metaById = new Map(Object.entries(index.meta).map(([id, m]) => [Number(id), m]));
const manualProvinces = new Map((template.provinces || []).map((p) => [p.id, p]));
const manualOwners = new Map(Object.entries(template.owners || {}).map(([id, tag]) => [Number(id), tag]));

// ---------- 自动生成国家定义 ----------
// P1-6 全量剧本生成器：除手写的 GER/POL/FRA 外，其余 247 个归属方也要生成
// 可玩、可运转的完整定义（人口/人力/工厂/资源/装备/初始部队），而不是空壳。
// 规模按省份数确定性缩放，让大国强、小国弱，地图上任何国家都能部署与作战。

/** 稳定整数哈希（与 hashColor 同源思路，用于确定性分配意识形态等） */
function hashInt(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return h;
}

/** 取该国首府：scalerank 最小（Natural Earth 中首都/主要城市更靠前），再按 id 稳定排序 */
function capitalOf(ids) {
    return ids.slice().sort((a, b) => {
        const ra = metaById.get(a)?.scalerank ?? 9;
        const rb = metaById.get(b)?.scalerank ?? 9;
        return ra - rb || a - b;
    })[0];
}

/** 生成一个非可玩国家的完整定义（含经济与军事底座，使其可部署、可科研、可建造） */
function generateCountryDef(tag, ids) {
    const n = ids.length;
    const h = hashInt(tag);
    const coastalIds = ids.filter((id) => metaById.get(id)?.coastal);
    const hasCoast = coastalIds.length > 0;

    // 规模缩放：省份越多，人口/工厂/资源越多
    const population = Math.max(5_000_000, Math.round(n * 2_500_000));
    const manpower = Math.floor(population * 0.8);
    const politicalPower = Math.max(10, Math.round(n * 3));
    const civs = Math.max(2, Math.round(n * 0.4));
    const mils = Math.max(1, Math.round(n * 0.3));
    const docks = hasCoast ? Math.max(1, Math.round(n * 0.15)) : 0;

    // 初始驻守师数：按规模给少量步兵师，开局即可指挥
    const garrisonDivs = Math.max(2, Math.round(n / 4));

    // 资源库存：保证产线与建造可运转
    const resources = {
        steel: Math.round(n * 3),
        iron: Math.round(n * 2),
        oil: hasCoast ? Math.max(1, Math.round(n * 0.4)) : 0,
        energy: Math.round(n * 1.5),
        aluminium: Math.max(1, Math.round(n * 0.5)),
        supplies: Math.round(n * 2),
        munitions: Math.round(n * 1),
        rubber: hasCoast ? Math.max(1, Math.round(n * 0.2)) : 0,
        rare: Math.max(1, Math.round(n * 0.2)),
    };

    // 装备库存：足够部署初始驻守师并留有扩编余量
    const equipment = {
        infantry_weapon: garrisonDivs * 6 + Math.round(n * 2),
        artillery: garrisonDivs * 2 + Math.round(n),
        fighter: Math.max(20, Math.round(n * 2)),
    };
    if (hasCoast) equipment.destroyer = Math.max(3, n);

    // 意识形态按哈希确定性分配，让世界有多样性
    const ideologies = ['neutral', 'democratic', 'fascist', 'communist'];
    const ideology = ideologies[h % ideologies.length];

    return {
        name: countryName(tag),
        flag: flagOf(tag),
        color: hashColor(tag),
        ideology,
        region: regionOf(tag),
        capital: capitalOf(ids) ?? null,
        population,
        manpower,
        politicalPower,
        stability: 0.55 + (h % 20) / 100,
        warSupport: 0.45 + (h % 20) / 100,
        legitimacy: 0.6,
        resources,
        equipment,
        civs,
        mils,
        docks,
        relations: {},
        faction: null,
        researchSlots: n >= 6 ? 2 : 1,
        unlockedTemplates: ['infantry'],
        unlockedAir: ['fighter'],
        unlockedShips: hasCoast ? ['destroyer'] : [],
    };
}

// ---------- 省份与归属 ----------
const provinces = [];
const owners = {};
const ownedBy = new Map(); // tag -> 省份 id[]

for (const [idStr, m] of Object.entries(index.meta).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const id = Number(idStr);
    if (m.sea) {
        // 海域省份：ocean 地形、无归属、不入任何州，仅供海军部署与移动
        provinces.push({ id, terrain: "ocean", coastal: false, supply: 0, infrastructure: 0 });
        continue;
    }
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
// 可玩名单：手写三国 + 全部自动生成国家，让地图上每个归属方都有剧本、可选中开局。
const allTags = [...ownedBy.keys()].sort();
const playable = allTags;

const countries = {};
// 先放入手写国家（完整数值、国策、事件、决议、任务），补上区域供选择菜单筛选
for (const tag of (template.playable || Object.keys(template.countries || {}))) {
    if (template.countries[tag]) countries[tag] = { ...template.countries[tag], region: regionOf(tag) };
}
// 模板中声明但地图上没有省份的国家也保留（避免引用失效）
for (const [tag, def] of Object.entries(template.countries || {})) {
    if (!countries[tag]) countries[tag] = { ...def, region: regionOf(tag) };
}

// 自动生成其余国家：完整经济/军事底座 + 初始部队，使其可部署、可科研、可建造
const generatedInitialArmies = [];
const generatedInitialAirForces = [];
const generatedInitialFleets = [];
for (const tag of allTags) {
    if (countries[tag]) continue;
    const ids = ownedBy.get(tag);
    const def = generateCountryDef(tag, ids);
    countries[tag] = def;

    // 初始驻守步兵师（首都）
    const garrisonDivs = Math.max(2, Math.round(ids.length / 4));
    if (def.capital != null) {
        generatedInitialArmies.push({ country: tag, province: def.capital, template: 'infantry', count: garrisonDivs });
    }
    // 较大国家给一个战斗机群（首都）
    if (ids.length >= 8 && def.capital != null) {
        generatedInitialAirForces.push({ country: tag, province: def.capital, template: 'fighter', count: 1 });
    }
    // 沿海国家给一个驱逐舰队（scalerank 最小的沿海省份）
    const coastalIds = ids.filter((id) => metaById.get(id)?.coastal);
    if (coastalIds.length > 0) {
        const coastalCapital = capitalOf(coastalIds);
        generatedInitialFleets.push({ country: tag, province: coastalCapital, template: 'destroyer', count: 1 });
    }
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
    const capital = capitalOf(ids);
    const def = countries[tag] || {};
    states.push({
        id: nextStateId++,
        name: countryName(tag),
        owner: tag,
        core: tag,
        provinces: ids,
        capitalProvince: capital,
        population: def.population || 0,
        factories: (def.civs || 0) + (def.mils || 0) + (def.docks || 0),
        isCapital: false,
    });
}

// ---------- 初始部队引用校验（不阻断生成，只提示） ----------
for (const a of [...(template.initialArmies || []), ...generatedInitialArmies]) {
    if (!countries[a.country]) console.warn(`[build-scenario] 初始部队国家不存在: ${a.country}`);
    if (!owners[a.province]) console.warn(`[build-scenario] 初始部队省份不存在: ${a.province}`);
}

// 合并手写与自动生成的初始部队，让每个国家开局都有可指挥的陆海空力量
const initialArmies = [...(template.initialArmies || []), ...generatedInitialArmies];
const initialAirForces = [...(template.initialAirForces || []), ...generatedInitialAirForces];
const initialFleets = [...(template.initialFleets || []), ...generatedInitialFleets];

const scenario = {
    ...template,
    playable,
    countries,
    provinces,
    owners,
    states,
    initialArmies,
    initialAirForces,
    initialFleets,
};

writeFileSync(OUT_PATH, JSON.stringify(scenario));
console.log(
    `scenario=${OUT_PATH} provinces=${provinces.length} countries=${Object.keys(countries).length} ` +
    `states=${states.length} playable=${Object.keys(countries).length} ` +
    `armies=${initialArmies.length} air=${initialAirForces.length} fleets=${initialFleets.length}`
);
