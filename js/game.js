/* ============================================================
 * 钢铁雄心4 网页版 - 游戏门面 game.js
 * 架构（按战役系统实现指南）：
 *   模拟层 = Campaign 核心（Clock + WorldState + Command + Rules）
 *   本文件 = 门面：地图与 UI 只通过它读快照、发命令，不直接改状态。
 *   战斗结算不在本层范围（指南界定：军队只保留存在性与数量，供呈现与 AI 评估）。
 * ============================================================ */

const Game = {
    campaign: null,        // Campaign 实例（模拟层）
    playerTag: null,       // 玩家国家 tag（GER/POL/FRA）
    selectedProvince: null,
    selectedArmy: null,    // 选中的部队 id（地图上点击相邻省份即可移动）
    tool: 'move',
    _mapIndex: null,       // 地图 index.json（省份名称/邻接/bbox）

    // ===================== 初始化 =====================

    /**
     * 准备新游戏：加载 l10n 与剧本（含校验），构建 Campaign 实例（尚未开局）。
     * 返回 campaign，供开始界面渲染国家选择。
     */
    async prepareNewGame() {
        const { Campaign, loadL10n } = window.Core;

        // 本地化（数据里只存 key，文案在 l10n）
        const l10nData = await fetch('data/l10n/zh.json').then(r => r.json());
        loadL10n(l10nData, 'zh');

        // 加载并校验剧本
        this.campaign = await Campaign.create('1936', {
            fetchJson: async (url) => (await fetch(url)).json(),
        });
        return this.campaign;
    },

    /**
     * 以指定国家开局：构建初始状态、设定玩家、挂接模拟层事件。
     * @param {string} tag 玩家国家 tag
     */
    startWith(tag) {
        this.campaign.newGame();

        // 玩家设定（剧本默认玩家可被选择覆盖）
        this.playerTag = tag;
        this.campaign.state.players = { [tag]: { tag, isHuman: true } };

        this.selectedProvince = null;
        this.selectedArmy = null;
        this.tool = 'move';

        // 归属就绪，让地图填充缓存失效并重绘
        if (typeof MapView !== 'undefined' && MapView.invalidateFills) MapView.invalidateFills();

        // 模拟层事件 → UI
        this.campaign.on('victory', ({ victory }) => { if (UI) UI.showVictory(victory); });
        this.campaign.on('event', ({ eventId, event }) => { if (UI) UI.showCampaignEvent(eventId, event); });

        return this.campaign;
    },

    /** 便捷组合：准备 + 开局 */
    async newGame(tag) {
        await this.prepareNewGame();
        return this.startWith(tag);
    },

    /** 地图数据加载完成后注入省份元数据（名称/邻接/bbox） */
    loadProvinceData(index) {
        this._mapIndex = index;
        // 邻接表是部队移动判定的依据，必须同步给模拟层
        if (this.campaign) this.campaign.setMapIndex(index);
    },

    // ===================== 模拟层访问 =====================

    get state() { return this.campaign ? this.campaign.state : null; },
    get clock() { return this.campaign ? this.campaign.clock : null; },
    get index() { return this._mapIndex; },   // 地图索引（邻接表 / 省份元数据）

    get speed() { return this.campaign ? this.campaign.clock.speed : 0; },
    set speed(v) { if (this.campaign) this.campaign.clock.setSpeed(v); },

    /** 命令唯一入口 */
    command(cmd) {
        if (!this.campaign) return { ok: false, err: '游戏未初始化' };
        const r = this.campaign.command(cmd);
        // 归属等状态变化后让地图填充缓存失效并重绘
        if (r.ok && typeof MapView !== 'undefined' && MapView.invalidateFills) MapView.invalidateFills();
        return r;
    },

    /**
     * 按钮禁用态查询：与命令校验同源（纯函数，不改状态）。
     * 返回 null 表示可执行，否则返回 { ok:false, err }。
     */
    canCommand(cmd) {
        if (!this.campaign) return { ok: false, err: '游戏未初始化' };
        return window.Core.validateCommand(cmd, this.campaign.state, this.campaign.ctx());
    },

    // ===================== 查询（读快照） =====================

    countryById(tag) {
        return this.state?.countries?.[tag] || null;
    },
    playerCountry() { return this.countryById(this.playerTag); },

    /** 国家显示名（解析 l10n key） */
    countryDisplayName(tag) {
        const c = this.countryById(tag);
        if (!c) return tag;
        try { return window.Core.t(c.name); } catch { return c.name; }
    },

    /**
     * 省份当前控制方。
     * 剧本省份取战役状态里的 controller；非剧本省份（地图上大量没有剧本数据的
     * 省份）回退到地图元数据里的原始 ISO3 归属，可玩国家换算为战役 tag。
     * 这样地图上任何省份都有明确归属，不会出现「无主」。
     */
    ownerOf(id) {
        const st = this.state?.provinces?.[id];
        if (st) return st.controller ?? null;
        const iso = this._mapIndex?.meta?.[String(id)]?.owner;
        if (!iso) return null;
        return this.countryIdByIso3(iso) || iso;
    },

    /**
     * 省份视图：合并战役状态（归属/地形/供给）与地图元数据（名称/bbox/邻接）。
     * 地图拾取、tooltip、省份面板都读这里。
     */
    provinceById(id) {
        const st = this.state?.provinces?.[id];
        const meta = this._mapIndex?.meta?.[String(id)];
        if (!st && !meta) return null;
        return {
            id,
            name: meta?.name || String(id),
            terrain: st?.terrain || 'plains',
            controller: this.ownerOf(id),
            supply: st?.supply ?? 0,
            infrastructure: st?.infrastructure ?? 0,
            damage: st?.damage ?? 0,
            bbox: meta?.bbox,
            neighbors: this._mapIndex?.neighbors?.[String(id)]?.map(Number) ?? [],
        };
    },

    provincesOf(tag) {
        const out = [];
        if (!this.state) return out;
        for (const p of Object.values(this.state.provinces)) {
            if (p.controller === tag) out.push(this.provinceById(p.id));
        }
        return out;
    },

    /** ISO3 → 战役 tag（地图前线索引用） */
    countryIdByIso3(iso3) {
        const map = { DEU: 'GER', POL: 'POL', FRA: 'FRA' };
        return map[iso3] || null;
    },

    areAtWar(a, b) {
        return this.state?.wars?.some((w) => w.status === 'active' &&
            ((w.a === a && w.b === b) || (w.a === b && w.b === a))) || false;
    },

    isWarFor(tag) {
        return this.state?.countries?.[tag]?.flags?.atWar === true;
    },

    formatDate() {
        if (!this.campaign) return '—';
        return window.Core.formatDate(this.campaign.clock.date);
    },

    /** 驻军存在性（仅呈现，无战斗结算） */
    garrisons() {
        const out = [];
        if (!this.state) return out;
        for (const [tag, c] of Object.entries(this.state.countries)) {
            for (const [pid, count] of Object.entries(c.garrison || {})) {
                out.push({ owner: tag, provinceId: Number(pid), count });
            }
        }
        return out;
    },

    // ===================== 内容访问（装备 / 科技 / 部队模板） =====================

    get equipment() { return this.campaign?.content?.equipment || {}; },
    get techs() { return this.campaign?.content?.techs || {}; },
    get divisions() { return this.campaign?.content?.divisions || {}; },

    /** 该国已解锁、可部署的部队模板 id 列表 */
    availableTemplates(tag) {
        const c = this.countryById(tag);
        if (!c) return [];
        return (c.unlockedTemplates || []).filter((id) => this.divisions[id]);
    },

    /** AI 接管开关（AI-only 模式 / 压测） */
    get aiEnabled() { return !!this.campaign?.aiEnabled; },
    setAI(enabled) { return this.campaign ? this.campaign.setAI(enabled) : false; },

    /** 最近一次经济 / 军事结算结果（供面板展示） */
    get lastEconomy() { return this.campaign?.lastEconomy || null; },
    get lastWar() { return this.campaign?.lastWar || null; },

    // ===================== 军队 =====================

    armyById(id) { return this.state?.armies?.find((a) => a.id === id) || null; },
    armiesOf(tag) { return (this.state?.armies || []).filter((a) => a.owner === tag); },
    armiesIn(provinceId) { return (this.state?.armies || []).filter((a) => a.provinceId === provinceId); },
    allArmies() { return this.state?.armies || []; },

    /** 目标省份是否与某省相邻（部队移动前的按钮禁用态，与命令校验同源） */
    isAdjacent(fromId, toId) {
        if (!this.campaign) return false;
        return window.Core.isAdjacent(this.campaign.ctx(), fromId, toId);
    },

    /** 部队模板的人力与装备消耗（面板展示用） */
    divisionCost(templateId) {
        const tpl = this.divisions[templateId];
        if (!tpl) return null;
        return { manpower: tpl.cost.manpower, equipment: tpl.cost.equipment || {} };
    },

    // ===================== 国策 / 决议可用性（UI 用，与 validate 同源） =====================

    availableFocuses(tag) {
        const c = this.countryById(tag);
        if (!c?.focusTree || !this.campaign) return [];
        const tree = this.campaign.content.focusTrees[c.focusTree];
        if (!tree) return [];
        const done = this.state.focuses[tag].done;
        return Object.entries(tree.nodes)
            .filter(([id]) => !done.includes(id))
            .map(([id, node]) => ({
                id,
                node,
                available: !c.activeFocus &&
                    (node.prerequisites || []).every((p) => done.includes(p)) &&
                    Object.entries(node.requires || {}).every(([k, v]) => (c[k] ?? 0) >= v) &&
                    (c.politicalPower ?? 0) >= (node.cost ?? 0),
            }));
    },

    availableDecisions(tag) {
        const out = [];
        if (!this.campaign) return out;
        for (const [id, dec] of Object.entries(this.campaign.content.decisions)) {
            if (dec.scope !== 'any' && dec.scope !== tag) continue;
            out.push({ id, decision: dec });
        }
        return out;
    },

    // ===================== 交互 =====================

    selectProvince(id) {
        this.selectedProvince = id;
        // 切到不包含已选部队的省份时，取消部队选择（移动流程由 MapView 单独处理）
        if (this.selectedArmy != null) {
            const army = this.armyById(this.selectedArmy);
            if (!army || army.provinceId !== id) this.selectedArmy = null;
        }
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
    },

    /** 选中一支部队（地图标记 / 省份速览卡 / 部队面板共用；只允许玩家自己的部队） */
    selectArmy(id) {
        const army = this.armyById(id);
        if (!army) return;
        if (this.playerTag && army.owner !== this.playerTag) return;
        this.selectedArmy = id;
        this.selectedProvince = army.provinceId;
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
    },

    /** 取消部队选择（右键 / Esc） */
    clearArmySelection() {
        if (this.selectedArmy == null) return;
        this.selectedArmy = null;
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
    },

    /**
     * 已选中部队的可移动方向（地图移动范围、面板下拉共用）。
     * 返回 [{ id, name, controller, ok, err }]，ok 与命令校验同源。
     */
    moveOptionsFor(armyId) {
        const army = this.armyById(armyId);
        if (!army) return [];
        const ids = this._mapIndex?.neighbors?.[String(army.provinceId)] || [];
        return ids.map(Number).map((id) => {
            const p = this.provinceById(id);
            const blocked = this.canCommand({ t: 'moveArmy', armyId: army.id, to: id, country: army.owner });
            return {
                id,
                name: p?.name || String(id),
                controller: p?.controller ?? null,
                ok: !blocked,
                err: blocked?.err || null,
            };
        });
    },

    /**
     * 移动已选中部队。成功后保留选中态，便于连续点击推进。
     * @returns 命令结果 { ok, err? }
     */
    moveSelectedArmy(to) {
        const armyId = this.selectedArmy;
        if (armyId == null) return { ok: false, err: '未选中部队' };
        const army = this.armyById(armyId);
        if (!army) {
            this.selectedArmy = null;
            return { ok: false, err: '部队不存在' };
        }
        const r = this.command({ t: 'moveArmy', armyId, to, country: army.owner });
        if (r.ok) {
            // 入场战斗可能把这支部队打光，销毁后不再保留选中态
            const after = this.armyById(armyId);
            if (!after || after.strength <= 0) this.selectedArmy = null;
            this.selectedProvince = to;
            if (UI) UI.updateProvincePanel();
            if (MapView) MapView.requestDraw();
        }
        return r;
    },

    // ===================== 存档 / 读取 =====================

    save() {
        if (!this.campaign) return false;
        const data = this.campaign.save();
        data.meta.playerTag = this.playerTag;
        // JSON 序列化会丢失 TypedArray：rngState 转普通数组，读档时由 Rng.loadState 兼容恢复
        if (data.snapshot.rngState) data.snapshot.rngState = Array.from(data.snapshot.rngState);
        try {
            localStorage.setItem('hoi4_campaign_save', JSON.stringify(data));
            return true;
        } catch {
            return false;
        }
    },

    load() {
        try {
            const raw = localStorage.getItem('hoi4_campaign_save');
            if (!raw || !this.campaign) return false;
            const data = JSON.parse(raw);
            this.campaign.restore(data);
            this.playerTag = data.meta.playerTag || this.playerTag;
            // 读档后旧的选中引用可能已不存在
            this.selectedProvince = null;
            this.selectedArmy = null;
            if (MapView.invalidateFills) MapView.invalidateFills();
            return true;
        } catch {
            return false;
        }
    },

    hasSave() {
        return !!localStorage.getItem('hoi4_campaign_save');
    },
};

if (typeof window !== 'undefined') window.Game = Game;
