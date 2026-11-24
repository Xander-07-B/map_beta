// scripts/build-sea.mjs — 生成海域省份，让海军能在海面（而非陆地）行动
// 用法: node scripts/build-sea.mjs
//
// 背景：原地图只有陆地省份（Natural Earth admin-1），没有任何海域省份，
// 舰队因此只能停在沿海陆地省份上——即「海军在陆地上行动」。本脚本：
//   1. 用 d3.geoMercator 把世界投影到网格。陆地掩码同时使用 10m admin-1
//      （与后续裁剪海域所用数据一致）和 50m 国家多边形（补足 admin-1 未
//      覆盖的陆地）。旧版只用 50m 国家多边形，而裁剪用 10m admin-1：掩码
//      认为是海的地方（小岛、细半岛在 50m 数据里被简化掉）裁剪时却被挖掉，
//      同一个海域省份就被陆地切成互不相连的几块。
//   2. 把海洋划分为若干海域省份（多源 BFS / 格网 Voronoi，约 SEED_SPACING 格一个省）
//   3. 每个海域省份用矩形合并生成 MultiPolygon（经纬度坐标）
//   4. 输出网格级「海域-陆地」邻接。海域只在格心落水时生成，沿岸格子常常
//      整格被算作陆地，裁剪后的海域边界会停在离海岸一格左右的位置，与陆地
//      几何并不共享弧段；若只靠 TopoJSON 弧段，很多沿海省份会失去海域邻接，
//      舰队可以部署却无海可去。海域-海域邻接仍由 build-index 从裁剪后的
//      共享弧段计算（同一条网格边，几何一致）。
// 输出：
//   data/sea.geojson     海域省份 GeoJSON（ne_id = 海域 id，供 build-provinces 并入 TopoJSON）
//   data/sea-adj.json    { seaLand: { seaId: [陆地省份 id...] } }（供 build-index 补邻接）
import { readFileSync, writeFileSync } from "node:fs";
import { geoMercator } from "d3-geo";

// 裁剪海域用的是 admin-1（见 build-provinces），掩码必须用同一份数据；
// 50m 国家多边形作为兜底，避免 admin-1 未覆盖到的陆地被当成海。
const LAND_SOURCES = [
    "data/ne_10m_admin_1_states_provinces.geojson",
    "data/ne_50m_admin_0_countries.geojson",
];
const SEA_GEO_PATH = "data/sea.geojson";
const SEA_ADJ_PATH = "data/sea-adj.json";

const COLS = 1000, ROWS = 500;          // 网格分辨率（约 40×80 km，更贴合海岸线）
const SEED_SPACING = 32;                // 海域种子间距（格），决定省份大小（约 1000 格/省）
const MIN_ISOLATED_CELLS = 20;          // 无种子的封闭水域小于此格数则不单独成省（小湖汊）
const SEA_ID_BASE = 900000001;          // 海域省份 id 起点（避开陆地 ne_id 区间）

// ---------- 投影 ----------
const proj = geoMercator().fitSize([4096, 2048], { type: "Sphere" });
// 世界经纬度范围（避开极点，mercator 在极点无定义）
const worldBounds = [
    proj([-180, 85]), proj([180, -85]),
];
const [wx0, wy0] = worldBounds[0];
const [wx1, wy1] = worldBounds[1];
const cellW = (wx1 - wx0) / COLS;
const cellH = (wy1 - wy0) / ROWS;

/** 网格中心（投影坐标） */
function cellCenter(r, c) {
    return [wx0 + (c + 0.5) * cellW, wy0 + (r + 0.5) * cellH];
}

// ---------- 点在多边形内（射线法，支持环/孔） ----------
function pointInRing(px, py, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}
function pointInPolygon(px, py, poly) {
    // poly: [outerRing, hole1, ...]
    if (!pointInRing(px, py, poly[0])) return false;
    for (let h = 1; h < poly.length; h++) {
        if (pointInRing(px, py, poly[h])) return false; // 落在孔里
    }
    return true;
}
function pointInFeature(px, py, feature) {
    const coords = feature.coords;
    if (!coords) return false;
    if (feature.type === "Polygon") return pointInPolygon(px, py, coords);
    if (feature.type === "MultiPolygon") {
        for (const poly of coords) if (pointInPolygon(px, py, poly)) return true;
    }
    return false;
}

// ---------- 投影多边形（用于网格判定） ----------
function projectRing(ring) {
    return ring.map((p) => proj(p));
}
function projectFeature(feature) {
    const g = feature.geometry;
    if (!g) return null;
    if (g.type === "Polygon") return { type: "Polygon", coords: g.coordinates.map(projectRing) };
    if (g.type === "MultiPolygon") return { type: "MultiPolygon", coords: g.coordinates.map((poly) => poly.map(projectRing)) };
    return null;
}
function featureBbox(f) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const polys = f.type === "Polygon" ? [f.coords] : f.coords;
    for (const poly of polys) for (const ring of poly) for (const p of ring) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return { x0, y0, x1, y1, geom: f };
}

// ---------- 读数据 ----------
const t0 = Date.now();
const adminData = JSON.parse(readFileSync(LAND_SOURCES[0], "utf8"));
const countryData = JSON.parse(readFileSync(LAND_SOURCES[1], "utf8"));

// admin-1 省份：既用于掩码（与裁剪数据一致），也用于海-陆邻接
const provFeats = [];
for (const f of adminData.features) {
    const g = projectFeature(f);
    if (g) provFeats.push({ ...featureBbox(g), id: Number(f.properties?.ne_id) || 0 });
}
// 国家多边形：只补足 admin-1 未覆盖的陆地
const countryFeats = [];
for (const f of countryData.features) {
    const g = projectFeature(f);
    if (g) countryFeats.push(featureBbox(g));
}
console.log(`[sea] projected ${provFeats.length} admin-1 + ${countryFeats.length} country features (${Date.now() - t0} ms)`);

// ---------- ① 陆海掩码 + 陆地格归属 ----------
// 遍历每块陆地多边形，把其投影多边形覆盖的网格标为陆地。
// 网格同时记录所在 admin-1 省份，供后面计算「海域-陆地」邻接。
// 国家多边形只补 admin-1 未覆盖到的陆地。
const land = new Uint8Array(COLS * ROWS);        // 1=陆 0=海
const provGrid = new Int32Array(COLS * ROWS);    // 0=海/未知，>0=陆地省份 ne_id

function eachRasterCell(b, fn) {
    const c0 = Math.max(0, Math.floor((b.x0 - wx0) / cellW));
    const c1 = Math.min(COLS - 1, Math.ceil((b.x1 - wx0) / cellW));
    const r0 = Math.max(0, Math.floor((b.y0 - wy0) / cellH));
    const r1 = Math.min(ROWS - 1, Math.ceil((b.y1 - wy0) / cellH));
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const idx = r * COLS + c;
            const [px, py] = cellCenter(r, c);
            fn(idx, px, py);
        }
    }
}

for (const b of countryFeats) {
    eachRasterCell(b, (idx, px, py) => {
        if (!land[idx] && pointInFeature(px, py, b.geom)) land[idx] = 1;
    });
}
for (const b of provFeats) {
    if (!b.id) continue;
    eachRasterCell(b, (idx, px, py) => {
        if (provGrid[idx]) return; // 先到先得（admin-1 互不重叠）
        if (pointInFeature(px, py, b.geom)) {
            provGrid[idx] = b.id;
            land[idx] = 1;
        }
    });
}
console.log(`[sea] rasterized land mask (${Date.now() - t0} ms)`);

// ---------- ② 划分海域省份 ----------
// 多源 BFS（格网上的 Voronoi 划分）：按约 SEED_SPACING 格的间距在海洋里撒
// 种子（相邻行错半格，近似六边形排布），所有种子同时向外扩张，每个海洋格
// 归给最先到达它的种子。
//
// 旧实现是「逐个种子长大、长满固定格数就换下一个」，会在交界处留下大量
// 1~2 格的芝麻海域：实测 1000×500 网格下 770 个「省份」里有一半只有 1~5 格。
// 多源 BFS 一次铺满整个海洋，没有生长边界，也就不会留下空洞；每个格子都由
// 一条水路连到自己的种子，所以每个省份在格网上天然 4 连通。
//
// 之后仍会用 admin-1 陆地裁剪，并拆分裁出来的残余碎片（见 build-provinces），
// 保证最终每个海域省份都是一整片互不相连的水域。
const seaProv = new Int32Array(COLS * ROWS).fill(0);  // 0=非海，>0=海域省份序号（1 起）
const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const oceanCells = [];
for (let i = 0; i < COLS * ROWS; i++) if (!land[i]) oceanCells.push(i);

// 撒种子：奇数行偏移半格，避免所有省份排成方块
const seedIdx = [];
for (let r = (SEED_SPACING >> 1); r < ROWS; r += SEED_SPACING) {
    const offset = ((r / SEED_SPACING) | 0) % 2 ? (SEED_SPACING >> 1) : 0;
    for (let c = offset; c < COLS; c += SEED_SPACING) {
        const idx = r * COLS + c;
        if (!land[idx]) seedIdx.push(idx);
    }
}

// 所有种子同时向外扩张
const queue = [];
seedIdx.forEach((idx, i) => {
    seaProv[idx] = i + 1;
    queue.push(idx);
});
let head = 0;
while (head < queue.length) {
    const idx = queue[head++];
    const label = seaProv[idx];
    const r = (idx / COLS) | 0, c = idx % COLS;
    for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const nidx = nr * COLS + nc;
        if (land[nidx] || seaProv[nidx] !== 0) continue;
        seaProv[nidx] = label;
        queue.push(nidx);
    }
}

// 没有种子的封闭水域（内陆湖、峡湾深处等）：整块独立成一省
let seaSeq = seedIdx.length;
let isolatedPockets = 0;
for (const start of oceanCells) {
    if (seaProv[start] !== 0) continue;
    seaSeq++;
    isolatedPockets++;
    seaProv[start] = seaSeq;
    const queue2 = [start];
    let h2 = 0;
    while (h2 < queue2.length) {
        const idx = queue2[h2++];
        const r = (idx / COLS) | 0, c = idx % COLS;
        for (const [dr, dc] of dirs) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
            const nidx = nr * COLS + nc;
            if (land[nidx] || seaProv[nidx] !== 0) continue;
            seaProv[nidx] = seaSeq;
            queue2.push(nidx);
        }
    }
}

// 按省份序号归集网格（序号从 1 开始且连续）
const seaProvinces = [];
for (let i = 0; i < COLS * ROWS; i++) {
    const label = seaProv[i];
    if (!label) continue;
    const sp = seaProvinces[label - 1] || (seaProvinces[label - 1] = { id: SEA_ID_BASE + label - 1, cells: [] });
    sp.cells.push(i);
}

// 没有种子的封闭水域里，大块（地中海、黑海、里海、红海等）仍值得保留为
// 独立海域；几十个格子以下的湖汊不值得各占一个省份 id（省份视图里只是
// 无法点选的小点），直接舍弃，让底图的海洋颜色作为空白水面。
const keptProvinces = seaProvinces.filter(
    (p, i) => i < seedIdx.length || p.cells.length >= MIN_ISOLATED_CELLS
);
const droppedPockets = seaProvinces.length - keptProvinces.length;

const sizeStats = keptProvinces.map((p) => p.cells.length).sort((a, b) => a - b);
console.log(
    `[sea] ${keptProvinces.length} provinces on ${COLS}x${ROWS} grid ` +
    `(seeds=${seedIdx.length}, isolated=${isolatedPockets}, dropped small=${droppedPockets}); ` +
    `size min=${sizeStats[0]} p50=${sizeStats[sizeStats.length >> 1]} ` +
    `p90=${sizeStats[Math.floor(sizeStats.length * 0.9)]} max=${sizeStats[sizeStats.length - 1]} ` +
    `(${Date.now() - t0} ms)`
);

// ---------- ③ 矩形合并生成海域多边形 ----------
/** 把一组网格按行合并成矩形，再纵向合并，返回矩形列表 [{x0,y0,x1,y1}]（网格坐标） */
function rectanglesOf(cells) {
    const byRow = new Map();
    for (const key of cells) {
        const r = (key / COLS) | 0, c = key % COLS;
        if (!byRow.has(r)) byRow.set(r, []);
        byRow.get(r).push(c);
    }
    // 每行合并成水平区段 [cStart, cEnd]（含）；行号升序
    const rows = [];
    for (const [r, cols] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
        cols.sort((a, b) => a - b);
        const runs = [];
        let cs = cols[0], ce = cols[0];
        for (let i = 1; i < cols.length; i++) {
            if (cols[i] === ce + 1) ce = cols[i];
            else { runs.push([cs, ce]); cs = ce = cols[i]; }
        }
        runs.push([cs, ce]);
        rows.push({ r, runs });
    }
    // 纵向合并：上一行与当前行拥有完全相同的列区间时，把矩形向下延伸。
    // open 只保留上一行的矩形，避免把不相邻行误合并。
    const rects = [];
    let open = new Map();
    let prevRow = -2;
    for (const row of rows) {
        const nextOpen = new Map();
        const adjacent = row.r === prevRow + 1;
        for (const [cs, ce] of row.runs) {
            const key = `${cs},${ce}`;
            const existing = adjacent ? open.get(key) : null;
            if (existing) {
                existing.y1 = row.r + 1;
                nextOpen.set(key, existing);
            } else {
                const rect = { x0: cs, y0: row.r, x1: ce + 1, y1: row.r + 1 };
                rects.push(rect);
                nextOpen.set(key, rect);
            }
        }
        open = nextOpen;
        prevRow = row.r;
    }
    return rects;
}

function rectToLonLatRing(rect) {
    // rect 的 x0/x1 是列索引、y0/y1 是行索引；先换算到投影坐标，再反投影到经纬度。
    // 行号向下增大（南），列号向右增大（东），因此按「西北 → 西南 → 东南 →
    // 东北」取角点得到逆时针外环（RFC 7946），否则 mapshaper 会把外环当成孔洞，
    // 后续 -erase 裁剪陆地时会整块丢弃海域。
    const corners = [
        [rect.x0, rect.y0],
        [rect.x0, rect.y1],
        [rect.x1, rect.y1],
        [rect.x1, rect.y0],
        [rect.x0, rect.y0],
    ];
    return corners.map(([c, r]) => proj.invert([wx0 + c * cellW, wy0 + r * cellH]));
}

const seaFeatures = [];
for (const sp of keptProvinces) {
    const rects = rectanglesOf(sp.cells);
    if (rects.length === 0) continue;
    const polygons = rects.map((rect) => [rectToLonLatRing(rect)]);
    seaFeatures.push({
        type: "Feature",
        id: sp.id,
        properties: { ne_id: sp.id, sea: 1 },
        geometry: { type: "MultiPolygon", coordinates: polygons },
    });
}

// ---------- ④ 海域-陆地邻接（网格级） ----------
// 沿岸格子常常整格被判为陆地，海域多边形的边界会停在离海岸约一格处，
// 与陆地多边形并不共享弧段。用网格 8 邻接补上这层关系，保证沿海省份
// 都有可进入的海域。海域-海域不在这里处理：两侧都是海域格，共享同一条
// 网格边，TopoJSON 弧段邻接已经能给出。
const dirs8 = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const keptSeaIds = new Set(seaFeatures.map((f) => Number(f.id)));
const seaLand = {};
for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
        const label = seaProv[r * COLS + c];
        if (!label) continue;
        const seaId = SEA_ID_BASE + label - 1;
        if (!keptSeaIds.has(seaId)) continue;
        for (const [dr, dc] of dirs8) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
            const pid = provGrid[nr * COLS + nc];
            if (!pid) continue;
            if (!seaLand[seaId]) seaLand[seaId] = new Set();
            seaLand[seaId].add(pid);
        }
    }
}

// ---------- 输出 ----------
writeFileSync(SEA_GEO_PATH, JSON.stringify({ type: "FeatureCollection", features: seaFeatures }));
writeFileSync(SEA_ADJ_PATH, JSON.stringify({
    seaLand: Object.fromEntries(Object.entries(seaLand).map(([k, v]) => [k, [...v]])),
}));

console.log(
    `sea=${SEA_GEO_PATH} provinces=${seaFeatures.length} ` +
    `cells=${keptProvinces.reduce((s, p) => s + p.cells.length, 0)} ` +
    `seaLandEdges=${Object.values(seaLand).reduce((s, v) => s + v.size, 0)} ` +
    `elapsed=${Date.now() - t0} ms`
);
