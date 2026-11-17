// scripts/build-index.mjs — 离线构建省份索引：邻接表 + 元数据 + bbox
// 用法: node scripts/build-index.mjs
import { readFileSync, writeFileSync } from "node:fs";
import * as topojson from "topojson-client";

const topo = JSON.parse(readFileSync("data/provinces.l1.topo.json", "utf8"));
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
geoms.forEach((g, i) => {
    const p = g.properties || {};
    meta[g.id] = {
        id: +g.id,
        name: p.name_zh || p.name || `prov${g.id}`,
        nameEn: p.name || `prov${g.id}`,
        owner: p.adm0_a3 || null,
        iso: p.iso_a2 || null,
        type: p.type || null,
        scalerank: p.scalerank ?? 9,
        bbox: bboxOf(g),
    };
});

writeFileSync("data/index.json", JSON.stringify({ neighbors, meta }));
console.log(`provinces=${geoms.length}, edges=${adj.flat().length / 2}`);
