/* ============================================================
 * 钢铁雄心4 网页版 - 主入口与游戏循环 main.js
 * 负责：启动菜单、国家选择、游戏循环、初始化串联
 * ============================================================ */

const App = {
    lastTime: 0,
    tickInterval: 1000, // 每1000ms执行一次日 tick
    lastTickTime: 0,

    init() {
        this.bindStartScreen();
        // 检查存档
        if (Game.hasSave()) {
            document.getElementById('btnContinue').disabled = false;
        }
        // 渲染国家选择
        this.renderCountryList();
    },

    // ===================== 启动菜单 =====================
    bindStartScreen() {
        document.getElementById('btnNewGame').addEventListener('click', () => {
            document.getElementById('countrySelect').classList.remove('hidden');
            this.renderCountryList();
        });
        document.getElementById('btnContinue').addEventListener('click', () => {
            // 存档省份体系已更新，继续游戏以存档中的国家重新开局
            const saved = Game.load();
            this.pendingCountry = saved ? (Game.playerCountryId || 'germany') : 'germany';
            this.enterGame();
        });
        document.getElementById('btnCredits').addEventListener('click', () => {
            document.getElementById('aboutBox').classList.remove('hidden');
        });
    },

    renderCountryList() {
        const list = document.getElementById('countryList');
        list.innerHTML = '';
        for (const c of COUNTRIES) {
            const card = document.createElement('div');
            card.className = 'country-card';
            const ideo = IDEOLOGY[c.ideology];
            card.innerHTML = `
                <div class="cc-flag">${c.flag}</div>
                <div class="cc-name">${c.name}</div>
                <div class="cc-ideo">${ideo.icon} ${ideo.name}</div>
            `;
            card.addEventListener('click', () => this.startGame(c.id));
            list.appendChild(card);
        }
    },

    startGame(countryId) {
        this.pendingCountry = countryId;
        this.enterGame();
    },

    enterGame() {
        document.getElementById('startScreen').classList.remove('active');
        document.getElementById('gameScreen').classList.add('active');

        // 显示加载遮罩
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

        // 异步加载矢量地图数据，加载完成后初始化游戏
        MapView.loadData().then(() => {
            // 数据就绪，构建省份与游戏状态
            Game.newGame(this.pendingCountry);
            // 首次绘制（此时省份归属已就绪）
            MapView.fitWorld();
            MapView.draw();
            loader.classList.add('hidden');

            // 初始化 UI
            UI.init(Game);
            UI.refreshAll();

            // 开始游戏循环
            this.lastTickTime = performance.now();
            this.lastTime = performance.now();
            this.tickAccumulator = 0;
            this.uiAccumulator = 0;
            this.gameRunning = true;
            this.gameLoop(performance.now());
        }).catch(err => {
            document.getElementById('loadingText').textContent = '地图加载失败：' + err.message;
            console.error(err);
        });
    },

    // ===================== 游戏循环 =====================
    gameLoop(currentTime) {
        const delta = currentTime - this.lastTime;
        this.lastTime = currentTime;

        // 事件弹窗出现时暂停时间推进
        if (Game.activeEvent) {
        } else if (Game.speed > 0) {
            this.tickAccumulator += delta;
            const tickInterval = 1000 / (Game.speed + 1);
            let ticksThisFrame = 0;
            while (this.tickAccumulator >= tickInterval && Game.speed > 0 && ticksThisFrame < 50) {
                this.tickAccumulator -= tickInterval;
                this.doTick();
                ticksThisFrame++;
            }
            // 防止堆积过多
            if (this.tickAccumulator > 5000) this.tickAccumulator = 0;
        }

        // 定期刷新 UI（每 400ms）
        this.uiAccumulator = (this.uiAccumulator || 0) + delta;
        if (this.uiAccumulator > 400) {
            this.uiAccumulator = 0;
            UI.refreshAll();
        }

        this.requestFrame = requestAnimationFrame((t) => this.gameLoop(t));
    },

    doTick() {
        Game.tickAccumulator++;
        Game.advanceDate(GAME.TICK_DAYS);
        Game.dailyTick();

        // 检查是否达到结束日期
        const end = GAME.END_DATE;
        if (Game.date.year > end.year) {
            this.endGame('时间已到达 1948 年，游戏结束！');
        }
    },

    endGame(message) {
        Game.running = false;
        Game.speed = 0;
        this.gameRunning = false;
        if (this.requestFrame) cancelAnimationFrame(this.requestFrame);
        UI.showModal('游戏结束', `<p>${message}</p>
            <p style="margin-top:10px;color:var(--text-dim)">最终日期：${Game.formatDate()}</p>
            <p>您统治的疆域：${Game.provincesOf(Game.playerCountryId).length} 个省份</p>`,
            [
                { text: '返回主菜单', cls: 'primary', action: () => {
                    UI.closeModal();
                    document.getElementById('gameScreen').classList.remove('active');
                    document.getElementById('startScreen').classList.add('active');
                }},
            ]);
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
    // 默认进入游戏循环（用标志控制）
    App.gameRunning = false;
});

if (typeof window !== 'undefined') window.App = App;
