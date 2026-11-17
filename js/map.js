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

    // === LOD 阈值（按 scale 切换图层）===
    // scale < LOD_COUNTRY：只显示国家
    // LOD_COUNTRY <= scale < LOD_PROV_COARSE：省份粗档
    // scale >= LOD_PROV_COARSE：省份精档
    LOD_COUNTRY: 0.5,
    LOD_PROV_COARSE: 1.2,

    // === 图层 ===
    // layers.country / provL0 / provL1 各含 { paths, bbox }
    layers: { country: null, provL0: null, provL1: null },
    paths: null,          // Map<ne_id, Path2D>  指向 provL1（拾取/军队/高亮用）
    bbox: null,           // Map<ne_id, [x0,y0,x1,y1]>  指向 provL1
    seqIndex: null,       // Map<ne_id, number>  顺序索引（拾取用）
    countryBorderPath: null, // 国界 mesh 的 Path2D
    worldBounds: [0, 0, 0, 0], // 投影后世界范围

    // === 拾取网格 ===
    grid: { cols: 0, rows: 0, cells: {} },

    // === 前线索引 ===
    borderIndex: null,    // Map<"isoA|isoB", number[][][]>

    // === 相机（屏幕 = 世界 * scale + offset）===
    scale: 1, offsetX: 0, offsetY: 0,
    targetScale: 1, targetOffsetX: 0, targetOffsetY: 0,
    viewW: 0, viewH: 0,

    // === 交互状态 ===
    hoverProvince: null, selectedProvince: null,
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
        this.buildCountryBorders();
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
    },

    // 国家配色：可玩国家用其定义色，其余按 ISO3 哈希生成稳定色
    countryColor(iso3) {
        if (!iso3) return '#2a3140';
        const cid = this.game.countryIdByIso3(iso3);
        if (cid) {
            const c = this.game.countryById(cid);
            if (c) return c.color;
        }
        // 非可玩国家：确定性哈希生成低饱和色
        let h = 0;
        for (let i = 0; i < iso3.length; i++) h = (h * 31 + iso3.charCodeAt(i)) >>> 0;
        const hue = h % 360;
        return `hsl(${hue}, 32%, 42%)`;
    },

    /* ===================== 拾取网格 ===================== */
    buildPicker() {
        const cols = 28, rows = 14;
        this.grid = { cols, rows, cells: {} };
        const [x0, y0, x1, y1] = this.worldBounds;
        const cellW = (x1 - x0) / cols;
        const cellH = (y1 - y0) / rows;
        for (const [id, b] of this.bbox) {
            const c0 = Math.max(0, Math.floor((b[0] - x0) / cellW));
            const c1 = Math.min(cols - 1, Math.floor((b[2] - x0) / cellW));
            const r0 = Math.max(0, Math.floor((b[1] - y0) / cellH));
            const r1 = Math.min(rows - 1, Math.floor((b[3] - y0) / cellH));
            for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
                const key = r * cols + c;
                if (!this.grid.cells[key]) this.grid.cells[key] = [];
                this.grid.cells[key].push(id);
            }
        }
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

    /* ===================== 国界 ===================== */
    buildCountryBorders() {
        const objName = this.countryObjName();
        const mesh = topojson.mesh(this.countriesTopo, this.countriesTopo.objects[objName]);
        const d = this.geoPath(mesh);
        if (d) this.countryBorderPath = new Path2D(d);
    },

    /* ===================== 前线索引（meshArcs） ===================== */
    buildBorderIndex() {
        const objName = this.provinceObjName();
        const obj = this.topo.objects[objName];
        // a !== b 只保留省份之间的内部边界
        const m = topojson.meshArcs(this.topo, obj, (a, b) => a !== b);
        const { arcs, transform } = this.topo;

        // 构建 弧段索引 → 使用该弧段的省份集合（meshArcs 不返回 objects，需自行反查）
        const arcProvinces = {};
        for (const g of obj.geometries) {
            const rings = g.type === 'Polygon' ? [g.arcs]
                      : g.type === 'MultiPolygon' ? g.arcs : [];
            for (const ring of rings.flat()) {
                for (const ai of ring) {
                    const idx = Math.abs(ai);
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
                    return [transform.scale[0] * (x + transform.translate[0]),
                            transform.scale[1] * (y + transform.translate[1])];
                });
                arcCache.set(idx, pts);
            }
            return i < 0 ? pts.slice().reverse() : pts;
        };

        for (let i = 0; i < m.arcs.length; i++) {
            const lineIdx = m.arcs[i];
            // 收集该边界线两侧的省份
            const provSet = new Set();
            for (const ai of lineIdx) {
                const set = arcProvinces[Math.abs(ai)];
                if (set) for (const pid of set) provSet.add(pid);
            }
            if (provSet.size !== 2) continue;
            const [pidA, pidB] = [...provSet];
            const oa = this.index.meta[pidA]?.owner;
            const ob = this.index.meta[pidB]?.owner;
            if (!oa || !ob || oa === ob) continue; // 同国省界，不是前线
            const key = oa < ob ? oa + '|' + ob : ob + '|' + oa;
            // 解码弧段为折线（世界坐标）
            const merged = [];
            for (const ai of lineIdx) {
                const a = decodeArc(ai);
                merged.push(...(merged.length ? a.slice(1) : a));
            }
            if (merged.length > 1) {
                if (!this.borderIndex.has(key)) this.borderIndex.set(key, []);
                this.borderIndex.get(key).push(merged);
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

    fitWorld() {
        if (!this.ready) return;
        const [x0, y0, x1, y1] = this.worldBounds;
        const w = x1 - x0, h = y1 - y0;
        const sx = this.viewW / w, sy = this.viewH / h;
        this.scale = Math.min(sx, sy) * 0.96;
        this.offsetX = (this.viewW - w * this.scale) / 2 - x0 * this.scale;
        this.offsetY = (this.viewH - h * this.scale) / 2 - y0 * this.scale;
        this.targetScale = this.scale;
        this.targetOffsetX = this.offsetX;
        this.targetOffsetY = this.offsetY;
    },

    centerOn(wx, wy, scale) {
        this.scale = scale;
        this.offsetX = this.viewW / 2 - wx * this.scale;
        this.offsetY = this.viewH / 2 - wy * this.scale;
        this.targetScale = this.scale;
        this.targetOffsetX = this.offsetX;
        this.targetOffsetY = this.offsetY;
        this.draw();
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
        const ctx = this.ctx;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // 海洋背景
        ctx.fillStyle = '#0b2545';
        ctx.fillRect(0, 0, this.viewW, this.viewH);

        // 应用相机变换，进入世界坐标空间
        ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, this.offsetX * dpr, this.offsetY * dpr);

        // === LOD 分层：按缩放比例选择渲染图层 ===
        if (this.scale < this.LOD_COUNTRY) {
            // 缩放小（看全貌）：只显示国家
            this.drawCountryFills(ctx);
            this.drawCountryBorders(ctx);
        } else if (this.scale < this.LOD_PROV_COARSE) {
            // 中等缩放：省份粗档
            this.drawProvinceFills(ctx, this.layers.provL0);
            this.drawProvinceBorders(ctx, this.layers.provL0);
            this.drawCountryBorders(ctx);
        } else {
            // 放大：省份精档
            this.drawProvinceFills(ctx, this.layers.provL1);
            this.drawProvinceBorders(ctx, this.layers.provL1);
            this.drawCountryBorders(ctx);
        }

        this.drawFrontlines(ctx);
        this.drawArmies(ctx);
        // 高亮仅在省份层级显示（国家级不画省份轮廓）
        if (this.scale >= this.LOD_COUNTRY) this.drawHighlights(ctx);

        this.drawMinimap();
    },

    inView(b, view) {
        return !(b[2] < view.x0 || b[0] > view.x1 || b[3] < view.y0 || b[1] > view.y1);
    },

    // 国家填充：按归属国配色
    drawCountryFills(ctx) {
        const view = this.viewRect();
        const layer = this.layers.country;
        for (const [iso3, path] of layer.paths) {
            const b = layer.bbox.get(iso3);
            if (!b || !this.inView(b, view)) continue;
            ctx.fillStyle = this.countryColor(iso3);
            ctx.fill(path);
        }
    },

    drawProvinceFills(ctx, layer) {
        const view = this.viewRect();
        const game = this.game;
        for (const [id, path] of layer.paths) {
            const b = layer.bbox.get(id);
            if (!b || !this.inView(b, view)) continue;
            const owner = game.ownerOf(id);
            const color = owner ? (game.countryById(owner)?.color || '#555') : '#2a3140';
            ctx.fillStyle = color;
            ctx.fill(path);
        }
    },

    drawCountryBorders(ctx) {
        if (!this.countryBorderPath) return;
        ctx.strokeStyle = 'rgba(15,20,28,0.6)';
        ctx.lineWidth = 1.1 / this.scale;
        ctx.lineJoin = 'round';
        ctx.stroke(this.countryBorderPath);
    },

    drawProvinceBorders(ctx, layer) {
        const view = this.viewRect();
        ctx.strokeStyle = 'rgba(10,14,20,0.35)';
        ctx.lineWidth = 0.6 / this.scale;
        ctx.lineJoin = 'round';
        for (const [id, path] of layer.paths) {
            const b = layer.bbox.get(id);
            if (!b || !this.inView(b, view)) continue;
            ctx.stroke(path);
        }
    },

    drawFrontlines(ctx) {
        const game = this.game;
        const t = performance.now() / 1000;
        const paths = [];
        for (const [key, segs] of this.borderIndex) {
            const [a, b] = key.split('|');
            if (game.areAtWar(a, b)) {
                for (const s of segs) {
                    const p = new Path2D();
                    p.moveTo(s[0][0], s[0][1]);
                    for (let i = 1; i < s.length; i++) p.lineTo(s[i][0], s[i][1]);
                    paths.push(p);
                }
            }
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
        for (const army of game.armies) {
            const prov = game.provinceById(army.provinceId);
            if (!prov) continue;
            const b = this.bbox.get(army.provinceId);
            if (!b) continue;
            const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
            const owner = game.countryById(army.owner);
            const color = owner ? owner.color : '#fff';
            const size = Math.max(5, Math.min(16, 5 + army.strength / 20)) / this.scale;
            ctx.fillStyle = color;
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1.2 / this.scale;
            ctx.beginPath();
            ctx.rect(cx - size / 2, cy - size / 2, size, size);
            ctx.fill();
            ctx.stroke();
            if (this.scale > 0.5) {
                ctx.fillStyle = '#fff';
                ctx.font = `bold ${9 / this.scale}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText(Math.round(army.strength), cx, cy + 3 / this.scale);
            }
        }
    },

    drawHighlights(ctx) {
        // 悬停高亮
        if (this.hoverProvince) {
            const path = this.paths.get(this.hoverProvince.id);
            if (path) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2 / this.scale;
                ctx.stroke(path);
            }
        }
        // 选中高亮
        if (this.selectedProvince) {
            const path = this.paths.get(this.selectedProvince);
            if (path) {
                ctx.strokeStyle = '#c9a96e';
                ctx.lineWidth = 3 / this.scale;
                ctx.stroke(path);
            }
        }
        // 前线高亮
        if (this.tool === 'front') {
            const view = this.viewRect();
            for (const [id] of this.paths) {
                const b = this.bbox.get(id);
                if (!b || !this.inView(b, view)) continue;
                const armies = this.game.armies.filter(a => a.provinceId === id);
                const owners = new Set(armies.map(a => a.owner));
                if (owners.size > 1) {
                    const path = this.paths.get(id);
                    ctx.fillStyle = 'rgba(200,74,74,0.25)';
                    ctx.fill(path);
                }
            }
        }
    },

    /* ===================== 小地图 ===================== */
    drawMinimap() {
        if (!this.miniCanvas || !this.miniCtx) return;
        const ctx = this.miniCtx;
        const w = this.miniCanvas.width, h = this.miniCanvas.height;
        const [x0, y0, x1, y1] = this.worldBounds;
        const sx = w / (x1 - x0), sy = h / (y1 - y0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0b2545';
        ctx.fillRect(0, 0, w, h);
        // 小地图用国家图层（轻量、清晰）
        const cLayer = this.layers.country;
        for (const [iso3, path] of cLayer.paths) {
            ctx.fillStyle = this.countryColor(iso3);
            ctx.fill(path);
        }
        // 视口框
        const v0 = this.screenToWorld(0, 0);
        const v1 = this.screenToWorld(this.viewW, this.viewH);
        ctx.strokeStyle = '#c9a96e';
        ctx.lineWidth = 1;
        ctx.strokeRect(
            (v0.x - x0) * sx, (v0.y - y0) * sy,
            (v1.x - v0.x) * sx, (v1.y - v0.y) * sy
        );
    },

    /* ===================== 事件 ===================== */
    bindEvents() {
        const c = this.canvas;
        c.addEventListener('mousedown', (e) => this.onMouseDown(e));
        c.addEventListener('mousemove', (e) => this.onMouseMove(e));
        c.addEventListener('mouseup', (e) => this.onMouseUp(e));
        c.addEventListener('mouseleave', () => { this.hoverProvince = null; this.hideTooltip(); });
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
            this.targetOffsetX = this.offsetX;
            this.targetOffsetY = this.offsetY;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.draw();
            return;
        }
        if (!this.ready) return;
        const world = this.screenToWorld(pos.x, pos.y);
        const prov = this.findProvinceAt(world.x, world.y);
        this.hoverProvince = prov;
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
        const newScale = Math.max(0.12, Math.min(14, this.scale * factor));
        this.offsetX = pos.x - worldBefore.x * newScale;
        this.offsetY = pos.y - worldBefore.y * newScale;
        this.scale = newScale;
        this.targetScale = this.scale;
        this.targetOffsetX = this.offsetX;
        this.targetOffsetY = this.offsetY;
        this.draw();
    },

    onDoubleClick(e) {
        const pos = this.getMousePos(e);
        const world = this.screenToWorld(pos.x, pos.y);
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
            const newScale = Math.max(0.12, Math.min(14, this.pinchStartScale * factor));
            const mid = this.touchMidpoint(touches);
            const midPos = this.getPos(mid.x, mid.y);
            const worldBefore = this.screenToWorld(this.pinchMid.x, this.pinchMid.y);
            this.scale = newScale;
            this.offsetX = midPos.x - worldBefore.x * newScale;
            this.offsetY = midPos.y - worldBefore.y * newScale;
            this.draw();
            return;
        }
        if (touches.length === 1 && this.isDragging) {
            const t = touches[0];
            const dx = t.clientX - this.lastMouseX;
            const dy = t.clientY - this.lastMouseY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastMouseX = t.clientX;
            this.lastMouseY = t.clientY;
            this.draw();
            return;
        }
        if (touches.length === 1) {
            const t = touches[0];
            const pos = this.getPos(t.clientX, t.clientY);
            const world = this.screenToWorld(pos.x, pos.y);
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
            if (moved < 8) {
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
    showTooltip(prov, pos) {
        let tip = document.getElementById('tooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'tooltip';
            document.body.appendChild(tip);
        }
        const owner = this.game.ownerOf(prov.id);
        const ownerName = owner ? this.game.countryById(owner).name : '无主';
        tip.innerHTML = `<b>${prov.name}</b><br/>归属：${ownerName}`;
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
