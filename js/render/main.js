/* ============================================================
 * 钢铁雄心4 网页版 - 主入口与游戏循环 main.js
 * 负责：启动菜单、国家选择、游戏循环、初始化串联
 * 模拟由战役核心（Campaign）驱动，本文件只做渲染层调度。
 * ============================================================ */

const App = {
    lastTime: 0,
    uiAccumulator: 0,
    pendingCampaign: null,   // 新游戏已加载的剧本（等待选择国家）
    gameRunning: false,
    theme: 'dark',

    init() {
        this.initTheme();
        this.bindStartScreen();
        this.bindAIToggle();
        this.setupShortcuts();
        if (Game.hasSave()) {
            document.getElementById('btnContinue').disabled = false;
        }
    },

    // ===================== AI 接管 =====================

    bindAIToggle() {
        const btn = document.getElementById('btnAI');
        if (!btn) return;
        const sync = () => {
            const on = !!Game.aiEnabled;
            btn.classList.toggle('active', on);
            btn.title = on ? 'AI 已接管所有非玩家国家（点击关闭）'
                           : '切换 AI 接管：所有非玩家国家由 AI 决策';
        };
        btn.addEventListener('click', () => {
            Game.setAI(!Game.aiEnabled);
            sync();
        });
        sync();
    },

    // ===================== 键盘快捷键 =====================
    /**
     * 空格暂停/继续，Esc 关闭面板或取消选中，1-9 / 0 切换面板。
     * 输入控件内不拦截，避免影响下拉框与文本输入。
     */
    setupShortcuts() {
        const PANEL_ORDER = ['overview', 'politics', 'economy', 'production', 'army',
            'tech', 'diplomacy', 'war', 'intelligence', 'notices'];
        window.addEventListener('keydown', (e) => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            if (!Game.campaign) return;
            if (!document.getElementById('gameScreen').classList.contains('active')) return;

            if (e.key === 'Escape') {
                const pm = document.getElementById('panelModal');
                if (pm && !pm.classList.contains('hidden')) { UI.closePanel(); return; }
                Game.clearArmySelection();
                return;
            }
            if (e.key === ' ') {
                e.preventDefault();
                Game.speed = Game.speed > 0 ? 0 : 3;
                UI.refreshAll();
                return;
            }
            if (e.key >= '0' && e.key <= '9') {
                const panel = PANEL_ORDER[Number(e.key) === 0 ? 9 : Number(e.key) - 1];
                if (panel && panel !== UI.currentPanel) UI.openPanel(panel);
            }
        });
    },

    // ===================== 主题 =====================
    initTheme() {
        let theme = 'dark';
        try {
            if (localStorage.getItem('hoi4_theme') === 'light') theme = 'light';
        } catch (e) { /* 隐私模式下忽略存储错误 */ }
        this.applyTheme(theme);
        document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.applyTheme(this.theme === 'light' ? 'dark' : 'light');
            });
        });
    },

    applyTheme(theme) {
        this.theme = theme === 'light' ? 'light' : 'dark';
        const isLight = this.theme === 'light';
        document.documentElement.dataset.theme = this.theme;
        try { localStorage.setItem('hoi4_theme', this.theme); } catch (e) { /* 忽略 */ }

        // 按钮显示「点击后会切换到的主题」：深色时显示太阳，浅色时显示月亮
        document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
            btn.textContent = isLight ? '☾' : '☀';
            const label = isLight ? '切换到深色主题' : '切换到浅色主题';
            btn.title = label;
            btn.setAttribute('aria-label', label);
        });

        if (typeof MapView !== 'undefined' && MapView.setTheme) {
            MapView.setTheme(this.theme);
        }
    },

    // ===================== 启动菜单 =====================
    bindStartScreen() {
        document.getElementById('btnNewGame').addEventListener('click', async () => {
            const countrySelect = document.getElementById('countrySelect');
            countrySelect.classList.remove('hidden');
            const list = document.getElementById('countryList');
            list.innerHTML = '<div style="color:var(--text-dim);padding:10px">正在加载剧本…</div>';
            try {
                // 加载并校验剧本（模拟层就绪）
                this.pendingCampaign = await Game.prepareNewGame();
                this.renderCountryList(this.pendingCampaign);
            } catch (err) {
                list.innerHTML = `<div style="color:var(--red);padding:10px">剧本加载失败：${err.message}</div>`;
                console.error(err);
            }
        });
        document.getElementById('btnContinue').addEventListener('click', async () => {
            // 继续游戏：先加载剧本（存档恢复需要 Campaign 实例），再从存档覆盖状态
            try {
                await Game.prepareNewGame();
                if (!Game.load()) {
                    alert('存档读取失败，请开始新游戏。');
                    return;
                }
                this.enterGame();
            } catch (err) {
                alert('存档读取失败：' + err.message);
                console.error(err);
            }
        });
        document.getElementById('btnCredits').addEventListener('click', () => {
            document.getElementById('aboutBox').classList.remove('hidden');
        });
    },

    renderCountryList(campaign) {
        const list = document.getElementById('countryList');
        list.innerHTML = '';
        const countries = campaign.scenario.countries;
        // 全量剧本包含 250 个归属方，但开局只展示有完整内容的可玩国家。
        const tags = Array.isArray(campaign.scenario.playable) && campaign.scenario.playable.length
            ? campaign.scenario.playable.filter((tag) => countries[tag])
            : Object.keys(countries);
        for (const tag of tags) {
            const def = countries[tag];
            const card = document.createElement('div');
            card.className = 'country-card';
            const ideo = IDEOLOGY[def.ideology] || { icon: '○', name: '中立' };
            card.innerHTML = `
                <div class="cc-flag" style="background:${def.color}">${def.flag}</div>
                <div class="cc-name">${window.Core.t(def.name)}</div>
                <div class="cc-ideo">${ideo.icon} ${ideo.name}</div>
            `;
            card.addEventListener('click', () => this.startGame(tag));
            list.appendChild(card);
        }
    },

    startGame(tag) {
        // 以选定国家开局（构建初始状态、挂接事件）
        Game.startWith(tag);
        this.enterGame();
    },

    enterGame() {
        document.getElementById('startScreen').classList.remove('active');
        document.getElementById('gameScreen').classList.add('active');

        const loader = document.getElementById('loadingOverlay');
        loader.classList.remove('hidden');
        document.getElementById('loadingText').textContent = '正在加载世界地图…';

        // 初始化地图（先建画布与事件，数据异步加载）
        const mapCanvas = document.getElementById('gameMap');
        const miniCanvas = document.createElement('canvas');
        miniCanvas.width = 180;
        miniCanvas.height = 90;
        document.getElementById('minimapContainer').appendChild(miniCanvas);

        MapView.init(mapCanvas, miniCanvas, Game);

        MapView.loadData().then(() => {
            // 数据就绪：归属已就绪，首次绘制
            MapView.fitWorld();
            MapView.draw();
            loader.classList.add('hidden');

            // 启动战役时钟（模拟层自驱 rAF 循环）
            // 开局默认暂停：先看清局面再手动选速度推进，符合大战略品类的惯例
            Game.clock.start();
            Game.speed = 0;

            // AI-only 模式：?ai=1 让所有非玩家国家由 AI 接管，并以高速推进（观战 / 压测）
            if (this.aiOnlyMode()) {
                Game.setAI(true);
                const aiBtn = document.getElementById('btnAI');
                if (aiBtn) {
                    aiBtn.classList.add('active');
                    aiBtn.title = 'AI 已接管所有非玩家国家（点击关闭）';
                }
                Game.speed = 5;
            }

            // 初始化 UI
            UI.init(Game);
            UI.refreshAll();

            // 主循环：只负责定期刷新 UI（模拟由 Campaign 时钟驱动）
            this.lastTime = performance.now();
            this.uiAccumulator = 0;
            this.gameRunning = true;
            this.gameLoop(performance.now());
        }).catch(err => {
            document.getElementById('loadingText').textContent = '地图加载失败：' + err.message;
            console.error(err);
        });
    },

    // ===================== 游戏循环（渲染层） =====================
    gameLoop(currentTime) {
        const delta = currentTime - this.lastTime;
        this.lastTime = currentTime;

        // 定期刷新 UI（每 400ms）
        this.uiAccumulator += delta;
        if (this.uiAccumulator > 400) {
            this.uiAccumulator = 0;
            UI.refreshAll();
        }

        this.requestFrame = requestAnimationFrame((t) => this.gameLoop(t));
    },

    // 返回主菜单：停时钟、停主循环
    returnToMenu() {
        if (Game.clock) Game.clock.stop();
        this.gameRunning = false;
        if (this.requestFrame) cancelAnimationFrame(this.requestFrame);
        document.getElementById('gameScreen').classList.remove('active');
        document.getElementById('startScreen').classList.add('active');
        document.getElementById('countrySelect').classList.add('hidden');
        if (Game.hasSave()) document.getElementById('btnContinue').disabled = false;
    },

    // AI-only 模式：URL 带 ?ai=1 时所有非玩家国家由 AI 接管
    aiOnlyMode() {
        try { return new URLSearchParams(location.search).get('ai') === '1'; }
        catch { return false; }
    },

    // 全局 resize 处理
    setupResize() {
        window.addEventListener('resize', () => {
            if (MapView.canvas && document.getElementById('gameScreen').classList.contains('active')) {
                MapView.resize();
            }
        });
    },
};

// ===================== 启动 =====================
window.addEventListener('DOMContentLoaded', () => {
    App.init();
    App.setupResize();
    App.gameRunning = false;
});

if (typeof window !== 'undefined') window.App = App;
