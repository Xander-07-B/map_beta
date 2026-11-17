/* ============================================================
 * 钢铁雄心4 网页版 - UI 渲染 ui.js
 * 负责：顶部栏、侧栏各面板、底部状态栏、模态框、事件弹窗
 * ============================================================ */

const UI = {
    currentPanel: 'overview',

    init(game) {
        this.game = game;
        this.bindIconRail();
        this.bindMapTools();
        this.bindTopBar();
        this.bindModal();
        this.bindPanelModal();
    },

    // ===================== 面板弹窗开关 =====================
    panelTitles: {
        overview: '总览', politics: '政治', economy: '经济',
        production: '生产', tech: '科技', diplomacy: '外交',
        intelligence: '情报', log: '日志'
    },

    openPanel(panel) {
        this.currentPanel = panel;
        // 更新图标栏高亮
        document.querySelectorAll('.rail-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.panel === panel);
        });
        // 设置标题并渲染
        document.getElementById('panelModalTitle').textContent = this.panelTitles[panel] || panel;
        this.renderPanel(panel);
        // 显示弹窗
        document.getElementById('panelModal').classList.remove('hidden');
        document.getElementById('panelModalBackdrop').classList.remove('hidden');
        // 触发动画
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

    // ===================== 图标栏绑定 =====================
    bindIconRail() {
        const btns = document.querySelectorAll('.rail-btn');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.openPanel(btn.dataset.panel);
            });
        });
    },

    // ===================== 主刷新 =====================
    refreshAll() {
        if (!this.game) return;
        this.updateTopBar();
        this.updateBottomBar();
        this.renderPanel(this.currentPanel);
        if (MapView) MapView.draw();
    },

    // ===================== 顶部栏 =====================
    updateTopBar() {
        const c = this.game.playerCountry();
        if (!c) return;
        const ideo = IDEOLOGY[c.ideology];
        document.getElementById('countryTag').style.background = c.color;
        document.getElementById('countryTag').textContent = c.tag;
        document.getElementById('countryName').textContent = `${c.flag} ${c.name} · ${ideo.name}`;
        document.getElementById('dateText').textContent = this.game.formatDate();
    },

    // ===================== 底部状态栏 =====================
    updateBottomBar() {
        const cid = this.game.playerCountryId;
        const c = this.game.playerCountry();
        if (!c) return;

        // 资源
        const resBox = document.getElementById('statResources');
        const income = this.game.computeResourceIncome(cid);
        const stock = this.game.resourceStock[cid] || {};
        const topRes = ['steel', 'oil', 'rubber', 'aluminium', 'munitions', 'supplies'];
        resBox.innerHTML = topRes.map(r => {
            const def = RESOURCES[r];
            const val = stock[r] || 0;
            const inc = income[r] || 0;
            const cls = inc >= 0 ? 'pos' : 'neg';
            return `<div class="stat-item">
                <span class="stat-label">${def.icon} ${def.name}</span>
                <span class="stat-value ${cls}">${val.toFixed(0)} (${inc >= 0 ? '+' : ''}${inc.toFixed(1)})</span>
            </div>`;
        }).join('');

        // 人力
        const mpBox = document.getElementById('statManpower');
        const mpPct = Math.round((c.manpower / c.maxManpower) * 100);
        mpBox.innerHTML = `<div class="stat-item">
            <span class="stat-label">⊕ 人力</span>
            <span class="stat-value">${Math.round(c.manpower)} / ${c.maxManpower}</span>
            <div class="stat-bar"><div class="stat-bar-fill" style="width:${mpPct}%;background:var(--blue)"></div></div>
        </div>
        <div class="stat-item">
            <span class="stat-label">▲ 战争支持</span>
            <span class="stat-value ${c.warSupport > 50 ? 'pos' : 'warn'}">${Math.round(c.warSupport)}%</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">◆ 稳定度</span>
            <span class="stat-value ${c.stability > 50 ? 'pos' : 'warn'}">${Math.round(c.stability)}%</span>
        </div>`;

        // 工业
        const indBox = document.getElementById('statIndustry');
        const f = this.game.factories[cid];
        indBox.innerHTML = `<div class="stat-item">
            <span class="stat-label">⬢ 民用工厂</span>
            <span class="stat-value">${Math.round(f.civilian)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">⬡ 军用工厂</span>
            <span class="stat-value">${Math.round(f.military)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">▢ 建造</span>
            <span class="stat-value">${Math.round(f.construction)}</span>
        </div>`;

        // 军事
        const milBox = document.getElementById('statMilitary');
        const myArmies = this.game.armies.filter(a => a.owner === cid);
        const totalStrength = myArmies.reduce((s, a) => s + a.strength, 0);
        const war = this.game.isWarFor(cid);
        milBox.innerHTML = `<div class="stat-item">
            <span class="stat-label">✕ 军队数</span>
            <span class="stat-value">${myArmies.length}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">◎ 总战力</span>
            <span class="stat-value">${Math.round(totalStrength)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">${war ? '● 战争中' : '○ 和平'}</span>
            <span class="stat-value ${war ? 'neg' : 'pos'}">${war ? '是' : '否'}</span>
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
                    document.getElementById('gameScreen').classList.remove('active');
                    document.getElementById('startScreen').classList.add('active');
                }},
            ]);
        });
    },

    bindModal() {
        // 事件委托：按钮使用 _action 自定义属性，避免与 onclick 属性重复触发
        document.getElementById('modalButtons').addEventListener('click', (e) => {
            const btn = e.target.closest('.modal-btn');
            if (btn && btn._action) btn._action();
        });
    },

    renderMenuBody() {
        const c = this.game.playerCountry();
        return `<p>当前国家：<b>${c.flag} ${c.name}</b></p>
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
            case 'tech': html = this.renderTech(); break;
            case 'diplomacy': html = this.renderDiplomacy(); break;
            case 'intelligence': html = this.renderIntelligence(); break;
            case 'log': html = this.renderLog(); break;
        }
        content.innerHTML = html;
        this.bindPanelActions(panel);
    },

    // ----- 总览 -----
    renderOverview() {
        const c = this.game.playerCountry();
        const f = this.game.factories[this.game.playerCountryId];
        const provinces = this.game.provincesOf(this.game.playerCountryId);
        const myArmies = this.game.armies.filter(a => a.owner === this.game.playerCountryId);
        const income = this.game.computeResourceIncome(this.game.playerCountryId);
        return `
        <div class="panel-section">
            <h4>国家总览</h4>
            <div class="panel-row"><span class="pr-label">国家</span><span class="pr-value">${c.flag} ${c.name}</span></div>
            <div class="panel-row"><span class="pr-label">意识形态</span><span class="pr-value">${IDEOLOGY[c.ideology].icon} ${IDEOLOGY[c.ideology].name}</span></div>
            <div class="panel-row"><span class="pr-label">日期</span><span class="pr-value">${this.game.formatDate()}</span></div>
            <div class="panel-row"><span class="pr-label">省份数</span><span class="pr-value">${provinces.length}</span></div>
            <div class="panel-row"><span class="pr-label">军队数</span><span class="pr-value">${myArmies.length}</span></div>
            <div class="panel-row"><span class="pr-label">战争状态</span><span class="pr-value ${this.game.isWarFor(this.game.playerCountryId) ? 'neg' : 'pos'}">${this.game.isWarFor(this.game.playerCountryId) ? '● 交战中' : '○ 和平'}</span></div>
        </div>
        <div class="panel-section">
            <h4>工业</h4>
            <div class="panel-row"><span class="pr-label">民用工厂</span><span class="pr-value">${Math.round(f.civilian)}</span></div>
            <div class="panel-row"><span class="pr-label">军用工厂</span><span class="pr-value">${Math.round(f.military)}</span></div>
            <div class="panel-row"><span class="pr-label">总工厂</span><span class="pr-value">${Math.round(f.civilian + f.military)}</span></div>
        </div>
        <div class="panel-section">
            <h4>每日资源产出</h4>
            ${Object.entries(RESOURCES).filter(([k]) => income[k] > 0).map(([k, def]) => `
                <div class="panel-row">
                    <span class="pr-label">${def.icon} ${def.name}</span>
                    <span class="pr-value pos">+${income[k].toFixed(2)}</span>
                </div>
            `).join('')}
        </div>
        <div class="panel-section">
            <h4>领土</h4>
            <div style="font-size:12px;color:var(--text-dim);line-height:1.8">
                ${provinces.map(p => `<div class="panel-row"><span class="pr-label">${p.name}</span><span class="pr-value">${TERRAIN[p.terrain].name}</span></div>`).join('')}
            </div>
        </div>`;
    },

    // ----- 政治 -----
    renderPolitics() {
        const cid = this.game.playerCountryId;
        const c = this.game.playerCountry();
        const focuses = this.game.getAvailableFocuses(cid);
        const doneFocuses = this.game.focuses[cid].done;
        return `
        <div class="panel-section">
            <h4>政治状态</h4>
            <div class="panel-row"><span class="pr-label">稳定度</span><span class="pr-value">${Math.round(c.stability)}%</span></div>
            <div class="panel-bar"><div class="panel-bar-fill" style="width:${c.stability}%;background:var(--green)"></div></div>
            <div class="panel-row"><span class="pr-label">战争支持</span><span class="pr-value">${Math.round(c.warSupport)}%</span></div>
            <div class="panel-bar"><div class="panel-bar-fill" style="width:${c.warSupport}%;background:var(--orange)"></div></div>
            <div class="panel-row"><span class="pr-label">人口</span><span class="pr-value">${Math.round(c.population)}</span></div>
            <div class="panel-row"><span class="pr-label">意识形态</span><span class="pr-value">${IDEOLOGY[c.ideology].icon} ${IDEOLOGY[c.ideology].name}</span></div>
        </div>
        <div class="panel-section">
            <h4>国家焦点 (${focuses.length} 可用)</h4>
            ${focuses.map(f => `
                <div class="focus-card available" data-focus="${f.id}">
                    <div style="font-weight:600">${f.icon} ${f.name}</div>
                    <div style="font-size:11px;color:var(--text-dim);margin-top:3px">${f.effect}</div>
                </div>
            `).join('')}
            ${doneFocuses.length > 0 ? `<div style="font-size:11px;color:var(--text-dim);margin:6px 0">已完成焦点：${doneFocuses.length} 个</div>` : ''}
        </div>`;
    },

    // ----- 经济 -----
    renderEconomy() {
        const cid = this.game.playerCountryId;
        const c = this.game.playerCountry();
        const f = this.game.factories[cid];
        const income = this.game.computeResourceIncome(cid);
        const cons = this.game.computeResourceConsumption(cid);
        const stock = this.game.resourceStock[cid] || {};
        return `
        <div class="panel-section">
            <h4>工厂</h4>
            <div class="panel-row"><span class="pr-label">民用工厂</span><span class="pr-value">${Math.round(f.civilian)}</span></div>
            <div class="panel-row"><span class="pr-label">军用工厂</span><span class="pr-value">${Math.round(f.military)}</span></div>
            <div class="panel-row"><span class="pr-label">建造工厂</span><span class="pr-value">${Math.round(f.construction)}</span></div>
        </div>
        <div class="panel-section">
            <h4>资源明细</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">产出 / 消耗 / 库存</div>
            ${Object.entries(RESOURCES).map(([k, def]) => `
                <div class="panel-row">
                    <span class="pr-label">${def.icon} ${def.name}</span>
                    <span class="pr-value">
                        <span class="pos">+${(income[k]||0).toFixed(1)}</span>
                        <span class="neg">${-(cons[k]||0).toFixed(1)}</span>
                        = ${(stock[k]||0).toFixed(0)}
                    </span>
                </div>
            `).join('')}
        </div>
        <div class="panel-section">
            <h4>装备库存</h4>
            ${Object.entries(this.game.equipmentStock[cid] || {}).filter(([k,v]) => v > 0).map(([k, v]) => `
                <div class="panel-row">
                    <span class="pr-label">${EQUIPMENT[k] ? EQUIPMENT[k].icon + ' ' + EQUIPMENT[k].name : k}</span>
                    <span class="pr-value">${Math.round(v)}</span>
                </div>
            `).join('') || '<div style="font-size:12px;color:var(--text-dim)">暂无库存</div>'}
        </div>`;
    },

    // ----- 生产 -----
    renderProduction() {
        const cid = this.game.playerCountryId;
        const f = this.game.factories[cid];
        const queue = this.game.production[cid] || [];
        const unlocked = this.game.unlockedEquipment[cid] || ['infantry_weapon', 'artillery'];
        return `
        <div class="panel-section">
            <h4>生产队列 (${queue.length}/4)</h4>
            ${queue.length === 0 ? '<div style="font-size:12px;color:var(--text-dim);margin-bottom:10px">生产队列为空，请添加生产项目。</div>' : ''}
            ${queue.map((item, i) => {
                const eq = EQUIPMENT[item.equipment];
                return `<div class="prod-row">
                    <span class="prod-icon">${eq ? eq.icon : '▢'}</span>
                    <span class="prod-name">${eq ? eq.name : item.equipment} <span style="color:var(--text-dim);font-size:11px">(优先${item.priority})</span></span>
                    <span class="prod-amount">${item.amount.toFixed(1)}</span>
                    <button class="btn-action" data-prod-remove="${i}" style="padding:2px 8px;margin:0">✕</button>
                </div>`;
            }).join('')}
        </div>
        <div class="panel-section">
            <h4>添加生产</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">军用工厂：${Math.round(f.military)}</div>
            ${Object.entries(EQUIPMENT).filter(([k]) => unlocked.includes(k)).map(([k, eq]) => `
                <button class="btn-action" data-prod-add="${k}">${eq.icon} ${eq.name}</button>
            `).join('')}
        </div>`;
    },

    // ----- 科技 -----
    renderTech() {
        const cid = this.game.playerCountryId;
        const r = this.game.research[cid];
        const c = this.game.playerCountry();
        const buffs = c.buffs || {};
        return `
        <div class="panel-section">
            <h4>科研槽 (${r.researching.length}/${r.slots})</h4>
            <div class="tech-slot">
                ${Array.from({ length: Math.max(r.slots, 1) }).map((_, i) => {
                    const item = r.researching[i];
                    if (item) {
                        const tech = TECHS.find(t => t.id === item.techId);
                        const pct = Math.min(100, (item.progress / tech.time) * 100);
                        return `<div class="tech-slot-item filled" style="cursor:default">
                            <div style="font-weight:600">${tech.icon} ${tech.name}</div>
                            <div class="tc-progress" style="margin-top:4px"><div class="tc-progress-fill" style="width:${pct}%"></div></div>
                            <div style="margin-top:2px">${Math.round(pct)}%</div>
                        </div>`;
                    }
                    return `<div class="tech-slot-item" data-tech-slot="${i}">+ 研究</div>`;
                }).join('')}
            </div>
        </div>
        <div class="panel-section">
            <h4>科技树</h4>
            ${TECHS.map(t => {
                const done = r.completed.includes(t.id);
                const inProgress = r.researching.some(x => x.techId === t.id);
                const available = t.requires.every(req => r.completed.includes(req));
                const cls = done ? 'done' : (inProgress ? 'active' : (available ? '' : 'locked'));
                return `<div class="tech-card ${cls}" data-tech="${t.id}" ${available && !done && !inProgress ? '' : 'style="cursor:default"'}>
                    <div class="tc-name">${t.icon} ${t.name}</div>
                    <div class="tc-cat">${t.cat} · ${t.time}天 ${done ? '✓ 已完成' : ''}</div>
                    <div style="font-size:11px;color:var(--text-dim);margin-top:3px">${t.effect}</div>
                </div>`;
            }).join('')}
        </div>`;
    },

    // ----- 外交 -----
    renderDiplomacy() {
        const cid = this.game.playerCountryId;
        const c = this.game.playerCountry();
        const others = Object.keys(this.game.countries).filter(id => id !== cid);
        return `
        <div class="panel-section">
            <h4>外交关系</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">点击国家可进行外交操作</div>
            ${others.map(oid => {
                const rel = c.relations[oid] || 0;
                const other = this.game.countryById(oid);
                const isAlly = c.alliances.includes(oid);
                const cls = rel > 30 ? 'pos' : (rel < -30 ? 'neg' : '');
                return `<div class="diplo-card">
                    <div class="dc-name">${other.flag} ${other.name} ${isAlly ? '☥' : ''}</div>
                    <div class="dc-rel ${cls}">关系: ${Math.round(rel)} ${rel > 0 ? '↑' : '↓'}</div>
                    <div style="margin-top:6px">
                        ${rel > 50 ? `<button class="btn-action" data-diplo="alliance" data-target="${oid}">结盟</button>` : ''}
                        ${rel < -20 ? `<button class="btn-action" data-diplo="war" data-target="${oid}">宣战</button>` : ''}
                        ${rel < 30 ? `<button class="btn-action" data-diplo="peace" data-target="${oid}">议和</button>` : ''}
                        <button class="btn-action" data-diplo="relation" data-target="${oid}">改善(-2民厂)</button>
                    </div>
                </div>`;
            }).join('')}
        </div>`;
    },

    // ----- 情报 -----
    renderIntelligence() {
        const cid = this.game.playerCountryId;
        const c = this.game.playerCountry();
        const myArmies = this.game.armies.filter(a => a.owner === cid);
        const enemies = this.game.armies.filter(a => a.owner && a.owner !== cid);
        const intelligence = (c.buffs && c.buffs.intelligence) || 0;
        const selectedProv = this.game.selectedProvince ? this.game.provinceById(this.game.selectedProvince) : null;
        const unlockedTemplates = this.game.unlockedTemplates[cid] || ['infantry'];
        const stock = this.game.equipmentStock[cid] || {};
        return `
        <div class="panel-section">
            <h4>情报能力</h4>
            <div class="panel-row"><span class="pr-label">情报效率</span><span class="pr-value">${Math.round((1 + intelligence) * 100)}%</span></div>
            <div class="panel-row"><span class="pr-label">已破译技术</span><span class="pr-value">${this.game.hasTech(cid, 'cipher_machine') ? '✓ 密码机' : '未'}</span></div>
        </div>
        <div class="panel-section">
            <h4>组建军队</h4>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">
                部署省份：${selectedProv ? '<b style="color:var(--accent)">' + selectedProv.name + '</b>' : '<span style="color:var(--red)">请在地图上选择一个省份</span>'}
            </div>
            ${unlockedTemplates.map(t => {
                const tpl = DIVISION_TEMPLATES[t];
                if (!tpl) return '';
                const hasEquip = tpl.cost.equipment && Object.entries(tpl.cost.equipment).every(([eq, amt]) => (stock[eq] || 0) >= amt);
                const hasManpower = c.manpower >= (tpl.cost.manpower || 0);
                const ready = hasEquip && hasManpower && selectedProv;
                return `<button class="btn-action ${ready ? '' : ''}" data-create="${t}" ${ready ? '' : 'disabled'} title="${ready ? '组建' : '资源或人力不足'}">
                    ${tpl.icon} ${tpl.name} <span style="font-size:10px;color:var(--text-dim)">(人力${tpl.cost.manpower||0})</span>
                </button>`;
            }).join('')}
            <div style="font-size:11px;color:var(--text-dim);margin-top:6px">人力：${Math.round(c.manpower)} | 库存装备见经济面板</div>
        </div>
        <div class="panel-section">
            <h4>我方军队</h4>
            ${myArmies.map(a => {
                const prov = this.game.provinceById(a.provinceId);
                const tpl = DIVISION_TEMPLATES[a.type];
                return `<div class="army-card">
                    <div class="ac-name">${a.name}</div>
                    <div style="font-size:11px;color:var(--text-dim)">${tpl ? tpl.icon + ' ' + tpl.name : a.type} · ${prov ? prov.name : '?'}</div>
                    <div class="ac-strength">战力: ${Math.round(a.strength)} / ${Math.round(a.maxStrength)}</div>
                    <div style="margin-top:4px">
                        ${this.getNeighborProvinces(a.provinceId).filter(n => n.owner !== cid).map(n => `<button class="btn-action" data-move="${a.id}" data-target="${n.id}" style="padding:2px 6px;font-size:11px">→${n.name}</button>`).join('')}
                        <button class="btn-action" data-disband="${a.id}" style="padding:2px 6px;font-size:11px;margin-left:4px">解散</button>
                    </div>
                </div>`;
            }).join('') || '<div style="font-size:12px;color:var(--text-dim)">暂无军队</div>'}
        </div>
        <div class="panel-section">
            <h4>敌方动向</h4>
            ${enemies.length === 0 ? '<div style="font-size:12px;color:var(--text-dim)">未发现敌方军队</div>' :
                enemies.map(a => {
                    const prov = this.game.provinceById(a.provinceId);
                    const owner = this.game.countryById(a.owner);
                    return `<div class="army-card">
                        <div class="ac-name">${owner ? owner.flag + ' ' + owner.name : '?'}</div>
                        <div style="font-size:11px;color:var(--text-dim)">${prov ? prov.name : '?'}</div>
                        <div class="ac-strength">战力: ${Math.round(a.strength)}</div>
                    </div>`;
                }).join('')
            }
        </div>`;
    },

    getNeighborProvinces(provinceId) {
        return this.game.getNeighborProvinces(provinceId);
    },

    // ----- 日志 -----
    renderLog() {
        const log = this.game.log;
        if (log.length === 0) return '<div style="font-size:12px;color:var(--text-dim)">暂无日志</div>';
        return `<div class="panel-section"><h4>事件日志</h4>
            ${log.map(l => `<div class="log-entry"><span class="le-date">${l.date}</span>${l.msg}</div>`).join('')}
        </div>`;
    },

    // ===================== 省份信息面板 =====================
    updateProvincePanel() {
        // 如果当前在情报面板，刷新；否则在面板顶部显示省份信息
        if (this.currentPanel !== 'intelligence') {
            // 不切换面板，仅在地图 tooltip 已处理
        }
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

    // ===================== 国家焦点弹窗 =====================
    showFocusPopup(focus) {
        const cid = this.game.playerCountryId;
        const f = this.game.focuses[cid];
        const done = f && f.done.includes(focus.id);
        const available = f && focus.requires.every(r => f.done.includes(r)) && !done;

        const reqText = focus.requires.length > 0
            ? `<p style="color:var(--text-dim);font-size:12px;margin-top:8px">前置焦点：${focus.requires.map(r => (FOCUSES.find(x => x.id === r) || {}).name || r).join('、')}</p>`
            : '<p style="color:var(--text-dim);font-size:12px;margin-top:8px">无前置要求，可直接执行</p>';

        const body = `
            <div style="text-align:center;margin-bottom:15px">
                <div style="font-size:42px;line-height:1">${focus.icon}</div>
                <h3 style="color:var(--accent);margin:12px 0 4px">${focus.name}</h3>
            </div>
            <p style="line-height:1.7;margin-bottom:10px"><b>效果：</b>${focus.effect}</p>
            ${reqText}
            ${done ? '<p style="color:var(--green);font-size:13px">✓ 该焦点已完成</p>' : ''}
        `;

        const buttons = [
            { text: '取消', action: () => this.closeModal() },
        ];
        if (available && !done) {
            buttons.push({
                text: '执行焦点', cls: 'primary',
                action: () => {
                    const result = this.game.startFocus(cid, focus.id);
                    this.closeModal();
                    if (!result) {
                        this.showModal('提示', '<p>该焦点无法执行。</p>', [
                            { text: '确定', cls: 'primary', action: () => this.closeModal() }
                        ]);
                    }
                    this.refreshAll();
                }
            });
        } else if (done) {
            // 已完成的焦点只显示关闭按钮
        }

        this.showModal(focus.name, body, buttons);
    },

    // ===================== 事件弹窗 =====================
    showEvent(evt) {
        document.getElementById('eventTitle').textContent = evt.title;
        document.getElementById('eventText').textContent = evt.text;
        const choices = document.getElementById('eventChoices');
        choices.innerHTML = '';
        evt.choices.forEach((choice, i) => {
            const btn = document.createElement('button');
            btn.className = 'event-choice';
            btn.textContent = choice.text;
            btn.onclick = () => this.game.resolveEvent(i);
            choices.appendChild(btn);
        });
        document.getElementById('eventOverlay').classList.remove('hidden');
    },

    // ===================== 面板交互绑定 =====================
    bindPanelActions(panel) {
        // 焦点 - 弹出详情弹窗
        document.querySelectorAll('[data-focus]').forEach(el => {
            el.addEventListener('click', () => {
                const focusId = el.dataset.focus;
                const focus = FOCUSES.find(f => f.id === focusId);
                if (focus) this.showFocusPopup(focus);
            });
        });
        // 生产
        document.querySelectorAll('[data-prod-add]').forEach(el => {
            el.addEventListener('click', () => {
                const eq = el.dataset.prodAdd;
                const queue = this.game.production[this.game.playerCountryId];
                if (queue.length < 4 && !queue.some(q => q.equipment === eq)) {
                    queue.push({ equipment: eq, amount: 10, priority: 1 });
                    this.refreshAll();
                }
            });
        });
        document.querySelectorAll('[data-prod-remove]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.prodRemove);
                this.game.production[this.game.playerCountryId].splice(idx, 1);
                this.refreshAll();
            });
        });
        // 科技
        document.querySelectorAll('[data-tech]').forEach(el => {
            el.addEventListener('click', () => {
                const techId = el.dataset.tech;
                const r = this.game.research[this.game.playerCountryId];
                const tech = TECHS.find(t => t.id === techId);
                if (!tech) return;
                if (r.completed.includes(techId)) return;
                if (r.researching.length >= r.slots) return;
                if (!tech.requires.every(req => r.completed.includes(req))) return;
                if (r.researching.some(x => x.techId === techId)) return;
                r.researching.push({ techId, progress: 0 });
                this.refreshAll();
            });
        });
        // 外交
        document.querySelectorAll('[data-diplo]').forEach(el => {
            el.addEventListener('click', () => {
                const type = el.dataset.diplo;
                const target = el.dataset.target;
                const cid = this.game.playerCountryId;
                if (type === 'war') this.game.declareWar(cid, target);
                else if (type === 'peace') this.game.makePeace(cid, target);
                else if (type === 'alliance') this.game.formAlliance(cid, target);
                else if (type === 'relation') {
                    const f = this.game.factories[cid];
                    if (f.civilian >= 2) { f.civilian -= 2; this.game.addRelation(cid, target, 8); }
                }
                this.refreshAll();
            });
        });
        // 军队创建
        document.querySelectorAll('[data-create]').forEach(el => {
            el.addEventListener('click', () => {
                const type = el.dataset.create;
                const provId = this.game.selectedProvince;
                if (!provId) { this.showModal('提示', '<p>请先在地图上选择一个省份作为部署地点。</p>', [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]); return; }
                const result = this.game.createArmy(this.game.playerCountryId, provId, type);
                if (!result) {
                    this.showModal('无法组建', '<p>人力或装备库存不足，无法组建该类型部队。</p>', [{ text: '确定', cls: 'primary', action: () => this.closeModal() }]);
                }
                this.refreshAll();
            });
        });
        // 军队移动/解散
        document.querySelectorAll('[data-move]').forEach(el => {
            el.addEventListener('click', () => {
                const armyId = parseInt(el.dataset.move);
                const target = el.dataset.target;
                this.game.moveArmy(armyId, target);
                this.refreshAll();
            });
        });
        document.querySelectorAll('[data-disband]').forEach(el => {
            el.addEventListener('click', () => {
                this.game.disbandArmy(parseInt(el.dataset.disband));
                this.refreshAll();
            });
        });
    },
};

if (typeof window !== 'undefined') window.UI = UI;
