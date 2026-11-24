// scripts/build-index.mjs — 离线构建省份索引：邻接表 + 元数据
// 用法: node scripts/build-sea.mjs && node scripts/build-provinces.mjs && node scripts/build-index.mjs
// 几何来自 provinces.l1.topo.json（属性已剥离以减小体积），
// 名称/归属等属性从原始 Natural Earth GeoJSON 按 ne_id 关联。
//
// 只写运行时真正读取的字段（name / owner / scalerank / coastal）。
// 早期版本还写了 nameEn / iso / type / bbox 和重复的 id，占索引体积一半以上，
// 浏览器解析后却没人用；删掉后 index.json 从 1.3 MB 降到约 0.5 MB。
//
// 海域省份（由 build-sea.mjs 生成、build-provinces 并入）在陆地 GeoJSON 中无属性，
// 这里按 sea-adj.json 的键识别，标记 sea:true、owner:null，并补入海域-陆地邻接
// （海域与陆地几何不共享弧段，弧段邻接表无法给出这层关系）。
import { readFileSync, writeFileSync } from "node:fs";
import * as topojson from "topojson-client";

const topo = JSON.parse(readFileSync("data/provinces.l1.topo.json", "utf8"));
const raw = JSON.parse(readFileSync("data/ne_10m_admin_1_states_provinces.geojson", "utf8"));
const seaAdj = JSON.parse(readFileSync("data/sea-adj.json", "utf8"));

// 原始属性表：ne_id -> properties（TopoJSON 几何 id 与之一一对应）
const propsById = new Map();
for (const f of raw.features) {
    const p = f.properties || {};
    if (p.ne_id != null) propsById.set(+p.ne_id, p);
}

// 海域省份 id 集合（来自 sea-adj.json）
const seaIds = new Set(Object.keys(seaAdj.seaLand).map(Number));

// mapshaper 以输入文件名作为对象名，这里取第一个 GeometryCollection
const objName = Object.keys(topo.objects).find(k => topo.objects[k].type === "GeometryCollection");
const geoms = topo.objects[objName].geometries;

// ① 邻接表：共享弧段即相邻（TopoJSON 白送的能力）
const adj = topojson.neighbors(geoms);
const neighbors = {};
geoms.forEach((g, i) => (neighbors[g.id] = adj[i].map(j => geoms[j].id)));

// ② 弧段引用计数：只被一个省引用的弧段就是海岸线（两个省共享的才是内陆省界），
// 由此可以真实判定省份是否沿海——舰队部署与移动都依赖这个字段。
const arcRefs = new Map();
const provinceArcs = new Map();   // province id -> Set<arcIndex>
const noteArc = (gid, ai) => {
    const idx = ai < 0 ? ~ai : ai;
    arcRefs.set(idx, (arcRefs.get(idx) || 0) + 1);
    if (!provinceArcs.has(gid)) provinceArcs.set(gid, new Set());
    provinceArcs.get(gid).add(idx);
};
geoms.forEach((g) => {
    const rings = g.type === "Polygon" ? [g.arcs]
              : g.type === "MultiPolygon" ? g.arcs : [];
    for (const ring of rings.flat()) for (const ai of ring) noteArc(g.id, ai);
});

// ③ 元数据（只保留运行时读取的字段）
// 海域省份已按陆地边界裁剪，海岸线弧段由陆地省份与海域省份共享，
// 因此不能再只看「只被自己引用」的弧段来判定沿海——只要和海域共边即可。
const seaArcSet = new Set();
for (const g of geoms) {
    if (!seaIds.has(+g.id)) continue;
    for (const idx of provinceArcs.get(g.id) || []) seaArcSet.add(idx);
}
const meta = {};
let missingProps = 0;
let coastalCount = 0;
geoms.forEach((g) => {
    const id = +g.id;
    if (seaIds.has(id)) {
        // 海域省份：无归属、不沿海，标记 sea 供剧本识别为 ocean 地形
        meta[id] = { name: "海域", owner: null, scalerank: 9, coastal: false, sea: true };
        return;
    }
    const p = propsById.get(id) || {};
    if (!p.adm0_a3) missingProps++;
    // 沿海判定：与海域共享任意一条弧段（海岸线），或拥有独立的海岸线弧段。
    const arcs = provinceArcs.get(g.id) || new Set();
    const coastal = [...arcs].some((idx) => arcRefs.get(idx) === 1 || seaArcSet.has(idx));
    if (coastal) coastalCount++;
    meta[id] = {
        name: p.name_zh || p.name || `prov${g.id}`,
        owner: p.adm0_a3 || null,
        scalerank: p.scalerank ?? 9,
        coastal,
    };
});

// ④ 补入海域-陆地、海域-海域邻接（来自 build-sea 的网格级计算；
//    裁剪后弧段邻接已能给出大部分关系，这里补上跨格的对角邻接并去重）
const geomIds = new Set(geoms.map((g) => +g.id));
function mergeAdj(map) {
    for (const [a, bs] of Object.entries(map)) {
        const aid = Number(a);
        if (!geomIds.has(aid)) continue; // 裁剪后可能已被完全抹掉的极小海域
        if (!neighbors[aid]) neighbors[aid] = [];
        for (const bid of bs) {
            if (!geomIds.has(bid)) continue;
            if (!neighbors[aid].includes(bid)) neighbors[aid].push(bid);
            if (!neighbors[bid]) neighbors[bid] = [];
            if (!neighbors[bid].includes(aid)) neighbors[bid].push(aid);
        }
    }
}
mergeAdj(seaAdj.seaLand);
mergeAdj(seaAdj.seaAdj || {});

writeFileSync("data/index.json", JSON.stringify({ neighbors, meta }));
console.log(`provinces=${geoms.length}, edges=${adj.flat().length / 2}, missingProps=${missingProps}, coastal=${coastalCount}, sea=${seaIds.size}`);
