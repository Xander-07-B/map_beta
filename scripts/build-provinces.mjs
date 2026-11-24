// scripts/build-provinces.mjs — 从 Natural Earth 10m admin-1 重建省份 TopoJSON
// 用法: node scripts/build-sea.mjs && node scripts/build-provinces.mjs && node scripts/build-index.mjs
// 说明: 不再按 scalerank 过滤，保留全部 4594 个要素（覆盖 251 个国家/地区），
//       否则会丢掉小国家（瑞士、台湾、乌干达等）的全部省份。
//       海域省份（data/sea.geojson，由 build-sea.mjs 生成）一并并入，使海军能在海面行动。
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const MAPSHAPER = "node_modules/mapshaper/bin/mapshaper";
const SRC = "data/ne_10m_admin_1_states_provinces.geojson";
const SEA_SRC = "data/sea.geojson";
const SEA_CLIPPED = "data/_sea_clipped.geojson";
const COMBINED = "data/_combined_provinces.geojson";
// mapshaper 以文件名（去扩展名）作为图层名
const LAND_LAYER = basename(SRC, ".geojson");
const SEA_LAYER = basename(SEA_SRC, ".geojson");

// 海域网格矩形只按「格心是否在陆地」判定，边缘会压到海岸线上，
// 在省份层级把海水色涂到陆地省份/国家底色上。构建时先用 admin-1
// 陆地多边形把海域裁掉，使海域与陆地共享同一条海岸线。
//
// 注意：mapshaper 的 -erase 对「一个要素包含大量互不相连的部件」的
// MultiPolygon 会整块丢弃（海域恰好由几百个矩形拼成，曾因此丢掉 19 个
// 海域省份）。这里先 -explode 把每个矩形拆成独立要素，裁剪后再用
// -dissolve ne_id 按海域省份合回一个 MultiPolygon。
function clipSeaToLand() {
    execFileSync(process.execPath, [MAPSHAPER,
        "-i", SEA_SRC, SRC, "combine-files",
        "-explode", `target=${SEA_LAYER}`,
        "-erase", `source=${LAND_LAYER}`,
        "-dissolve", "ne_id", `target=${SEA_LAYER}`,
        "-o", `target=${SEA_LAYER}`, SEA_CLIPPED, "format=geojson",
    ], { stdio: "inherit" });
}

// 把海域要素并入陆地图源：海域要素标记 adm0_a3='SEA'，通过过滤器且拥有 ne_id
function combineSources(seaFeatures) {
    const land = JSON.parse(readFileSync(SRC, "utf8"));
    let seaCount = 0;
    for (const f of seaFeatures) {
        // -dissolve 会清掉要素 id，ne_id 保留在 properties 里
        const id = f.id ?? f.properties?.ne_id;
        f.properties = { ...(f.properties || {}), ne_id: id, adm0_a3: "SEA" };
        seaCount++;
    }
    land.features = [...land.features, ...seaFeatures];
    writeFileSync(COMBINED, JSON.stringify(land));
    return seaCount;
}

function build(percent, out, quantization, seaFeatures) {
    const seaCount = combineSources(seaFeatures);
    execFileSync(process.execPath, [MAPSHAPER, COMBINED,
        "-filter", "adm0_a3 != 'ATA'", // 与国界图层保持一致：不含南极洲（海域 adm0_a3='SEA' 通过）
        "-simplify", `${percent}%`, "keep-shapes",
        "-o", out, "format=topojson", "id-field=ne_id", `quantization=${quantization}`,
    ], { stdio: "inherit" });

    // 剥离属性：名称/归属由 scripts/build-index.mjs 从原始 GeoJSON 按 ne_id 关联
    const topo = JSON.parse(readFileSync(out, "utf8"));
    const objName = Object.keys(topo.objects).find(k => topo.objects[k].type === "GeometryCollection");
    const geoms = topo.objects[objName].geometries;
    for (const g of geoms) delete g.properties;
    writeFileSync(out, JSON.stringify(topo));
    console.log(`[built] ${out}: ${geoms.length} features (含 ${seaCount} 海域), ${(JSON.stringify(topo).length / 1048576).toFixed(2)} MB`);
    try { unlinkSync(COMBINED); } catch {}
}

// 先用陆地多边形裁剪海域（只做一次，两档共用），再分别建粗/精两档 TopoJSON
clipSeaToLand();
const clipped = JSON.parse(readFileSync(SEA_CLIPPED, "utf8"));
const seaFeatures = (clipped.features || []).filter((f) => {
    const g = f.geometry;
    return !!(g && g.coordinates && g.coordinates.length);
});
console.log(`[sea] clipped ${seaFeatures.length} 个海域省份`);

build(30, "data/provinces.l1.topo.json", 300000, seaFeatures);
build(8, "data/provinces.l0.topo.json", 110000, seaFeatures);

for (const tmp of [SEA_CLIPPED, COMBINED]) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
}

