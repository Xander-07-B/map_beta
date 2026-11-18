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
    },

    // ===================== 模拟层访问 =====================

    get state() { return this.campaign ? this.campaign.state : null; },
    get clock() { return this.campaign ? this.campaign.clock : null; },

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
            controller: st?.controller ?? null,
            supply: st?.supply ?? 0,
            infrastructure: st?.infrastructure ?? 0,
            damage: st?.damage ?? 0,
            bbox: meta?.bbox,
            neighbors: this._mapIndex?.neighbors?.[String(id)]?.map(Number) ?? [],
        };
    },

    /** 省份当前控制方（战役状态）；非剧本省份返回 null，地图回退到原始 ISO3 归属 */
    ownerOf(id) {
        return this.state?.provinces?.[id]?.controller ?? null;
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
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
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
