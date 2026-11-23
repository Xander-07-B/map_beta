// scripts/build-index.mjs — 离线构建省份索引：邻接表 + 元数据
// 用法: node scripts/build-index.mjs
// 几何来自 provinces.l1.topo.json（属性已剥离以减小体积），
// 名称/归属等属性从原始 Natural Earth GeoJSON 按 ne_id 关联。
//
// 只写运行时真正读取的字段（name / owner / scalerank / coastal）。
// 早期版本还写了 nameEn / iso / type / bbox 和重复的 id，占索引体积一半以上，
// 浏览器解析后却没人用；删掉后 index.json 从 1.3 MB 降到约 0.5 MB。
import { readFileSync, writeFileSync } from "node:fs";
import * as topojson from "topojson-client";

const topo = JSON.parse(readFileSync("data/provinces.l1.topo.json", "utf8"));
const raw = JSON.parse(readFileSync("data/ne_10m_admin_1_states_provinces.geojson", "utf8"));

// 原始属性表：ne_id -> properties（TopoJSON 几何 id 与之一一对应）
const propsById = new Map();
for (const f of raw.features) {
    const p = f.properties || {};
    if (p.ne_id != null) propsById.set(+p.ne_id, p);
}

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
const meta = {};
let missingProps = 0;
let coastalCount = 0;
geoms.forEach((g) => {
    const p = propsById.get(+g.id) || {};
    if (!p.adm0_a3) missingProps++;
    // 沿海判定：该省拥有任意一条「只被自己引用」的弧段（即海岸线）
    const coastal = [...(provinceArcs.get(g.id) || [])].some((idx) => arcRefs.get(idx) === 1);
    if (coastal) coastalCount++;
    meta[g.id] = {
        name: p.name_zh || p.name || `prov${g.id}`,
        owner: p.adm0_a3 || null,
        scalerank: p.scalerank ?? 9,
        coastal,
    };
});

writeFileSync("data/index.json", JSON.stringify({ neighbors, meta }));
console.log(`provinces=${geoms.length}, edges=${adj.flat().length / 2}, missingProps=${missingProps}, coastal=${coastalCount}`);
