/* ============================================================
 * 钢铁雄心4 网页版 - 地图渲染 map.js
 * 负责：绘制省份、国界、军队、悬停、缩放平移、小地图
 * ============================================================ */

const MapView = {
    canvas: null,
    ctx: null,
    miniCanvas: null,
    miniCtx: null,
    game: null,          // 引用 Game 对象

    // 视图变换
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    // 目标变换（用于平滑缩放）
    targetScale: 1,
    targetOffsetX: 0,
    targetOffsetY: 0,

    // 交互状态
    hoverProvince: null,
    selectedProvince: null,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    lastMouseX: 0,
    lastMouseY: 0,

    // 缓存：省份多边形顶点（屏幕坐标）
    provinceScreenCache: {},

    init(canvas, miniCanvas, game) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.miniCanvas = miniCanvas;
        this.miniCtx = miniCanvas.getContext('2d');
        this.game = game;
        this.bindEvents();
        this.resize();
    },

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.viewW = rect.width;
        this.viewH = rect.height;
        this.draw();
    },

    /* ---------- 坐标变换 ---------- */
    // 世界坐标 -> 屏幕坐标
    worldToScreen(wx, wy) {
        return {
            x: wx * this.scale + this.offsetX,
            y: wy * this.scale + this.offsetY,
        };
    },
    screenToWorld(sx, sy) {
        return {
            x: (sx - this.offsetX) / this.scale,
            y: (sy - this.offsetY) / this.scale,
        };
    },

    // 适应窗口，显示整个世界
    fitWorld() {
        const sx = this.viewW / GAME.WORLD_W;
        const sy = this.viewH / GAME.WORLD_H;
        this.scale = Math.min(sx, sy) * 0.95;
        this.offsetX = (this.viewW - GAME.WORLD_W * this.scale) / 2;
        this.offsetY = (this.viewH - GAME.WORLD_H * this.scale) / 2;
        this.targetScale = this.scale;
        this.targetOffsetX = this.offsetX;
        this.targetOffsetY = this.offsetY;
    },

    /* ---------- 事件绑定 ---------- */
    bindEvents() {
        const c = this.canvas;
        c.addEventListener('mousedown', (e) => this.onMouseDown(e));
        c.addEventListener('mousemove', (e) => this.onMouseMove(e));
        c.addEventListener('mouseup', (e) => this.onMouseUp(e));
        c.addEventListener('mouseleave', () => { this.hoverProvince = null; this.hideTooltip(); });
        c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        c.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        window.addEventListener('resize', () => this.resize());
    },

    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },

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
        // 悬停检测
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
        if (this.isDragging) {
            const moved = Math.abs(e.clientX - this.dragStartX) + Math.abs(e.clientY - this.dragStartY);
            this.isDragging = false;
            this.canvas.style.cursor = 'grab';
            // 如果没有拖动，视为点击
            if (moved < 4) {
                const pos = this.getMousePos(e);
                const world = this.screenToWorld(pos.x, pos.y);
                const prov = this.findProvinceAt(world.x, world.y);
                if (prov) {
                    this.game.selectProvince(prov.id);
                } else {
                    this.game.selectProvince(null);
                }
            }
        }
    },

    onWheel(e) {
        e.preventDefault();
        const pos = this.getMousePos(e);
        const worldBefore = this.screenToWorld(pos.x, pos.y);
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newScale = Math.max(0.5, Math.min(8, this.scale * factor));
        // 保持鼠标位置不变
        this.offsetX = pos.x - worldBefore.x * newScale;
        this.offsetY = pos.y - worldBefore.y * newScale;
        this.scale = newScale;
        this.targetScale = this.scale;
        this.targetOffsetX = this.offsetX;
        this.targetOffsetY = this.offsetY;
        this.draw();
    },

    onDoubleClick(e) {
        // 双击定位到选定省份中心
        const pos = this.getMousePos(e);
        const world = this.screenToWorld(pos.x, pos.y);
        const prov = this.findProvinceAt(world.x, world.y);
        if (prov) {
            this.centerOn(prov.x + prov.w / 2, prov.y + prov.h / 2, Math.max(this.scale * 1.5, 1.5));
        }
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

    /* ---------- 省份查找 ---------- */
    findProvinceAt(wx, wy) {
        const provinces = this.game.provinces;
        for (let i = provinces.length - 1; i >= 0; i--) {
            const p = provinces[i];
            const t = this.game.terrainOf(p.id);
            if (t === 'ocean') continue;
            if (wx >= p.x && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h) {
                return p;
            }
        }
        return null;
    },

    /* ---------- tooltip ---------- */
    showTooltip(prov, pos) {
        let tip = document.getElementById('tooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'tooltip';
            document.body.appendChild(tip);
        }
        const owner = this.game.ownerOf(prov.id);
        const ownerName = owner ? this.game.countryById(owner).name : '无主';
        const terr = TERRAIN[prov.terrain];
        tip.innerHTML = `<b>${prov.name}</b><br/>地形: ${terr.name}<br/>归属: ${ownerName}`;
        tip.style.display = 'block';
        tip.style.left = (pos.x + 14) + 'px';
        tip.style.top = (pos.y + 14) + 'px';
    },
    hideTooltip() {
        const tip = document.getElementById('tooltip');
        if (tip) tip.style.display = 'none';
    },

    /* ---------- 主绘制 ---------- */
    draw() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.viewW, this.viewH);

        // 海洋背景
        ctx.fillStyle = '#0d1f30';
        ctx.fillRect(0, 0, this.viewW, this.viewH);

        // 绘制省份
        this.drawProvinces(ctx);

        // 绘制国家边界（省份之间自动有色块，这里画国家轮廓高亮可选）
        // 绘制军队
        this.drawArmies(ctx);

        // 绘制省份高亮
        this.drawHighlights(ctx);

        // 绘制小地图
        this.drawMinimap();
    },

    drawProvinces(ctx) {
        const provinces = this.game.provinces;
        for (const p of provinces) {
            const terr = this.game.terrainOf(p.id);
            const screen = this.worldToScreen(p.x, p.y);
            const w = p.w * this.scale;
            const h = p.h * this.scale;

            if (terr === 'ocean') {
                // 海洋用深色
                ctx.fillStyle = '#102840';
                ctx.fillRect(screen.x, screen.y, w, h);
                continue;
            }

            // 省份填充：根据归属着色
            const owner = this.game.ownerOf(p.id);
            const baseColor = owner ? this.game.countryById(owner).color : '#3a4250';
            ctx.fillStyle = this.shadeColor(baseColor, -0.25);
            ctx.fillRect(screen.x, screen.y, w, h);

            // 地形纹理叠加
            const terrainColor = TERRAIN[p.terrain] ? TERRAIN[p.terrain].color : '#3a5a3a';
            ctx.fillStyle = this.mixColor(this.shadeColor(baseColor, -0.25), terrainColor, 0.35);
            ctx.fillRect(screen.x, screen.y, w, h);

            // 边界线
            ctx.strokeStyle = this.shadeColor(baseColor, -0.5);
            ctx.lineWidth = 1;
            ctx.strokeRect(screen.x, screen.y, w, h);
        }
    },

    drawHighlights(ctx) {
        // 悬停高亮
        if (this.hoverProvince) {
            const p = this.hoverProvince;
            const s = this.worldToScreen(p.x, p.y);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.strokeRect(s.x, s.y, p.w * this.scale, p.h * this.scale);
        }
        // 选中高亮
        if (this.game.selectedProvince) {
            const p = this.game.provinceById(this.game.selectedProvince);
            if (p) {
                const s = this.worldToScreen(p.x, p.y);
                ctx.strokeStyle = '#c9a96e';
                ctx.lineWidth = 3;
                ctx.strokeRect(s.x, s.y, p.w * this.scale, p.h * this.scale);
            }
        }
        // 前线高亮（战争省份）
        if (this.game.tool === 'front') {
            const frontProvinces = this.game.findFrontProvinces();
            for (const p of frontProvinces) {
                const s = this.worldToScreen(p.x, p.y);
                ctx.fillStyle = 'rgba(200, 74, 74, 0.3)';
                ctx.fillRect(s.x, s.y, p.w * this.scale, p.h * this.scale);
            }
        }
        // 资源高亮
        if (this.game.tool === 'resources') {
            const provinces = this.game.provinces;
            for (const p of provinces) {
                if (terr_isOcean(p)) continue;
                const res = this.game.provinceResources(p.id);
                const total = Object.values(res).reduce((a, b) => a + b, 0);
                if (total > 1.0) {
                    const s = this.worldToScreen(p.x, p.y);
                    ctx.fillStyle = `rgba(201, 169, 110, ${Math.min(0.5, total * 0.2)})`;
                    ctx.fillRect(s.x, s.y, p.w * this.scale, p.h * this.scale);
                }
            }
        }
    },

    drawArmies(ctx) {
        const armies = this.game.armies;
        for (const army of armies) {
            const prov = this.game.provinceById(army.provinceId);
            if (!prov) continue;
            const s = this.worldToScreen(prov.x + prov.w / 2, prov.y + prov.h / 2);
            const size = Math.max(6, Math.min(14, 5 + army.strength / 20));
            const owner = this.game.countryById(army.owner);
            const color = owner ? owner.color : '#fff';
            // 军队方块
            ctx.fillStyle = color;
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.rect(s.x - size / 2, s.y - size / 2, size, size);
            ctx.fill();
            ctx.stroke();
            // 军力数字
            if (this.scale > 0.7) {
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 9px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(Math.round(army.strength), s.x, s.y + 3);
            }
        }
    },

    /* ---------- 小地图 ---------- */
    drawMinimap() {
        if (!this.miniCanvas || !this.miniCtx) return;
        const ctx = this.miniCtx;
        const w = this.miniCanvas.width, h = this.miniCanvas.height;
        const sx = w / GAME.WORLD_W;
        const sy = h / GAME.WORLD_H;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0d1f30';
        ctx.fillRect(0, 0, w, h);

        for (const p of this.game.provinces) {
            const terr = this.game.terrainOf(p.id);
            if (terr === 'ocean') continue;
            const owner = this.game.ownerOf(p.id);
            ctx.fillStyle = owner ? this.game.countryById(owner).color : '#3a4250';
            ctx.fillRect(p.x * sx, p.y * sy, p.w * sx, p.h * sy);
        }

        // 玩家位置标记
        if (this.game.playerCountry) {
            const pc = this.game.playerCountry;
            for (const pid of pc.provinces) {
                const p = this.game.provinceById(pid);
                if (p) ctx.fillStyle = '#fff';
                if (p) ctx.fillRect(p.x * sx, p.y * sy, p.w * sx, p.h * sy);
            }
        }

        // 视口框
        const v0 = this.screenToWorld(0, 0);
        const v1 = this.screenToWorld(this.viewW, this.viewH);
        ctx.strokeStyle = '#c9a96e';
        ctx.lineWidth = 1;
        ctx.strokeRect(v0.x * sx, v0.y * sy, (v1.x - v0.x) * sx, (v1.y - v0.y) * sy);
    },

    /* ---------- 颜色工具 ---------- */
    shadeColor(hex, percent) {
        const num = parseInt(hex.replace('#', ''), 16);
        let r = (num >> 16) + Math.round(255 * percent);
        let g = ((num >> 8) & 0xff) + Math.round(255 * percent);
        let b = (num & 0xff) + Math.round(255 * percent);
        r = Math.max(0, Math.min(255, r));
        g = Math.max(0, Math.min(255, g));
        b = Math.max(0, Math.min(255, b));
        return `rgb(${r},${g},${b})`;
    },
    mixColor(c1, c2, t) {
        const p = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
        const a = c1.startsWith('#') ? p(c1) : this.hexToRgb(c1);
        const b = c2.startsWith('#') ? p(c2) : this.hexToRgb(c2);
        const r = Math.round(a[0] + (b[0]-a[0])*t);
        const g = Math.round(a[1] + (b[1]-a[1])*t);
        const bl = Math.round(a[2] + (b[2]-a[2])*t);
        return `rgb(${r},${g},${bl})`;
    },
    hexToRgb(h) {
        const num = parseInt(h.replace('#',''), 16);
        return [(num>>16)&255, (num>>8)&255, num&255];
    },
};

function terr_isOcean(p) { return p.terrain === 'ocean'; }

if (typeof window !== 'undefined') window.MapView = MapView;
