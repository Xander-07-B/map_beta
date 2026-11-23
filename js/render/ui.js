/* ============================================================
 * 钢铁雄心4 网页版 - UI 渲染 ui.js
 * 负责：顶部栏、侧栏各面板、底部状态栏、模态框、事件弹窗
 * 架构：只读模拟层快照（Game → Campaign state），所有操作翻译成 Command。
 * ============================================================ */

const UI = {
    currentPanel: 'overview',
    _eventPauseSpeed: 1,
    _lastPanelSignature: null,   // 上次渲染面板时的数据签名（避免无变化时反复重建 DOM）
    _panelMouse: null,           // 鼠标在面板内容区内的视口坐标（悬停镜像用）
    _deployTarget: null,         // 部队面板里手动选择的部署省份
    _toastTimer: null,

    init(game) {
        this.game = game;
        this._lastPanelSignature = null;
        this._panelMouse = null;
        this._deployTarget = null;
        this._noticeFilter = 'all';
        this._peacePauseSpeed = 1;
        this.bindIconRail();
        this.bindMapTools();
        this.bindTopBar();
        this.bindModal();
        this.bindPanelModal();
        this.bindPanelHover();
        this.bindProvinceCard();
    },

    // 安全翻译（缺 key 回退，不抛错到渲染层）
    tt(key, params) {
        try { return window.Core.t(key, params); } catch { return key; }
    },
    fp(v) { return window.Core.fromFP(v); },   // 定点 → 浮点

    /** 命令失败时弹出提示（成功则静默） */
    notify(r) {
        if (r && r.ok) return;
        const err = (r && r.err) || '命令执行失败';
        this.showModal('提示', `<p>${err}</p>`,
            [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
    },

    /**
     * 部署目标省份：地图当前选中的己方省份 > 面板里手动选择的目标 > 首个控制省份。
     * 三者都走同一条解析，部署按钮与省份速览卡不会出现目标不一致。
     */
    resolveDeployTarget(tag) {
        const mine = this.game.provincesOf(tag);
        if (mine.length === 0) return null;
        const sel = this.game.selectedProvince;
        if (sel != null && mine.some((p) => p.id === sel)) return sel;
        if (this._deployTarget != null && mine.some((p) => p.id === this._deployTarget)) {
            return this._deployTarget;
        }
        return mine[0].id;
    },

    /** 国家显示名：可玩国家走 l10n；其余用地图元数据里的中文名，避免只显示 ISO3 */
    ownerLabel(tag) {
        if (!tag) return '无主';
        const name = this.game.countryDisplayName(tag);
        if (name !== tag) return name;
        const meta = typeof MapView !== 'undefined' && MapView.countryMeta
            ? MapView.countryMeta.get(tag) : null;
        return meta?.name || tag;
    },

    /** 轻量提示条（部署/移动成功反馈） */
    toast(msg) {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
    },

    /**
     * 部署一支部队：命令、反馈、自动选中新部队（便于接着移动）。
     * 面板与省份速览卡共用。
     */
    deployAt(templateId, province, count = 1) {
        const tag = this.game.playerTag;
        const before = new Set(this.game.allArmies().map((a) => a.id));
        const r = this.game.command({
            t: 'deployArmy', country: tag, province, template: templateId, count,
        });
        if (!r.ok) {
            this.toast(r.err || '部署失败');
            return r;
        }
        const tpl = this.game.divisions[templateId];
        const prov = this.game.provinceById(province);
        this.toast(`已部署 ${tpl ? tpl.name : templateId} ×${count} → ${prov ? prov.name : province}`);
        const created = this.game.allArmies().filter((a) => !before.has(a.id) && a.provinceId === province);
        if (created.length > 0) {
            // 选中新部队，紧接着就能在地图或面板里移动
            this.game.selectArmy(created[created.length - 1].id);
        } else {
            this.updateProvincePanel();
        }
        if (typeof MapView !== 'undefined' && MapView.requestDraw) MapView.requestDraw();
        return r;
    },

    // ===================== 面板弹窗开关 =====================
    panelTitles: {
        overview: '总览', politics: '政治', economy: '经济',
        production: '生产', army: '部队', tech: '科技', diplomacy: '外交',
        war: '战争', intelligence: '情报', notices: '通知', log: '日志'
    },

    openPanel(panel) {
        this.currentPanel = panel;
        document.querySelectorAll('.rail-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.panel === panel);
        });
        document.getElementById('panelModalTitle').textContent = this.panelTitles[panel] || panel;
        this.renderPanel(panel);
        this._lastPanelSignature = this.panelSignature();
        document.getElementById('panelModal').classList.remove('hidden');
        document.getElementById('panelModalBackdrop').classList.remove('hidden');
        requestAnimationFrame(() => {
            document.getElementById('panelModal').classList.add('open');
            document.getElementById('panelModalBackdrop').classList.add('show');
        });
    },

    closePanel() {
        const pm = document.getElementById('panelModal');
        const bd = document.getElementById('panelModalBackdrop');
        pm.classList.remove('open');
        bd.classList.remove('show');
        setTimeout(() => {
            pm.classList.add('hidden');
            bd.classList.add('hidden');
        }, 280);
    },

    bindPanelModal() {
        document.getElementById('panelModalClose').addEventListener('click', () => this.closePanel());
        document.getElementById('panelModalBackdrop').addEventListener('click', () => this.closePanel());
    },

    /**
     * 地图上的省份速览卡（选中省份后出现）：查看驻扎部队、快捷部署、选中部队。
     * 事件委托在卡片容器上，卡片内容重建后无需重新绑定。
     */
    bindProvinceCard() {
        const card = document.getElementById('provinceCard');
        if (!card) return;
        card.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || typeof target.closest !== 'function') return;
            const armyBtn = target.closest('[data-army-select]');
            if (armyBtn) {
                this.game.selectArmy(Number(armyBtn.dataset.armySelect));
                return;
            }
            const airBtn = target.closest('[data-air-select]');
            if (airBtn) {
                this.game.selectAirForce(Number(airBtn.dataset.airSelect));
                return;
            }
            const fleetBtn = target.closest('[data-fleet-select]');
            if (fleetBtn) {
                this.game.selectFleet(Number(fleetBtn.dataset.fleetSelect));
                return;
            }
            const deployBtn = target.closest('[data-deploy-here]');
            if (deployBtn) {
                const province = this.game.selectedProvince;
                if (province != null) this.deployAt(deployBtn.dataset.deployHere, province, 1);
                return;
            }
            if (target.closest('[data-province-close]')) this.game.selectProvince(null);
        });
    },

    bindIconRail() {
        const btns = document.querySelectorAll('.rail-btn');
        btns.forEach(btn => {
            btn.addEventListener('click', () => this.openPanel(btn.dataset.panel));
        });
    },

    // ===================== 主刷新 =====================
    refreshAll() {
        if (!this.game || !this.game.state) return;
        // 战斗/空战/海战可能已经打光当前选中的单位，及时清理选中态
        this.game.clearStaleSelection();
        this.updateTopBar();
        this.updateStatsBar();
        // 面板关闭时不要反复重建隐藏的 DOM；打开时也只在数据签名变化时重建，
        // 否则每 400ms 重建一次会销毁鼠标下的选项元素，导致 hover 样式闪烁
        const pm = document.getElementById('panelModal');
        if (pm && !pm.classList.contains('hidden')) {
            const sig = this.panelSignature();
            if (sig !== this._lastPanelSignature) {
                const content = document.getElementById('panelContent');
                // 下拉框展开时不要重建 DOM：否则选取部署/移动目标会被定时刷新打断
                const active = document.activeElement;
                if (active && active.tagName === 'SELECT' && content.contains(active)) return;
                this._lastPanelSignature = sig;
                const scrollTop = content.scrollTop;
                this.renderPanel(this.currentPanel);
                content.scrollTop = scrollTop;
            }
        }
    },

    /**
     * 玩家控制省份的轻量签名（数量 + 稳定哈希）。
     * 全量剧本有 4,594 个省份，面板每 400ms 刷新时不能把整个 provinces 表
     * 序列化进签名，否则会造成明显卡顿。
     */
    ownedProvinceSignature(tag) {
        let count = 0;
        let hash = 0;
        for (const p of Object.values(this.game.state.provinces)) {
            if (p.controller !== tag) continue;
            count++;
            hash = (hash * 31 + p.id) >>> 0;
        }
        return [count, hash];
    },

    /**
     * 玩家全部武装力量的轻量签名（数量 + 稳定哈希）。
     * 全量剧本下空军/舰队可能很多，面板每 400ms 刷新时不能整表序列化。
     */
    ownForcesSignature(tag) {
        let n = 0;
        let hash = 0;
        for (const a of this.game.allArmies()) {
            if (a.owner !== tag) continue;
            n++;
            hash = (hash * 31 + a.id) >>> 0;
        }
        for (const g of this.game.allAirForces()) {
            if (g.owner !== tag) continue;
            n++;
            hash = (hash * 31 + g.id) >>> 0;
        }
        for (const f of this.game.allFleets()) {
            if (f.owner !== tag) continue;
            n++;
            hash = (hash * 31 + f.id) >>> 0;
        }
        return [n, hash];
    },

    /**
     * 面板渲染内容的轻量数据签名：涵盖各面板展示的全部可变数据。
     * 签名不变说明渲染结果不变，可以跳过重建（避免悬停选项闪烁）。
     */
    panelSignature() {
        const g = this.game;
        const s = g.state;
        if (!s || !g.playerTag) return '';
        const tag = g.playerTag;
        const c = s.countries[tag];
        if (!c) return '';
        return JSON.stringify([
            tag, g.selectedProvince, g.selectedArmy, g.selectedAir, g.selectedFleet, this._deployTarget,
            c.politicalPower, c.manpower, c.population, c.civs, c.mils, c.docks,
            c.stability, c.warSupport, c.legitimacy,
            c.resources, c.equipment, c.construction, c.production,
            c.tech, c.unlockedTemplates, c.unlockedAir, c.unlockedShips,
            c.relations, c.garrison, c.flags, c.bonuses, c.faction,
            c.activeFocus,
            s.focuses[tag], s.decisions[tag], s.research[tag],
            this.ownedProvinceSignature(tag), this.ownForcesSignature(tag),
            s.wars, s.alliances, s.missions, s.peaceOffers, s.factionInvites, s.lendLease,
            s.history.length, s.log.length,
            this._noticeFilter,
        ]);
    },

    // ===================== 面板悬停镜像 =====================
    // 面板 DOM 重建后，鼠标仍停留的位置上的元素是新节点，浏览器可能不会立即
    // 把 :hover 应用到新节点，表现为选项悬停样式闪烁。重建后用 .ui-hover 类
    // 镜像 :hover 样式（与 CSS 中的 :hover 规则同声明），鼠标一移动即交还给
    // 原生 :hover。
    PANEL_HOVER_SELECTORS: ['.btn-action', '.focus-card', '.tech-card', '.tech-slot-item', '.panel-row'],

    bindPanelHover() {
        const content = document.getElementById('panelContent');
        content.addEventListener('mousemove', (e) => {
            this._panelMouse = { x: e.clientX, y: e.clientY };
            this.clearHoverMirror(content);
        });
        content.addEventListener('mouseleave', () => {
            this._panelMouse = null;
            this.clearHoverMirror(content);
        });
    },

    clearHoverMirror(content) {
        content.querySelectorAll('.ui-hover').forEach((el) => el.classList.remove('ui-hover'));
    },

    /** 面板重建后，把悬停样式镜像到鼠标当前所在的可悬停元素及其容器 */
    restorePanelHover(content) {
        if (!this._panelMouse || typeof document.elementFromPoint !== 'function') return;
        const el = document.elementFromPoint(this._panelMouse.x, this._panelMouse.y);
        if (!el || !content.contains(el)) return;
        let node = el;
        while (node && node !== content) {
            if (this.PANEL_HOVER_SELECTORS.some((sel) => node.matches(sel))) {
                node.classList.add('ui-hover');
            }
            node = node.parentElement;
        }
    },

    // ===================== 顶部栏 =====================
    updateTopBar() {
        const c = this.game.playerCountry();
        if (!c) return;
        const ideo = IDEOLOGY[c.ideology] || { icon: '○', name: '中立' };
        document.getElementById('countryTag').style.background = c.color;
        document.getElementById('countryTag').textContent = c.tag;
        document.getElementById('countryName').textContent = `${c.flag} ${this.tt(c.name)} · ${ideo.icon} ${ideo.name}`;
        document.getElementById('dateText').textContent = this.game.formatDate();

        // 暂停提示：速度为 0 时提醒玩家手动推进
        document.getElementById('pauseHint').classList.toggle('hidden', this.game.speed > 0);

        // 速度按钮高亮与实际速度同步（AI 模式、事件恢复等程序内改速也要跟上）
        document.querySelectorAll('.speed-btn').forEach(btn => {
            btn.classList.toggle('active', Number(btn.dataset.speed) === this.game.speed);
        });
    },

    // ===================== 底部状态条 =====================
    // 紧凑显示「图标 + 简称 + 数值」，悬停浮出全称；
    // 数值没变时跳过重建，避免 400ms 刷新打断悬停气泡。
    updateStatsBar() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const resBox = document.getElementById('statResources');
        if (!c || !resBox) return;

        const item = (icon, short, full, value, cls = '') => `<div class="stat-item">
            <span class="stat-label">${icon} ${short}</span>
            <span class="stat-value ${cls}">${value}</span>
            <span class="stat-tip">${full}</span>
        </div>`;

        // 资源（战役状态持有量）——只显示单字简称
        const shortRes = { steel: '钢', oil: '油', rubber: '胶', aluminium: '铝', munitions: '弹', supplies: '补' };
        const topRes = ['steel', 'oil', 'rubber', 'aluminium', 'munitions', 'supplies'];
        const resHtml = topRes.map(r => {
            const def = RESOURCES[r];
            return item(def.icon, shortRes[r], def.name, Math.round(c.resources?.[r] || 0));
        }).join('');

        // 人力 / 战争支持 / 稳定度
        const warSupport = Math.round(this.fp(c.warSupport) * 100);
        const stability = Math.round(this.fp(c.stability) * 100);
        const mpHtml = [
            item('⊕', '人', '人力', Math.round(c.manpower)),
            item('▲', '战支', '战争支持', `${warSupport}%`, warSupport > 50 ? 'pos' : 'warn'),
            item('◆', '稳定', '稳定度', `${stability}%`, stability > 50 ? 'pos' : 'warn'),
        ].join('');

        // 工业
        const indHtml = [
            item('⬢', '民工', '民用工厂', c.civs),
            item('⡡', '军工', '军用工厂', c.mils),
            item('⚓', '船坞', '船坞', c.docks),
        ].join('');

        // 军事（可指挥部队 / 空军 / 舰队 / 总兵力）
        const myArmies = this.game.armiesOf(tag);
        const myAir = this.game.airForcesOf(tag);
        const myFleets = this.game.fleetsOf(tag);
        const totalStrength = Math.round(myArmies.reduce((sum, a) => sum + (a.strength || 0), 0));
        const war = this.game.isWarFor(tag);
        const wars = this.game.warsOf(tag).length;
        const milHtml = [
            item('⚔', '部队', '可指挥部队', myArmies.length),
            item('✈', '空军', '空军', myAir.length),
            item('⚓', '舰队', '舰队', myFleets.length),
            item('▮', '兵力', '总兵力', totalStrength),
            item(war ? '●' : '○', war ? '战争中' : '和平', '战争状态',
                war ? `${wars} 场` : '否', war ? 'neg' : 'pos'),
        ].join('');

        const signature = `${tag}|${resHtml}|${mpHtml}|${indHtml}|${milHtml}`;
        if (signature === this._statBarHtml) return;
        this._statBarHtml = signature;

        resBox.innerHTML = resHtml;
        document.getElementById('statManpower').innerHTML = mpHtml;
        document.getElementById('statIndustry').innerHTML = indHtml;
        document.getElementById('statMilitary').innerHTML = milHtml;
    },

    bindMapTools() {
        const btns = document.querySelectorAll('.tool-btn');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool || 'move';
                btns.forEach(b => b.classList.toggle('active', b === btn));
                this.game.tool = tool;
                // MapView 才是真正读取 tool 的渲染方
                if (typeof MapView !== 'undefined' && MapView.setTool) MapView.setTool(tool);
                this.updateMapLegend();
            });
        });
        this.updateMapLegend();
    },

    /** 地图视图图例：非默认视图时替换左下角的操作提示 */
    updateMapLegend() {
        const el = document.getElementById('mapLegend');
        if (!el) return;
        const tool = (typeof MapView !== 'undefined' && MapView.tool)
            || (this.game && this.game.tool) || 'move';
        let html = '';
        if (tool === 'front') {
            html = `<span class="lg-item"><i class="lg-dot" style="background:#f97316"></i>本国边境</span>
                <span class="lg-item"><i class="lg-dot" style="background:#c0392b"></i>交战前线（开战后）</span>`;
        } else if (tool === 'terrain') {
            const legend = (typeof MapView !== 'undefined' && MapView.terrainLegend)
                ? MapView.terrainLegend() : [];
            html = legend.map(x =>
                `<span class="lg-item"><i class="lg-dot" style="background:${x.color}"></i>${x.label}</span>`
            ).join('');
        } else if (tool === 'province') {
            html = '<span class="lg-item">省界 · 放大后显示省名</span>';
        }
        el.innerHTML = html;
        el.classList.toggle('hidden', !html);
        const hint = document.querySelector('.map-hint');
        if (hint) hint.classList.toggle('hidden', !!html);
    },

    bindTopBar() {
        document.querySelectorAll('.speed-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.game.speed = parseInt(btn.dataset.speed);
            });
        });
        document.getElementById('btnMenu').addEventListener('click', () => {
            this.showModal('游戏菜单', this.renderMenuBody(), [
                { text: '继续游戏', cls: 'primary', action: () => this.closeModal() },
                { text: '保存游戏', action: () => { this.game.save(); this.closeModal(); } },
                { text: '返回主菜单', action: () => {
                    this.game.save();
                    this.closeModal();
                    App.returnToMenu();
                }},
            ]);
        });
    },

    bindModal() {
        document.getElementById('modalButtons').addEventListener('click', (e) => {
            const btn = e.target.closest('.modal-btn');
            if (btn && btn._action) btn._action();
        });
    },

    renderMenuBody() {
        const c = this.game.playerCountry();
        return `<p>当前国家：<b>${c.flag} ${this.tt(c.name)}</b></p>
                <p>日期：${this.game.formatDate()}</p>
                <p>速度：${this.game.speed} 级</p>
                <p style="margin-top:10px;color:var(--text-dim)">点击保存可保留当前进度到本地。</p>`;
    },

    // ===================== 面板渲染 =====================
    renderPanel(panel) {
        const content = document.getElementById('panelContent');
        let html = '';
        switch (panel) {
            case 'overview': html = this.renderOverview(); break;
            case 'politics': html = this.renderPolitics(); break;
            case 'economy': html = this.renderEconomy(); break;
            case 'production': html = this.renderProduction(); break;
            case 'army': html = this.renderArmy(); break;
            case 'tech': html = this.renderTech(); break;
            case 'diplomacy': html = this.renderDiplomacy(); break;
            case 'war': html = this.renderWar(); break;
            case 'intelligence': html = this.renderIntelligence(); break;
            case 'notices': html = this.renderNotices(); break;
            case 'log': html = this.renderLog(); break;
        }
        content.innerHTML = html;
        this.bindPanelActions(panel);
        this.restorePanelHover(content);
    },

    // ----- 总览 -----
    renderOverview() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const provinces = this.game.provincesOf(tag);
        const ideo = IDEOLOGY[c.ideology] || { icon: '○', name: '中立' };
        const war = this.game.isWarFor(tag);
        const missions = this.game.state.missions[tag] || [];
        return `
        <div class="panel-section">
            <h4>国家总览</h4>
            <div class="panel-row"><span class="pr-label">国家</span><span class="pr-value">${c.flag} ${this.tt(c.name)}</span></div>
            <div class="panel-row"><span class="pr-label">意识形态</span><span class="pr-value">${ideo.icon} ${ideo.name}</span></div>
            <div class="panel-row"><span class="pr-label">日期</span><span class="pr-value">${this.game.formatDate()}</span></div>
            <div class="panel-row"><span class="pr-label">省份数</span><span class="pr-value">${provinces.length}</span></div>
            <div class="panel-row"><span class="pr-label">政治点数</span><span class="pr-value">${c.politicalPower}</span></div>
            <div class="panel-row"><span class="pr-label">战争状态</span><span class="pr-value ${war ? 'neg' : 'pos'}">${war ? '● 交战中' : '○ 和平'}</span></div>
        </div>
        <div class="panel-section">
            <h4>工业</h4>
            <div class="panel-row"><span class="pr-label">民用工厂</span><span class="pr-value">${c.civs}</span></div>
            <div class="panel-row"><span class="pr-label">军用工厂</span><span class="pr-value">${c.mils}</span></div>
            <div class="panel-row"><span class="pr-label">船坞</span><span class="pr-value">${c.docks}</span></div>
            <div class="panel-row"><span class="pr-label">人力</span><span class="pr-value">${Math.round(c.manpower)}</span></div>
        </div>
        <div class="panel-section">
            <h4>任务</h4>
            ${missions.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">无任务</div>' :
                missions.map(m => `
                    <div class="panel-row">
                        <span class="pr-label">${this.tt('mission.' + m.id, { id: m.id })}</span>
                        <span class="pr-value ${m.status === 'completed' ? 'pos' : (m.status === 'failed' ? 'neg' : '')}">${m.status}</span>
                    </div>`).join('')}
        </div>
        <div class="panel-section">
            <h4>领土</h4>
            <div style="font-size:12px;color:var(--text-dim);line-height:1.8">
                ${provinces.map(p => `<div class="panel-row"><span class="pr-label">${p.name}</span><span class="pr-value">${(TERRAIN[p.terrain] || { name: p.terrain }).name}</span></div>`).join('')}
            </div>
        </div>`;
    },

    // ----- 政治 -----
    renderPolitics() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const focuses = this.game.availableFocuses(tag);
        const decisions = this.game.availableDecisions(tag);
        const activeFocus = c.activeFocus;
        let activeHtml = '';
        if (activeFocus && this.game.campaign.content.focusTrees[c.focusTree]) {
            const node = this.game.campaign.content.focusTrees[c.focusTree].nodes[activeFocus.id];
            const pct = Math.min(100, (activeFocus.progress / activeFocus.totalTicks) * 100);
            activeHtml = `
            <div class="panel-section">
                <h4>进行中的国策</h4>
                <div class="panel-row"><span class="pr-label">${node ? this.tt(node.name) : activeFocus.id}</span>
                    <span class="pr-value">${Math.round(pct)}%</span></div>
                <div class="panel-bar"><div class="panel-bar-fill" style="width:${pct}%;background:var(--orange)"></div></div>
                <button class="btn-action" data-focus-cancel>取消国策</button>
            </div>`;
        }
        return `
        <div class="panel-section">
            <h4>政治状态</h4>
            <div class="panel-row"><span class="pr-label">政治点数</span><span class="pr-value">${c.politicalPower}</span></div>
            <div class="panel-row"><span class="pr-label">稳定度</span><span class="pr-value">${Math.round(this.fp(c.stability) * 100)}%</span></div>
            <div class="panel-bar"><div class="panel-bar-fill" style="width:${Math.round(this.fp(c.stability) * 100)}%;background:var(--green)"></div></div>
            <div class="panel-row"><span class="pr-label">战争支持</span><span class="pr-value">${Math.round(this.fp(c.warSupport) * 100)}%</span></div>
            <div class="panel-bar"><div class="panel-bar-fill" style="width:${Math.round(this.fp(c.warSupport) * 100)}%;background:var(--orange)"></div></div>
            <div class="panel-row"><span class="pr-label">合法性</span><span class="pr-value">${Math.round(this.fp(c.legitimacy) * 100)}%</span></div>
        </div>
        ${activeHtml}
        <div class="panel-section">
            <h4>国策树</h4>
            ${focuses.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">暂无可选国策（前置未满足或已完成）</div>' :
                focuses.map(f => `
                    <div class="focus-card ${f.available ? 'available' : 'locked'}">
                        <div style="font-weight:600">${this.tt(f.node.name)}</div>
                        <div style="font-size:11px;color:var(--text-dim);margin-top:3px">${this.tt(f.node.desc)}</div>
                        <div style="font-size:11px;margin-top:3px">成本 ${f.node.cost} PP · ${f.node.days} 天</div>
                        ${f.available ? `<button class="btn-action" data-focus-choose="${f.id}">选择国策</button>` : '<div style="font-size:11px;color:var(--text-dim)">前置未满足</div>'}
                    </div>`).join('')}
        </div>
        <div class="panel-section">
            <h4>决议</h4>
            ${decisions.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">暂无可用决议</div>' :
                decisions.map(d => {
                    const dec = d.decision;
                    // canCommand 约定：可执行返回 null，不可执行返回 { ok:false, err }
                    // 返回非 null 时按钮应禁用
                    const blocked = this.game.canCommand({ t: 'executeDecision', country: tag, decisionId: d.id });
                    return `<div class="focus-card">
                        <div style="font-weight:600">${this.tt('decision.' + d.id)}</div>
                        <div style="font-size:11px;color:var(--text-dim);margin-top:3px">${this.tt('decision.' + d.id + '.desc')}</div>
                        <div style="font-size:11px">成本 ${dec.cost?.politicalPower || 0} PP</div>
                        <button class="btn-action" data-decision="${d.id}" ${blocked ? 'disabled' : ''}>执行决议</button>
                    </div>`;
                }).join('')}
        </div>`;
    },

    // ----- 经济 -----
    renderEconomy() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const eco = window.Core.economyOf(this.game.campaign.scenario);
        const cap = window.Core.capacityOf(c, eco);
        const resBonus = c.bonuses?.resource || {};
        const CONSTRUCTION = window.Core.CONSTRUCTION || {};
        return `
        <div class="panel-section">
            <h4>产能</h4>
            <div class="panel-row"><span class="pr-label">民用工厂</span><span class="pr-value">${c.civs}</span></div>
            <div class="panel-row"><span class="pr-label">军用工厂</span><span class="pr-value">${c.mils}</span></div>
            <div class="panel-row"><span class="pr-label">船坞</span><span class="pr-value">${c.docks}</span></div>
            <div class="panel-row"><span class="pr-label">人力 / 人口</span>
                <span class="pr-value">${Math.round(c.manpower)} / ${Math.round(c.population)}</span></div>
            <div class="panel-row"><span class="pr-label">综合产能</span>
                <span class="pr-value ${cap >= 1 ? 'pos' : ''}">${Math.round(cap * 100)}%</span></div>
            <div class="panel-bar"><div class="panel-bar-fill" style="width:${Math.min(100, cap * 100)}%;background:var(--green)"></div></div>
        </div>
        <div class="panel-section">
            <h4>资源持有</h4>
            ${Object.entries(c.resources || {}).map(([k, v]) => {
                const def = RESOURCES[k];
                const base = eco.income[k];
                const up = base !== undefined ? `<span style="color:var(--text-dim);font-size:11px">+${(base * cap * (1 + (resBonus[k] || 0))).toFixed(2)}/日</span>` : '';
                return `<div class="panel-row">
                    <span class="pr-label">${def ? def.icon + ' ' + def.name : k}</span>
                    <span class="pr-value">${Math.round(v)} ${up}</span>
                </div>`;
            }).join('') || '<div style="font-size:12px;color:var(--text-dim)">无资源</div>'}
        </div>
        <div class="panel-section">
            <h4>装备库存</h4>
            ${Object.entries(c.equipment || {}).filter(([, v]) => v > 0).map(([k, v]) => {
                const def = this.game.equipment[k];
                return `<div class="panel-row">
                    <span class="pr-label">${def ? def.icon + ' ' + def.name : k}</span>
                    <span class="pr-value">${Math.round(v)}</span>
                </div>`;
            }).join('') || '<div style="font-size:12px;color:var(--text-dim)">无库存（需通过生产线生产）</div>'}
        </div>
        <div class="panel-section">
            <h4>建设队列</h4>
            ${(c.construction || []).length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">无建造项目</div>' :
                (c.construction || []).map((b, i) => {
                    const target = b.province ? this.game.provinceById(b.province)?.name
                        : b.state ? `州 ${b.state}` : '国家';
                    return `
                    <div class="prod-row">
                        <span class="prod-icon">⬢</span>
                        <span class="prod-name">${CONSTRUCTION[b.kind]?.name || b.kind}
                            <span style="color:var(--text-dim);font-size:11px">· ${target} · ${Math.round(b.progress || 0)}%</span></span>
                        <button class="btn-action" data-construction-cancel="${i}" style="padding:2px 8px;margin:0">✕</button>
                    </div>
                    <div class="panel-bar"><div class="panel-bar-fill" style="width:${Math.min(100, b.progress || 0)}%;background:var(--orange)"></div></div>
                `;
                }).join('')}
        </div>`;
    },

    // ----- 生产 -----
    renderProduction() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const equipment = this.game.equipment;
        const queue = c.production || [];
        const usedMils = queue.reduce((sum, l) => sum + (l.factories || 1), 0);
        return `
        <div class="panel-section">
            <h4>生产线 (${queue.length})</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">
                军用工厂 ${c.mils} · 已分配 ${usedMils} · 每条产线按「分配工厂数 ÷ 装备成本」每日产出
            </div>
            ${queue.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">未分配生产线。</div>' : ''}
            ${queue.map((item, i) => {
                const eq = equipment[item.equipment];
                const canDown = (item.factories || 1) > 1;
                const canUp = (item.factories || 1) < (c.mils || 0);
                const produced = Math.floor(item.produced || 0);
                const frac = (item.progress || 0);
                return `<div class="prod-row ${item.disabled ? 'disabled' : ''}">
                    <span class="prod-icon">${eq ? eq.icon : '▢'}</span>
                    <span class="prod-name">${eq ? eq.name : item.equipment}
                        <span style="color:var(--text-dim);font-size:11px">· ${item.factories || 1} 厂
                            · 已生产 ${produced}${frac > 0 ? `（进行中 ${frac.toFixed(2)}）` : ''}</span></span>
                    <button class="btn-action" data-prod-adj="${i}" data-delta="-1" ${canDown ? '' : 'disabled'}>−</button>
                    <button class="btn-action" data-prod-adj="${i}" data-delta="1" ${canUp ? '' : 'disabled'}>+</button>
                    <button class="btn-action" data-prod-toggle="${i}" title="暂停 / 恢复该产线">
                        ${item.disabled ? '启用' : '暂停'}</button>
                    <button class="btn-action" data-prod-remove="${i}" style="padding:2px 8px;margin:0">✕</button>
                </div>
                ${item.disabled ? '' : `<div class="panel-bar"><div class="panel-bar-fill"
                    style="width:${Math.min(100, (item.progress || 0) * 20)}%;background:var(--green)"></div></div>`}
                `;
            }).join('')}
        </div>
        <div class="panel-section">
            <h4>分配生产线</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">
                点击为队列追加一条产线（每条默认 1 个军用工厂）
            </div>
            ${Object.entries(equipment).map(([k, eq]) => `
                <button class="btn-action" data-prod-add="${k}">${eq.icon} ${eq.name}
                    <span style="color:var(--text-dim);font-size:11px">· ${eq.cost} 天/件</span></button>
            `).join('')}
        </div>`;
    },

    // ----- 部队 -----
    renderArmy() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const divisions = this.game.divisions;
        const armies = this.game.armiesOf(tag);
        const templates = this.game.availableTemplates(tag);
        const owned = this.game.provincesOf(tag);
        const target = this.resolveDeployTarget(tag);
        const targetProv = target != null ? this.game.provinceById(target) : null;
        const targetArmies = target != null ? this.game.armiesIn(target).length : 0;
        const selectedArmy = this.game.selectedArmy != null
            ? this.game.armyById(this.game.selectedArmy) : null;

        const targetOptions = owned.map((p) => {
            const n = this.game.armiesIn(p.id).length;
            return `<option value="${p.id}" ${p.id === target ? 'selected' : ''}>${p.name}${n ? `（${n} 支部队）` : ''}</option>`;
        }).join('');

        return `
        <div class="panel-section">
            <h4>部署部队</h4>
            <div class="deploy-target">
                <label>目标省份</label>
                ${owned.length === 0
                    ? '<span style="color:var(--red)">尚无可部署省份</span>'
                    : `<select id="armyDeployTarget" class="ui-select" data-deploy-target>
                           ${targetOptions}
                       </select>`}
            </div>
            <div class="deploy-meta">${targetProv
                ? `${targetProv.name} · 我军控制 · 现有部队 ${targetArmies}`
                : '无可部署省份'} · 人力 ${Math.round(c.manpower)} · 补给 ${Math.round(c.resources.supplies || 0)}</div>
            ${templates.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">未解锁任何部队模板，需先研究对应科技。</div>' :
                templates.map((tplId) => {
                    const tpl = divisions[tplId];
                    const cost = this.game.divisionCost(tplId);
                    const one = this.game.canCommand({ t: 'deployArmy', country: tag, province: target, template: tplId, count: 1 });
                    const five = this.game.canCommand({ t: 'deployArmy', country: tag, province: target, template: tplId, count: 5 });
                    return `<div class="focus-card deploy-card">
                        <div class="dc-head">
                            <span>${tpl.icon} ${tpl.name}</span>
                            <span class="dc-cost">人力 ${cost.manpower} · ${Object.entries(cost.equipment).map(([k, v]) =>
                                `${this.game.equipment[k]?.name || k}×${v}`).join('、') || '无装备消耗'}</span>
                        </div>
                        <div class="dc-actions">
                            <button class="btn-action" data-deploy="${tplId}" data-deploy-count="1" ${one ? 'disabled' : ''}>部署 1 支</button>
                            <button class="btn-action" data-deploy="${tplId}" data-deploy-count="5" ${five ? 'disabled' : ''}>部署 5 支</button>
                        </div>
                    </div>`;
                }).join('')}
        </div>
        <div class="panel-section">
            <h4>部队（${armies.length}）</h4>
            ${selectedArmy ? `<div class="army-selected-hint">
                <span>已选中 ${divisions[selectedArmy.template]?.name || selectedArmy.template}：
                    点击地图上相邻省份即可移动，右键 / Esc 取消。</span>
                <button class="btn-action" data-clear-army="1">取消选择</button>
            </div>
            <div class="order-row">
                <span class="or-label">指令</span>
                <button class="btn-action" data-order="hold" ${selectedArmy.order === 'hold' ? 'disabled' : ''}>待机</button>
                <button class="btn-action" data-order="advance" ${selectedArmy.order === 'advance' ? 'disabled' : ''}>进攻</button>
                <button class="btn-action" data-order="retreat" ${selectedArmy.order === 'retreat' ? 'disabled' : ''}>撤退</button>
                <button class="btn-action" data-advance-one="1">向敌方推进一格</button>
            </div>` : ''}
            ${armies.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">尚无部队，先在上方部署。</div>' :
                armies.map((a) => this.renderArmyCard(a, divisions, selectedArmy)).join('')}
        </div>
        ${this.renderAirSection(tag)}
        ${this.renderFleetSection(tag)}`;
    },

    /** 空军区块：部署 + 编制列表（可移动、可解散） */
    renderAirSection(tag) {
        const aircraft = this.game.aircraft;
        const groups = this.game.airForcesOf(tag);
        const target = this.resolveDeployTarget(tag);
        const templates = this.game.availableAir(tag);
        return `
        <div class="panel-section">
            <h4>空军（${groups.length} 群）</h4>
            <div class="deploy-meta">部署目标：${target != null ? (this.game.provinceById(target)?.name || target) : '无可用省份'}
                · 飞机总量 ${Math.round(groups.reduce((s, g) => s + g.planes, 0))} 架</div>
            ${templates.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">未解锁任何飞机型号，需先研究对应科技。</div>' :
                templates.map((tplId) => {
                    const tpl = aircraft[tplId];
                    const cost = this.game.aircraftCost(tplId);
                    const blocked = this.game.canCommand({
                        t: 'deployAirForce', country: tag, province: target, template: tplId, count: 1,
                    });
                    return `<div class="focus-card deploy-card">
                        <div class="dc-head">
                            <span>${tpl.icon} ${tpl.name}</span>
                            <span class="dc-cost">${tpl.planes} 架/群 · ${Object.entries(cost.equipment).map(([k, v]) =>
                                `${this.game.equipment[k]?.name || k}×${v * tpl.planes}`).join('、') || '无装备消耗'}</span>
                        </div>
                        <div class="dc-actions">
                            <button class="btn-action" data-deploy-air="${tplId}" ${blocked ? 'disabled' : ''}>部署 1 群</button>
                        </div>
                    </div>`;
                }).join('')}
            ${groups.length === 0 ? '' : groups.map((g) => this.renderAirCard(g)).join('')}
        </div>`;
    },

    /** 舰队区块：只能在沿海省份部署 */
    renderFleetSection(tag) {
        const ships = this.game.ships;
        const fleets = this.game.fleetsOf(tag);
        const coastal = this.game.provincesOf(tag).filter((p) => p.coastal);
        const target = this.resolveFleetTarget(tag);
        const templates = this.game.availableShips(tag);
        return `
        <div class="panel-section">
            <h4>海军（${fleets.length} 支）</h4>
            <div class="deploy-meta">部署目标：${target != null ? (this.game.provinceById(target)?.name || target) : '无可用沿海省份'}
                · 舰船总量 ${Math.round(fleets.reduce((s, f) => s + f.ships, 0))} 艘
                ${coastal.length ? `· 沿海省份 ${coastal.length} 个` : ''}</div>
            ${coastal.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">没有控制的沿海省份，无法部署舰队。</div>' :
                templates.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">未解锁任何舰种，需先研究对应科技。</div>' :
                templates.map((tplId) => {
                    const tpl = ships[tplId];
                    const cost = this.game.shipCost(tplId);
                    const blocked = this.game.canCommand({
                        t: 'deployFleet', country: tag, province: target, template: tplId, count: 1,
                    });
                    return `<div class="focus-card deploy-card">
                        <div class="dc-head">
                            <span>${tpl.icon} ${tpl.name}</span>
                            <span class="dc-cost">${tpl.ships} 艘/支 · ${Object.entries(cost.equipment).map(([k, v]) =>
                                `${this.game.equipment[k]?.name || k}×${v * tpl.ships}`).join('、') || '无装备消耗'}</span>
                        </div>
                        <div class="dc-actions">
                            <button class="btn-action" data-deploy-fleet="${tplId}" ${blocked ? 'disabled' : ''}>部署 1 支</button>
                        </div>
                    </div>`;
                }).join('')}
            ${fleets.length === 0 ? '' : fleets.map((f) => this.renderFleetCard(f)).join('')}
        </div>`;
    },

    /** 空军群卡片 */
    renderAirCard(g) {
        const tpl = this.game.aircraft[g.template];
        const prov = this.game.provinceById(g.provinceId);
        const opts = this.game.moveOptionsFor(g.id, 'air');
        const legal = opts.filter((o) => o.ok);
        const isSel = this.game.selectedAir === g.id;
        return `<div class="army-card${isSel ? ' selected' : ''}">
            <div class="ac-head">
                <span class="ac-name">${tpl ? tpl.icon + ' ' + tpl.name : g.template}</span>
                <span class="ac-prov">${prov ? prov.name : g.provinceId}</span>
            </div>
            <div class="ac-strength">飞机 ${Math.round(g.planes)} 架</div>
            <div class="ac-actions">
                <button class="btn-action" data-select-air="${g.id}">${isSel ? '已选中' : '地图选中'}</button>
                <button class="btn-action" data-focus-air="${g.id}">定位</button>
                <button class="btn-action" data-disband-air="${g.id}">解散</button>
            </div>
            ${legal.length === 0 ? '<div class="ac-move-note">无可移动的相邻省份</div>' : `
                <div class="ac-move">
                    <select class="ui-select" data-move-select="${g.id}" data-kind="air">
                        <option value="">移动至相邻省份…</option>
                        ${opts.map((o) => `<option value="${o.id}" ${o.ok ? '' : 'disabled'}>${o.name}${o.ok ? '' : `（${o.err || '不可移动'}）`}</option>`).join('')}
                    </select>
                    <button class="btn-action" data-move-unit="${g.id}" data-kind="air">移动</button>
                </div>`}
        </div>`;
    },

    /** 舰队卡片 */
    renderFleetCard(f) {
        const tpl = this.game.ships[f.template];
        const prov = this.game.provinceById(f.provinceId);
        const opts = this.game.moveOptionsFor(f.id, 'fleet');
        const legal = opts.filter((o) => o.ok);
        const isSel = this.game.selectedFleet === f.id;
        return `<div class="army-card${isSel ? ' selected' : ''}">
            <div class="ac-head">
                <span class="ac-name">${tpl ? tpl.icon + ' ' + tpl.name : f.template}</span>
                <span class="ac-prov">${prov ? prov.name : f.provinceId}</span>
            </div>
            <div class="ac-strength">舰船 ${Math.round(f.ships)} 艘</div>
            <div class="ac-actions">
                <button class="btn-action" data-select-fleet="${f.id}">${isSel ? '已选中' : '地图选中'}</button>
                <button class="btn-action" data-focus-fleet="${f.id}">定位</button>
                <button class="btn-action" data-disband-fleet="${f.id}">解散</button>
            </div>
            ${legal.length === 0 ? '<div class="ac-move-note">无可移动的相邻省份</div>' : `
                <div class="ac-move">
                    <select class="ui-select" data-move-select="${f.id}" data-kind="fleet">
                        <option value="">移动至相邻省份…</option>
                        ${opts.map((o) => `<option value="${o.id}" ${o.ok ? '' : 'disabled'}>${o.name}${o.ok ? '' : `（${o.err || '不可移动'}）`}</option>`).join('')}
                    </select>
                    <button class="btn-action" data-move-unit="${f.id}" data-kind="fleet">移动</button>
                </div>`}
        </div>`;
    },

    /** 舰队部署目标：优先当前选中省份（须沿海），否则首个控制的沿海省份 */
    resolveFleetTarget(tag) {
        const mine = this.game.provincesOf(tag).filter((p) => p.coastal);
        if (mine.length === 0) return null;
        const sel = this.game.selectedProvince;
        if (sel != null && mine.some((p) => p.id === sel)) return sel;
        return mine[0].id;
    },

    /** 单支部队卡片：查看状态、地图选中、定位、快捷移动、解散 */
    renderArmyCard(a, divisions, selectedArmy) {
        const tpl = divisions[a.template];
        const prov = this.game.provinceById(a.provinceId);
        const opts = this.game.moveOptionsFor(a.id);
        const legal = opts.filter((o) => o.ok);
        const isSel = !!selectedArmy && selectedArmy.id === a.id;
        const inSelectedProv = this.game.selectedProvince === a.provinceId;
        return `<div class="army-card${isSel ? ' selected' : ''}">
            <div class="ac-head">
                <span class="ac-name">${tpl ? tpl.icon + ' ' + tpl.name : a.template}</span>
                <span class="ac-prov">${prov ? prov.name : a.provinceId}${inSelectedProv ? ' · 当前选中省份' : ''}</span>
            </div>
            <div class="ac-strength">兵力 ${Math.round(a.strength)} · 组织度 ${Math.round(a.org * 100)}% · 速度 ${a.speed}
                ${a.order && a.order !== 'hold' ? ` · 指令：${a.order === 'advance' ? '进攻' : '撤退'}` : ''}
                ${this.game.supplyFactor(a.provinceId) === null ? '' :
                    ` · 补给 ${Math.round(this.game.supplyFactor(a.provinceId) * 100)}%`}</div>
            <div class="ac-actions">
                <button class="btn-action" data-select-army="${a.id}">${isSel ? '已选中' : '地图选中'}</button>
                <button class="btn-action" data-focus-army="${a.id}">定位</button>
                <button class="btn-action" data-disband="${a.id}">解散</button>
            </div>
            ${legal.length === 0 ? '<div class="ac-move-note">无可移动的相邻省份</div>' : `
                <div class="ac-move">
                    <select class="ui-select" data-move-select="${a.id}">
                        <option value="">移动至相邻省份…</option>
                        ${opts.map((o) => `<option value="${o.id}" ${o.ok ? '' : 'disabled'}>${o.name}${o.ok ? '' : `（${o.err || '不可移动'}）`}</option>`).join('')}
                    </select>
                    <button class="btn-action" data-move-army="${a.id}">移动</button>
                </div>`}
        </div>`;
    },

    // ----- 科技 -----
    renderTech() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const r = this.game.state.research[tag];
        const techs = this.game.techs;
        const done = c.tech || {};
        const busy = new Set(r.researching.map((x) => x.techId));
        const slotsFree = (c.researchSlots || 0) - r.researching.length;

        const rows = Object.entries(techs).map(([id, t]) => {
            const isDone = !!done[id];
            const isBusy = busy.has(id);
            const prereqOk = (t.requires || []).every((pre) => done[pre]);
            return { id, tech: t, done: isDone, busy: isBusy, prereqOk, locked: !prereqOk };
        });
        // 可研究优先，其次按类别与耗时排序
        const catRank = { army: 0, industry: 1, navy: 2, air: 3, support: 4 };
        rows.sort((a, b) => {
            const av = a.done ? 2 : (a.busy ? 1 : (a.prereqOk ? 0 : 3));
            const bv = b.done ? 2 : (b.busy ? 1 : (b.prereqOk ? 0 : 3));
            if (av !== bv) return av - bv;
            return (catRank[a.tech.cat] ?? 9) - (catRank[b.tech.cat] ?? 9) || a.tech.time - b.tech.time;
        });

        return `
        <div class="panel-section">
            <h4>科研槽 (${r.researching.length}/${c.researchSlots})</h4>
            <div class="tech-slot">
                ${Array.from({ length: Math.max(c.researchSlots, 1) }).map((_, i) => {
                    const item = r.researching[i];
                    if (item) {
                        const tech = techs[item.techId] || { name: item.techId, time: 100 };
                        const pct = Math.min(100, (item.progress / (tech.time || 100)) * 100);
                        return `<div class="tech-slot-item filled" style="cursor:default">
                            <div style="font-weight:600">${tech.icon || '⚛'} ${tech.name}</div>
                            <div class="tc-progress" style="margin-top:4px"><div class="tc-progress-fill" style="width:${pct}%"></div></div>
                            <div style="margin-top:2px">${Math.round(pct)}% · 第 ${Math.round(item.progress)} 天</div>
                        </div>`;
                    }
                    return `<div class="tech-slot-item" data-tech-slot="${i}">+ 研究</div>`;
                }).join('')}
            </div>
        </div>
        <div class="panel-section">
            <h4>科技树（${rows.length} 项，可研究 ${rows.filter((x) => x.prereqOk && !x.done && !x.busy).length} 项）</h4>
            ${rows.map(({ id, tech, done: isDone, busy: isBusy, prereqOk }) => {
                const blocked = !isDone && !isBusy && prereqOk && slotsFree > 0 &&
                    this.game.canCommand({ t: 'startResearch', country: tag, techId: id });
                const missing = (tech.requires || []).filter((pre) => !done[pre]);
                return `<div class="tech-card ${isDone ? 'done' : (isBusy ? 'active' : (prereqOk ? '' : 'locked'))}">
                    <div class="tc-name">${tech.icon || '⚛'} ${tech.name}</div>
                    <div class="tc-cat">${tech.cat || ''} · ${tech.time} 天 ${isDone ? '✓ 已完成' : (isBusy ? '· 研究中' : '')}</div>
                    <div style="font-size:11px;color:var(--text-dim);margin-top:2px">${tech.effect || ''}</div>
                    ${!isDone && !isBusy ? `
                        ${!prereqOk ? `<div style="font-size:11px;color:var(--text-dim)">前置：${missing.join('、')}</div>` : ''}
                        <button class="btn-action" data-tech="${id}" ${blocked ? 'disabled' : ''}>开始研究</button>` : ''}
                </div>`;
            }).join('')}
        </div>`;
    },

    // ----- 外交 -----
    renderDiplomacy() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const others = Object.keys(this.game.state.countries).filter((t) => t !== tag);
        const wars = this.game.warsOf(tag);
        const myFaction = this.game.factionOf(tag);
        const fac = myFaction ? this.game.factionById(myFaction) : null;
        const isLeader = !!fac && this.game.factionLeader(myFaction) === tag;
        const invitesToMe = this.game.factionInvites().filter((i) => i.to === tag);
        const leaseTargets = others
            .filter((t) => (c.relations?.[t] || 0) >= 50 || this.game.factionOf(t) === myFaction)
            .sort((a, b) => (c.relations?.[b] || 0) - (c.relations?.[a] || 0))
            .slice(0, 8);

        return `
        <div class="panel-section">
            <h4>阵营</h4>
            ${!fac ? '<div style="font-size:12px;color:var(--text-dim)">未加入任何阵营</div>' : `
                <div class="panel-row"><span class="pr-label">阵营</span>
                    <span class="pr-value">${this.tt(fac.name) || fac.id} ${isLeader ? '（领袖）' : ''}</span></div>
                <div class="panel-row"><span class="pr-label">成员</span>
                    <span class="pr-value">${fac.members.map((m) => this.ownerLabel(m)).join('、')}</span></div>
                <div style="margin-top:6px">
                    ${isLeader ? `<button class="btn-action" data-invite-open="1">邀请国家加入阵营</button>` : ''}
                    <button class="btn-action" data-leave-faction="1">退出阵营</button>
                </div>`}
        </div>
        <div class="panel-section">
            <h4>阵营邀请</h4>
            ${invitesToMe.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">没有待处理的邀请</div>' :
                invitesToMe.map((i) => `
                    <div class="diplo-card">
                        <div class="dc-name">${this.ownerLabel(i.from)} 邀请你加入阵营 ${this.tt(i.faction) || i.faction}</div>
                        <div style="margin-top:6px">
                            <button class="btn-action" data-invite-accept="${i.id}">接受</button>
                            <button class="btn-action" data-invite-reject="${i.id}">拒绝</button>
                        </div>
                    </div>`).join('')}
        </div>
        <div class="panel-section">
            <h4>战争状态（${wars.length}）</h4>
            ${wars.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">无进行中的战争</div>' :
                wars.map(w => {
                    const side = (w.alliesA || [w.a]).includes(tag) ? 'a' : 'b';
                    const otherSide = side === 'a' ? (w.alliesB || [w.b]) : (w.alliesA || [w.a]);
                    const other = otherSide.find((t) => t !== tag) || otherSide[0];
                    // 敌方控制的州（可作为吞并目标）
                    const enemyStates = Object.values(this.game.state.states)
                        .filter((st) => st.owner === other && st.provinces.length > 0)
                        .slice(0, 6);
                    return `<div class="diplo-card">
                        <div class="dc-name">${this.ownerLabel(other)}</div>
                        <div class="dc-rel neg">${w.status === 'peacePending' ? '等待和谈回应' : '交战中'}
                            · 分数 ${Math.round(side === 'a' ? (w.scoreA || 0) : (w.scoreB || 0))}</div>
                        <div style="margin-top:6px">
                            <button class="btn-action" data-diplo="peace" data-target="${other}"
                                ${this.game.canCommand({ t: 'makePeace', from: tag, to: other }) ? 'disabled' : ''}>议和</button>
                        </div>
                        ${enemyStates.length ? `<div style="margin-top:6px;font-size:11px;color:var(--text-dim)">
                            可设为目标：${enemyStates.map((st) => `
                                <button class="btn-action mini" data-war-goal="${other}" data-state="${st.id}"
                                    style="margin:2px">吞并州 ${st.id}</button>`).join('')}
                        </div>` : ''}
                    </div>`;
                }).join('')}
        </div>
        <div class="panel-section">
            <h4>租借</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">
                向阵营盟友或关系 ≥ 50 的国家输送补给（每月每国 60，30 天冷却）
            </div>
            ${leaseTargets.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">没有可租借的对象</div>' :
                leaseTargets.map((t) => {
                    const used = this.game.lendLeaseOf(tag)[t]?.amount || 0;
                    const blocked = this.game.canCommand({ t: 'lendLease', country: tag, to: t, amount: 10, resource: 'supplies' });
                    return `<div class="diplo-card">
                        <div class="dc-name">${this.ownerLabel(t)}
                            <span style="color:var(--text-dim);font-size:11px">· 已借 ${used}</span></div>
                        <div style="margin-top:6px">
                            <button class="btn-action" data-lend="${t}" ${blocked ? 'disabled' : ''}>租借 10 补给</button>
                        </div>
                    </div>`;
                }).join('')}
        </div>
        <div class="panel-section">
            <h4>外交关系</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">点击国家可进行外交操作</div>
            ${others.map(oid => {
                const rel = c.relations?.[oid] || 0;
                const other = this.game.countryById(oid);
                const cls = rel > 30 ? 'pos' : (rel < -30 ? 'neg' : '');
                const blockWar = this.game.canCommand({ t: 'declareWar', from: tag, to: oid });
                const blockPeace = this.game.canCommand({ t: 'makePeace', from: tag, to: oid });
                const sameFaction = this.game.factionOf(oid) === myFaction && myFaction;
                return `<div class="diplo-card">
                    <div class="dc-name">${other.flag} ${this.tt(other.name)} ${other.faction ? '☥' : ''}</div>
                    <div class="dc-rel ${cls}">关系: ${Math.round(rel)} ${rel > 0 ? '↑' : '↓'}${sameFaction ? ' · 同阵营' : ''}</div>
                    <div style="margin-top:6px">
                        <button class="btn-action" data-diplo="war" data-target="${oid}" ${blockWar ? 'disabled' : ''}>宣战</button>
                        <button class="btn-action" data-diplo="peace" data-target="${oid}" ${blockPeace ? 'disabled' : ''}>议和</button>
                        <button class="btn-action" data-diplo="relation" data-target="${oid}">改善(+10)</button>
                    </div>
                </div>`;
            }).join('')}
        </div>`;
    },

    // ----- 战争进度 -----
    renderWar() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const wars = this.game.warsOf(tag);
        const PEACE_SCORE = window.Core.PEACE_SCORE || 100;
        const myArmies = this.game.armiesOf(tag);
        const myAir = this.game.airForcesOf(tag);
        const myFleets = this.game.fleetsOf(tag);
        const totalStrength = Math.round(myArmies.reduce((s, a) => s + (a.strength || 0), 0));

        // 交战省份：同一省份内存在多方部队
        const battled = new Map();
        for (const a of this.game.allArmies()) {
            if (a.strength <= 0) continue;
            if (!battled.has(a.provinceId)) battled.set(a.provinceId, new Set());
            battled.get(a.provinceId).add(a.owner);
        }
        const frontProvinces = [...battled.entries()]
            .filter(([, owners]) => owners.size > 1)
            .map(([pid]) => this.game.provinceById(pid))
            .filter(Boolean);

        // 补给被切断的部队
        const supply = this.game.supplyMap();
        const cutOff = myArmies.filter((a) => (supply.get(a.provinceId) ?? 1) <= 0).length;

        const scoreBar = (score) => {
            const pct = Math.min(100, (score / PEACE_SCORE) * 100);
            return `<div class="panel-bar"><div class="panel-bar-fill" style="width:${pct}%;background:var(--red)"></div></div>`;
        };

        return `
        <div class="panel-section">
            <h4>进行中的战争（${wars.length}）</h4>
            ${wars.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">当前没有进行中的战争</div>' :
                wars.map(w => {
                    const side = (w.alliesA || [w.a]).includes(tag) ? 'a' : 'b';
                    const score = side === 'a' ? (w.scoreA || 0) : (w.scoreB || 0);
                    const otherSide = side === 'a' ? (w.alliesB || [w.b]) : (w.alliesA || [w.a]);
                    const other = otherSide.find((t) => t !== tag) || otherSide[0];
                    const statusText = w.status === 'peacePending' ? '等待和谈回应' : '交战中';
                    return `<div class="diplo-card">
                        <div class="dc-name">${this.ownerLabel(other)} ${other !== tag ? '' : ''}</div>
                        <div class="dc-rel ${w.status === 'peacePending' ? 'warn' : 'neg'}">${statusText}
                            · 战争分数 ${Math.round(score)} / ${PEACE_SCORE}</div>
                        ${scoreBar(score)}
                        <div style="font-size:11px;color:var(--text-dim);margin-top:4px">
                            开始于 tick ${w.startedAt} · 阵营：${(w.alliesA || []).concat(w.alliesB || []).join('、')}
                        </div>
                        ${(w.goals || []).length ? `<div style="font-size:11px;margin-top:4px">目标：${
                            w.goals.map(g => g.type === 'annexState' ? `吞并州 ${g.state}`
                                : g.type === 'resources' ? `索取 ${g.amount} ${g.resource}` : g.type).join('、')
                        }</div>` : ''}
                        <div style="margin-top:6px">
                            <button class="btn-action" data-diplo="peace" data-target="${other}"
                                ${this.game.canCommand({ t: 'makePeace', from: tag, to: other }) ? 'disabled' : ''}>议和</button>
                        </div>
                    </div>`;
                }).join('')}
        </div>
        <div class="panel-section">
            <h4>我方军事力量</h4>
            <div class="panel-row"><span class="pr-label">陆军部队</span><span class="pr-value">${myArmies.length} 支 · 兵力 ${totalStrength}</span></div>
            <div class="panel-row"><span class="pr-label">空军群</span><span class="pr-value">${myAir.length} 群 · 飞机 ${Math.round(myAir.reduce((s, g) => s + g.planes, 0))} 架</span></div>
            <div class="panel-row"><span class="pr-label">舰队</span><span class="pr-value">${myFleets.length} 支 · 舰船 ${Math.round(myFleets.reduce((s, f) => s + f.ships, 0))} 艘</span></div>
            <div class="panel-row"><span class="pr-label">补给状态</span>
                <span class="pr-value ${cutOff ? 'warn' : 'pos'}">${cutOff ? `${cutOff} 支部队被切断补给` : '全部部队补给正常'}</span></div>
            <div class="panel-row"><span class="pr-label">人力 / 装备</span>
                <span class="pr-value">${Math.round(c.manpower)} / ${Object.keys(c.equipment || {}).length} 种</span></div>
        </div>
        <div class="panel-section">
            <h4>交战省份（${frontProvinces.length}）</h4>
            ${frontProvinces.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">没有多国部队交叠的省份</div>' :
                frontProvinces.slice(0, 40).map(p => `
                    <div class="panel-row">
                        <span class="pr-label">${p.name}</span>
                        <span class="pr-value">${this.ownerLabel(p.controller)}</span>
                    </div>`).join('')}
        </div>
        <div class="panel-section">
            <h4>待回应的和平提议</h4>
            ${this.game.peaceOffers().length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">没有待回应的和平提议</div>' :
                this.game.peaceOffers().map(o => `
                    <div class="diplo-card">
                        <div class="dc-name">来自 ${this.ownerLabel(o.from)} 的和平条件</div>
                        <div style="font-size:11px;margin:4px 0">${o.terms.map(t =>
                            t.type === 'annexState' ? `吞并州 ${t.state}`
                            : t.type === 'resources' ? `转让 ${t.amount} ${t.resource}` : '停战').join('、')}</div>
                        <div style="margin-top:6px">
                            <button class="btn-action" data-peace="accept" data-offer="${o.id}">接受</button>
                            <button class="btn-action" data-peace="reject" data-offer="${o.id}">拒绝</button>
                        </div>
                    </div>`).join('')}
        </div>`;
    },

    // ----- 通知中心 -----
    renderNotices() {
        const history = (this.game.state.history || []).slice().reverse();
        const filter = this._noticeFilter || 'all';
        const CATEGORIES = [
            { key: 'all', label: '全部' },
            { key: 'war', label: '战争' },
            { key: 'build', label: '建造' },
            { key: 'tech', label: '科技' },
            { key: 'diplo', label: '外交' },
        ];
        const classify = (text) => {
            if (/战斗|占领|宣战|投降|停战|和平|战争分数|制空|制海|空战|海战|轰炸/.test(text)) return 'war';
            if (/建造|完成建造/.test(text)) return 'build';
            if (/科技|科研/.test(text)) return 'tech';
            if (/阵营|租借|邀请|议和|归属变更/.test(text)) return 'diplo';
            return 'other';
        };
        const shown = history.filter((h) => filter === 'all' || classify(h.text) === filter);
        return `
        <div class="panel-section">
            <h4>通知筛选</h4>
            <div class="filter-row">
                ${CATEGORIES.map(c => `<button class="btn-action ${filter === c.key ? 'on' : ''}"
                    data-notice-filter="${c.key}">${c.label}</button>`).join('')}
            </div>
        </div>
        <div class="panel-section">
            <h4>播报（${shown.length}）</h4>
            ${shown.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">暂无通知</div>' :
                shown.slice(0, 80).map(h => `<div class="log-entry"><span class="le-date">${h.date}</span>${h.text}</div>`).join('')}
        </div>`;
    },

    // ----- 情报 / 省份详情 -----
    renderIntelligence() {
        const tag = this.game.playerTag;
        const myArmies = this.game.armiesOf(tag);
        const myAir = this.game.airForcesOf(tag);
        const myFleets = this.game.fleetsOf(tag);
        const selProv = this.game.selectedProvince ? this.game.provinceById(this.game.selectedProvince) : null;
        const supply = this.game.supplyMap();

        const unitRows = (list, kind) => list.map((u) => {
            const prov = this.game.provinceById(u.provinceId);
            const tpl = kind === 'air' ? this.game.aircraft[u.template] : kind === 'fleet' ? this.game.ships[u.template] : this.game.divisions[u.template];
            const label = kind === 'air' ? `${Math.round(u.planes)} 架`
                : kind === 'fleet' ? `${Math.round(u.ships)} 艘` : `兵力 ${Math.round(u.strength)}`;
            return `<div class="army-card">
                <div class="ac-name">${prov ? prov.name : u.provinceId}</div>
                <div class="ac-strength">${tpl ? tpl.name : u.template} · ${label}</div>
            </div>`;
        }).join('');

        return `
        <div class="panel-section">
            <h4>我方部队（${myArmies.length + myAir.length + myFleets.length}）</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">
                开局部队与后续部署的部队都可直接指挥；点击地图上的标记，或在「部队」面板中选择。
            </div>
            ${myArmies.length ? `<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">陆军</div>${unitRows(myArmies, 'army')}` : ''}
            ${myAir.length ? `<div style="font-size:11px;color:var(--text-dim);margin:6px 0 4px">空军</div>${unitRows(myAir, 'air')}` : ''}
            ${myFleets.length ? `<div style="font-size:11px;color:var(--text-dim);margin:6px 0 4px">海军</div>${unitRows(myFleets, 'fleet')}` : ''}
            ${(myArmies.length + myAir.length + myFleets.length) === 0 ? '<div style="font-size:12px;color:var(--text-dim)">无部队</div>' : ''}
        </div>
        <div class="panel-section">
            <h4>省份详情</h4>
            ${selProv ? this.renderProvinceDetail(selProv, supply) :
                '<div style="font-size:12px;color:var(--text-dim)">请在地图上选择一个省份</div>'}
        </div>`;
    },

    /** 省份详情：地形 / 供给 / 基建 / 驻军 / 建造一屏看完 */
    renderProvinceDetail(prov, supply) {
        const s = this.game.state;
        const st = this.game.stateOfProvince(prov.id);
        const terrainDef = window.Core.terrainDefense(prov.terrain, 'infantry', this.game.campaign.ctx(), s.countries[prov.controller]);
        const factor = this.game.supplyFactor(prov.id);
        const armies = this.game.armiesIn(prov.id).filter((a) => a.strength > 0);
        const air = this.game.airForcesIn(prov.id);
        const fleets = this.game.fleetsIn(prov.id);
        const row = (label, value, cls = '') =>
            `<div class="panel-row"><span class="pr-label">${label}</span><span class="pr-value ${cls}">${value}</span></div>`;

        return `
            ${row('省份', prov.name)}
            ${row('控制方', this.ownerLabel(prov.controller))}
            ${row('地形', `${(TERRAIN[prov.terrain] || { name: prov.terrain }).name}（防御 +${terrainDef.toFixed(2)}）`)}
            ${row('沿海', prov.coastal ? '是' : '否')}
            ${row('供给', `${prov.supply}${factor === null ? '' : ` · 补给系数 ${(factor * 100).toFixed(0)}%`}`,
                factor !== null && factor <= 0 ? 'warn' : '')}
            ${row('基建 / 要塞', `${prov.infrastructure} / ${prov.fortLevel || 0}`)}
            ${row('受损', prov.damage ? `${Math.round(prov.damage)}（补给折损 ${(window.Core.damageSupplyPenalty(prov.damage) * 100).toFixed(0)}%）` : '无')}
            ${st ? row('所属州', `${st.name || st.id}（${this.ownerLabel(st.owner)}）`) : ''}
            ${st ? row('人口 / 工厂', `${Math.round(st.population)} / ${st.factories}`) : ''}
            ${row('驻军', `${armies.length} 支${armies.length ? ` · 兵力 ${Math.round(armies.reduce((sum, a) => sum + a.strength, 0))}` : ''}`)}
            ${row('空军 / 舰队', `${air.length} 群 / ${fleets.length} 支`)}
            ${row('我方建造', this.game.state.countries[this.game.playerTag]?.construction?.filter((b) => b.province === prov.id).length || 0)}
            ${armies.length ? `<div style="margin-top:6px">${armies.map((a) => {
                const tpl = this.game.divisions[a.template];
                const mine = a.owner === this.game.playerTag;
                return `<div class="army-card${mine ? ' mine' : ''}">
                    <div class="ac-name">${tpl ? tpl.icon + ' ' + tpl.name : a.template}
                        <span style="color:var(--text-dim);font-weight:400">· ${this.ownerLabel(a.owner)}</span></div>
                    <div class="ac-strength">兵力 ${Math.round(a.strength)} · 组织度 ${Math.round(a.org * 100)}%</div>
                </div>`;
            }).join('')}</div>` : ''}`;
    },

    // ----- 日志 -----
    renderLog() {
        const s = this.game.state;
        const history = (s.history || []).slice().reverse();
        const cmds = (s.log || []).slice().reverse();
        return `<div class="panel-section"><h4>历史播报</h4>
            ${history.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">暂无记录</div>' :
                history.map(h => `<div class="log-entry"><span class="le-date">${h.date}</span>${h.text}</div>`).join('')}
        </div>
        <div class="panel-section"><h4>命令日志（可回放）</h4>
            ${cmds.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">暂无命令</div>' :
                cmds.map(l => `<div class="log-entry"><span class="le-date">tick ${l.tick}</span>${l.cmd.t}</div>`).join('')}
        </div>`;
    },

    // ===================== 省份速览卡（地图左下角） =====================
    /**
     * 点击省份后在左下角显示速览卡：归属、地形、驻扎部队（可选中）、
     * 快捷部署按钮。查看与部署都不再需要打开侧栏面板。
     */
    updateProvincePanel() {
        const card = document.getElementById('provinceCard');
        if (!card || !this.game || !this.game.state) return;
        const id = this.game.selectedProvince;
        if (id == null) {
            card.classList.add('hidden');
            card.innerHTML = '';
            return;
        }
        const prov = this.game.provinceById(id);
        if (!prov) {
            card.classList.add('hidden');
            card.innerHTML = '';
            return;
        }

        const tag = this.game.playerTag;
        const mine = prov.controller === tag;
        if (mine) this._deployTarget = prov.id;

        const armies = this.game.armiesIn(prov.id).filter((a) => a.strength > 0);
        const airGroups = this.game.airForcesIn(prov.id);
        const fleets = this.game.fleetsIn(prov.id);
        const selArmyId = this.game.selectedArmy;
        const unitRows = armies.map((a) => {
            const tpl = this.game.divisions[a.template];
            const selected = a.id === selArmyId;
            const isMine = a.owner === tag;
            return `<div class="pc-army${selected ? ' selected' : ''}">
                <span class="pc-army-name">${tpl ? tpl.icon + ' ' + tpl.name : a.template}</span>
                <span class="pc-army-str">${Math.round(a.strength)}</span>
                ${isMine
                    ? `<button class="pc-btn${selected ? ' on' : ''}" data-army-select="${a.id}">${selected ? '已选中' : '选中'}</button>`
                    : `<span class="pc-army-owner">${this.ownerLabel(a.owner)}</span>`}
            </div>`;
        }).join('');

        const airRows = airGroups.map((g) => {
            const tpl = this.game.aircraft[g.template];
            const isMine = g.owner === tag;
            const sel = this.game.selectedAir === g.id;
            return `<div class="pc-army${sel ? ' selected' : ''}">
                <span class="pc-army-name">${tpl ? tpl.icon + ' ' + tpl.name : g.template}</span>
                <span class="pc-army-str">${Math.round(g.planes)}</span>
                ${isMine
                    ? `<button class="pc-btn${sel ? ' on' : ''}" data-air-select="${g.id}">${sel ? '已选中' : '选中'}</button>`
                    : `<span class="pc-army-owner">${this.ownerLabel(g.owner)}</span>`}
            </div>`;
        }).join('');

        const fleetRows = fleets.map((f) => {
            const tpl = this.game.ships[f.template];
            const isMine = f.owner === tag;
            const sel = this.game.selectedFleet === f.id;
            return `<div class="pc-army${sel ? ' selected' : ''}">
                <span class="pc-army-name">${tpl ? tpl.icon + ' ' + tpl.name : f.template}</span>
                <span class="pc-army-str">${Math.round(f.ships)}</span>
                ${isMine
                    ? `<button class="pc-btn${sel ? ' on' : ''}" data-fleet-select="${f.id}">${sel ? '已选中' : '选中'}</button>`
                    : `<span class="pc-army-owner">${this.ownerLabel(f.owner)}</span>`}
            </div>`;
        }).join('');

        const templates = mine ? this.game.availableTemplates(tag) : [];
        const deployButtons = templates.length === 0 ? '' : `
            <div class="pc-section-title">快捷部署</div>
            <div class="pc-deploy">${templates.map((tplId) => {
                const tpl = this.game.divisions[tplId];
                const blocked = this.game.canCommand({
                    t: 'deployArmy', country: tag, province: prov.id, template: tplId, count: 1,
                });
                return `<button class="pc-btn" data-deploy-here="${tplId}" ${blocked ? 'disabled' : ''}
                    title="${blocked ? blocked.err : '部署 1 支到本省'}">${tpl.icon} ${tpl.name}</button>`;
            }).join('')}</div>`;

        const terrain = (typeof TERRAIN !== 'undefined' && TERRAIN[prov.terrain]?.name) || prov.terrain;
        const supplyFactor = this.game.supplyFactor(prov.id);
        const supplyText = supplyFactor === null ? prov.supply
            : `${prov.supply} · 补给 ${Math.round(supplyFactor * 100)}%`;
        const movingNote = selArmyId != null && armies.some((a) => a.id === selArmyId)
            ? '<div class="pc-note">已选中部队：点击地图上相邻省份移动，右键 / Esc 取消。</div>' : '';

        card.innerHTML = `
            <div class="pc-head">
                <span class="pc-name">${prov.name}</span>
                <button class="pc-close" data-province-close title="关闭">✕</button>
            </div>
            <div class="pc-sub"><span class="pc-owner">${this.ownerLabel(prov.controller)}</span>
                · ${terrain}${prov.coastal ? ' · 沿海' : ''} · 供给 ${supplyText}${prov.damage ? ` · 受损 ${Math.round(prov.damage)}` : ''}</div>
            ${armies.length === 0 ? '' : `<div class="pc-section-title">驻扎部队</div><div class="pc-armies">${unitRows}</div>`}
            ${airGroups.length === 0 ? '' : `<div class="pc-section-title">空军</div><div class="pc-armies">${airRows}</div>`}
            ${fleets.length === 0 ? '' : `<div class="pc-section-title">舰队</div><div class="pc-armies">${fleetRows}</div>`}
            ${deployButtons}
            ${movingNote}
        `;
        card.classList.remove('hidden');
    },

    // ===================== 模态框 =====================
    showModal(title, bodyHtml, buttons) {
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalBody').innerHTML = bodyHtml;
        const btnBox = document.getElementById('modalButtons');
        btnBox.innerHTML = '';
        buttons.forEach(b => {
            const btn = document.createElement('button');
            btn.className = 'modal-btn' + (b.cls ? ' ' + b.cls : '');
            btn.textContent = b.text;
            btn._action = b.action;
            btnBox.appendChild(btn);
        });
        document.getElementById('modal').classList.remove('hidden');
    },

    closeModal() {
        document.getElementById('modal').classList.add('hidden');
    },

    /** 邀请国家加入阵营：列出满足条件的候选国家 */
    openInviteDialog() {
        const tag = this.game.playerTag;
        const myFaction = this.game.factionOf(tag);
        if (!myFaction) { this.toast('你还没有加入阵营'); return; }
        const candidates = Object.keys(this.game.state.countries)
            .filter((t) => t !== tag && !this.game.factionOf(t) &&
                (this.game.countryById(t)?.relations?.[tag] ?? 0) >= -20)
            .sort((a, b) => (this.game.countryById(b).relations?.[tag] || 0)
                - (this.game.countryById(a).relations?.[tag] || 0))
            .slice(0, 30);
        if (candidates.length === 0) {
            this.showModal('邀请加入阵营',
                '<p>没有满足条件（未加入阵营且关系 ≥ -20）的国家。</p>',
                [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
            return;
        }
        this.showModal('邀请加入阵营', `
            <div class="modal-scroll">
                ${candidates.map((t) => `<div class="diplo-card">
                    <div class="dc-name">${this.ownerLabel(t)}
                        <span style="color:var(--text-dim);font-size:11px">· 关系 ${Math.round(this.game.countryById(t).relations?.[tag] || 0)}</span></div>
                    <div style="margin-top:6px">
                        <button class="btn-action" data-invite-send="${t}">发送邀请</button>
                    </div>
                </div>`).join('')}
            </div>`,
            [{ text: '关闭', action: () => this.closeModal() }]);
        document.querySelectorAll('[data-invite-send]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({
                    t: 'inviteFaction', from: tag, faction: myFaction, to: el.dataset.inviteSend,
                });
                if (!r.ok) {
                    this.showModal('提示', `<p>${r.err}</p>`, [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
                } else {
                    this.closeModal();
                }
                this.refreshAll();
            });
        });
    },

    // ===================== 和平会议弹窗 =====================
    showPeaceConference(offer) {
        // 与事件弹窗一致：出现时暂停时间，处理后恢复原速度
        this._peacePauseSpeed = this.game.speed;
        this.game.speed = 0;

        const terms = offer.terms.map((t) => {
            if (t.type === 'annexState') return `· 吞并州 ${t.state}`;
            if (t.type === 'resources') return `· 转让 ${t.amount} ${t.resource}`;
            return '· 停战';
        }).join('<br/>');
        this.showModal('和平会议', `
            <p><b>${this.ownerLabel(offer.from)}</b> 提出和平条件：</p>
            <p style="margin:8px 0">${terms}</p>
            <p style="color:var(--text-dim);font-size:12px">拒绝后战争将继续，战争分数不会清零。</p>
        `, [
            { text: '接受', cls: 'primary', action: () => {
                this.game.command({ t: 'acceptPeace', country: this.game.playerTag, offerId: offer.id });
                this.closeModal();
                this.game.speed = this._peacePauseSpeed;
                this.refreshAll();
            }},
            { text: '拒绝', action: () => {
                this.game.command({ t: 'rejectPeace', country: this.game.playerTag, offerId: offer.id });
                this.closeModal();
                this.game.speed = this._peacePauseSpeed;
                this.refreshAll();
            }},
        ]);
    },

    // ===================== 事件弹窗（战役事件） =====================
    showCampaignEvent(eventId, event) {
        // 事件弹窗出现时暂停时间推进；记录真实速度（可能本来就是 0），
        // 否则玩家暂停中处理事件后会被强行恢复成 1x
        this._eventPauseSpeed = this.game.speed;
        this.game.speed = 0;

        const title = this.tt(`event.${eventId}.title`, { event: eventId });
        const text = this.tt(`event.${eventId}.text`);
        document.getElementById('eventTitle').textContent = title;
        document.getElementById('eventText').textContent = text;
        const choices = document.getElementById('eventChoices');
        choices.innerHTML = '';
        event.options.forEach((opt, i) => {
            const btn = document.createElement('button');
            btn.className = 'event-choice';
            btn.textContent = this.tt(opt.text);
            btn.onclick = () => this.resolveCampaignEvent(eventId, i);
            choices.appendChild(btn);
        });
        document.getElementById('eventOverlay').classList.remove('hidden');
    },

    resolveCampaignEvent(eventId, option) {
        const r = this.game.command({ t: 'triggerEvent', eventId, option });
        if (!r.ok) console.warn('[事件] 选项执行失败:', r.err);
        document.getElementById('eventOverlay').classList.add('hidden');
        this.game.speed = this._eventPauseSpeed;   // 恢复时间推进
        this.refreshAll();
    },

    // ===================== 胜负弹窗 =====================
    showVictory(victory) {
        const winner = this.game.countryById(victory.winner);
        const name = winner ? this.tt(winner.name) : victory.winner;
        this.showModal('游戏结束', `
            <p>胜负判定：<b style="color:var(--green)">${name}</b> 达成胜利条件（${victory.type}）</p>
            <p style="margin-top:10px;color:var(--text-dim)">最终日期：${this.game.formatDate()}</p>
        `, [
            { text: '返回主菜单', cls: 'primary', action: () => { this.closeModal(); App.returnToMenu(); } },
        ]);
    },

    // ===================== 面板交互绑定 =====================
    bindPanelActions(panel) {
        const tag = this.game.playerTag;
        // 国策选择 / 取消
        document.querySelectorAll('[data-focus-choose]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({ t: 'chooseFocus', country: tag, focusId: el.dataset.focusChoose });
                if (!r.ok) this.showModal('提示', `<p>${r.err}</p>`, [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-focus-cancel]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.command({ t: 'cancelFocus', country: tag });
                this.refreshAll();
            });
        });
        // 决议
        document.querySelectorAll('[data-decision]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({ t: 'executeDecision', country: tag, decisionId: el.dataset.decision });
                if (!r.ok) this.showModal('提示', `<p>${r.err}</p>`, [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
                this.refreshAll();
            });
        });
        // 生产
        document.querySelectorAll('[data-prod-add]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({
                    t: 'allocateFactory', country: tag,
                    line: { equipment: el.dataset.prodAdd, factories: 1, priority: 1 },
                });
                this.notify(r);
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-prod-remove]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({ t: 'cancelProduction', country: tag, index: Number(el.dataset.prodRemove) });
                this.notify(r);
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-prod-adj]').forEach(el => {
            el.addEventListener('click', () => {
                const line = this.game.countryById(tag).production?.[Number(el.dataset.prodAdj)];
                if (!line) return;
                const r = this.game.command({
                    t: 'adjustProduction', country: tag,
                    index: Number(el.dataset.prodAdj), factories: (line.factories || 1) + Number(el.dataset.delta),
                });
                this.notify(r);
                this.refreshAll();
            });
        });
        // 部队：部署目标选择（选省份同时同步地图高亮）
        document.querySelectorAll('[data-deploy-target]').forEach(el => {
            el.addEventListener('change', () => {
                this._deployTarget = Number(el.value);
                this.game.selectProvince(this._deployTarget);
                this._lastPanelSignature = this.panelSignature();
                this.renderPanel(this.currentPanel);
            });
        });
        // 部队：部署
        document.querySelectorAll('[data-deploy]').forEach(el => {
            el.addEventListener('click', () => {
                const target = this.resolveDeployTarget(tag);
                if (target == null) {
                    this.toast('请先选择一个自己控制的省份');
                    return;
                }
                this.deployAt(el.dataset.deploy, target, Number(el.dataset.deployCount || 1));
                this.refreshAll();
            });
        });
        // 部队：面板内快捷移动（地图上也可“选中部队 → 点相邻省份”）
        document.querySelectorAll('[data-move-army]').forEach(el => {
            el.addEventListener('click', () => {
                const armyId = Number(el.dataset.moveArmy);
                const select = document.querySelector(`[data-move-select="${armyId}"]`);
                const to = select ? Number(select.value) : NaN;
                if (!to) {
                    this.toast('请先选择目标省份');
                    return;
                }
                const r = this.game.command({ t: 'moveArmy', armyId, to });
                if (!r.ok) {
                    this.toast(r.err || '移动失败');
                    return;
                }
                this.game.selectProvince(to);
                this.game.selectArmy(armyId);
                this.toast('部队已移动');
                this.refreshAll();
                if (typeof MapView !== 'undefined' && MapView.requestDraw) MapView.requestDraw();
            });
        });
        // 部队：地图选中 / 定位 / 取消 / 解散
        document.querySelectorAll('[data-select-army]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.selectArmy(Number(el.dataset.selectArmy));
                this.closePanel();
            });
        });
        document.querySelectorAll('[data-focus-army]').forEach(el => {
            el.addEventListener('click', () => {
                const army = this.game.armyById(Number(el.dataset.focusArmy));
                if (!army) return;
                this.closePanel();
                this.game.selectArmy(army.id);
                if (typeof MapView !== 'undefined' && MapView.focusProvince) {
                    MapView.focusProvince(army.provinceId);
                }
            });
        });
        document.querySelectorAll('[data-clear-army]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.clearArmySelection();
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-disband]').forEach(el => {
            el.addEventListener('click', () => {
                const id = Number(el.dataset.disband);
                const r = this.game.command({ t: 'disbandArmy', armyId: id });
                if (!r.ok) {
                    this.toast(r.err || '解散失败');
                } else {
                    if (this.game.selectedArmy === id) this.game.clearArmySelection();
                    this.toast('部队已解散');
                }
                this.refreshAll();
            });
        });
        // 部队指令：待机 / 进攻 / 撤退 / 手动推进一格
        document.querySelectorAll('[data-order]').forEach(el => {
            el.addEventListener('click', () => {
                const sel = this.game.selectedArmy;
                if (sel == null) { this.toast('请先选中一支部队'); return; }
                const r = this.game.command({ t: 'setArmyOrder', armyId: sel, order: el.dataset.order });
                if (!r.ok) this.toast(r.err || '指令设置失败');
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-advance-one]').forEach(el => {
            el.addEventListener('click', () => {
                const sel = this.game.selectedArmy;
                if (sel == null) { this.toast('请先选中一支部队'); return; }
                const r = this.game.advanceArmyOneStep(sel);
                if (!r.ok) this.toast(r.err || '无法推进');
                this.refreshAll();
            });
        });
        // 空军：部署 / 选中 / 定位 / 解散 / 移动
        document.querySelectorAll('[data-deploy-air]').forEach(el => {
            el.addEventListener('click', () => {
                const target = this.resolveDeployTarget(tag);
                if (target == null) { this.toast('请先选择一个自己控制的省份'); return; }
                const r = this.game.command({
                    t: 'deployAirForce', country: tag, province: target, template: el.dataset.deployAir, count: 1,
                });
                if (!r.ok) this.toast(r.err || '部署失败');
                else this.toast('已部署 1 个空军群');
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-select-air]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.selectAirForce(Number(el.dataset.selectAir));
                this.closePanel();
            });
        });
        document.querySelectorAll('[data-focus-air]').forEach(el => {
            el.addEventListener('click', () => {
                const g = this.game.airForceById(Number(el.dataset.focusAir));
                if (!g) return;
                this.closePanel();
                this.game.selectAirForce(g.id);
                if (typeof MapView !== 'undefined' && MapView.focusProvince) MapView.focusProvince(g.provinceId);
            });
        });
        document.querySelectorAll('[data-disband-air]').forEach(el => {
            el.addEventListener('click', () => {
                const id = Number(el.dataset.disbandAir);
                const r = this.game.command({ t: 'disbandAirForce', airId: id });
                if (!r.ok) this.toast(r.err || '解散失败');
                else if (this.game.selectedAir === id) this.game.clearArmySelection();
                this.refreshAll();
            });
        });
        // 海军：部署 / 选中 / 定位 / 解散 / 移动
        document.querySelectorAll('[data-deploy-fleet]').forEach(el => {
            el.addEventListener('click', () => {
                const target = this.resolveFleetTarget(tag);
                if (target == null) { this.toast('需要先控制一个沿海省份'); return; }
                const r = this.game.command({
                    t: 'deployFleet', country: tag, province: target, template: el.dataset.deployFleet, count: 1,
                });
                if (!r.ok) this.toast(r.err || '部署失败');
                else this.toast('已部署 1 支舰队');
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-select-fleet]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.selectFleet(Number(el.dataset.selectFleet));
                this.closePanel();
            });
        });
        document.querySelectorAll('[data-focus-fleet]').forEach(el => {
            el.addEventListener('click', () => {
                const f = this.game.fleetById(Number(el.dataset.focusFleet));
                if (!f) return;
                this.closePanel();
                this.game.selectFleet(f.id);
                if (typeof MapView !== 'undefined' && MapView.focusProvince) MapView.focusProvince(f.provinceId);
            });
        });
        document.querySelectorAll('[data-disband-fleet]').forEach(el => {
            el.addEventListener('click', () => {
                const id = Number(el.dataset.disbandFleet);
                const r = this.game.command({ t: 'disbandFleet', fleetId: id });
                if (!r.ok) this.toast(r.err || '解散失败');
                else if (this.game.selectedFleet === id) this.game.clearArmySelection();
                this.refreshAll();
            });
        });
        // 空军 / 舰队移动
        document.querySelectorAll('[data-move-unit]').forEach(el => {
            el.addEventListener('click', () => {
                const id = Number(el.dataset.moveUnit);
                const kind = el.dataset.kind;
                const select = document.querySelector(`[data-move-select="${id}"]`);
                const to = select ? Number(select.value) : NaN;
                if (!to) { this.toast('请先选择目标省份'); return; }
                const r = this.game.command(this.game.moveCommandFor(kind, id, to, this.game.playerTag));
                if (!r.ok) { this.toast(r.err || '移动失败'); return; }
                this.game.selectProvince(to);
                if (kind === 'air') this.game.selectAirForce(id);
                else this.game.selectFleet(id);
                this.toast('已移动');
                this.refreshAll();
                if (typeof MapView !== 'undefined' && MapView.requestDraw) MapView.requestDraw();
            });
        });
        // 生产：暂停 / 恢复产线、取消建造
        document.querySelectorAll('[data-prod-toggle]').forEach(el => {
            el.addEventListener('click', () => {
                const line = this.game.countryById(tag).production?.[Number(el.dataset.prodToggle)];
                if (!line) return;
                const r = this.game.command({
                    t: 'toggleProduction', country: tag, index: Number(el.dataset.prodToggle),
                    disabled: !line.disabled,
                });
                this.notify(r);
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-construction-cancel]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({
                    t: 'cancelConstruction', country: tag, index: Number(el.dataset.constructionCancel),
                });
                this.notify(r);
                this.refreshAll();
            });
        });
        // 通知筛选
        document.querySelectorAll('[data-notice-filter]').forEach(el => {
            el.addEventListener('click', () => {
                this._noticeFilter = el.dataset.noticeFilter;
                this._lastPanelSignature = null;
                this.renderPanel(this.currentPanel);
            });
        });
        // 和平提议：接受 / 拒绝
        document.querySelectorAll('[data-peace]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({
                    t: el.dataset.peace, country: tag, offerId: Number(el.dataset.offer),
                });
                if (!r.ok) this.showModal('提示', `<p>${r.err}</p>`, [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
                this.refreshAll();
            });
        });
        // 阵营：邀请 / 接受 / 拒绝 / 退出
        document.querySelectorAll('[data-invite-open]').forEach(el => {
            el.addEventListener('click', () => this.openInviteDialog());
        });
        document.querySelectorAll('[data-invite-accept]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.command({ t: 'acceptFactionInvite', country: tag, inviteId: Number(el.dataset.inviteAccept) });
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-invite-reject]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.command({ t: 'rejectFactionInvite', country: tag, inviteId: Number(el.dataset.inviteReject) });
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-leave-faction]').forEach(el => {
            el.addEventListener('click', () => {
                this.showModal('退出阵营', '<p>确认退出当前阵营？退出后阵营战争不再自动卷入。</p>', [
                    { text: '确认退出', cls: 'primary', action: () => {
                        this.game.command({ t: 'leaveFaction', country: tag });
                        this.closeModal();
                        this.refreshAll();
                    }},
                    { text: '取消', action: () => this.closeModal() },
                ]);
            });
        });
        // 租借
        document.querySelectorAll('[data-lend]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({
                    t: 'lendLease', country: tag, to: el.dataset.lend, amount: 10, resource: 'supplies',
                });
                if (!r.ok) this.toast(r.err || '租借失败');
                else this.toast('已租借 10 补给');
                this.refreshAll();
            });
        });
        // 战争目标：把敌方控制的州设为吞并目标
        document.querySelectorAll('[data-war-goal]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({
                    t: 'addWarGoal', from: tag, to: el.dataset.warGoal,
                    goal: { type: 'annexState', state: Number(el.dataset.state) },
                });
                if (!r.ok) this.toast(r.err || '添加目标失败');
                this.refreshAll();
            });
        });
        // 科技
        document.querySelectorAll('[data-tech]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({ t: 'startResearch', country: tag, techId: el.dataset.tech });
                if (!r.ok) this.showModal('提示', `<p>${r.err}</p>`, [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
                this.refreshAll();
            });
        });
        // 外交
        document.querySelectorAll('[data-diplo]').forEach(el => {
            el.addEventListener('click', () => {
                const type = el.dataset.diplo;
                const target = el.dataset.target;
                let cmd;
                if (type === 'war') cmd = { t: 'declareWar', from: tag, to: target, justification: '玩家宣战' };
                else if (type === 'peace') cmd = { t: 'makePeace', from: tag, to: target };
                else if (type === 'relation') cmd = { t: 'improveRelations', from: tag, to: target, amount: 10 };
                if (cmd) {
                    const r = this.game.command(cmd);
                    if (!r.ok) this.showModal('提示', `<p>${r.err}</p>`, [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
                }
                this.refreshAll();
            });
        });
    },
};

if (typeof window !== 'undefined') window.UI = UI;
