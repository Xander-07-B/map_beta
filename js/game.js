/* ============================================================
 * 钢铁雄心4 网页版 - 核心游戏逻辑 game.js
 * 负责：状态、时间、经济、科技、生产、军队、战斗、焦点、事件
 * ============================================================ */

const Game = {
    // === 状态 ===
    date: { ...GAME.START_DATE },
    running: false,
    speed: 0,
    provinces: [],          // 运行时省份（含归属）
    countries: {},         // id -> 运行时国家状态
    playerCountryId: null,
    selectedProvince: null,
    tool: 'move',

    // === 运行时数据 ===
    research: {},           // 国家id -> { researching: [{techId, progress}], completed: [techId], slots: n, speed }
    production: {},        // 国家id -> 生产队列 [{equipment, amount, priority}]
    factories: {},         // 国家id -> { civilian, military, construction }
    armies: [],            // 所有军队 [{id, owner, provinceId, type, strength, equipment, experience}]
    equipmentStock: {},    // 国家id -> { equipmentId: amount }
    focuses: {},           // 国家id -> { done: [focusId], active: focusId|null }
    pendingEvents: [],
    activeEvent: null,
    log: [],
    nextArmyId: 1,
    tickAccumulator: 0,

    // ===================== 初始化 =====================
    newGame(countryId) {
        this.date = { ...GAME.START_DATE };
        this.running = true;
        this.speed = 1;
        this.selectedProvince = null;
        this.tool = 'move';
        this.armies = [];
        this.log = [];
        this.nextArmyId = 1;
        this.pendingEvents = [];
        this.activeEvent = null;
        this.tickAccumulator = 0;
        this.resourceStock = {};
        this.unlockedTemplates = {};
        this.unlockedEquipment = {};

        // 初始化省份运行时数据
        this.provinces = PROVINCES.map(p => ({
            ...p,
            owner: null,          // 归属国家id
            infrastructure: 0,
            garrison: 0,
            conqueredBy: null,
        }));
        // 重新映射省份id -> 对象
        this._provinceMap = {};
        for (const p of this.provinces) this._provinceMap[p.id] = p;

        // 初始化国家
        this.countries = {};
        for (const cdef of COUNTRIES) {
            this.countries[cdef.id] = this.initCountry(cdef);
        }
        // 分配省份归属
        for (const p of this.provinces) {
            const ownerDef = COUNTRIES.find(c => c.provinces.includes(p.id));
            p.owner = ownerDef ? ownerDef.id : null;
        }

        this.playerCountryId = countryId;

        // 玩家初始分配一些装备库存
        this.equipmentStock[countryId] = this.computeInitialEquipment(countryId);

        // 为所有国家初始化研究/生产
        for (const cid of Object.keys(this.countries)) {
            this.research[cid] = { completed: [], researching: [], slots: 1, speed: 1.0 };
            this.production[cid] = [];
            this.factories[cid] = {
                civilian: this.countries[cid].civilianFactories,
                military: this.countries[cid].militaryFactories,
                construction: 0,
            };
            this.focuses[cid] = { done: [], active: null };
            // 开局解锁基础装备与部队模板
            this.unlockedEquipment[cid] = ['infantry_weapon', 'artillery', 'truck'];
            this.unlockedTemplates[cid] = ['infantry', 'cavalry'];
            // 分配初始装备库存（所有国家，AI 才能组建军队）
            this.equipmentStock[cid] = this.computeInitialEquipment(cid);
        }

        // 触发初始事件检查
        this.checkEvents('init');
        this.logMsg(`游戏开始，您选择了【${this.playerCountry().name}】`);
    },

    initCountry(cdef) {
        const c = {
            id: cdef.id,
            name: cdef.name,
            flag: cdef.flag,
            color: cdef.color,
            ideology: cdef.ideology,
            tag: cdef.tag,
            aiTags: cdef.aiTags || [],
            manpower: cdef.manpower,
            maxManpower: cdef.manpower,
            stability: cdef.stability,
            warSupport: cdef.warSupport,
            population: cdef.population,
            civilianFactories: cdef.civilianFactories,
            militaryFactories: cdef.militaryFactories,
            provinces: [...cdef.provinces],
            relations: {},       // 与其他国家关系
            alliances: [],       // 盟国id
            isPlayer: false,
            // 修正值
            resourceIncomeMod: 1.0,
            factoryMod: 1.0,
        };
        // 初始化外交关系
        for (const other of COUNTRIES) {
            if (other.id === c.id) continue;
            c.relations[other.id] = 0;
        }
        return c;
    },

    computeInitialEquipment(countryId) {
        const stock = {};
        const c = this.countryById(countryId);
        // 根据工业能力给予初始装备
        const mil = c.militaryFactories;
        const amount = Math.max(0, Math.floor(mil * 2));
        stock['infantry_weapon'] = amount;
        stock['artillery'] = Math.floor(amount * 0.3);
        stock['truck'] = Math.floor(amount * 0.2);
        return stock;
    },

    // ===================== 查询辅助 =====================
    playerCountry() { return this.countryById(this.playerCountryId); },
    countryById(id) { return this.countries[id] || null; },
    provinceById(id) { return this._provinceMap[id] || null; },
    terrainOf(provinceId) {
        const p = this.provinceById(provinceId);
        return p ? p.terrain : 'ocean';
    },
    ownerOf(provinceId) {
        const p = this.provinceById(provinceId);
        return p ? p.owner : null;
    },
    provinceResources(provinceId) {
        const p = this.provinceById(provinceId);
        if (!p) return {};
        return p.resources || {};
    },
    provincesOf(countryId) {
        return this.provinces.filter(p => p.owner === countryId);
    },

    ownersOfProvince(provinceId) {
        const p = this.provinceById(provinceId);
        if (!p) return [];
        return this.armies.filter(a => a.provinceId === provinceId).map(a => a.owner);
    },

    // ===================== 时间系统 =====================
    advanceDate(days) {
        let d = { ...this.date };
        // 天数转月
        let addDays = days;
        let m = d.month - 1;
        let y = d.year;
        // 用日期计算
        const start = new Date(d.year, d.month - 1, d.day);
        start.setDate(start.getDate() + addDays);
        d.year = start.getFullYear();
        d.month = start.getMonth() + 1;
        d.day = start.getDate();
        this.date = d;
    },

    formatDate() {
        const d = this.date;
        return `${d.year}.${String(d.month).padStart(2,'0')}.${String(d.day).padStart(2,'0')}`;
    },

    isWar() {
        // 玩家是否在战争中（有敌方军队相邻或交战）
        const pc = this.playerCountry();
        const myProvs = this.provincesOf(this.playerCountryId);
        const myProvIds = new Set(myProvs.map(p => p.id));
        for (const army of this.armies) {
            if (army.owner === this.playerCountryId) continue;
            // 检查是否有敌方军队在我的省份，或我的军队在敌方省份
            if (myProvIds.has(army.provinceId)) return true;
            if (army.owner && pc.relations[army.owner] < -30) {
                // 检查是否相邻
            }
        }
        // 检查是否存在交战（两军同省）
        for (const p of this.provinces) {
            const armies = this.armies.filter(a => a.provinceId === p.id);
            const owners = new Set(armies.map(a => a.owner));
            if (owners.has(this.playerCountryId) && owners.size > 1) return true;
            if (owners.size > 1 && owners.has(this.playerCountryId)) return true;
        }
        return false;
    },

    // ===================== 经济系统 =====================
    // 计算国家每日资源产出
    computeResourceIncome(countryId) {
        const c = this.countryById(countryId);
        const income = {};
        const myProvs = this.provincesOf(countryId);
        for (const res of Object.keys(RESOURCES)) income[res] = 0;

        for (const p of myProvs) {
            const res = p.resources || {};
            for (const [k, v] of Object.entries(res)) {
                if (income[k] !== undefined) income[k] += v;
            }
        }
        // 应用修正
        for (const res of Object.keys(income)) {
            income[res] *= (c.resourceIncomeMod || 1);
        }
        // 合成炼油科技加成
        if (this.hasTech(countryId, 'synthetic_refining')) income['oil'] *= 1.3;
        return income;
    },

    // 计算每个生产项的每日产量速率（基于军用工厂分配）
    computeProductionRates(countryId) {
        const queue = this.production[countryId] || [];
        const milFactories = (this.factories[countryId] && this.factories[countryId].military) || 0;
        if (queue.length === 0 || milFactories <= 0) {
            return queue.map(item => ({ item, dailyRate: 0 }));
        }
        const bonus = this.productionBonus(countryId);
        const totalPriority = queue.reduce((s, item) => s + (item.priority || 1), 0);
        return queue.map(item => {
            const share = milFactories * ((item.priority || 1) / totalPriority);
            const dailyRate = share * 0.1 * (1 + bonus);
            return { item, dailyRate };
        });
    },

    // 每日消耗（根据生产队列的每日产量）
    computeResourceConsumption(countryId) {
        const cons = {};
        for (const res of Object.keys(RESOURCES)) cons[res] = 0;
        const rates = this.computeProductionRates(countryId);
        for (const { item, dailyRate } of rates) {
            const eq = EQUIPMENT[item.equipment];
            if (!eq || !eq.usesResources) continue;
            for (const [res, amt] of Object.entries(eq.usesResources)) {
                if (cons[res] !== undefined) cons[res] += amt * dailyRate;
            }
        }
        return cons;
    },

    // 每日 tick：资源、生产、人力、稳定度
    dailyTick() {
        // 玩家国家
        this.tickCountry(this.playerCountryId);
        // AI 国家
        for (const cid of Object.keys(this.countries)) {
            if (cid === this.playerCountryId) continue;
            AI.tickCountry(this, cid);
        }
        // 战斗结算
        this.resolveCombat();
        // 焦点完成检查
        this.checkFocusProgress(this.playerCountryId);
        // 事件检查
        this.checkEvents('tick');
    },

    tickCountry(countryId) {
        const c = this.countryById(countryId);
        if (!c) return;

        // 资源
        const income = this.computeResourceIncome(countryId);
        const cons = this.computeResourceConsumption(countryId);
        if (!this.resourceStock[countryId]) this.resourceStock[countryId] = {};
        for (const res of Object.keys(RESOURCES)) {
            if (!this.resourceStock[countryId][res]) this.resourceStock[countryId][res] = 0;
            this.resourceStock[countryId][res] += income[res] - cons[res];
            if (this.resourceStock[countryId][res] < 0) this.resourceStock[countryId][res] = 0;
        }

        // 生产：根据军用工厂推进生产队列
        this.tickProduction(countryId);

        // 人力恢复
        if (c.manpower < c.maxManpower) {
            c.manpower = Math.min(c.maxManpower, c.manpower + c.population * 0.02);
        }

        // 稳定度/战争支持
        if (this.isWarFor(countryId)) {
            c.warSupport -= 0.3;
            if (c.warSupport < 20) c.stability -= 0.2;
        } else {
            c.warSupport = Math.min(100, c.warSupport + 0.5);
            c.stability = Math.min(100, c.stability + 0.2);
        }
        c.stability = Math.max(0, Math.min(100, c.stability));
        c.warSupport = Math.max(0, Math.min(100, c.warSupport));

        // 研究推进
        this.tickResearch(countryId);
    },

    tickProduction(countryId) {
        const queue = this.production[countryId];
        if (!queue || queue.length === 0) return;
        const c = this.countryById(countryId);
        const milFactories = (this.factories[countryId] && this.factories[countryId].military) || 0;
        if (milFactories <= 0) return;

        const stock = this.resourceStock[countryId] || {};
        const rates = this.computeProductionRates(countryId);
        const bonus = this.productionBonus(countryId);

        for (const { item, dailyRate } of rates) {
            if (dailyRate <= 0) continue;
            const eq = EQUIPMENT[item.equipment];
            // 检查资源是否足够支撑本日生产
            let canProduce = true;
            if (eq && eq.usesResources) {
                for (const [res, amt] of Object.entries(eq.usesResources)) {
                    if ((stock[res] || 0) < amt * dailyRate) {
                        canProduce = false;
                        break;
                    }
                }
            }
            if (!canProduce) {
                // 资源不足，按比例缩减产量
                let ratio = 1;
                if (eq && eq.usesResources) {
                    for (const [res, amt] of Object.entries(eq.usesResources)) {
                        ratio = Math.min(ratio, (stock[res] || 0) / (amt * dailyRate || 1));
                    }
                }
                // 消耗可用资源，按比例生产
                if (eq && eq.usesResources) {
                    for (const [res, amt] of Object.entries(eq.usesResources)) {
                        const use = amt * dailyRate * ratio;
                        stock[res] = Math.max(0, (stock[res] || 0) - use);
                    }
                }
                item.amount -= dailyRate * ratio;
            } else {
                // 资源充足，正常消耗与生产
                if (eq && eq.usesResources) {
                    for (const [res, amt] of Object.entries(eq.usesResources)) {
                        stock[res] = Math.max(0, (stock[res] || 0) - amt * dailyRate);
                    }
                }
                item.amount -= dailyRate;
            }
        }

        // 移除完成的生产项，加入库存
        this.production[countryId] = queue.filter(item => {
            if (item.amount <= 0) {
                if (!this.equipmentStock[countryId]) this.equipmentStock[countryId] = {};
                this.equipmentStock[countryId][item.equipment] = (this.equipmentStock[countryId][item.equipment] || 0) + 1;
                return false;
            }
            return true;
        });
    },

    productionBonus(countryId) {
        let bonus = 0;
        if (this.hasTech(countryId, 'steel_alloys')) bonus += 0.15;
        if (this.hasTech(countryId, 'advanced_engineering')) bonus += 0.10;
        // 海军/空军建造速度科技影响对应装备
        return bonus;
    },

    tickResearch(countryId) {
        const r = this.research[countryId];
        if (!r) return;
        const slots = r.slots;
        let speed = r.speed * this.researchSpeed(countryId);
        for (let i = 0; i < Math.min(slots, r.researching.length); i++) {
            const item = r.researching[i];
            if (!item) continue;
            item.progress += speed;
            const tech = TECHS.find(t => t.id === item.techId);
            if (tech && item.progress >= tech.time) {
                this.completeTech(countryId, tech);
                r.researching.splice(i, 1);
                i--;
            }
        }
    },

    researchSpeed(countryId) {
        let s = 1.0;
        if (this.hasTech(countryId, 'f_tech_2')) s += 0.15;
        // 修正
        const c = this.countryById(countryId);
        if (c.stability > 80) s *= 1.05;
        return s;
    },

    hasTech(countryId, techId) {
        const r = this.research[countryId];
        return r && r.completed.includes(techId);
    },

    completeTech(countryId, tech) {
        this.research[countryId].completed.push(tech.id);
        // 应用效果
        this.applyTechEffect(countryId, tech);
        if (countryId === this.playerCountryId) {
            this.logMsg(`科研完成：${tech.name}`);
        }
    },

    applyTechEffect(countryId, tech) {
        const t = tech.target || {};
        const c = this.countryById(countryId);
        if (t.unlockTemplate) {
            if (!this.unlockedTemplates) this.unlockedTemplates = {};
            if (!this.unlockedTemplates[countryId]) this.unlockedTemplates[countryId] = [];
            this.unlockedTemplates[countryId].push(t.unlockTemplate);
        }
        if (t.unlockEquipment) {
            if (!this.unlockedEquipment) this.unlockedEquipment = {};
            if (!this.unlockedEquipment[countryId]) this.unlockedEquipment[countryId] = [];
            this.unlockedEquipment[countryId].push(t.unlockEquipment);
        }
        // 数值加成（记录到国家的 buffs）
        if (!c.buffs) c.buffs = { attack: 0, defense: 0, speed: 0, civilianFactory: 0, militaryFactory: 0, factory: 0, construction: 0, resourceOil: 0, navyBuild: 0, airBuild: 0, airDefense: 0, intelligence: 0 };
        for (const [k, v] of Object.entries(t)) {
            if (typeof v === 'number' && c.buffs[k] !== undefined) {
                c.buffs[k] += v;
            }
        }
        if (t.nuclear) { c.nuclear = true; }
        if (t.researchSpeed) { if (!c.buffs) c.buffs = {}; c.buffs.researchSpeed = (c.buffs.researchSpeed || 0) + t.researchSpeed; }
    },

    // ===================== 战斗系统 =====================
    resolveCombat() {
        // 对每个有多方军队的省份进行战斗
        for (const p of this.provinces) {
            const armies = this.armies.filter(a => a.provinceId === p.id);
            if (armies.length < 2) continue;
            const owners = new Set(armies.map(a => a.owner));
            if (owners.size < 2) continue;

            // 计算每方战力
            const sides = {};
            for (const a of armies) {
                if (!sides[a.owner]) sides[a.owner] = { attack: 0, defense: 0, count: 0 };
                const tpl = DIVISION_TEMPLATES[a.type] || DIVISION_TEMPLATES['infantry'];
                const terr = TERRAIN[p.terrain] || TERRAIN['plain'];
                const atk = a.strength * (tpl.baseStrength / 20) * (1 + this.divisionBuff(a.owner, 'attack'));
                const def = a.strength * (1 + terr.defBonus + this.divisionBuff(a.owner, 'defense'));
                sides[a.owner].attack += atk;
                sides[a.owner].defense += def;
                sides[a.owner].count++;
            }

            // 计算总战力，分配伤害
            for (const a of armies) {
                let damageTaken = 0;
                const mySide = sides[a.owner];
                for (const [oid, side] of Object.entries(sides)) {
                    if (oid === a.owner) continue;
                    const ratio = side.attack / (mySide.defense + 1);
                    damageTaken += side.attack * 0.5 * ratio;
                }
                // 地形防御减免
                const terr = TERRAIN[p.terrain] || TERRAIN['plain'];
                damageTaken = damageTaken / (1 + terr.defBonus);
                a.strength = Math.max(0, a.strength - damageTaken);
                a.experience += damageTaken * 0.1;
            }

            // 检查占领：如果某方战力占比最高且超过阈值，尝试占领
            const totalAtk = Object.values(sides).reduce((s, x) => s + x.attack, 0);
            if (totalAtk === 0) continue;
            // 找出最强方
            let strongest = null, maxAtk = 0;
            for (const [oid, side] of Object.entries(sides)) {
                if (side.attack > maxAtk) { maxAtk = side.attack; strongest = oid; }
            }
            // 占领概率
            if (maxAtk / totalAtk > 0.55 && Math.random() < 0.05) {
                // 占领省份
                p.owner = strongest;
                // 被占领方军队撤退到相邻省份
                for (const a of armies) {
                    if (a.owner !== strongest && a.strength > 0) {
                        this.retreatArmy(a, p.id);
                    }
                }
                if (strongest === this.playerCountryId) {
                    this.logMsg(`占领了 ${p.name}！`);
                }
            }

            // 移除被消灭的军队
            this.armies = this.armies.filter(a => a.strength > 0.5);
        }
    },

    divisionBuff(countryId, key) {
        const c = this.countryById(countryId);
        if (!c || !c.buffs) return 0;
        return c.buffs[key] || 0;
    },

    retreatArmy(army, fromProvinceId) {
        const prov = this.provinceById(fromProvinceId);
        if (!prov) return;
        const neighbors = this.getNeighborProvinces(fromProvinceId);
        // 找同 owner 的相邻省份
        const sameOwner = neighbors.find(n => {
            const np = this.provinceById(n.id);
            return np.owner === army.owner && (this.armies.find(a => a.provinceId === n.id && a.owner === army.owner) === undefined);
        });
        if (sameOwner) {
            army.provinceId = sameOwner.id;
        } else {
            // 任意相邻省份
            if (neighbors.length > 0) {
                army.provinceId = neighbors[0].id;
            }
        }
    },

    getNeighborProvinces(provinceId) {
        const p = this.provinceById(provinceId);
        if (!p) return [];
        return this.provinces.filter(q => {
            if (q.id === provinceId) return false;
            // 简单矩形相邻判定
            return !(q.x + q.w < p.x || q.x > p.x + p.w || q.y + q.h < p.y || q.y > p.y + p.h);
        });
    },

    findFrontProvinces() {
        // 前线：玩家与敌方军队相邻或同省的省份
        const front = [];
        const pc = this.playerCountry();
        for (const p of this.provinces) {
            const armies = this.armies.filter(a => a.provinceId === p.id);
            const hasPlayer = armies.some(a => a.owner === this.playerCountryId);
            const hasEnemy = armies.some(a => a.owner && a.owner !== this.playerCountryId);
            if (hasPlayer && hasEnemy) { front.push(p); continue; }
            // 相邻敌方
            if (hasPlayer) {
                const nb = this.getNeighborProvinces(p.id);
                if (nb.some(n => this.armies.some(a => a.provinceId === n.id && a.owner && a.owner !== this.playerCountryId))) {
                    front.push(p);
                }
            }
        }
        return front;
    },

    isWarFor(countryId) {
        const myProvIds = new Set(this.provincesOf(countryId).map(p => p.id));
        for (const a of this.armies) {
            if (a.owner === countryId) continue;
            if (myProvIds.has(a.provinceId)) return true;
        }
        for (const p of this.provinces) {
            const armies = this.armies.filter(a => a.provinceId === p.id);
            const owners = new Set(armies.map(a => a.owner));
            if (owners.has(countryId) && owners.size > 1) return true;
        }
        return false;
    },

    logMsg(msg) {
        this.log.unshift({ date: this.formatDate(), msg });
        if (this.log.length > 50) this.log.pop();
    },

    // 选择省份
    selectProvince(id) {
        this.selectedProvince = id;
        if (UI) UI.updateProvincePanel();
        if (MapView) MapView.draw();
    },

    // ===================== 军队管理 =====================
    // 创建一支部队
    createArmy(countryId, provinceId, type) {
        const c = this.countryById(countryId);
        if (!c) return null;
        const tpl = DIVISION_TEMPLATES[type];
        if (!tpl) return null;
        // 检查模板是否解锁
        if (tpl.requires && tpl.requires.tech && !this.hasTech(countryId, tpl.requires.tech)) {
            return null;
        }
        // 检查人力
        if (c.manpower < (tpl.cost.manpower || 0)) return null;
        c.manpower -= tpl.cost.manpower || 0;
        // 检查装备库存
        const stock = this.equipmentStock[countryId] || {};
        for (const [eq, amt] of Object.entries(tpl.cost.equipment || {})) {
            if ((stock[eq] || 0) < amt) return null;
            stock[eq] -= amt;
        }
        const army = {
            id: this.nextArmyId++,
            owner: countryId,
            provinceId,
            type,
            strength: tpl.baseStrength,
            maxStrength: tpl.baseStrength * 1.5,
            experience: 0,
            name: `${c.tag} ${tpl.name} #${this.nextArmyId - 1}`,
        };
        this.armies.push(army);
        // 驻守该省份
        const prov = this.provinceById(provinceId);
        if (prov && !prov.owner) prov.owner = countryId;
        this.logMsg(`组建了 ${c.name} 的 ${tpl.name}`);
        return army;
    },

    // 移动军队到目标省份
    moveArmy(armyId, targetProvinceId) {
        const army = this.armies.find(a => a.id === armyId);
        if (!army) return false;
        const from = this.provinceById(army.provinceId);
        const to = this.provinceById(targetProvinceId);
        if (!to) return false;
        // 只能移动到相邻省份或同国省份
        const isSameCountry = to.owner === army.owner;
        const isNeighbor = this.getNeighborProvinces(army.provinceId).some(n => n.id === targetProvinceId);
        if (!isSameCountry && !isNeighbor) return false;
        // 敌方省份需要战斗进入
        if (to.owner && to.owner !== army.owner) {
            // 自动触发战斗
            this.resolveProvinceCombat(targetProvinceId);
        }
        army.provinceId = targetProvinceId;
        if (MapView) MapView.draw();
        return true;
    },

    // 单省份战斗（军队进入敌方省份时触发）
    resolveProvinceCombat(provinceId) {
        const armies = this.armies.filter(a => a.provinceId === provinceId);
        if (armies.length < 2) return;
        // 复用整体战斗逻辑（简化为单省份结算）
        const sides = {};
        for (const a of armies) {
            if (!sides[a.owner]) sides[a.owner] = { attack: 0, defense: 0 };
            const tpl = DIVISION_TEMPLATES[a.type] || DIVISION_TEMPLATES['infantry'];
            const terr = TERRAIN[this.terrainOf(provinceId)] || TERRAIN['plain'];
            sides[a.owner].attack += a.strength * (tpl.baseStrength / 20) * (1 + this.divisionBuff(a.owner, 'attack'));
            sides[a.owner].defense += a.strength * (1 + terr.defBonus + this.divisionBuff(a.owner, 'defense'));
        }
        for (const a of armies) {
            let dmg = 0;
            for (const [oid, s] of Object.entries(sides)) {
                if (oid === a.owner) continue;
                dmg += s.attack * 0.4;
            }
            const terr = TERRAIN[this.terrainOf(provinceId)] || TERRAIN['plain'];
            a.strength = Math.max(0, a.strength - dmg / (1 + terr.defBonus));
        }
    },

    disbandArmy(armyId) {
        const idx = this.armies.findIndex(a => a.id === armyId);
        if (idx === -1) return;
        const army = this.armies[idx];
        const c = this.countryById(army.owner);
        if (c) c.manpower += 5;
        this.armies.splice(idx, 1);
        if (MapView) MapView.draw();
    },

    // ===================== 焦点系统 =====================
    // 获取可用焦点
    getAvailableFocuses(countryId) {
        const f = this.focuses[countryId] || { done: [], active: null };
        return FOCUSES.filter(focus => {
            if (f.done.includes(focus.id) || f.active === focus.id) return false;
            return focus.requires.every(r => f.done.includes(r));
        });
    },

    startFocus(countryId, focusId) {
        const f = this.focuses[countryId];
        if (!f || f.active || f.done.includes(focusId)) return false;
        const focus = FOCUSES.find(x => x.id === focusId);
        if (!focus) return false;
        if (!focus.requires.every(r => f.done.includes(r))) return false;
        f.active = focusId;
        // 立即给予效果（简化：焦点即时完成）
        this.applyFocusEffect(countryId, focus);
        f.done.push(focusId);
        f.active = null;
        if (countryId === this.playerCountryId) {
            this.logMsg(`完成国家焦点：${focus.name}`);
        }
        return true;
    },

    applyFocusEffect(countryId, focus) {
        const t = focus.target || {};
        const c = this.countryById(countryId);
        if (!c.buffs) c.buffs = { attack: 0, defense: 0, speed: 0, civilianFactory: 0, militaryFactory: 0, factory: 0, construction: 0, resourceOil: 0, navyBuild: 0, airBuild: 0, airDefense: 0, intelligence: 0, researchSpeed: 0 };
        if (t.civilianFactories) this.factories[countryId].civilian += t.civilianFactories;
        if (t.militaryFactories) this.factories[countryId].military += t.militaryFactories;
        if (t.manpower) { c.manpower += t.manpower; c.maxManpower += t.manpower; }
        if (t.stability) c.stability = Math.min(100, c.stability + t.stability);
        if (t.warSupport) c.warSupport = Math.min(100, c.warSupport + t.warSupport);
        if (t.researchSlots) this.research[countryId].slots += t.researchSlots;
        if (t.researchSpeed) c.buffs.researchSpeed += t.researchSpeed;
        if (t.resourceIncome) c.resourceIncomeMod = (c.resourceIncomeMod || 1) * (1 + t.resourceIncome);
        if (t.relations) {
            for (const oid of Object.keys(c.relations)) {
                c.relations[oid] = Math.min(100, c.relations[oid] + t.relations);
            }
        }
        if (t.navyBuild) c.buffs.navyBuild += t.navyBuild;
        if (t.airBuild) c.buffs.airBuild += t.airBuild;
    },

    checkFocusProgress(countryId) {
        // 焦点即时完成，此处仅用于触发事件（保留接口）
    },

    // ===================== 事件系统 =====================
    checkEvents(context) {
        const cid = this.playerCountryId;
        const daysElapsed = this.daysSinceStart();
        for (const evt of EVENTS) {
            if (this.pendingEvents.includes(evt.id)) continue;
            if (this.activeEvent && this.activeEvent.id === evt.id) continue;
            if (this.eventTriggered(evt, daysElapsed, context)) {
                this.triggerEvent(evt);
            }
        }
    },

    daysSinceStart() {
        const start = new Date(GAME.START_DATE.year, GAME.START_DATE.month - 1, GAME.START_DATE.day);
        const now = new Date(this.date.year, this.date.month - 1, this.date.day);
        return Math.floor((now - start) / (1000 * 60 * 60 * 24));
    },

    eventTriggered(evt, daysElapsed, context) {
        const tr = evt.trigger;
        if (!tr) return false;
        if (tr.type === 'after_days') {
            if (daysElapsed >= tr.days && context === 'tick') {
                // 检查是否之前已触发过（简单用随机是否命中）
                return true;
            }
            if (context === 'init' && daysElapsed >= tr.days) return false;
            return false;
        }
        if (tr.type === 'random') {
            if (tr.after_days && daysElapsed < tr.after_days) return false;
            return Math.random() < tr.chance;
        }
        if (tr.type === 'on_war') {
            return tr.isWar ? this.isWarFor(this.playerCountryId) : !this.isWarFor(this.playerCountryId);
        }
        if (tr.type === 'on_tech_complete') {
            return this.hasTech(this.playerCountryId, tr.tech);
        }
        return false;
    },

    triggerEvent(evt) {
        this.activeEvent = evt;
        this.pendingEvents.push(evt.id);
        if (UI) UI.showEvent(evt);
    },

    resolveEvent(choiceIndex) {
        const evt = this.activeEvent;
        if (!evt) return;
        const choice = evt.choices[choiceIndex];
        if (choice && choice.effect) {
            this.applyEventEffect(choice.effect);
        }
        this.logMsg(`事件【${evt.title}】：${choice ? choice.text : ''}`);
        this.activeEvent = null;
        // 关闭事件弹窗覆盖层
        const overlay = document.getElementById('eventOverlay');
        if (overlay) overlay.classList.add('hidden');
        if (UI) UI.refreshAll();
    },

    applyEventEffect(effect) {
        const cid = this.playerCountryId;
        const c = this.countryById(cid);
        if (!c.buffs) c.buffs = { attack: 0, defense: 0, speed: 0, civilianFactory: 0, militaryFactory: 0, factory: 0, construction: 0, resourceOil: 0, navyBuild: 0, airBuild: 0, airDefense: 0, intelligence: 0, researchSpeed: 0 };
        if (effect.civilianFactories) this.factories[cid].civilian += effect.civilianFactories;
        if (effect.militaryFactories) this.factories[cid].military += effect.militaryFactories;
        if (effect.manpower) { c.manpower += effect.manpower; c.maxManpower += effect.manpower; }
        if (effect.stability) c.stability = Math.max(0, Math.min(100, c.stability + effect.stability));
        if (effect.warSupport) c.warSupport = Math.max(0, Math.min(100, c.warSupport + effect.warSupport));
        if (effect.researchSlots) this.research[cid].slots += effect.researchSlots;
        if (effect.researchSpeed) c.buffs.researchSpeed += effect.researchSpeed;
        if (effect.resourceIncome) c.resourceIncomeMod = (c.resourceIncomeMod || 1) * (1 + effect.resourceIncome);
        if (effect.intelligence) c.buffs.intelligence += effect.intelligence;
        if (effect.relations) {
            for (const oid of Object.keys(c.relations)) c.relations[oid] = Math.min(100, c.relations[oid] + effect.relations);
        }
    },

    // ===================== 外交系统 =====================
    addRelation(countryId, targetId, amount) {
        const c = this.countryById(countryId);
        if (!c || !c.relations[targetId]) return;
        c.relations[targetId] = Math.max(-100, Math.min(100, c.relations[targetId] + amount));
    },

    getRelation(countryId, targetId) {
        const c = this.countryById(countryId);
        return c && c.relations ? (c.relations[targetId] || 0) : 0;
    },

    declareWar(countryId, targetId) {
        const c = this.countryById(countryId);
        if (!c) return;
        c.relations[targetId] = -100;
        this.logMsg(`${c.name} 对 ${this.countryById(targetId).name} 宣战！`);
        // AI 在对方省份部署军队
        this.aiRespondToWar(countryId, targetId);
    },

    makePeace(countryId, targetId) {
        const c = this.countryById(countryId);
        if (!c) return;
        c.relations[targetId] = Math.min(30, c.relations[targetId] + 40);
        this.logMsg(`${c.name} 与 ${this.countryById(targetId).name} 议和。`);
    },

    formAlliance(countryId, targetId) {
        const c = this.countryById(countryId);
        if (!c) return;
        if (!c.alliances.includes(targetId)) c.alliances.push(targetId);
        const t = this.countryById(targetId);
        if (t && !t.alliances.includes(countryId)) t.alliances.push(countryId);
        c.relations[targetId] = Math.min(100, c.relations[targetId] + 30);
        this.logMsg(`${c.name} 与 ${t ? t.name : ''} 缔结同盟。`);
    },

    aiRespondToWar(attackerId, defenderId) {
        // 防御方在边境部署军队
        const defender = this.countryById(defenderId);
        if (!defender) return;
        const borderProvs = this.provincesOf(defenderId).filter(p => {
            const nb = this.getNeighborProvinces(p.id);
            return nb.some(n => n.owner === attackerId);
        });
        if (borderProvs.length === 0) return;
        // 尝试在边境部署一支军队
        if (defender.manpower >= 8 && Math.random() < 0.5) {
            this.createArmy(defenderId, borderProvs[0].id, 'infantry');
        }
    },

    // ===================== 保存/读取 =====================
    save() {
        const data = {
            date: this.date,
            speed: this.speed,
            playerCountryId: this.playerCountryId,
            selectedProvince: this.selectedProvince,
            provinces: this.provinces,
            countries: this.countries,
            armies: this.armies,
            research: this.research,
            production: this.production,
            factories: this.factories,
            equipmentStock: this.equipmentStock,
            resourceStock: this.resourceStock,
            focuses: this.focuses,
            unlockedTemplates: this.unlockedTemplates,
            unlockedEquipment: this.unlockedEquipment,
            log: this.log,
            nextArmyId: this.nextArmyId,
            pendingEvents: this.pendingEvents,
        };
        try {
            localStorage.setItem('hoi4_save', JSON.stringify(data));
            return true;
        } catch (e) {
            return false;
        }
    },

    load() {
        try {
            const raw = localStorage.getItem('hoi4_save');
            if (!raw) return false;
            const data = JSON.parse(raw);
            Object.assign(this, data);
            this._provinceMap = {};
            for (const p of this.provinces) this._provinceMap[p.id] = p;
            this.running = true;
            return true;
        } catch (e) {
            return false;
        }
    },

    hasSave() {
        return !!localStorage.getItem('hoi4_save');
    },
};

if (typeof window !== 'undefined') window.Game = Game;
