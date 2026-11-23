// scripts/strip-topo.mjs — 删除 TopoJSON 中运行时不再读取的 properties
// 用法: node scripts/strip-topo.mjs <file> [字段1,字段2,...]
//
// Natural Earth 的 TopoJSON 每个几何带 100+ 个属性（多语言名称、GDP、
// 各种 ISO 变体……），地图只用其中的中文名与国名。剥离后文件体积可减少
// 80% 以上，几何与 id 完全不动。
import { readFileSync, writeFileSync } from "node:fs";

const [file, keepArg] = process.argv.slice(2);
if (!file) {
    console.error("用法: node scripts/strip-topo.mjs <file> [字段1,字段2,...]");
    process.exit(1);
}
const keep = (keepArg || "").split(",").map((s) => s.trim()).filter(Boolean);

const topo = JSON.parse(readFileSync(file, "utf8"));
let count = 0;
for (const obj of Object.values(topo.objects || {})) {
    if (!obj || obj.type !== "GeometryCollection") continue;
    for (const g of obj.geometries) {
        if (!g.properties) continue;
        const out = {};
        for (const k of keep) {
            if (g.properties[k] !== undefined) out[k] = g.properties[k];
        }
        g.properties = out;
        count++;
    }
}

const json = JSON.stringify(topo);
writeFileSync(file, json);
console.log(`[stripped] ${file}: ${count} geometries, ${(Buffer.byteLength(json) / 1048576).toFixed(2)} MB`);
