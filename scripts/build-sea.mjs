// scripts/build-sea.mjs — 生成海域省份，让海军能在海面（而非陆地）行动
// 用法: node scripts/build-sea.mjs
//
// 背景：原地图只有陆地省份（Natural Earth admin-1），没有任何海域省份，
// 舰队因此只能停在沿海陆地省份上——即「海军在陆地上行动」。本脚本：
//   1. 用 d3.geoMercator 把世界投影到网格，按国家多边形判定陆/海
//   2. 把海洋划分为若干海域省份（播种式区域生长，每块至多 MAX_CELLS 格）
//   3. 每个海域省份用矩形合并生成 MultiPolygon（经纬度坐标）
//   4. 计算海域-海域、海域-陆地的邻接（网格级；陆地裁剪后虽会共享弧段，
//      但跨格的对角邻接仍只有栅格能给出）
// 输出：
//   data/sea.geojson     海域省份 GeoJSON（ne_id = 海域 id，供 build-provinces 并入 TopoJSON）
//   data/sea-adj.json    { seaLand: { seaId: [陆地省份id...] } }（供 build-index 补邻接）
import { readFileSync, writeFileSync } from "node:fs";
import { geoMercator } from "d3-geo";

const COUNTRIES_PATH = "data/ne_50m_admin_0_countries.geojson";
const PROVINCES_PATH = "data/ne_10m_admin_1_states_provinces.geojson";
const SEA_GEO_PATH = "data/sea.geojson";
const SEA_ADJ_PATH = "data/sea-adj.json";

const COLS = 500, ROWS = 250;          // 网格分辨率（更高分辨率以更好贴合海岸线）
const MAX_CELLS = 600;                  // 单个海域省份最多包含的网格数
const SEA_ID_BASE = 900000001;         // 海域省份 id 起点（避开陆地 ne_id 区间）

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
/** 网格左上角（投影坐标） */
function cellOrigin(r, c) {
    return [wx0 + c * cellW, wy0 + r * cellH];
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
    // feature 为投影后的 { type, coords }
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

// ---------- 读数据 ----------
const countries = JSON.parse(readFileSync(COUNTRIES_PATH, "utf8"));
const provinces = JSON.parse(readFileSync(PROVINCES_PATH, "utf8"));

const countryFeats = countries.features.map(projectFeature).filter(Boolean);
const provFeats = provinces.features.map((f) => ({ id: f.properties.ne_id, geom: projectFeature(f) })).filter((f) => f.geom);

// 国家 bbox 索引（加速陆海判定）
const countryBboxes = countryFeats.map((f) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const coords = f.type === "Polygon" ? [f.coords] : f.coords;
    for (const poly of coords) for (const ring of poly) for (const p of ring) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return { x0, y0, x1, y1, geom: f };
});

// ---------- ① 陆海掩码 ----------
// 填充法：遍历每个国家，把其投影多边形覆盖的网格标为陆地。
// 比「逐格对所有国家求点是否在内」快一个量级，可支撑更高分辨率以贴合海岸线。
const land = new Uint8Array(COLS * ROWS);   // 1=陆 0=海
for (const b of countryBboxes) {
    const c0 = Math.max(0, Math.floor((b.x0 - wx0) / cellW));
    const c1 = Math.min(COLS - 1, Math.ceil((b.x1 - wx0) / cellW));
    const r0 = Math.max(0, Math.floor((b.y0 - wy0) / cellH));
    const r1 = Math.min(ROWS - 1, Math.ceil((b.y1 - wy0) / cellH));
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const idx = r * COLS + c;
            if (land[idx]) continue; // 已是陆地
            const [px, py] = cellCenter(r, c);
            if (pointInFeature(px, py, b.geom)) land[idx] = 1;
        }
    }
}

// ---------- ② 省一级栅格（用于海域-陆地邻接） ----------
const provGrid = new Int32Array(COLS * ROWS).fill(0);  // 0=海/未知，>0=省份 ne_id
for (const pf of provFeats) {
    const g = pf.geom;
    const polys = g.type === "Polygon" ? [g.coords] : g.coords;
    // 计算投影 bbox
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) for (const ring of poly) for (const p of ring) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    const c0 = Math.max(0, Math.floor((x0 - wx0) / cellW));
    const c1 = Math.min(COLS - 1, Math.ceil((x1 - wx0) / cellW));
    const r0 = Math.max(0, Math.floor((y0 - wy0) / cellH));
    const r1 = Math.min(ROWS - 1, Math.ceil((y1 - wy0) / cellH));
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const idx = r * COLS + c;
            if (provGrid[idx] !== 0) continue; // 已有归属（先到先得，省份不重叠）
            const [px, py] = cellCenter(r, c);
            let inside = false;
            for (const poly of polys) {
                if (pointInPolygon(px, py, poly)) { inside = true; break; }
            }
            if (inside) provGrid[idx] = pf.id;
        }
    }
}

// ---------- ③ 划分海域省份 ----------
// 播种式区域生长：每个海域省份从一个尚未分配的海洋格出发，按广度优先向外
// 铺开最多 MAX_CELLS 格，再换下一个种子。
//
// 旧实现是把整个海洋连通块按 BFS 顺序切成 1000 格一段，切片会沿着海岸线
// 一路拉长成「从上到下的一条」，悬停时轮廓横贯整张地图，还会在海岸线处
// 压住国家底色。改为紧凑生长后，海域省份近似圆形，尺寸也可控。
const seaProv = new Int32Array(COLS * ROWS).fill(0);  // 0=非海，>0=海域省份序号（1 起）
const seaProvinces = [];
const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const claimed = new Uint8Array(COLS * ROWS);          // 已被某个海域省份占用
const enqueued = new Int32Array(COLS * ROWS).fill(0); // 当前种子轮次内已入队

// 所有海洋格按行优先顺序作为候选种子；已被其他省份占用的跳过。
const oceanCells = [];
for (let i = 0; i < COLS * ROWS; i++) if (!land[i]) oceanCells.push(i);

let seaSeq = 0;
for (const start of oceanCells) {
    if (claimed[start]) continue;
    seaSeq++;
    const seq = seaSeq;
    const cells = [];
    const queue = [start];
    enqueued[start] = seq;
    let head = 0;
    while (head < queue.length && cells.length < MAX_CELLS) {
        const idx = queue[head++];
        claimed[idx] = 1;
        seaProv[idx] = seq;
        cells.push(idx);
        const r = (idx / COLS) | 0, c = idx % COLS;
        for (const [dr, dc] of dirs) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
            const nidx = nr * COLS + nc;
            if (land[nidx] || claimed[nidx] || enqueued[nidx] === seq) continue;
            enqueued[nidx] = seq;
            queue.push(nidx);
        }
    }
    seaProvinces.push({ id: SEA_ID_BASE + seq - 1, cells });
}

// ---------- ④ 矩形合并生成海域多边形 ----------
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
for (const sp of seaProvinces) {
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

// ---------- ⑤ 邻接：海域-海域、海域-陆地 ----------
// 海域-海域用 4 邻接（海域省份按 4 连通划分，邻接即共边）；
// 海域-陆地用 8 邻接（含对角），以在粗网格下尽量捕获曲折海岸线的相邻关系。
const dirs4 = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const dirs8 = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const seaLand = {};   // seaId -> Set<陆地省份id>
for (const sp of seaProvinces) {
    seaLand[sp.id] = new Set();
}
const seaAdj = {};    // seaId -> Set<seaId>
for (const sp of seaProvinces) seaAdj[sp.id] = new Set();

for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        if (seaProv[idx] === 0) continue; // 非海域
        const myId = SEA_ID_BASE + seaProv[idx] - 1;
        for (const [dr, dc] of dirs4) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
            const nidx = nr * COLS + nc;
            if (seaProv[nidx] !== 0) {
                // 海域-海域（共边）
                const nId = SEA_ID_BASE + seaProv[nidx] - 1;
                if (nId !== myId) { seaAdj[myId].add(nId); seaAdj[nId].add(myId); }
            }
        }
        for (const [dr, dc] of dirs8) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
            const nidx = nr * COLS + nc;
            if (provGrid[nidx] !== 0) {
                // 海域-陆地（含对角）
                seaLand[myId].add(provGrid[nidx]);
            }
        }
    }
}

// ---------- 输出 ----------
const seaGeo = { type: "FeatureCollection", features: seaFeatures };
writeFileSync(SEA_GEO_PATH, JSON.stringify(seaGeo));

// 输出 data/sea-adj.json：{ seaLand: { seaId: [陆地省份id...] }, seaAdj: { seaId: [seaId...] } }
// 海域-海域邻接也可由弧段邻接表给出，但 mapshaper 对海域矩形弧段合并不充分，
// 这里一并输出网格级邻接，供 build-index 可靠补全。
const seaAdjOut = {
    seaLand: Object.fromEntries(Object.entries(seaLand).map(([k, v]) => [k, [...v]])),
    seaAdj: Object.fromEntries(Object.entries(seaAdj).map(([k, v]) => [k, [...v]])),
};
writeFileSync(SEA_ADJ_PATH, JSON.stringify(seaAdjOut));

console.log(
    `sea=${SEA_GEO_PATH} provinces=${seaFeatures.length} ` +
    `cells=${seaProvinces.reduce((s, p) => s + p.cells.length, 0)} ` +
    `seaLandEdges=${Object.values(seaLand).reduce((s, v) => s + v.size, 0)}`
);
