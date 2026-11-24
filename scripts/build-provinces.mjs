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
const SEA_IDS = "data/sea-ids.json";
const COMBINED = "data/_combined_provinces.geojson";
const SPLIT_SEA_ID_BASE = 910000001; // 海域被陆地切成多块时，拆出的新省份 id 起点
const MIN_SEA_AREA = 0.05;           // 小于这个面积（平方度，约 600 km²）的裁剪碎片不再单独成省
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

// ---------- 海域连通性 ----------
// 即使换了更细的网格、让掩码与裁剪都用 10m admin-1，仍可能有极小的
// 岛屿/半岛横跨一个格子：网格上连成一片的海域省份，裁剪陆地后会被切成
// 互不相连的几块。同一个省份 id 却分成两块，舰队会「隔空出现」在另一块，
// 悬停轮廓也会同时框住两片海。这里按多边形部件（地图裁剪后即互不相连）
// 拆成独立省份：面积最大的一块沿用原 id，其余分配新 id。
// 注意：部件之间可能只在一个点上相接，那不算通航连通，同样拆开。
function polygonArea(coords) {
    // 经度 × 纬度面积，按部件平均纬度做 cos 修正，避免高纬小海域被低估
    let total = 0;
    for (let r = 0; r < coords.length; r++) {
        const ring = coords[r];
        let sum = 0, latSum = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
            latSum += ring[i][1];
        }
        const lat = latSum / Math.max(1, ring.length);
        const part = Math.abs(sum / 2) * Math.max(0.05, Math.cos(lat * Math.PI / 180));
        total += r === 0 ? part : -part; // 外环加、孔洞减
    }
    return total;
}

function splitDisconnectedSea(features) {
    const out = [];
    let splitCount = 0;
    let droppedSmall = 0;
    const push = (f, id, coords) => {
        // 裁剪会在海岸线格角留下大量远小于一个网格的碎片；让它们各自成省
        // 只会在省份视图里制造一堆无法点选的小点，且没有航行意义，直接舍弃。
        if (polygonArea(coords) < MIN_SEA_AREA) { droppedSmall++; return; }
        out.push({
            type: "Feature",
            id,
            properties: { ...(f.properties || {}), ne_id: id, sea: 1 },
            geometry: { type: "Polygon", coordinates: coords },
        });
    };

    for (const f of features) {
        const g = f.geometry;
        if (!g) continue;
        const parts = g.type === "Polygon" ? [g.coordinates]
                    : g.type === "MultiPolygon" ? g.coordinates : [];
        if (parts.length === 0) continue;

        const id = Number(f.id ?? f.properties?.ne_id);
        if (parts.length === 1) {
            push(f, id, parts[0]);
            continue;
        }

        const ranked = parts
            .map((coords) => ({ coords, area: polygonArea(coords) }))
            .sort((a, b) => b.area - a.area);
        ranked.forEach(({ coords }, i) => {
            const pid = i === 0 ? id : SPLIT_SEA_ID_BASE + splitCount++;
            push(f, pid, coords);
        });
    }
    return { features: out, splitCount, droppedSmall };
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
const clippedFeatures = (clipped.features || []).filter((f) => {
    const g = f.geometry;
    return !!(g && g.coordinates && g.coordinates.length);
});
const split = splitDisconnectedSea(clippedFeatures);
const seaFeatures = split.features;
// 供 build-index 识别海域省份（并给 meta 打 sea:true）
writeFileSync(SEA_IDS, JSON.stringify(seaFeatures.map((f) => Number(f.id))));
console.log(
    `[sea] clipped ${clippedFeatures.length} 个海域省份，` +
    `按连通性拆分 ${split.splitCount} 个碎片，丢弃 ${split.droppedSmall} 个过小碎片，` +
    `共 ${seaFeatures.length} 个连通海域`
);

build(30, "data/provinces.l1.topo.json", 300000, seaFeatures);
build(8, "data/provinces.l0.topo.json", 110000, seaFeatures);

for (const tmp of [SEA_CLIPPED, COMBINED]) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
}

