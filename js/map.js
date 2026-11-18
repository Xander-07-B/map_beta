/* ============================================================
 * 钢铁雄心4 网页版 - 矢量地图渲染 map.js
 * Natural Earth 数据 → TopoJSON → d3 投影 → Path2D 缓存
 * 架构：投影(加载时一次) + 相机(缩放平移) + 网格拾取 + meshArcs 前线
 * ============================================================ */

const MapView = {
    canvas: null, ctx: null, miniCanvas: null, miniCtx: null, game: null,

    // === 数据 ===
    topo: null,          // 省份 TopoJSON（精档 l1，用于拾取与前线）
    topoL0: null,        // 省份 TopoJSON（粗档 l0）
    countriesTopo: null, // 国界 TopoJSON
    index: null,         // index.json (邻接 + 元数据)
    proj: null,          // d3 投影（加载时算一次）
    geoPath: null,       // d3.geoPath(proj)

    // === LOD 阈值（按 scale 切换图层，调晚触发让每层保持更久）===
    // scale < LOD_COUNTRY：只显示国家（全图/概览）
    // LOD_COUNTRY <= scale < LOD_PROV_COARSE：省份粗档
    // scale >= LOD_PROV_COARSE：省份精档
    LOD_COUNTRY: 2.0,
    LOD_PROV_COARSE: 4.8,
    // 国家层级底图缓存向四周多渲染的比例：平移到 20% 视口内、
    // 缩小到 1.4 倍以内都能直接复用旧图，不必每帧重绘整屏
    COUNTRY_BASE_PAD: 0.2,
    // 底图缓存的最大像素数：4K + 2x DPR 时整屏留白缓存会到 50MP，
    // 超过这个值就降低离屏分辨率，控制显存占用
    BASE_MAX_PIXELS: 20e6,

    // === 图层 ===
    // layers.country / provL0 / provL1 各含 { paths, bbox }
    layers: { country: null, provL0: null, provL1: null },
    paths: null,          // Map<ne_id, Path2D>  指向 provL1（拾取/军队/高亮用）
    bbox: null,           // Map<ne_id, [x0,y0,x1,y1]>  指向 provL1
    seqIndex: null,       // Map<ne_id, number>  顺序索引（拾取用）
    lineTiles: null,         // 线要素网格：国界/省界/海岸线按 512px 网格合并，只描边视口内的格子
    landBasePath: null,      // 合并陆地底色（仅国家级 LOD 兜底）
    worldBounds: [0, 0, 0, 0], // 投影后世界范围

    // === 配色 ===
    // 主题切换时只改变地图本身的底色与线条，国家/省份填充色保持不变，
    // 避免切换主题后国家颜色「换了一套」影响识别。
    oceanColor: '#0b2545',
    landColor: '#2f3b33',    // 无归属省份的陆地底色（保证任何缩放都有颜色）
    countryBorderColor: 'rgba(8,12,18,0.85)',
    provinceBorderColor: 'rgba(10,14,20,0.45)',
    coastGlowColor: 'rgba(130,155,180,0.5)',
    coastColor: 'rgba(4,8,14,0.9)',
    hoverStrokeColor: '#ffffff',
    selectedStrokeColor: '#c9a96e',
    miniViewportColor: '#c9a96e',
    armyTextColor: '#ffffff',

    THEME_PALETTES: {
        dark: {
            oceanColor: '#0b2545',
            landColor: '#2f3b33',
            countryBorderColor: 'rgba(8,12,18,0.85)',
            provinceBorderColor: 'rgba(10,14,20,0.45)',
            coastGlowColor: 'rgba(130,155,180,0.5)',
            coastColor: 'rgba(4,8,14,0.9)',
            hoverStrokeColor: '#ffffff',
            selectedStrokeColor: '#c9a96e',
            miniViewportColor: '#c9a96e',
            armyTextColor: '#ffffff',
        },
        light: {
            oceanColor: '#cbdff0',
            landColor: '#e9eef5',
            countryBorderColor: 'rgba(51,65,85,0.55)',
            provinceBorderColor: 'rgba(100,116,139,0.42)',
            coastGlowColor: 'rgba(255,255,255,0.8)',
            coastColor: 'rgba(71,85,105,0.8)',
            hoverStrokeColor: 'rgba(15,23,42,0.85)',
            selectedStrokeColor: '#b07d2b',
            miniViewportColor: '#b07d2b',
            armyTextColor: '#12233c',
        },
    },
    theme: 'dark',

    // === 填充缓存（颜色 × 空间网格，只绘制视口覆盖的格子）===
    _fillCaches: {},         // layerKey -> { version, cells, cols, rows, ... }
    _ownerVersion: 0,
    _drawPending: false,
    _miniCache: null,        // 小地图离屏缓存
    _countryBaseCache: null, // 国家层级整屏底图缓存（海洋/陆地/国界/海岸线）
    _countryBaseKey: '',
    _countryBaseView: null,  // 缓存对应的世界视口矩形，用于缩放时的过渡贴图
    _countryBaseVersion: -1, // 缓存对应的归属/配色版本
    _countryBaseSize: null,  // 缓存对应的视口尺寸
    _countryBaseScale: 0,    // 缓存对应的缩放比例（仅缩放时需要重建高清版）
    _countryBaseMode: '',    // 'c' 国家层级 / 'p' 省份层级，跨层级不复用旧图
    _renderCullView: null,   // 渲染底图缓存时用的裁剪范围（含四周留白）
    _countryBaseTimer: 0,    // 交互结束后重建高清底图的定时器
    _countryBaseForce: false,
    _fillColorCache: new Map(), // 浅色主题下国家填充色的提亮结果缓存

    // === 拾取网格 ===
    grid: { cols: 0, rows: 0, cells: {} },
    countryGrid: null,       // 国家层级拾取网格（仅低缩放时使用）
    countryMeta: null,       // ISO3 -> { name }（标签下钻用）

    // === 前线索引 ===
    borderIndex: null,    // Map<"isoA|isoB", {path: Path2D, bbox}>

    // === 相机（屏幕 = 世界 * scale + offset）===
    scale: 1, offsetX: 0, offsetY: 0,
    targetScale: 1, targetOffsetX: 0, targetOffsetY: 0,
    viewW: 0, viewH: 0,
    fitScale: 0.3, minScale: 0.25, maxScale: 24.0,

    // === 交互状态 ===
    hoverProvince: null, hoverCountry: null, selectedProvince: null,
    isDragging: false, isPinching: false,
    dragStartX: 0, dragStartY: 0, lastMouseX: 0, lastMouseY: 0,
    pinchStartDist: 0, pinchStartScale: 1, pinchMid: { x: 0, y: 0 },
    tool: 'move',
    ready: false,

    /* ===================== 初始化 ===================== */
    init(canvas, miniCanvas, game) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.miniCanvas = miniCanvas;
        this.miniCtx = miniCanvas.getContext('2d');
        this.game = game;
        this.paths = new Map();
        this.bbox = new Map();
        this.seqIndex = new Map();
        this.borderIndex = new Map();
        this.layers = {
            country: { paths: new Map(), bbox: new Map() },
            provL0: { paths: new Map(), bbox: new Map() },
            provL1: { paths: new Map(), bbox: new Map() },
        };
        this.hoverProvince = null;
        this.hoverCountry = null;
        this.selectedProvince = null;
        this._fillCaches = {};
        this._miniCache = null;
        this._countryBaseCache = null;
        this._countryBaseKey = '';
        this._countryBaseView = null;
        this._countryBaseVersion = -1;
        this._countryBaseSize = null;
        this._countryBaseScale = 0;
        this._countryBaseMode = '';
        this._renderCullView = null;
        if (this._countryBaseTimer) { clearTimeout(this._countryBaseTimer); this._countryBaseTimer = 0; }
        this._countryBaseForce = false;
        this._fillColorCache.clear();
        this.bindEvents();
        this.resize();
    },

    /* ===================== 数据加载 ===================== */
    async loadData() {
        const [provL0Res, provL1Res, cntRes, idxRes] = await Promise.all([
            fetch('data/provinces.l0.topo.json').then(r => r.json()),
            fetch('data/provinces.l1.topo.json').then(r => r.json()),
            fetch('data/countries.l1.topo.json').then(r => r.json()),
            fetch('data/index.json').then(r => r.json()),
        ]);
        this.topoL0 = provL0Res;
        this.topo = provL1Res;          // 精档，用于拾取与前线
        this.countriesTopo = cntRes;
        this.index = idxRes;
        this.buildLayers();
        this.buildPicker();
        this.buildLineTiles();
        this.buildBorderIndex();
        this.ready = true;
        // 把省份元数据交给游戏逻辑
        if (this.game) this.game.loadProvinceData(this.index);
        this.fitWorld();
        // 首次绘制由调用方在 Game.newGame 之后触发（此时省份归属才就绪）
    },

    provinceObjName() {
        return Object.keys(this.topo.objects).find(k => this.topo.objects[k].type === 'GeometryCollection');
    },
    countryObjName() {
        return Object.keys(this.countriesTopo.objects).find(k => this.countriesTopo.objects[k].type === 'GeometryCollection');
    },

    /* ===================== 构建图层 ===================== */
    buildLayers() {
        const W = 4096, H = 2048;
        const objName = this.provinceObjName();
        // 投影：把整个世界一次性铺进 W×H 逻辑画布，此后几何都是平面坐标
        this.proj = d3.geoMercator().fitSize([W, H], topojson.feature(this.topo, this.topo.objects[objName]));
        this.geoPath = d3.geoPath(this.proj);

        // 构建单个图层：用 topojson.feature() 转 GeoJSON，生成 Path2D + bbox
        const buildLayer = (topo, objKey) => {
            const obj = topo.objects[objKey];
            const feats = topojson.feature(topo, obj).features;
            const layer = { paths: new Map(), bbox: new Map() };
            let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
            for (const f of feats) {
                const id = f.id;
                const d = this.geoPath(f);
                if (!d) continue;
                layer.paths.set(id, new Path2D(d));
                const b = this.geoPath.bounds(f);
                if (!b) continue;
                const flat = [b[0][0], b[0][1], b[1][0], b[1][1]];
                layer.bbox.set(id, flat);
                gx0 = Math.min(gx0, flat[0]); gy0 = Math.min(gy0, flat[1]);
                gx1 = Math.max(gx1, flat[2]); gy1 = Math.max(gy1, flat[3]);
            }
            return { layer, bounds: [gx0, gy0, gx1, gy1] };
        };

        const objNameL0 = Object.keys(this.topoL0.objects).find(k => this.topoL0.objects[k].type === 'GeometryCollection');
        const cObjName = this.countryObjName();

        // 国家图层
        const cRes = buildLayer(this.countriesTopo, cObjName);
        this.layers.country = cRes.layer;
        // 国家名称（Natural Earth 自带 NAME_ZH，低缩放悬停时显示国家而不是省份）
        this.countryMeta = new Map();
        for (const g of this.countriesTopo.objects[cObjName].geometries) {
            const p = g.properties || {};
            this.countryMeta.set(g.id, {
                name: p.NAME_ZH || p.NAME_ZHT || p.NAME || p.ADMIN || g.id,
            });
        }
        // 省份粗档
        const l0Res = buildLayer(this.topoL0, objNameL0);
        this.layers.provL0 = l0Res.layer;
        // 省份精档（同时作为拾取图层）
        const l1Res = buildLayer(this.topo, objName);
        this.layers.provL1 = l1Res.layer;

        // 拾取/军队/高亮统一使用精档
        this.paths = this.layers.provL1.paths;
        this.bbox = this.layers.provL1.bbox;
        // 顺序索引
        this.seqIndex = new Map();
        let seq = 0;
        for (const id of this.paths.keys()) this.seqIndex.set(id, seq++);

        // 世界范围取省份精档
        this.worldBounds = l1Res.bounds;

        // 合并陆地底色：把所有国家路径拼成一个 Path2D，作为国家级 LOD 的兜底填充
        const land = new Path2D();
        for (const p of this.layers.country.paths.values()) land.addPath(p);
        this.landBasePath = land;

    },

    // 把所有线要素（国界/省界/海岸线）按网格合并成 tile：每帧只描边视口内的少数 tile
    buildLineTiles() {
        const p0 = Object.keys(this.topoL0.objects).find(k => this.topoL0.objects[k].type === 'GeometryCollection');
        const p1 = this.provinceObjName();
        const c = this.countryObjName();
        this.lineTiles = {
            // 国家级：内部国界与海岸线分开，避免同一条线被描边两次
            country: this.buildMeshTiles(this.countriesTopo, c, (a, b) => a !== b),
            coastCountry: this.buildMeshTiles(this.countriesTopo, c, (a, b) => a === b),
            provL0: this.buildMeshTiles(this.topoL0, p0, (a, b) => a !== b),
            provL1: this.buildMeshTiles(this.topo, p1, (a, b) => a !== b),
            coastL0: this.buildMeshTiles(this.topoL0, p0, (a, b) => a === b),
            coastL1: this.buildMeshTiles(this.topo, p1, (a, b) => a === b),
        };
    },

    // 将 meshArcs 折线投影后按空间网格合并为 Path2D tile
    buildMeshTiles(topo, objName, filter) {
        const mesh = topojson.meshArcs(topo, topo.objects[objName], filter);
        const { arcs, transform } = topo;
        const [wx0, wy0, wx1, wy1] = this.worldBounds;
        const cell = this.FILL_CELL;
        const cols = Math.max(1, Math.ceil((wx1 - wx0) / cell));
        const rows = Math.max(1, Math.ceil((wy1 - wy0) / cell));
        const paths = new Array(cols * rows).fill(null);

        const cache = new Map();
        const decode = (i) => {
            const idx = i < 0 ? ~i : i;
            let pts = cache.get(idx);
            if (!pts) {
                let x = 0, y = 0;
                pts = arcs[idx].map(([dx, dy]) => {
                    x += dx; y += dy;
                    // 反量化得到经纬度，再投影到与省份一致的平面坐标
                    return this.proj([x * transform.scale[0] + transform.translate[0],
                                      y * transform.scale[1] + transform.translate[1]]);
                });
                cache.set(idx, pts);
            }
            return i < 0 ? pts.slice().reverse() : pts;
        };

        // 每个 tile 只存「落在该 tile 内」的线段：先按线段做矩形裁剪，
        // 避免一条跨越多个 tile 的长海岸线被重复描边多次。
        const pad = 4; // 少量重叠，防止相邻 tile 接缝处出现断点
        const lastX = new Float64Array(cols * rows);
        const lastY = new Float64Array(cols * rows);
        lastX.fill(NaN); lastY.fill(NaN);

        for (const line of mesh.arcs) {
            const pts = [];
            for (const ai of line) {
                const a = decode(ai);
                for (const p of a) pts.push(p);
            }
            for (let i = 0; i + 1 < pts.length; i++) {
                const ax = pts[i][0], ay = pts[i][1];
                const bx = pts[i + 1][0], by = pts[i + 1][1];
                if (ax === bx && ay === by) continue;
                // 跨越日期变更线的线段：经度恰为 ±180° 的点会被 d3 投影折到
                // 地图另一端，形成横贯全图的假线段（如瓦朗格尔岛海岸线）。
                // 直接丢弃该线段，两端在地图左右边缘自然断开。
                if (Math.abs(bx - ax) > (wx1 - wx0) / 2) continue;
                const sx0 = Math.min(ax, bx), sx1 = Math.max(ax, bx);
                const sy0 = Math.min(ay, by), sy1 = Math.max(ay, by);
                const c0 = Math.max(0, Math.min(cols - 1, Math.floor((sx0 - wx0) / cell)));
                const c1 = Math.max(0, Math.min(cols - 1, Math.floor((sx1 - wx0) / cell)));
                const r0 = Math.max(0, Math.min(rows - 1, Math.floor((sy0 - wy0) / cell)));
                const r1 = Math.max(0, Math.min(rows - 1, Math.floor((sy1 - wy0) / cell)));
                for (let r = r0; r <= r1; r++) {
                    for (let cc = c0; cc <= c1; cc++) {
                        const rx0 = wx0 + cc * cell - pad, ry0 = wy0 + r * cell - pad;
                        const rx1 = wx0 + (cc + 1) * cell + pad, ry1 = wy0 + (r + 1) * cell + pad;
                        const t = this.clipSegment(ax, ay, bx, by, rx0, ry0, rx1, ry1);
                        if (!t) continue;
                        const dx = bx - ax, dy = by - ay;
                        const px0 = ax + dx * t[0], py0 = ay + dy * t[0];
                        const px1 = ax + dx * t[1], py1 = ay + dy * t[1];
                        const k = r * cols + cc;
                        let path = paths[k];
                        if (!path) path = paths[k] = new Path2D();
                        if (lastX[k] === px0 && lastY[k] === py0) {
                            path.lineTo(px1, py1);
                        } else {
                            path.moveTo(px0, py0);
                            path.lineTo(px1, py1);
                        }
                        lastX[k] = px1; lastY[k] = py1;
                    }
                }
            }
        }
        return { wx0, wy0, cellW: cell, cellH: cell, cols, rows, paths };
    },

    // Liang–Barsky 线段裁剪：返回裁剪后的参数区间 [t0,t1]，不相交返回 null
    clipSegment(ax, ay, bx, by, x0, y0, x1, y1) {
        let t0 = 0, t1 = 1;
        const dx = bx - ax, dy = by - ay;
        const p = [-dx, dx, -dy, dy];
        const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
        for (let i = 0; i < 4; i++) {
            if (p[i] === 0) {
                if (q[i] < 0) return null;
                continue;
            }
            const r = q[i] / p[i];
            if (p[i] < 0) {
                if (r > t1) return null;
                if (r > t0) t0 = r;
            } else {
                if (r < t0) return null;
                if (r < t1) t1 = r;
            }
        }
        return t0 <= t1 ? [t0, t1] : null;
    },

    // 描边当前视口覆盖的 tile
    strokeLineTiles(ctx, tiles, color, widthPx) {
        if (!tiles) return;
        const view = this.cullView();
        const { wx0, wy0, cellW, cellH, cols, rows, paths } = tiles;
        const c0 = Math.max(0, Math.floor((view.x0 - wx0) / cellW));
        const c1 = Math.min(cols - 1, Math.floor((view.x1 - wx0) / cellW));
        const r0 = Math.max(0, Math.floor((view.y0 - wy0) / cellH));
        const r1 = Math.min(rows - 1, Math.floor((view.y1 - wy0) / cellH));
        ctx.strokeStyle = color;
        ctx.lineWidth = widthPx / this.scale;
        ctx.lineJoin = ctx.lineCap = 'round';
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const p = paths[r * cols + c];
                if (p) ctx.stroke(p);
            }
        }
    },

    // 配色别名：台湾、香港、澳门与中国大陆同色
    // （数据里仍保留各自的 adm0_a3，只影响颜色，不改变归属与玩法）
    COLOR_ALIAS: { TWN: 'CHN', HKG: 'CHN', MAC: 'CHN' },

    // 国家配色：可玩国家用其定义色，其余按 ISO3 哈希生成稳定色
    countryColor(iso3) {
        if (!iso3) return this.landColor;
        iso3 = this.COLOR_ALIAS[iso3] || iso3;
        const game = this.game;
        const cid = game ? game.countryIdByIso3(iso3) : null;
        if (cid) {
            const c = game.countryById(cid);
            if (c) return this.themeFillColor(c.color);
        }
        // 非可玩国家：确定性哈希生成低饱和色
        let h = 0;
        for (let i = 0; i < iso3.length; i++) h = (h * 31 + iso3.charCodeAt(i)) >>> 0;
        const hue = h % 360;
        return this.themeFillColor(`hsl(${hue}, 32%, 42%)`);
    },

    // 省份颜色：运行时归属国优先，其次原始 ISO3 国家色，最后陆地底色
    // 这样任何 LOD、任何归属状态下都有颜色，不会露出海洋色
    provinceColor(id) {
        const game = this.game;
        if (game) {
            const owner = game.ownerOf(id);
            if (owner) {
                const c = game.countryById(owner);
                if (c) return this.themeFillColor(c.color);
            }
        }
        const iso = this.index && this.index.meta[id] ? this.index.meta[id].owner : null;
        return iso ? this.countryColor(iso) : this.landColor;
    },

    // 归属变化时调用（如战斗占领），让填充缓存失效并触发重绘
    invalidateFills() {
        this._ownerVersion++;
        this.requestDraw();
    },

    // 切换地图配色（深色 / 浅色）
    setTheme(theme) {
        const palette = this.THEME_PALETTES[theme];
        if (!palette || this.theme === theme) return;
        this.theme = theme;
        Object.assign(this, palette);
        // 国家填充色、底色、小地图和整屏底图都随主题变化，全部失效
        this._ownerVersion++;
        this._miniCache = null;
        this._countryBaseKey = '';
        if (this.ready) this.requestDraw();
    },

    // 浅色主题下的国家/省份填色：提高明度、略降饱和，
    // 避免深色色块压在浅色地图上显得脏。深色主题原样返回。
    themeFillColor(color) {
        if (this.theme !== 'light' || !color) return color;
        let out = this._fillColorCache.get(color);
        if (out === undefined) {
            out = this.lightenMapColor(color);
            this._fillColorCache.set(color, out);
        }
        return out;
    },

    lightenMapColor(color) {
        let h = 0, s = 0, l = 50;
        if (color[0] === '#') {
            let hex = color.slice(1);
            if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
            if (hex.length !== 6) return color;
            const r = parseInt(hex.slice(0, 2), 16) / 255;
            const g = parseInt(hex.slice(2, 4), 16) / 255;
            const b = parseInt(hex.slice(4, 6), 16) / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            l = (max + min) / 2;
            if (max !== min) {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
                else if (max === g) h = (b - r) / d + 2;
                else h = (r - g) / d + 4;
                h *= 60;
            }
            s *= 100;
            l *= 100;
        } else {
            const m = color.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/);
            if (!m) return color;
            h = +m[1]; s = +m[2]; l = +m[3];
        }
        // 明度压到 54%–72%，饱和度不超过 46%
        l = Math.max(54, Math.min(72, 58 + (l - 42) * 0.45));
        s = Math.min(s, 46);
        return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
    },

    // 省份填充按「颜色 × 空间网格」合并：
    // 1) 同色同格只 fill 一次，调用次数从数千降到数十；
    // 2) 每帧只遍历视口覆盖的网格，缩放/平移只处理主界面看得到的区域。
    FILL_CELL: 512,
    fillChunks(layerKey, layer) {
        const cache = this._fillCaches[layerKey];
        if (cache && cache.version === this._ownerVersion) return cache;

        const [wx0, wy0, wx1, wy1] = this.worldBounds;
        const cellW = this.FILL_CELL, cellH = this.FILL_CELL;
        const cols = Math.max(1, Math.ceil((wx1 - wx0) / cellW));
        const rows = Math.max(1, Math.ceil((wy1 - wy0) / cellH));
        const cells = new Array(cols * rows).fill(null);

        for (const [id, path] of layer.paths) {
            const b = layer.bbox.get(id);
            if (!b) continue;
            const color = this.provinceColor(id);
            const c0 = Math.max(0, Math.floor((b[0] - wx0) / cellW));
            const c1 = Math.min(cols - 1, Math.floor((b[2] - wx0) / cellW));
            const r0 = Math.max(0, Math.floor((b[1] - wy0) / cellH));
            const r1 = Math.min(rows - 1, Math.floor((b[3] - wy0) / cellH));
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    const k = r * cols + c;
                    let bucket = cells[k];
                    if (!bucket) bucket = cells[k] = new Map();
                    let g = bucket.get(color);
                    if (!g) { g = { color, path: new Path2D() }; bucket.set(color, g); }
                    g.path.addPath(path);
                }
            }
        }

        const chunk = {
            version: this._ownerVersion,
            wx0, wy0, cellW, cellH, cols, rows,
            cells: cells.map(b => (b ? [...b.values()] : null)),
        };
        this._fillCaches[layerKey] = chunk;
        return chunk;
    },

    // 合并输入触发的重绘，每帧最多一次
    requestDraw() {
        if (this._drawPending) return;
        this._drawPending = true;
        requestAnimationFrame(() => {
            this._drawPending = false;
            this.draw();
        });
    },

    /* ===================== 拾取网格 ===================== */
    buildPicker() {
        const cols = 28, rows = 14;
        const [x0, y0, x1, y1] = this.worldBounds;
        const cellW = (x1 - x0) / cols;
        const cellH = (y1 - y0) / rows;

        const fillGrid = (source, target, pick) => {
            for (const [id, b] of source) {
                const c0 = Math.max(0, Math.floor((b[0] - x0) / cellW));
                const c1 = Math.min(cols - 1, Math.floor((b[2] - x0) / cellW));
                const r0 = Math.max(0, Math.floor((b[1] - y0) / cellH));
                const r1 = Math.min(rows - 1, Math.floor((b[3] - y0) / cellH));
                for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
                    const key = r * cols + c;
                    if (!target.cells[key]) target.cells[key] = [];
                    target.cells[key].push(pick(id));
                }
            }
        };

        this.grid = { cols, rows, cells: {} };
        fillGrid(this.bbox, this.grid, id => id);

        // 国家图层同样建网格：低缩放时按国家拾取，避免拾取到未显示的省份
        this.countryGrid = { cols, rows, cells: {} };
        fillGrid(this.layers.country.bbox, this.countryGrid, id => id);
    },

    findProvinceAt(wx, wy) {
        if (!this.ready) return null;
        const [x0, y0, x1, y1] = this.worldBounds;
        if (wx < x0 || wy < y0 || wx > x1 || wy > y1) return null;
        const { cols, rows, cells } = this.grid;
        const cx = Math.floor((wx - x0) / ((x1 - x0) / cols));
        const cy = Math.floor((wy - y0) / ((y1 - y0) / rows));
        const key = cy * cols + cx;
        const candidates = cells[key];
        if (!candidates) return null;
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0); // 恒等变换，用世界坐标做命中测试
        for (const id of candidates) {
            const path = this.paths.get(id);
            if (path && ctx.isPointInPath(path, wx, wy)) {
                return this.game.provinceById(id);
            }
        }
        return null;
    },

    findCountryAt(wx, wy) {
        if (!this.ready || !this.countryGrid) return null;
        const [x0, y0, x1, y1] = this.worldBounds;
        if (wx < x0 || wy < y0 || wx > x1 || wy > y1) return null;
        const { cols, rows, cells } = this.countryGrid;
        const cx = Math.floor((wx - x0) / ((x1 - x0) / cols));
        const cy = Math.floor((wy - y0) / ((y1 - y0) / rows));
        const candidates = cells[cy * cols + cx];
        if (!candidates) return null;
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (const iso of candidates) {
            const path = this.layers.country.paths.get(iso);
            if (path && ctx.isPointInPath(path, wx, wy)) return iso;
        }
        return null;
    },

    /* ===================== 前线索引（按弧段归属建表） ===================== */
    buildBorderIndex() {
        const objName = this.provinceObjName();
        const obj = this.topo.objects[objName];
        const { arcs, transform } = this.topo;

        // 构建 弧段索引 → 使用该弧段的省份集合（meshArcs 不返回 objects，需自行反查）
        const arcProvinces = {};
        for (const g of obj.geometries) {
            const rings = g.type === 'Polygon' ? [g.arcs]
                      : g.type === 'MultiPolygon' ? g.arcs : [];
            for (const ring of rings.flat()) {
                for (const ai of ring) {
                    // TopoJSON 负索引表示反向引用：i < 0 时真实索引是 ~i
                    const idx = ai < 0 ? ~ai : ai;
                    if (!arcProvinces[idx]) arcProvinces[idx] = new Set();
                    arcProvinces[idx].add(g.id);
                }
            }
        }

        // 弧段解码（delta 编码 + 负索引反转），带缓存
        const arcCache = new Map();
        const decodeArc = (i) => {
            const idx = i < 0 ? ~i : i;
            let pts = arcCache.get(idx);
            if (!pts) {
                let x = 0, y = 0;
                pts = arcs[idx].map(([dx, dy]) => {
                    x += dx; y += dy;
                    // 反量化得到经纬度，再投影到省份平面坐标（前线绘制用）
                    return this.proj([x * transform.scale[0] + transform.translate[0],
                                      y * transform.scale[1] + transform.translate[1]]);
                });
                arcCache.set(idx, pts);
            }
            return i < 0 ? pts.slice().reverse() : pts;
        };

        // 逐弧段建索引：TopoJSON 中一条内部弧段正好被两个省引用，
        // 直接按弧段取两侧省份，避免 meshArcs 拼接后的长链跨越多国边界。
        for (let idx = 0; idx < arcs.length; idx++) {
            const set = arcProvinces[idx];
            if (!set || set.size !== 2) continue; // 海岸线弧段只属于一个省
            const pids = [...set];
            const oa = this.index.meta[pids[0]]?.owner;
            const ob = this.index.meta[pids[1]]?.owner;
            if (!oa || !ob || oa === ob) continue; // 同国省界，不是前线
            const key = oa < ob ? oa + '|' + ob : ob + '|' + oa;
            // 预生成 Path2D，避免每帧重建；同时记录 bbox 便于视口裁剪
            let entry = this.borderIndex.get(key);
            if (!entry) {
                // 键是 ISO3，但战争状态按国家 id 存储，这里预先换算好
                const game = this.game;
                entry = {
                    path: new Path2D(),
                    bbox: [Infinity, Infinity, -Infinity, -Infinity],
                    ids: [game ? game.countryIdByIso3(oa) : oa,
                          game ? game.countryIdByIso3(ob) : ob],
                };
                this.borderIndex.set(key, entry);
            }
            const pts = decodeArc(idx);
            const b = entry.bbox;
            const halfW = (this.worldBounds[2] - this.worldBounds[0]) / 2;
            for (let k = 0; k < pts.length; k++) {
                const [x, y] = pts[k];
                // 跨日期变更线的线段会把 x 折到地图另一端：断开子路径而不是连线
                if (k === 0 || Math.abs(x - pts[k - 1][0]) > halfW) entry.path.moveTo(x, y);
                else entry.path.lineTo(x, y);
                if (x < b[0]) b[0] = x; if (x > b[2]) b[2] = x;
                if (y < b[1]) b[1] = y; if (y > b[3]) b[3] = y;
            }
        }
    },

    /* ===================== 相机 ===================== */
    worldToScreen(wx, wy) {
        return { x: wx * this.scale + this.offsetX, y: wy * this.scale + this.offsetY };
    },
    screenToWorld(sx, sy) {
        return { x: (sx - this.offsetX) / this.scale, y: (sy - this.offsetY) / this.scale };
    },
    viewRect() {
        const a = this.screenToWorld(0, 0);
        const b = this.screenToWorld(this.viewW, this.viewH);
        return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    },

    clampScale(s) {
        return Math.max(this.minScale, Math.min(this.maxScale, s));
    },

    // 边界钳制：地图大于视口时不允许拖出空白；小于视口时居中
    clampCamera() {
        if (!this.ready) return;
        const [x0, y0, x1, y1] = this.worldBounds;
        const mapW = (x1 - x0) * this.scale;
        const mapH = (y1 - y0) * this.scale;
        if (mapW <= this.viewW) {
            this.offsetX = (this.viewW - mapW) / 2 - x0 * this.scale;
        } else {
            this.offsetX = Math.max(this.viewW - x1 * this.scale,
                                    Math.min(-x0 * this.scale, this.offsetX));
        }
        if (mapH <= this.viewH) {
            this.offsetY = (this.viewH - mapH) / 2 - y0 * this.scale;
        } else {
            this.offsetY = Math.max(this.viewH - y1 * this.scale,
                                    Math.min(-y0 * this.scale, this.offsetY));
        }
        this.targetScale = this.scale;
        this.targetOffsetX = this.offsetX;
        this.targetOffsetY = this.offsetY;
    },

    fitWorld() {
        if (!this.ready) return;
        const [x0, y0, x1, y1] = this.worldBounds;
        const w = x1 - x0, h = y1 - y0;
        const sx = this.viewW / w, sy = this.viewH / h;
        this.fitScale = Math.min(sx, sy) * 0.96;
        // 最小缩放略小于全图适配，最大放大 24 倍，避免无意义的超远缩放
        this.minScale = this.fitScale * 0.9;
        this.scale = this.fitScale;
        this.offsetX = (this.viewW - w * this.scale) / 2 - x0 * this.scale;
        this.offsetY = (this.viewH - h * this.scale) / 2 - y0 * this.scale;
        this.clampCamera();
    },

    centerOn(wx, wy, scale) {
        this.scale = this.clampScale(scale);
        this.offsetX = this.viewW / 2 - wx * this.scale;
        this.offsetY = this.viewH / 2 - wy * this.scale;
        this.clampCamera();
        this.requestDraw();
    },

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.viewW = rect.width;
        this.viewH = rect.height;
        if (this.ready) { this.fitWorld(); this.draw(); }
    },

    /* ===================== 主绘制 ===================== */
    draw() {
        if (!this.ctx || !this.ready) return;
        this.drawMapLevel(this.ctx, Math.min(window.devicePixelRatio || 1, 2));
    },

    // 全缩放层级共用整屏底图缓存：
    // 海洋/陆地/国家与省份填充/国界省界/海岸线这些静态内容只在相机、
    // 主题或归属变化时重绘；悬停、军队、前线动画每帧作为动态图层叠加。
    // 全图概览时 250 国填充 + 整条海岸线每帧重绘要 30ms+，
    // 省份层级的中等缩放同样会被精细海岸线拖到 30fps。
    drawMapLevel(ctx, dpr) {
        const countryMode = this.scale < this.LOD_COUNTRY;
        const key = [
            countryMode ? 'c' : 'p',
            this.scale, this.offsetX, this.offsetY, this.viewW, this.viewH, dpr,
            this._ownerVersion, this.oceanColor, this.landColor,
            this.countryBorderColor, this.provinceBorderColor,
            this.coastGlowColor, this.coastColor,
        ].join('|');
        const cache = this._countryBaseCache;
        const size = this._countryBaseSize;
        const sizeMatch = size && size.w === this.viewW && size.h === this.viewH && size.dpr === dpr;

        if (cache && this._countryBaseKey === key) {
            this.blitCountryBase(ctx, dpr);
        } else if (cache && sizeMatch && !this._countryBaseForce &&
                   this._countryBaseVersion === this._ownerVersion &&
                   this._countryBaseMode === (countryMode ? 'c' : 'p') &&
                   this.canPreviewCountryBase()) {
            // 连续缩放时先把旧底图拉伸贴上去，等交互停下后再重绘清晰版本，
            // 避免滚轮每动一下都同步重绘整屏海岸线。
            this.drawCountryBasePreview(ctx, dpr);
            this.scheduleCountryBaseRefresh();
        } else {
            this._countryBaseForce = false;
            this.renderMapBase(dpr, key, countryMode);
            this.blitCountryBase(ctx, dpr);
        }

        // 动态图层（前线 / 驻军 / 悬停高亮）仍按相机变换绘制
        ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr,
                         this.offsetX * dpr, this.offsetY * dpr);
        const view = this.viewRect();
        const pad = 3 / this.scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(view.x0 - pad, view.y0 - pad,
                 (view.x1 - view.x0) + pad * 2, (view.y1 - view.y0) + pad * 2);
        ctx.clip();
        this.drawFrontlines(ctx);
        this.drawArmies(ctx);
        if (countryMode) this.drawCountryHover(ctx);
        else this.drawHighlights(ctx);
        ctx.restore();

        this.drawMinimap();
    },

    // 缓存范围比视口向四周各多 COUNTRY_BASE_PAD 个视口尺寸，
    // 这样小平移/小缩放可以直接贴旧图过渡
    countryBaseRect() {
        const v = this.viewRect();
        const m = this.COUNTRY_BASE_PAD;
        const ex = this.viewW * m / this.scale;
        const ey = this.viewH * m / this.scale;
        return { x0: v.x0 - ex, y0: v.y0 - ey, x1: v.x1 + ex, y1: v.y1 + ey };
    },

    // 把缓存画回主画布：缓存左上角对应屏幕坐标 (-padW, -padH)
    blitCountryBase(ctx, dpr) {
        const c = this._countryBaseCache;
        if (!c) return;
        const m = this.COUNTRY_BASE_PAD;
        const w = this.viewW * (1 + 2 * m);
        const h = this.viewH * (1 + 2 * m);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(c, 0, 0, c.width, c.height,
                      -this.viewW * m, -this.viewH * m, w, h);
    },

    renderMapBase(dpr, key, countryMode) {
        if (!this._countryBaseCache) this._countryBaseCache = document.createElement('canvas');
        const c = this._countryBaseCache;
        const m = this.COUNTRY_BASE_PAD;
        const cssW = this.viewW * (1 + 2 * m);
        const cssH = this.viewH * (1 + 2 * m);
        const wantPx = cssW * cssH * dpr * dpr;
        const baseDpr = dpr * Math.min(1, Math.sqrt(this.BASE_MAX_PIXELS / Math.max(1, wantPx)));
        c.width = Math.max(1, Math.round(cssW * baseDpr));
        c.height = Math.max(1, Math.round(cssH * baseDpr));
        const g = c.getContext('2d');
        g.setTransform(baseDpr, 0, 0, baseDpr, 0, 0);
        g.fillStyle = this.oceanColor;
        g.fillRect(0, 0, cssW, cssH);
        // 缓存贴回主画布时左上角位于 (-pad, -pad)，所以缓存内部的世界原点
        // 要再向右下补回同样距离，保证贴图与屏幕坐标严格对齐
        g.setTransform(this.scale * baseDpr, 0, 0, this.scale * baseDpr,
                       (this.offsetX + this.viewW * m) * baseDpr,
                       (this.offsetY + this.viewH * m) * baseDpr);

        const view = this.countryBaseRect();
        const pad = 3 / this.scale;
        g.save();
        g.beginPath();
        g.rect(view.x0 - pad, view.y0 - pad,
               (view.x1 - view.x0) + pad * 2, (view.y1 - view.y0) + pad * 2);
        g.clip();
        // 填充/描边按“视口 + 四周留白”的范围裁剪，否则缓存边缘那一圈
        // 平移进来时会缺色
        this._renderCullView = view;

        if (countryMode) {
            // 陆地底色兜底，保证海洋与国界之间不会露出缝隙
            if (this.landBasePath) {
                g.fillStyle = this.landColor;
                g.fill(this.landBasePath);
            }
            this.drawCountryFills(g);
            this.drawCountryBorders(g);
        } else {
            // 省份层级：先铺国家底色兜底（admin-1 未覆盖的国家不会露出海洋色），
            // 再按缩放选省份粗档 / 精档
            this.drawCountryFills(g);
            if (this.scale < this.LOD_PROV_COARSE) {
                this.drawProvinceFills(g, 'l0', this.layers.provL0);
                this.drawProvinceBorders(g, 'provL0');
            } else {
                this.drawProvinceFills(g, 'l1', this.layers.provL1);
                this.drawProvinceBorders(g, 'provL1');
            }
            this.drawCountryBorders(g);
        }
        this.drawCoastline(g);
        g.restore();
        this._renderCullView = null;

        this._countryBaseKey = key;
        this._countryBaseVersion = this._ownerVersion;
        this._countryBaseView = view;
        this._countryBaseSize = { w: this.viewW, h: this.viewH, dpr };
        this._countryBaseScale = this.scale;
        this._countryBaseMode = countryMode ? 'c' : 'p';
    },

    // 渲染底图时用包含留白的范围做裁剪，其余时候就是屏幕视口
    cullView() {
        return this._renderCullView || this.viewRect();
    },

    // 新视口完全落在旧缓存覆盖的世界范围内时，才能安全地用旧图过渡
    canPreviewCountryBase() {
        const old = this._countryBaseView;
        if (!old) return false;
        const v = this.viewRect();
        const eps = 0.5 / this.scale;
        return v.x0 >= old.x0 - eps && v.y0 >= old.y0 - eps &&
               v.x1 <= old.x1 + eps && v.y1 <= old.y1 + eps;
    },

    drawCountryBasePreview(ctx, dpr) {
        const old = this._countryBaseView;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = this.oceanColor;
        ctx.fillRect(0, 0, this.viewW, this.viewH);
        const a = this.worldToScreen(old.x0, old.y0);
        const b = this.worldToScreen(old.x1, old.y1);
        const c = this._countryBaseCache;
        ctx.drawImage(c, 0, 0, c.width, c.height,
                      a.x, a.y, b.x - a.x, b.y - a.y);
    },

    scheduleCountryBaseRefresh() {
        // 纯平移时旧图与当前帧是 1:1 的，内容完全正确，无需重建；
        // 只有缩放（贴图被拉伸）才需要在停手后补一帧清晰底图。
        if (this._countryBaseScale === this.scale &&
            this._countryBaseVersion === this._ownerVersion &&
            this._countryBaseMode === (this.scale < this.LOD_COUNTRY ? 'c' : 'p')) return;
        if (this._countryBaseTimer) clearTimeout(this._countryBaseTimer);
        this._countryBaseTimer = setTimeout(() => {
            this._countryBaseTimer = 0;
            this._countryBaseForce = true;
            this.requestDraw();
        }, 120);
    },

    inView(b, view) {
        return !(b[2] < view.x0 || b[0] > view.x1 || b[3] < view.y0 || b[1] > view.y1);
    },

    // 国家填充：按归属国配色
    drawCountryFills(ctx) {
        const view = this.cullView();
        const layer = this.layers.country;
        for (const [iso3, path] of layer.paths) {
            const b = layer.bbox.get(iso3);
            if (!b || !this.inView(b, view)) continue;
            ctx.fillStyle = this.countryColor(iso3);
            ctx.fill(path);
        }
    },

    drawProvinceFills(ctx, layerKey, layer) {
        const chunk = this.fillChunks(layerKey, layer);
        const view = this.cullView();
        const { wx0, wy0, cellW, cellH, cols, rows, cells } = chunk;
        // 只遍历视口覆盖的网格单元
        const c0 = Math.max(0, Math.floor((view.x0 - wx0) / cellW));
        const c1 = Math.min(cols - 1, Math.floor((view.x1 - wx0) / cellW));
        const r0 = Math.max(0, Math.floor((view.y0 - wy0) / cellH));
        const r1 = Math.min(rows - 1, Math.floor((view.y1 - wy0) / cellH));
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const list = cells[r * cols + c];
                if (!list) continue;
                for (const g of list) {
                    ctx.fillStyle = g.color;
                    ctx.fill(g.path);
                }
            }
        }
    },

    drawCountryBorders(ctx) {
        this.strokeLineTiles(ctx, this.lineTiles && this.lineTiles.country,
                             this.countryBorderColor, 1.6);
    },

    drawProvinceBorders(ctx, layerKey) {
        this.strokeLineTiles(ctx, this.lineTiles && this.lineTiles[layerKey],
                             this.provinceBorderColor, 0.6);
    },

    drawCoastline(ctx) {
        if (!this.lineTiles) return;
        // 海岸线也按 LOD 取档：全图用 50m 粗档（顶点少一个数量级），
        // 中等缩放用省界粗档，放大后用精档；只描边视野内的 tile。
        const key = this.scale < this.LOD_COUNTRY ? 'coastCountry'
                  : this.scale < this.LOD_PROV_COARSE ? 'coastL0'
                  : 'coastL1';
        // 光晕只用于全图概览，避免中高缩放下同一条线描两遍
        if (this.scale < this.LOD_COUNTRY) {
            this.strokeLineTiles(ctx, this.lineTiles[key], this.coastGlowColor, 2.8);
        }
        this.strokeLineTiles(ctx, this.lineTiles[key], this.coastColor, 1.3);
    },

    drawFrontlines(ctx) {
        const game = this.game;
        const t = performance.now() / 1000;
        const view = this.viewRect();
        const paths = [];
        for (const entry of this.borderIndex.values()) {
            if (!this.inView(entry.bbox, view)) continue;
            if (game.areAtWar(entry.ids[0], entry.ids[1])) paths.push(entry.path);
        }
        if (paths.length === 0) return;
        ctx.lineJoin = ctx.lineCap = 'round';
        // 外圈深色底
        ctx.setLineDash([]);
        ctx.lineWidth = 5 / this.scale;
        ctx.strokeStyle = '#1a1d21';
        paths.forEach(p => ctx.stroke(p));
        // 中圈主色
        ctx.lineWidth = 3.5 / this.scale;
        ctx.strokeStyle = '#c0392b';
        paths.forEach(p => ctx.stroke(p));
        // 内圈流动虚线
        ctx.setLineDash([10 / this.scale, 8 / this.scale]);
        ctx.lineDashOffset = -(t * 0.03) / this.scale;
        ctx.lineWidth = 2 / this.scale;
        ctx.strokeStyle = '#ffe08a';
        paths.forEach(p => ctx.stroke(p));
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
    },

    drawArmies(ctx) {
        const game = this.game;
        // 驻军存在性（仅呈现，无战斗结算）
        for (const g of game.garrisons()) {
            const prov = game.provinceById(g.provinceId);
            if (!prov) continue;
            const b = this.bbox.get(g.provinceId);
            if (!b) continue;
            const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
            const owner = game.countryById(g.owner);
            const color = owner ? this.themeFillColor(owner.color) : '#fff';
            const size = Math.max(5, Math.min(16, 4 + g.count / 4)) / this.scale;
            ctx.fillStyle = color;
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1.2 / this.scale;
            ctx.beginPath();
            ctx.rect(cx - size / 2, cy - size / 2, size, size);
            ctx.fill();
            ctx.stroke();
            if (this.scale > 0.5) {
                ctx.fillStyle = this.armyTextColor;
                ctx.font = `bold ${9 / this.scale}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText(Math.round(g.count), cx, cy + 3 / this.scale);
            }
        }
    },

    // 低缩放只显示国家：悬停高亮整个国家轮廓
    drawCountryHover(ctx) {
        if (!this.hoverCountry) return;
        const path = this.layers.country.paths.get(this.hoverCountry);
        if (!path) return;
        ctx.strokeStyle = this.hoverStrokeColor;
        ctx.lineWidth = 2 / this.scale;
        ctx.stroke(path);
    },

    drawHighlights(ctx) {
        // 悬停高亮
        if (this.hoverProvince) {
            const path = this.paths.get(this.hoverProvince.id);
            if (path) {
                ctx.strokeStyle = this.hoverStrokeColor;
                ctx.lineWidth = 2 / this.scale;
                ctx.stroke(path);
            }
        }
        // 选中高亮
        if (this.selectedProvince) {
            const path = this.paths.get(this.selectedProvince);
            if (path) {
                ctx.strokeStyle = this.selectedStrokeColor;
                ctx.lineWidth = 3 / this.scale;
                ctx.stroke(path);
            }
        }
        // 前线高亮
        if (this.tool === 'front') {
            const view = this.viewRect();
            const garrisons = this.game.garrisons();
            for (const [id] of this.paths) {
                const b = this.bbox.get(id);
                if (!b || !this.inView(b, view)) continue;
                const owners = new Set(garrisons.filter(g => g.provinceId === id).map(g => g.owner));
                if (owners.size > 1) {
                    const path = this.paths.get(id);
                    ctx.fillStyle = 'rgba(200,74,74,0.25)';
                    ctx.fill(path);
                }
            }
        }
    },

    /* ===================== 小地图 ===================== */
    miniTransform() {
        const w = this.miniCanvas.width, h = this.miniCanvas.height;
        const [x0, y0, x1, y1] = this.worldBounds;
        const s = Math.min(w / (x1 - x0), h / (y1 - y0));
        return { w, h, s, ox: (w - (x1 - x0) * s) / 2 - x0 * s, oy: (h - (y1 - y0) * s) / 2 - y0 * s };
    },

    // 小地图底图只渲染一次到离屏画布，之后每帧只贴图 + 画视口框
    buildMiniCache() {
        if (!this.miniCanvas || !this.ready) return;
        const { w, h, s, ox, oy } = this.miniTransform();
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = this.oceanColor;
        g.fillRect(0, 0, w, h);
        g.setTransform(s, 0, 0, s, ox, oy);
        for (const [iso3, path] of this.layers.country.paths) {
            g.fillStyle = this.countryColor(iso3);
            g.fill(path);
        }
        this._miniCache = c;
    },

    drawMinimap() {
        if (!this.miniCanvas || !this.miniCtx) return;
        if (!this._miniCache) this.buildMiniCache();
        if (!this._miniCache) return;
        const ctx = this.miniCtx;
        const { w, h, s, ox, oy } = this.miniTransform();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(this._miniCache, 0, 0, w, h);
        // 视口框
        const v0 = this.screenToWorld(0, 0);
        const v1 = this.screenToWorld(this.viewW, this.viewH);
        ctx.strokeStyle = this.miniViewportColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(v0.x * s + ox, v0.y * s + oy, (v1.x - v0.x) * s, (v1.y - v0.y) * s);
    },

    /* ===================== 事件 ===================== */
    bindEvents() {
        const c = this.canvas;
        c.addEventListener('mousedown', (e) => this.onMouseDown(e));
        c.addEventListener('mousemove', (e) => this.onMouseMove(e));
        c.addEventListener('mouseup', (e) => this.onMouseUp(e));
        c.addEventListener('mouseleave', () => {
            this.hoverProvince = null;
            this.hoverCountry = null;
            this.hideTooltip();
        });
        c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        c.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        c.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        c.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        c.addEventListener('touchend', (e) => this.onTouchEnd(e));
        c.addEventListener('touchcancel', (e) => this.onTouchEnd(e));
        window.addEventListener('resize', () => this.resize());
    },

    getPos(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    },
    getMousePos(e) { return this.getPos(e.clientX, e.clientY); },

    onMouseDown(e) {
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
    },

    onMouseMove(e) {
        const pos = this.getMousePos(e);
        if (this.isDragging) {
            const dx = e.clientX - this.lastMouseX;
            const dy = e.clientY - this.lastMouseY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.clampCamera();
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.hideTooltip();
            this.requestDraw();
            return;
        }
        if (!this.ready) return;
        const world = this.screenToWorld(pos.x, pos.y);

        // 低缩放只画国家：按国家拾取，避免提示未显示的省份
        if (this.scale < this.LOD_COUNTRY) {
            const prev = this.hoverCountry;
            const iso = this.findCountryAt(world.x, world.y);
            this.hoverCountry = iso;
            this.hoverProvince = null;
            if (iso !== prev) this.requestDraw();
            if (iso) {
                this.showCountryTooltip(iso, pos);
                this.canvas.style.cursor = 'pointer';
            } else {
                this.hideTooltip();
                this.canvas.style.cursor = 'grab';
            }
            return;
        }

        this.hoverCountry = null;
        const prevHover = this.hoverProvince ? this.hoverProvince.id : null;
        const prov = this.findProvinceAt(world.x, world.y);
        this.hoverProvince = prov;
        if ((prov ? prov.id : null) !== prevHover) this.requestDraw();
        if (prov) {
            this.showTooltip(prov, pos);
            this.canvas.style.cursor = 'pointer';
            if (this.game.selectedProvince !== prov.id) {
                this.game.selectProvince(prov.id);
            }
        } else {
            this.hideTooltip();
            this.canvas.style.cursor = 'grab';
        }
    },

    onMouseUp(e) {
        if (!this.isDragging) return;
        const moved = Math.abs(e.clientX - this.dragStartX) + Math.abs(e.clientY - this.dragStartY);
        this.isDragging = false;
        this.canvas.style.cursor = 'grab';
        if (moved < 4) {
            // 国家级 LOD 下省份未显示，不选中隐藏的省份
            if (this.scale < this.LOD_COUNTRY) return;
            const pos = this.getMousePos(e);
            const world = this.screenToWorld(pos.x, pos.y);
            const prov = this.findProvinceAt(world.x, world.y);
            if (prov) this.game.selectProvince(prov.id);
            else this.game.selectProvince(null);
        }
    },

    onWheel(e) {
        e.preventDefault();
        const pos = this.getMousePos(e);
        const worldBefore = this.screenToWorld(pos.x, pos.y);
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newScale = this.clampScale(this.scale * factor);
        if (newScale === this.scale) return;
        this.offsetX = pos.x - worldBefore.x * newScale;
        this.offsetY = pos.y - worldBefore.y * newScale;
        this.scale = newScale;
        // 缩放可能跨过 LOD 分界，旧的悬停目标已失效
        this.hoverProvince = null;
        this.hoverCountry = null;
        this.hideTooltip();
        this.clampCamera();
        this.requestDraw();
    },

    onDoubleClick(e) {
        const pos = this.getMousePos(e);
        const world = this.screenToWorld(pos.x, pos.y);

        if (this.scale < this.LOD_COUNTRY) {
            // 概览双击国家：放大到该国家范围
            const iso = this.findCountryAt(world.x, world.y);
            const b = iso && this.layers.country.bbox.get(iso);
            if (b) {
                this.centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2,
                              Math.max(this.LOD_COUNTRY + 0.2, this.scale * 2));
            }
            return;
        }

        const prov = this.findProvinceAt(world.x, world.y);
        if (prov) {
            const b = this.bbox.get(prov.id);
            if (b) this.centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.max(this.scale * 1.5, 1.5));
        }
    },

    /* ---------- 触摸 ---------- */
    onTouchStart(e) {
        if (!this.ready) return;
        e.preventDefault();
        const touches = e.touches;
        if (touches.length === 1) {
            const t = touches[0];
            this.isDragging = true;
            this.dragStartX = t.clientX;
            this.dragStartY = t.clientY;
            this.lastMouseX = t.clientX;
            this.lastMouseY = t.clientY;
        } else if (touches.length === 2) {
            this.isPinching = true;
            this.isDragging = false;
            this.pinchStartDist = this.touchDistance(touches);
            this.pinchStartScale = this.scale;
            const mid = this.touchMidpoint(touches);
            this.pinchMid = this.getPos(mid.x, mid.y);
        }
    },

    onTouchMove(e) {
        if (!this.ready) return;
        e.preventDefault();
        const touches = e.touches;
        if (this.isPinching && touches.length === 2) {
            const dist = this.touchDistance(touches);
            const factor = dist / this.pinchStartDist;
            const newScale = this.clampScale(this.pinchStartScale * factor);
            const mid = this.touchMidpoint(touches);
            const midPos = this.getPos(mid.x, mid.y);
            const worldBefore = this.screenToWorld(this.pinchMid.x, this.pinchMid.y);
            this.scale = newScale;
            this.offsetX = midPos.x - worldBefore.x * newScale;
            this.offsetY = midPos.y - worldBefore.y * newScale;
            this.clampCamera();
            this.requestDraw();
            return;
        }
        if (touches.length === 1 && this.isDragging) {
            const t = touches[0];
            const dx = t.clientX - this.lastMouseX;
            const dy = t.clientY - this.lastMouseY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.clampCamera();
            this.lastMouseX = t.clientX;
            this.lastMouseY = t.clientY;
            this.hideTooltip();
            this.requestDraw();
            return;
        }
        if (touches.length === 1) {
            const t = touches[0];
            const pos = this.getPos(t.clientX, t.clientY);
            const world = this.screenToWorld(pos.x, pos.y);
            if (this.scale < this.LOD_COUNTRY) {
                const iso = this.findCountryAt(world.x, world.y);
                this.hoverCountry = iso;
                this.hoverProvince = null;
                if (iso) {
                    this.showCountryTooltip(iso, pos);
                    this.requestDraw();
                } else this.hideTooltip();
                return;
            }
            this.hoverCountry = null;
            const prov = this.findProvinceAt(world.x, world.y);
            this.hoverProvince = prov;
            if (prov) {
                this.showTooltip(prov, pos);
                if (this.game.selectedProvince !== prov.id) this.game.selectProvince(prov.id);
            } else this.hideTooltip();
        }
    },

    onTouchEnd(e) {
        if (this.isPinching) {
            if (e.touches.length === 1) {
                const t = e.touches[0];
                this.isPinching = false;
                this.isDragging = true;
                this.dragStartX = t.clientX;
                this.dragStartY = t.clientY;
                this.lastMouseX = t.clientX;
                this.lastMouseY = t.clientY;
            } else this.isPinching = false;
            return;
        }
        if (this.isDragging) {
            let cx, cy;
            if (e.changedTouches.length > 0) {
                cx = e.changedTouches[0].clientX;
                cy = e.changedTouches[0].clientY;
            } else { cx = this.lastMouseX; cy = this.lastMouseY; }
            const moved = Math.abs(cx - this.dragStartX) + Math.abs(cy - this.dragStartY);
            this.isDragging = false;
            if (moved < 8 && this.scale >= this.LOD_COUNTRY) {
                const pos = this.getPos(cx, cy);
                const world = this.screenToWorld(pos.x, pos.y);
                const prov = this.findProvinceAt(world.x, world.y);
                if (prov) this.game.selectProvince(prov.id);
                else this.game.selectProvince(null);
            }
        }
    },

    touchDistance(touches) {
        const a = touches[0], b = touches[1];
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    },
    touchMidpoint(touches) {
        const a = touches[0], b = touches[1];
        return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    },

    /* ===================== tooltip ===================== */
    tooltipEl() {
        let tip = document.getElementById('tooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'tooltip';
            document.body.appendChild(tip);
        }
        return tip;
    },

    showTooltip(prov, pos) {
        const tip = this.tooltipEl();
        const owner = this.game.ownerOf(prov.id);
        const ownerName = owner ? this.game.countryDisplayName(owner) : '无主';
        tip.innerHTML = `<b>${prov.name}</b><br/>归属：${ownerName}`;
        tip.style.display = 'block';
        tip.style.left = (pos.x + 14) + 'px';
        tip.style.top = (pos.y + 14) + 'px';
    },

    // 低缩放下的国家提示（Natural Earth 数据自带中文名）
    showCountryTooltip(iso, pos) {
        const tip = this.tooltipEl();
        const meta = this.countryMeta && this.countryMeta.get(iso);
        tip.innerHTML = `<b>${meta ? meta.name : iso}</b><br/>国家`;
        tip.style.display = 'block';
        tip.style.left = (pos.x + 14) + 'px';
        tip.style.top = (pos.y + 14) + 'px';
    },

    hideTooltip() {
        const tip = document.getElementById('tooltip');
        if (tip) tip.style.display = 'none';
    },
};

if (typeof window !== 'undefined') window.MapView = MapView;
