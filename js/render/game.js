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
    selectedAir: null,     // 选中的空军群 id
    selectedFleet: null,   // 选中的舰队 id
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

        // 存档读写接口：模拟层不直接依赖 localStorage，由渲染层注入
        const storage = {
            read: (key) => {
                try { return localStorage.getItem(key); } catch { return null; }
            },
            write: (key, value) => {
                try {
                    localStorage.setItem(key, value);
                } catch (err) {
                    throw new Error('存档写入失败：本地存储空间不足或被浏览器策略拒绝');
                }
            },
        };

        // 加载并校验剧本
        this.campaign = await Campaign.create('1936', {
            fetchJson: async (url) => (await fetch(url)).json(),
            storage,
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
        this.selectedAir = null;
        this.selectedFleet = null;
        this.tool = 'move';

        // 归属就绪，让地图填充缓存失效并重绘
        if (typeof MapView !== 'undefined' && MapView.invalidateFills) MapView.invalidateFills();

        // 模拟层事件 → UI
        this.campaign.on('victory', ({ victory }) => { if (UI) UI.showVictory(victory); });
        this.campaign.on('event', ({ eventId, event }) => { if (UI) UI.showCampaignEvent(eventId, event); });
        this.campaign.on('peace', ({ offer }) => { if (UI) UI.showPeaceConference(offer); });

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
            fortLevel: st?.fortLevel ?? 0,
            damage: st?.damage ?? 0,
            coastal: st?.coastal ?? !!meta?.coastal,
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

    /** 战役 tag → 地图层 ISO3（除德国外，可玩国家的 tag 与 ISO3 相同） */
    ISO_BY_TAG: { GER: 'DEU' },
    isoOfTag(tag) {
        return this.ISO_BY_TAG[tag] || tag;
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

    /** 省份所属的州（无则返回 null） */
    stateOfProvince(provinceId) {
        const states = this.state?.states || {};
        for (const st of Object.values(states)) {
            if (st.provinces.includes(provinceId)) return st;
        }
        return null;
    },

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

    // ===================== 空军 / 海军 =====================

    get aircraft() { return this.campaign?.content?.aircraft || {}; },
    get ships() { return this.campaign?.content?.ships || {}; },

    airForceById(id) { return this.state?.airForces?.find((g) => g.id === id) || null; },
    airForcesOf(tag) { return (this.state?.airForces || []).filter((g) => g.owner === tag); },
    airForcesIn(provinceId) { return (this.state?.airForces || []).filter((g) => g.provinceId === provinceId); },
    allAirForces() { return this.state?.airForces || []; },

    fleetById(id) { return this.state?.fleets?.find((f) => f.id === id) || null; },
    fleetsOf(tag) { return (this.state?.fleets || []).filter((f) => f.owner === tag); },
    fleetsIn(provinceId) { return (this.state?.fleets || []).filter((f) => f.provinceId === provinceId); },
    allFleets() { return this.state?.fleets || []; },

    /** 该国已解锁、可部署的飞机型号 */
    availableAir(tag) {
        const c = this.countryById(tag);
        if (!c) return [];
        return (c.unlockedAir || []).filter((id) => this.aircraft[id]);
    },

    /** 该国已解锁、可部署的舰种 */
    availableShips(tag) {
        const c = this.countryById(tag);
        if (!c) return [];
        return (c.unlockedShips || []).filter((id) => this.ships[id]);
    },

    /** 飞机型号的装备消耗（面板展示用） */
    aircraftCost(templateId) {
        const tpl = this.aircraft[templateId];
        if (!tpl) return null;
        return { equipment: tpl.cost.equipment || {}, planes: tpl.planes };
    },

    /** 舰种的装备消耗（面板展示用） */
    shipCost(templateId) {
        const tpl = this.ships[templateId];
        if (!tpl) return null;
        return { equipment: tpl.cost.equipment || {}, ships: tpl.ships };
    },

    /** 目标省份是否为沿海（舰队部署前的按钮禁用态） */
    isCoastal(id) {
        return !!this.provinceById(id)?.coastal;
    },

    // ===================== 外交查询 =====================

    factionOf(tag) { return window.Core.factionOf(this.state, tag); },
    factionById(id) { return window.Core.factionById(this.state, id); },
    factionMembers(tag) { return window.Core.factionMembers(this.state, tag); },
    factionLeader(factionId) { return window.Core.factionLeader(this.state, factionId); },

    /** 与该国交战的所有国家（含阵营战争） */
    warOpponents(tag) { return window.Core.warOpponents(this.state, tag); },

    peaceOffers() { return this.state?.peaceOffers || []; },
    factionInvites() { return this.state?.factionInvites || []; },
    lendLeaseOf(tag) { return this.state?.lendLease?.[tag] || {}; },

    /** 该国进行中的战争（含战争目标与分数） */
    warsOf(tag) {
        return (this.state?.wars || []).filter((w) =>
            w.status !== 'ended' &&
            ((w.alliesA || [w.a]).includes(tag) || (w.alliesB || [w.b]).includes(tag)));
    },

    /** 最近一次空中 / 海上结算结果（面板展示） */
    get lastAirNavy() { return this.campaign?.lastAirNavy || null; },

    /** 补给网络（省份 → 补给系数），面板展示部队是否被切断 */
    supplyMap() { return this.campaign?._supply || new Map(); },

    /** 部队的补给系数（0 = 被切断） */
    supplyFactor(provinceId) {
        const map = this.supplyMap();
        if (map.size === 0) return null;
        return map.get(provinceId) ?? 0;
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
        // 切到不包含已选单位的省份时，取消单位选择（移动流程由 MapView 单独处理）
        this.clearStaleSelection();
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
    },

    /** 选中态与实际单位位置不同步时清空（省份切换、单位被消灭、读档后） */
    clearStaleSelection() {
        if (this.selectedArmy != null) {
            const army = this.armyById(this.selectedArmy);
            if (!army || army.strength <= 0 || army.provinceId !== this.selectedProvince) this.selectedArmy = null;
        }
        if (this.selectedAir != null) {
            const g = this.airForceById(this.selectedAir);
            if (!g || g.planes <= 0 || g.provinceId !== this.selectedProvince) this.selectedAir = null;
        }
        if (this.selectedFleet != null) {
            const f = this.fleetById(this.selectedFleet);
            if (!f || f.ships <= 0 || f.provinceId !== this.selectedProvince) this.selectedFleet = null;
        }
    },

    /** 选中一支部队（地图标记 / 省份速览卡 / 部队面板共用；只允许玩家自己的部队） */
    selectArmy(id) {
        const army = this.armyById(id);
        if (!army || army.strength <= 0) return;
        if (this.playerTag && army.owner !== this.playerTag) return;
        this.selectedArmy = id;
        this.selectedAir = null;
        this.selectedFleet = null;
        this.selectedProvince = army.provinceId;
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
    },

    /** 选中一个空军群 */
    selectAirForce(id) {
        const g = this.airForceById(id);
        if (!g || g.planes <= 0) return;
        if (this.playerTag && g.owner !== this.playerTag) return;
        this.selectedAir = id;
        this.selectedArmy = null;
        this.selectedFleet = null;
        this.selectedProvince = g.provinceId;
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
    },

    /** 选中一支舰队 */
    selectFleet(id) {
        const f = this.fleetById(id);
        if (!f || f.ships <= 0) return;
        if (this.playerTag && f.owner !== this.playerTag) return;
        this.selectedFleet = id;
        this.selectedArmy = null;
        this.selectedAir = null;
        this.selectedProvince = f.provinceId;
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
    },

    /** 取消单位选择（右键 / Esc） */
    clearArmySelection() {
        this.selectedArmy = null;
        this.selectedAir = null;
        this.selectedFleet = null;
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.requestDraw();
    },

    /** 当前选中的单位类型与 id：'army' | 'air' | 'fleet' | null */
    get selectedUnit() {
        if (this.selectedArmy != null) return { kind: 'army', id: this.selectedArmy };
        if (this.selectedAir != null) return { kind: 'air', id: this.selectedAir };
        if (this.selectedFleet != null) return { kind: 'fleet', id: this.selectedFleet };
        return null;
    },

    /** 按类型取单位实体 */
    unitByKind(kind, id) {
        if (kind === 'army') return this.armyById(id);
        if (kind === 'air') return this.airForceById(id);
        if (kind === 'fleet') return this.fleetById(id);
        return null;
    },

    /** 单位移动命令的构造（与命令校验同源） */
    moveCommandFor(kind, id, to, owner) {
        if (kind === 'army') return { t: 'moveArmy', armyId: id, to, country: owner };
        if (kind === 'air') return { t: 'moveAirForce', airId: id, to };
        if (kind === 'fleet') return { t: 'moveFleet', fleetId: id, to };
        return null;
    },

    /**
     * 已选中单位的可移动方向（地图移动范围、面板下拉共用）。
     * 返回 [{ id, name, controller, ok, err }]，ok 与命令校验同源。
     */
    moveOptionsFor(id, kind = 'army') {
        const item = this.unitByKind(kind, id);
        if (!item) return [];
        const ids = this._mapIndex?.neighbors?.[String(item.provinceId)] || [];
        return ids.map(Number).map((pid) => {
            const p = this.provinceById(pid);
            const blocked = this.canCommand(this.moveCommandFor(kind, item.id, pid, item.owner));
            return {
                id: pid,
                name: p?.name || String(pid),
                controller: p?.controller ?? null,
                ok: !blocked,
                err: blocked?.err || null,
            };
        });
    },

    /**
     * 移动已选中单位（部队 / 空军 / 舰队通用）。成功后保留选中态，便于连续点击推进。
     * @returns 命令结果 { ok, err? }
     */
    moveSelected(kind, to) {
        const id = kind === 'army' ? this.selectedArmy : kind === 'air' ? this.selectedAir : this.selectedFleet;
        if (id == null) return { ok: false, err: '未选中单位' };
        const item = this.unitByKind(kind, id);
        if (!item) {
            if (kind === 'army') this.selectedArmy = null;
            if (kind === 'air') this.selectedAir = null;
            if (kind === 'fleet') this.selectedFleet = null;
            return { ok: false, err: '单位不存在' };
        }
        const r = this.command(this.moveCommandFor(kind, id, to, item.owner));
        if (r.ok) {
            // 入场战斗/空战可能把该单位打光，销毁后不再保留选中态
            const after = this.unitByKind(kind, id);
            const alive = kind === 'army' ? after && after.strength > 0
                : kind === 'air' ? after && after.planes > 0 : after && after.ships > 0;
            if (!alive) {
                if (kind === 'army') this.selectedArmy = null;
                if (kind === 'air') this.selectedAir = null;
                if (kind === 'fleet') this.selectedFleet = null;
            }
            this.selectedProvince = to;
            if (UI) UI.updateProvincePanel();
            if (MapView) MapView.requestDraw();
        }
        return r;
    },

    /** 移动已选中部队（部队面板与地图共用） */
    moveSelectedArmy(to) {
        return this.moveSelected('army', to);
    },

    /**
     * 让一支部队沿最短路径向最近的敌方省份推进一格。
     * 与「进攻」指令同源（指令由每 tick 的结算自动执行，这里是手动单步）。
     */
    advanceArmyOneStep(armyId) {
        const army = this.armyById(armyId);
        if (!army || army.strength <= 0) return { ok: false, err: '部队不存在' };
        const to = window.Core.nextStepTowardEnemy(this.state, this.campaign.ctx(), army.provinceId, army.owner);
        if (to == null) return { ok: false, err: '附近没有可推进的敌方方向' };
        return this.command({ t: 'moveArmy', armyId, to, country: army.owner });
    },

    // ===================== 存档 / 读取 =====================

    save() {
        if (!this.campaign) return false;
        // 手动存档用全量快照：最稳妥，读档路径最简单
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

    /** 增量存档：只保存自基线以来变化过的字段（菜单里的可选存档方式） */
    saveIncremental() {
        if (!this.campaign) return false;
        const data = this.campaign.saveIncremental();
        data.meta.playerTag = this.playerTag;
        if (data.snapshot?.rngState) data.snapshot.rngState = Array.from(data.snapshot.rngState);
        if (data.base?.snapshot?.rngState) data.base.snapshot.rngState = Array.from(data.base.snapshot.rngState);
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
            this.selectedAir = null;
            this.selectedFleet = null;
            if (MapView.invalidateFills) MapView.invalidateFills();
            // 读档时若已有待回应的和平提议，直接呈现（事件只在产生当 tick 抛出）
            const pending = this.state?.peaceOffers?.find((o) => o.to === this.playerTag);
            if (pending && UI) UI.showPeaceConference(pending);
            return true;
        } catch {
            return false;
        }
    },

    hasSave() {
        try {
            return !!localStorage.getItem('hoi4_campaign_save');
        } catch {
            return false;
        }
    },

    hasAutosave() {
        try {
            return !!localStorage.getItem('hoi4_campaign_autosave');
        } catch {
            return false;
        }
    },

    /** 读取自动存档（供「继续游戏」的备份入口使用） */
    loadAutosave() {
        try {
            const raw = localStorage.getItem('hoi4_campaign_autosave');
            if (!raw || !this.campaign) return false;
            if (!this.campaign.restore(JSON.parse(raw))) return false;
            this.selectedProvince = null;
            this.selectedArmy = null;
            if (MapView.invalidateFills) MapView.invalidateFills();
            return true;
        } catch {
            return false;
        }
    },
};

if (typeof window !== 'undefined') window.Game = Game;
