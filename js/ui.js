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

    init(game) {
        this.game = game;
        this._lastPanelSignature = null;
        this._panelMouse = null;
        this.bindIconRail();
        this.bindMapTools();
        this.bindTopBar();
        this.bindModal();
        this.bindPanelModal();
        this.bindPanelHover();
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

    /** 部署目标省份：优先当前选中省份（须为己方控制），否则取首个控制省份 */
    deployTarget(tag) {
        const sel = this.game.selectedProvince;
        const mine = this.game.provincesOf(tag);
        if (sel !== null && mine.some((p) => p.id === sel)) return sel;
        return mine[0]?.id ?? null;
    },

    // ===================== 面板弹窗开关 =====================
    panelTitles: {
        overview: '总览', politics: '政治', economy: '经济',
        production: '生产', army: '部队', tech: '科技', diplomacy: '外交',
        intelligence: '情报', log: '日志'
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

    bindIconRail() {
        const btns = document.querySelectorAll('.rail-btn');
        btns.forEach(btn => {
            btn.addEventListener('click', () => this.openPanel(btn.dataset.panel));
        });
    },

    // ===================== 主刷新 =====================
    refreshAll() {
        if (!this.game || !this.game.state) return;
        this.updateTopBar();
        this.updateBottomBar();
        // 面板关闭时不要反复重建隐藏的 DOM；打开时也只在数据签名变化时重建，
        // 否则每 400ms 重建一次会销毁鼠标下的选项元素，导致 hover 样式闪烁
        const pm = document.getElementById('panelModal');
        if (pm && !pm.classList.contains('hidden')) {
            const sig = this.panelSignature();
            if (sig !== this._lastPanelSignature) {
                this._lastPanelSignature = sig;
                const content = document.getElementById('panelContent');
                const scrollTop = content.scrollTop;
                this.renderPanel(this.currentPanel);
                content.scrollTop = scrollTop;
            }
        }
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
            tag, g.selectedProvince,
            c.politicalPower, c.manpower, c.population, c.civs, c.mils, c.docks,
            c.stability, c.warSupport, c.legitimacy,
            c.resources, c.equipment, c.construction, c.production,
            c.tech, c.unlockedTemplates, c.relations, c.garrison, c.flags, c.bonuses,
            c.activeFocus,
            s.focuses[tag], s.decisions[tag], s.research[tag],
            s.provinces, s.armies, s.wars, s.alliances, s.missions,
            s.history.length, s.log.length,
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

    // ===================== 底部状态栏 =====================
    updateBottomBar() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        if (!c) return;

        // 资源（战役状态持有量）
        const resBox = document.getElementById('statResources');
        const topRes = ['steel', 'oil', 'rubber', 'aluminium', 'munitions', 'supplies'];
        resBox.innerHTML = topRes.map(r => {
            const def = RESOURCES[r];
            const val = c.resources?.[r] || 0;
            return `<div class="stat-item">
                <span class="stat-label">${def.icon} ${def.name}</span>
                <span class="stat-value">${Math.round(val)}</span>
            </div>`;
        }).join('');

        // 人力 / 战争支持 / 稳定度
        const mpBox = document.getElementById('statManpower');
        const warSupport = Math.round(this.fp(c.warSupport) * 100);
        const stability = Math.round(this.fp(c.stability) * 100);
        mpBox.innerHTML = `<div class="stat-item">
            <span class="stat-label">⊕ 人力</span>
            <span class="stat-value">${Math.round(c.manpower)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">▲ 战争支持</span>
            <span class="stat-value ${warSupport > 50 ? 'pos' : 'warn'}">${warSupport}%</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">◆ 稳定度</span>
            <span class="stat-value ${stability > 50 ? 'pos' : 'warn'}">${stability}%</span>
        </div>`;

        // 工业
        const indBox = document.getElementById('statIndustry');
        indBox.innerHTML = `<div class="stat-item">
            <span class="stat-label">⬢ 民用工厂</span>
            <span class="stat-value">${c.civs}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">⡡ 军用工厂</span>
            <span class="stat-value">${c.mils}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">⚓ 船坞</span>
            <span class="stat-value">${c.docks}</span>
        </div>`;

        // 军事（部队 + 驻军存在性）
        const milBox = document.getElementById('statMilitary');
        const myGarrison = this.game.garrisons().filter(g => g.owner === tag).length;
        const myArmies = this.game.armiesOf(tag).length;
        const war = this.game.isWarFor(tag);
        const wars = this.game.state.wars.filter(w => w.a === tag || w.b === tag).length;
        milBox.innerHTML = `<div class="stat-item">
            <span class="stat-label">⚔ 部队</span>
            <span class="stat-value">${myArmies}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">✕ 驻军区</span>
            <span class="stat-value">${myGarrison}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">${war ? '● 战争中' : '○ 和平'}</span>
            <span class="stat-value ${war ? 'neg' : 'pos'}">${war ? `${wars} 场` : '否'}</span>
        </div>`;
    },

    bindMapTools() {
        const btns = document.querySelectorAll('.tool-btn');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.game.tool = btn.dataset.tool;
                MapView.draw();
            });
        });
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
            case 'intelligence': html = this.renderIntelligence(); break;
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
                (c.construction || []).map((b) => `
                    <div class="panel-row">
                        <span class="pr-label">${CONSTRUCTION[b.kind]?.name || b.kind}</span>
                        <span class="pr-value">${Math.min(100, Math.round(b.progress || 0))}%</span>
                    </div>
                    <div class="panel-bar"><div class="panel-bar-fill" style="width:${Math.min(100, b.progress || 0)}%;background:var(--orange)"></div></div>
                `).join('')}
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
                return `<div class="prod-row">
                    <span class="prod-icon">${eq ? eq.icon : '▢'}</span>
                    <span class="prod-name">${eq ? eq.name : item.equipment}
                        <span style="color:var(--text-dim);font-size:11px">· ${item.factories || 1} 厂</span></span>
                    <button class="btn-action" data-prod-adj="${i}" data-delta="-1" ${canDown ? '' : 'disabled'}>−</button>
                    <button class="btn-action" data-prod-adj="${i}" data-delta="1" ${canUp ? '' : 'disabled'}>+</button>
                    <button class="btn-action" data-prod-remove="${i}" style="padding:2px 8px;margin:0">✕</button>
                </div>`;
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
        const selProv = this.game.selectedProvince;

        // 可部署省份：玩家控制的省份
        const myProvinces = this.game.provincesOf(tag);
        const deployable = myProvinces.length > 0;

        return `
        <div class="panel-section">
            <h4>部队（${armies.length}）</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">
                人力 ${Math.round(c.manpower)} · 补给 ${Math.round(c.resources.supplies || 0)}
            </div>
            ${armies.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">尚无部队，从下方部署。</div>' :
                armies.map((a) => {
                    const prov = this.game.provinceById(a.provinceId);
                    const tpl = divisions[a.template];
                    const adj = this.game.index?.neighbors?.[String(a.provinceId)] || [];
                    return `<div class="army-card">
                        <div class="ac-name">${tpl ? tpl.icon + ' ' + tpl.name : a.template}
                            <span style="color:var(--text-dim);font-size:11px">· ${prov ? prov.name : a.provinceId}</span></div>
                        <div class="ac-strength">兵力 ${Math.round(a.strength)} · 组织度 ${Math.round(a.org * 100)}% · 速度 ${a.speed}</div>
                        <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
                            ${adj.length === 0 ? '<span style="font-size:11px;color:var(--text-dim)">无可移动方向</span>' :
                                adj.map((nid) => {
                                    const n = this.game.provinceById(Number(nid));
                                    const blocked = this.game.canCommand({ t: 'moveArmy', armyId: a.id, to: Number(nid) });
                                    return `<button class="btn-action" data-move-army="${a.id}" data-to="${nid}" ${blocked ? 'disabled' : ''}>
                                        ${n ? n.name : nid}</button>`;
                                }).join('')}
                            <button class="btn-action" data-disband="${a.id}">解散</button>
                        </div>
                    </div>`;
                }).join('')}
        </div>
        <div class="panel-section">
            <h4>部署部队</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">
                部署需消耗人力与装备库存。目标省份：<b>${selProv ? (this.game.provinceById(selProv)?.name || selProv) : '未选择（默认首个控制省份）'}</b>
            </div>
            ${templates.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">未解锁任何部队模板，需先研究对应科技。</div>' :
                templates.map((tplId) => {
                    const tpl = divisions[tplId];
                    const cost = this.game.divisionCost(tplId);
                    const target = selProv && myProvinces.some((p) => p.id === selProv)
                        ? selProv : myProvinces[0]?.id;
                    const blocked = this.game.canCommand({
                        t: 'deployArmy', country: tag, province: target, template: tplId, count: 1,
                    });
                    return `<div class="focus-card">
                        <div style="font-weight:600">${tpl.icon} ${tpl.name}</div>
                        <div style="font-size:11px;color:var(--text-dim);margin-top:3px">
                            人力 ${cost.manpower} · ${Object.entries(cost.equipment).map(([k, v]) =>
                                `${this.game.equipment[k]?.name || k}×${v}`).join('、') || '无装备消耗'}
                        </div>
                        <button class="btn-action" data-deploy="${tplId}" ${blocked ? 'disabled' : ''}>部署 1 支</button>
                    </div>`;
                }).join('')}
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
        const others = Object.keys(this.game.state.countries).filter(t => t !== tag);
        const wars = this.game.state.wars.filter(w => w.a === tag || w.b === tag);
        return `
        <div class="panel-section">
            <h4>战争状态</h4>
            ${wars.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">无进行中的战争</div>' :
                wars.map(w => {
                    const other = w.a === tag ? w.b : w.a;
                    const oc = this.game.countryById(other);
                    return `<div class="diplo-card">
                        <div class="dc-name">${oc ? oc.flag + ' ' + this.tt(oc.name) : other}</div>
                        <div class="dc-rel neg">战争（${w.status}）</div>
                        <div style="margin-top:6px">
                            <button class="btn-action" data-diplo="peace" data-target="${other}">议和</button>
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
                return `<div class="diplo-card">
                    <div class="dc-name">${other.flag} ${this.tt(other.name)} ${other.faction ? '☥' : ''}</div>
                    <div class="dc-rel ${cls}">关系: ${Math.round(rel)} ${rel > 0 ? '↑' : '↓'}</div>
                    <div style="margin-top:6px">
                        <button class="btn-action" data-diplo="war" data-target="${oid}" ${blockWar ? 'disabled' : ''}>宣战</button>
                        <button class="btn-action" data-diplo="peace" data-target="${oid}" ${blockPeace ? 'disabled' : ''}>议和</button>
                        <button class="btn-action" data-diplo="relation" data-target="${oid}">改善(+10)</button>
                    </div>
                </div>`;
            }).join('')}
        </div>`;
    },

    // ----- 情报 / 驻军 -----
    renderIntelligence() {
        const tag = this.game.playerTag;
        const c = this.game.playerCountry();
        const myGarrison = this.game.garrisons().filter(g => g.owner === tag);
        const selProv = this.game.selectedProvince ? this.game.provinceById(this.game.selectedProvince) : null;
        return `
        <div class="panel-section">
            <h4>驻军（存在性）</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">战斗结算不在战役系统范围内，驻军仅作呈现与 AI 评估输入。</div>
            ${myGarrison.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">无驻军</div>' :
                myGarrison.map(g => {
                    const prov = this.game.provinceById(g.provinceId);
                    return `<div class="army-card">
                        <div class="ac-name">${prov ? prov.name : g.provinceId}</div>
                        <div class="ac-strength">驻军：${g.count}</div>
                    </div>`;
                }).join('')}
        </div>
        <div class="panel-section">
            <h4>当前选中省份</h4>
            ${selProv ? `
                <div class="panel-row"><span class="pr-label">省份</span><span class="pr-value">${selProv.name}</span></div>
                <div class="panel-row"><span class="pr-label">控制方</span><span class="pr-value">${selProv.controller ? this.tt(this.game.countryById(selProv.controller).name) : '无主'}</span></div>
                <div class="panel-row"><span class="pr-label">地形</span><span class="pr-value">${(TERRAIN[selProv.terrain] || { name: selProv.terrain }).name}</span></div>
                <div class="panel-row"><span class="pr-label">供给</span><span class="pr-value">${selProv.supply}</span></div>
            ` : '<div style="font-size:12px;color:var(--text-dim)">请在地图上选择一个省份</div>'}
        </div>`;
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

    // ===================== 省份信息面板 =====================
    updateProvincePanel() {
        // 省份信息在情报面板与地图 tooltip 呈现，此处保留接口
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
        // 部队
        document.querySelectorAll('[data-deploy]').forEach(el => {
            el.addEventListener('click', () => {
                const target = this.deployTarget(tag);
                if (target === null) {
                    this.showModal('提示', '<p>请先在地图上选择一个自己控制的省份。</p>',
                        [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
                    return;
                }
                const r = this.game.command({
                    t: 'deployArmy', country: tag, province: target, template: el.dataset.deploy, count: 1,
                });
                this.notify(r);
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-move-army]').forEach(el => {
            el.addEventListener('click', () => {
                const r = this.game.command({
                    t: 'moveArmy', armyId: Number(el.dataset.moveArmy), to: Number(el.dataset.to),
                });
                this.notify(r);
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-disband]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.command({ t: 'disbandArmy', armyId: Number(el.dataset.disband) });
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
