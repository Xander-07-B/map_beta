/* ============================================================
 * 钢铁雄心4 网页版 - AI 逻辑 ai.js
 * 负责：AI 国家的科研、生产、军事、外交决策
 * ============================================================ */

const AI = {
    // AI 国家每日 tick
    tickCountry(game, countryId) {
        const c = game.countryById(countryId);
        if (!c) return;

        // 资源与生产（与玩家一致，复用 game.tickCountry 的核心，但补充 AI 决策）
        game.tickCountry(countryId);

        // AI 决策：每若干天做一次决策
        if (game.tickAccumulator % 5 !== 0) return;

        this.decideResearch(game, countryId);
        this.decideProduction(game, countryId);
        this.decideMilitary(game, countryId);
        this.decideDiplomacy(game, countryId);
    },

    // === 科研决策 ===
    decideResearch(game, countryId) {
        const r = game.research[countryId];
        if (!r) return;
        // 填充空闲科研槽
        while (r.researching.length < r.slots) {
            const tech = this.pickNextTech(game, countryId);
            if (!tech) break;
            r.researching.push({ techId: tech.id, progress: 0 });
        }
    },

    pickNextTech(game, countryId) {
        const r = game.research[countryId];
        const c = game.countryById(countryId);
        const available = TECHS.filter(t =>
            !r.completed.includes(t.id) &&
            !r.researching.some(x => x.techId === t.id) &&
            t.requires.every(req => r.completed.includes(req))
        );
        if (available.length === 0) return null;

        // 根据 AI 人格和战争状态选择
        const tags = c.aiTags || [];
        const war = game.isWarFor(countryId);

        // 优先军事科技（如果处于战争）
        if (war) {
            const mil = available.filter(t => t.cat === 'army' || t.cat === 'air' || t.cat === 'navy');
            if (mil.length > 0) return mil[Math.floor(Math.random() * mil.length)];
        }

        // 优先工业
        if (tags.includes('industry')) {
            const ind = available.filter(t => t.cat === 'industry');
            if (ind.length > 0) return ind[Math.floor(Math.random() * ind.length)];
        }

        // 优先海军（海军型）
        if (tags.includes('navy')) {
            const nav = available.filter(t => t.cat === 'navy');
            if (nav.length > 0) return nav[Math.floor(Math.random() * nav.length)];
        }

        // 优先空军
        if (tags.includes('air') || tags.includes('navy')) {
            const air = available.filter(t => t.cat === 'air');
            if (air.length > 0) return air[Math.floor(Math.random() * air.length)];
        }

        // 优先陆军
        if (tags.includes('army') || tags.includes('aggressive')) {
            const army = available.filter(t => t.cat === 'army');
            if (army.length > 0) return army[Math.floor(Math.random() * army.length)];
        }

        return available[Math.floor(Math.random() * available.length)];
    },

    // === 生产决策 ===
    decideProduction(game, countryId) {
        const c = game.countryById(countryId);
        const queue = game.production[countryId];
        const stock = game.equipmentStock[countryId] || {};
        const war = game.isWarFor(countryId);

        // 如果队列已满（4项），不再添加
        if (queue.length >= 4) return;

        // 根据战争状态决定生产什么
        const eqTypes = game.unlockedEquipment[countryId] || ['infantry_weapon', 'artillery'];

        if (war) {
            // 战争中：优先生产当前最缺的装备
            const needed = this.estimateEquipmentNeed(game, countryId);
            for (const [eq, amt] of Object.entries(needed)) {
                if (queue.length >= 4) break;
                if (!eqTypes.includes(eq)) continue;
                if ((stock[eq] || 0) < amt && !queue.some(q => q.equipment === eq)) {
                    game.production[countryId].push({ equipment: eq, amount: 10, priority: 2 });
                }
            }
        } else {
            // 和平时期：生产民用急需或积攒装备
            if ((stock['infantry_weapon'] || 0) < 20 && !queue.some(q => q.equipment === 'infantry_weapon')) {
                game.production[countryId].push({ equipment: 'infantry_weapon', amount: 20, priority: 1 });
            } else if (eqTypes.includes('light_tank') && (stock['light_tank'] || 0) < 10 && !queue.some(q => q.equipment === 'light_tank')) {
                game.production[countryId].push({ equipment: 'light_tank', amount: 10, priority: 1 });
            }
        }
    },

    estimateEquipmentNeed(game, countryId) {
        const need = {};
        const myArmies = game.armies.filter(a => a.owner === countryId);
        // 统计当前军队所需装备缺口
        const tpl = DIVISION_TEMPLATES['infantry'];
        for (const army of myArmies) {
            for (const [eq, amt] of Object.entries(tpl.cost.equipment || {})) {
                need[eq] = (need[eq] || 0) + amt;
            }
        }
        // 如果军队少，需要基础装备
        if (myArmies.length < 5) {
            need['infantry_weapon'] = (need['infantry_weapon'] || 0) + 30;
            need['artillery'] = (need['artillery'] || 0) + 10;
        }
        return need;
    },

    // === 军事决策 ===
    decideMilitary(game, countryId) {
        const c = game.countryById(countryId);
        const tags = c.aiTags || [];

        // 如果人力足够且军队不足，组建军队
        const myArmies = game.armies.filter(a => a.owner === countryId);
        const stock = game.equipmentStock[countryId] || {};

        // 找到可部署的省份（本国省份，且没有军队）
        const emptyProvs = game.provincesOf(countryId).filter(p =>
            !game.armies.some(a => a.provinceId === p.id)
        );

        // 决定组建什么类型的军队
        let templateType = 'infantry';
        const unlocked = game.unlockedTemplates[countryId] || [];
        const isWar = game.isWarFor(countryId);

        if (isWar || tags.includes('aggressive')) {
            if (unlocked.includes('armor') && (stock['light_tank'] || 0) >= 5 && (stock['medium_tank'] || 0) >= 2) {
                templateType = 'armor';
            } else if (unlocked.includes('mechanized') && (stock['truck'] || 0) >= 4) {
                templateType = 'mechanized';
            }
        }

        // 组建军队
        if (c.manpower >= 8 && emptyProvs.length > 0 && myArmies.length < 12) {
            if ((templateType === 'infantry' && (stock['infantry_weapon'] || 0) >= 6) ||
                (templateType === 'armor' && (stock['light_tank'] || 0) >= 5 && (stock['medium_tank'] || 0) >= 2) ||
                (templateType === 'mechanized' && (stock['truck'] || 0) >= 4)) {
                const prov = emptyProvs[Math.floor(Math.random() * emptyProvs.length)];
                game.createArmy(countryId, prov.id, templateType);
            }
        }

        // 进攻决策：如果军队强大且与邻国关系差，尝试进攻
        if (tags.includes('aggressive') && !game.isWarFor(countryId)) {
            const strongArmies = myArmies.filter(a => a.strength > 20);
            if (strongArmies.length > 0) {
                this.aiConsiderAttack(game, countryId);
            }
        }

        // 军队移动：将前线军队向前推进
        if (game.isWarFor(countryId)) {
            this.aiAdvanceArmies(game, countryId);
        }
    },

    aiConsiderAttack(game, countryId) {
        const c = game.countryById(countryId);
        // 找关系最差且相邻的国家
        let target = null, worstRelation = 0;
        for (const [oid, rel] of Object.entries(c.relations)) {
            if (oid === countryId) continue;
            if (rel > -40) continue;
            // 检查是否相邻（通过省份边界）
            const myProvs = game.provincesOf(countryId);
            const theirProvs = game.provincesOf(oid);
            const adjacent = myProvs.some(mp =>
                theirProvs.some(tp => game.getNeighborProvinces(mp.id).some(n => n.id === tp.id))
            );
            if (adjacent && rel < worstRelation) {
                worstRelation = rel;
                target = oid;
            }
        }
        if (target && Math.random() < 0.3) {
            game.declareWar(countryId, target);
        }
    },

    aiAdvanceArmies(game, countryId) {
        const myArmies = game.armies.filter(a => a.owner === countryId);
        for (const army of myArmies) {
            if (army.strength < 15) continue;
            // 找相邻的敌方省份
            const neighbors = game.getNeighborProvinces(army.provinceId);
            const enemyProv = neighbors.find(n =>
                n.owner && n.owner !== countryId
            );
            if (enemyProv) {
                game.moveArmy(army.id, enemyProv.id);
            }
        }
    },

    // === 外交决策 ===
    decideDiplomacy(game, countryId) {
        const c = game.countryById(countryId);
        const tags = c.aiTags || [];

        // 与高关系国家结盟
        for (const [oid, rel] of Object.entries(c.relations)) {
            if (oid === countryId) continue;
            if (rel > 70 && !c.alliances.includes(oid) && Math.random() < 0.1) {
                game.formAlliance(countryId, oid);
            }
        }

        // 关系改善
        for (const [oid, rel] of Object.entries(c.relations)) {
            if (rel < 20 && Math.random() < 0.2) {
                game.addRelation(countryId, oid, 1);
            }
        }

        // 侵略型：对弱国施加外交压力
        if (tags.includes('aggressive') && !game.isWarFor(countryId)) {
            for (const [oid, rel] of Object.entries(c.relations)) {
                if (rel < -20 && Math.random() < 0.1) {
                    game.addRelation(countryId, oid, -5);
                }
            }
        }
    },
};

if (typeof window !== 'undefined') window.AI = AI;
