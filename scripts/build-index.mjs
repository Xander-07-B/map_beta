// scripts/build-index.mjs — 离线构建省份索引：邻接表 + 元数据 + bbox
// 用法: node scripts/build-index.mjs
// 几何来自 provinces.l1.topo.json（属性已剥离以减小体积），
// 名称/归属等属性从原始 Natural Earth GeoJSON 按 ne_id 关联。
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

// ② bbox：解码弧段坐标，取 lon/lat 包围盒
const { arcs, transform } = topo;
const arcCache = new Map();
const decodeArc = (i) => {
    const idx = i < 0 ? ~i : i;
    let pts = arcCache.get(idx);
    if (!pts) {
        let x = 0, y = 0;
        pts = arcs[idx].map(([dx, dy]) => {
            x += dx; y += dy;
            // TopoJSON 反量化：world = quantized * scale + translate
            return [x * transform.scale[0] + transform.translate[0],
                    y * transform.scale[1] + transform.translate[1]];
        });
        arcCache.set(idx, pts);
    }
    return i < 0 ? pts.slice().reverse() : pts;
};

// 弧段引用计数：只被一个省引用的弧段就是海岸线（两个省共享的才是内陆省界），
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

function bboxOf(geom) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const rings = geom.type === "Polygon" ? [geom.arcs]
              : geom.type === "MultiPolygon" ? geom.arcs : [];
    for (const ring of rings.flat()) {
        for (const i of ring) {
            const a = decodeArc(i);
            for (const [x, y] of a) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
    }
    return [x0, y0, x1, y1];
}

// ③ 元数据
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
        id: +g.id,
        name: p.name_zh || p.name || `prov${g.id}`,
        nameEn: p.name || `prov${g.id}`,
        owner: p.adm0_a3 || null,
        iso: p.iso_a2 || null,
        type: p.type || null,
        scalerank: p.scalerank ?? 9,
        coastal,
        bbox: bboxOf(g),
    };
});

writeFileSync("data/index.json", JSON.stringify({ neighbors, meta }));
console.log(`provinces=${geoms.length}, edges=${adj.flat().length / 2}, missingProps=${missingProps}, coastal=${coastalCount}`);
