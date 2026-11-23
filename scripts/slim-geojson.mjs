// scripts/slim-geojson.mjs — 精简 Natural Earth 原始 GeoJSON 的属性
// 用法: node scripts/slim-geojson.mjs [file] [字段1,字段2,...]
//
// 原始 admin-1 文件约 39 MB（4,596 个要素 × 121 个属性），但构建脚本
// 只读取 ne_id / name_zh / name / adm0_a3 / scalerank 五个字段。
// 其余属性（多语言名称、bbox、GDP 等）全部剔除，几何原样保留。
// 注意：该文件只是离线构建源，浏览器不会下载它；网页加载的是
// provinces.l0/l1.topo.json 与 index.json。
import { readFileSync, writeFileSync } from "node:fs";

const DEFAULT_FILE = "data/ne_10m_admin_1_states_provinces.geojson";
const DEFAULT_KEEP = "ne_id,name_zh,name,adm0_a3,scalerank";

const file = process.argv[2] || DEFAULT_FILE;
const keep = (process.argv[3] || DEFAULT_KEEP).split(",").map((s) => s.trim()).filter(Boolean);

const before = readFileSync(file);
const geo = JSON.parse(before.toString("utf8"));

let count = 0;
for (const f of geo.features || []) {
    const p = f.properties || {};
    const out = {};
    for (const k of keep) {
        if (p[k] !== undefined) out[k] = p[k];
    }
    f.properties = out;
    count++;
}

const json = JSON.stringify(geo);
writeFileSync(file, json);
const mb = (n) => (n / 1048576).toFixed(2);
console.log(`[slim] ${file}: ${count} features, ${mb(before.length)} MB → ${mb(Buffer.byteLength(json))} MB`);
