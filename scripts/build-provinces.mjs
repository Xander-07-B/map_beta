// scripts/build-provinces.mjs — 从 Natural Earth 10m admin-1 重建省份 TopoJSON
// 用法: node scripts/build-provinces.mjs && node scripts/build-index.mjs
// 说明: 不再按 scalerank 过滤，保留全部 4594 个要素（覆盖 251 个国家/地区），
//       否则会丢掉小国家（瑞士、台湾、乌干达等）的全部省份。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MAPSHAPER = "node_modules/mapshaper/bin/mapshaper";
const SRC = "data/ne_10m_admin_1_states_provinces.geojson";

function build(percent, out, quantization) {
    execFileSync(process.execPath, [MAPSHAPER, SRC,
        "-filter", "adm0_a3 != 'ATA'", // 与国界图层保持一致：不含南极洲
        "-simplify", `${percent}%`, "keep-shapes",
        "-o", out, "format=topojson", "id-field=ne_id", `quantization=${quantization}`,
    ], { stdio: "inherit" });

    // 剥离属性：名称/归属由 scripts/build-index.mjs 从原始 GeoJSON 按 ne_id 关联
    const topo = JSON.parse(readFileSync(out, "utf8"));
    const objName = Object.keys(topo.objects).find(k => topo.objects[k].type === "GeometryCollection");
    const geoms = topo.objects[objName].geometries;
    for (const g of geoms) delete g.properties;
    writeFileSync(out, JSON.stringify(topo));
    console.log(`[built] ${out}: ${geoms.length} features, ${(JSON.stringify(topo).length / 1048576).toFixed(2)} MB`);
}

build(30, "data/provinces.l1.topo.json", 300000);
build(8, "data/provinces.l0.topo.json", 110000);
