/* ============================================================
 * 钢铁雄心4 网页版 - 数据文件 data.js
 * 包含：常量、资源、国家、省份、科技、部队模板、事件、焦点
 * ============================================================ */

const GAME = {
    START_DATE: { year: 1936, month: 1, day: 1 },
    END_DATE:   { year: 1948, month: 12, day: 31 },
    TICK_DAYS: 1,
    MAX_SPEED_TICKS: 8,
    WORLD_W: 1000,
    WORLD_H: 520,
};

/* ---------- 意识形态 ---------- */
const IDEOLOGY = {
    democracy:   { name: '民主',   color: '#5a8ac8', icon: '🏛' },
    fascism:     { name: '法西斯', color: '#c84a4a', icon: '⚡' },
    communism:   { name: '共产主义', color: '#c88a4a', icon: '☭' },
    neutrality:  { name: '中立',   color: '#8a99ab', icon: '⚖' },
};

/* ---------- 资源定义 ---------- */
const RESOURCES = {
    steel:     { name: '钢铁',   icon: '🔩', color: '#9aa0a6' },
    iron:      { name: '铁矿',   icon: '⛏', color: '#b06030' },
    oil:       { name: '石油',   icon: '🛢', color: '#2a8a2a' },
    rubber:    { name: '橡胶',   icon: '🌱', color: '#4a9a4a' },
    energy:    { name: '电力',   icon: '⚡', color: '#c9a94a' },
    aluminium: { name: '铝',     icon: '🪙', color: '#8a9aa8' },
    supplies:  { name: '补给',   icon: '📦', color: '#a89070' },
    munitions: { name: '弹药',   icon: '💣', color: '#c84a4a' },
    rare:      { name: '稀有材料', icon: '💎', color: '#9a5ac8' },
};

/* ---------- 装备类型（生产队列用） ---------- */
const EQUIPMENT = {
    infantry_weapon: { name: '步兵武器',   icon: '🔫', cost: 1.0, usesResources: { steel: 0.3, iron: 0.2 } },
    artillery:       { name: '火炮',       icon: '💣', cost: 3.0, usesResources: { steel: 0.6, iron: 0.3 } },
    light_tank:      { name: '轻坦',       icon: '🚜', cost: 6.0, usesResources: { steel: 0.8, aluminium: 0.3, energy: 0.2 } },
    medium_tank:     { name: '中坦',       icon: '🚜', cost: 10.0, usesResources: { steel: 1.0, aluminium: 0.5, energy: 0.3 } },
    heavy_tank:      { name: '重坦',       icon: '🚜', cost: 14.0, usesResources: { steel: 1.2, aluminium: 0.7, energy: 0.4 } },
    fighter:         { name: '战斗机',     icon: '✈️', cost: 8.0, usesResources: { aluminium: 0.6, steel: 0.3, energy: 0.2 } },
    bomber:          { name: '轰炸机',     icon: '🛩', cost: 12.0, usesResources: { aluminium: 0.8, steel: 0.4, energy: 0.3 } },
    tactical_bomber: { name: '战术轰炸机', icon: '🛩', cost: 10.0, usesResources: { aluminium: 0.7, steel: 0.3, energy: 0.3 } },
    destroyer:       { name: '驱逐舰',     icon: '🚢', cost: 10.0, usesResources: { steel: 1.0, aluminium: 0.3 } },
    cruiser:         { name: '巡洋舰',     icon: '🚢', cost: 16.0, usesResources: { steel: 1.2, aluminium: 0.4 } },
    carrier:         { name: '航母',       icon: '🚢', cost: 24.0, usesResources: { steel: 1.5, aluminium: 0.6, energy: 0.3 } },
    battleship:      { name: '战列舰',     icon: '🚢', cost: 28.0, usesResources: { steel: 1.8, aluminium: 0.4, energy: 0.4 } },
    truck:           { name: '卡车',       icon: '🚚', cost: 3.0, usesResources: { steel: 0.4, energy: 0.2 } },
    radar:           { name: '雷达',       icon: '📡', cost: 4.0, usesResources: { steel: 0.2, aluminium: 0.3, energy: 0.3 } },
};

/* ---------- 部队模板 ---------- */
const DIVISION_TEMPLATES = {
    infantry: {
        name: '步兵师', icon: '🪖', baseStrength: 15, cost: { manpower: 8, equipment: { infantry_weapon: 6, artillery: 2 } },
        speed: 2, requires: {},
    },
    mountain: {
        name: '山地师', icon: '🏔', baseStrength: 12, cost: { manpower: 7, equipment: { infantry_weapon: 5, artillery: 2 } },
        speed: 2, requires: { tech: 'mountain_warfare' }, terrainBonus: { mountain: 0.5, forest: 0.3 },
    },
    mechanized: {
        name: '机械师', icon: '🚜', baseStrength: 20, cost: { manpower: 6, equipment: { infantry_weapon: 4, truck: 4, light_tank: 2 } },
        speed: 6, requires: { tech: 'mechanized_infantry' },
    },
    armor: {
        name: '装甲师', icon: '🛡', baseStrength: 35, cost: { manpower: 4, equipment: { light_tank: 6, medium_tank: 3, truck: 2 } },
        speed: 10, requires: { tech: 'armored_tactics' },
    },
    cavalry: {
        name: '骑兵师', icon: '🐎', baseStrength: 18, cost: { manpower: 5, equipment: { infantry_weapon: 3 } },
        speed: 8, requires: {}, terrainBonus: { plain: 0.2 },
    },
};

/* ---------- 省份 ---------- */
// 地形类型影响战斗与移动
const TERRAIN = {
    plain:     { name: '平原', color: '#3a5a3a', defBonus: 0,  moveBonus: 0 },
    forest:    { name: '森林', color: '#1a4028', defBonus: 0.3, moveBonus: -0.2 },
    mountain:  { name: '山地', color: '#5a5a5a', defBonus: 0.5, moveBonus: -0.5 },
    desert:    { name: '沙漠', color: '#8a7a4a', defBonus: 0.1, moveBonus: -0.1 },
    tundra:    { name: '苔原', color: '#6a7a8a', defBonus: 0.2, moveBonus: -0.3 },
    ocean:     { name: '海洋', color: '#10304a', defBonus: 0,  moveBonus: 0 },
    coast:     { name: '海岸', color: '#1a4a6a', defBonus: 0,  moveBonus: 0 },
};

// 省份定义：id, name, 位置(x,y,w,h), 地形, 资源加成, 初始归属国家id
const PROVINCES = [
    // ===== 北美 =====
    { id: 'na_nw',  name: '阿拉斯加',   x: 40,  y: 80,  w: 70,  h: 50, terrain: 'tundra',   resources: { oil: 0.2 } },
    { id: 'na_w',   name: '加拿大西部', x: 70,  y: 130, w: 90,  h: 80, terrain: 'tundra',   resources: { timber: 0.3 } },
    { id: 'na_c',   name: '加拿大中部', x: 160, y: 110, w: 90,  h: 70, terrain: 'plain',    resources: {} },
    { id: 'na_ne',  name: '纽芬兰',     x: 250, y: 120, w: 50,  h: 40, terrain: 'forest',   resources: { fish: 0.2 } },
    { id: 'na_e',   name: '加拿大东部', x: 230, y: 160, w: 60,  h: 60, terrain: 'forest',   resources: {} },
    { id: 'us_w',   name: '美国西部',   x: 100, y: 200, w: 110, h: 80, terrain: 'desert',   resources: { oil: 0.4, iron: 0.2 } },
    { id: 'us_c',   name: '美国中部',   x: 170, y: 210, w: 110, h: 70, terrain: 'plain',    resources: { iron: 0.3, steel: 0.2 } },
    { id: 'us_e',   name: '美国东部',   x: 260, y: 220, w: 90,  h: 70, terrain: 'forest',   resources: { steel: 0.3, energy: 0.2 } },
    { id: 'us_s',   name: '美国南部',   x: 190, y: 290, w: 100, h: 60, terrain: 'plain',    resources: { oil: 0.3, rubber: 0.1 } },
    { id: 'mex',    name: '墨西哥',     x: 230, y: 330, w: 80,  h: 60, terrain: 'desert',   resources: { oil: 0.3, silver: 0.2 } },
    { id: 'ca_s',   name: '中美洲',     x: 290, y: 360, w: 60,  h: 50, terrain: 'forest',   resources: { rubber: 0.4 } },
    // ===== 南美 =====
    { id: 'sa_n',   name: '哥伦比亚',   x: 240, y: 420, w: 60,  h: 50, terrain: 'forest',   resources: { oil: 0.2, rubber: 0.3 } },
    { id: 'sa_w',   name: '秘鲁',       x: 180, y: 440, w: 50,  h: 60, terrain: 'mountain', resources: { copper: 0.3 } },
    { id: 'sa_c',   name: '巴西',       x: 230, y: 450, w: 90,  h: 80, terrain: 'forest',   resources: { rubber: 0.5, iron: 0.2 } },
    { id: 'sa_s',   name: '阿根廷',     x: 250, y: 500, w: 80,  h: 40, terrain: 'plain',    resources: { iron: 0.3 } },
    // ===== 欧洲 =====
    { id: 'eu_ib',  name: '伊比利亚',   x: 380, y: 170, w: 70,  h: 70, terrain: 'plain',    resources: {} },
    { id: 'eu_fr',  name: '法国',       x: 450, y: 130, w: 80,  h: 60, terrain: 'plain',    resources: { iron: 0.3, steel: 0.2 } },
    { id: 'eu_de',  name: '德国',       x: 490, y: 110, w: 70,  h: 50, terrain: 'plain',    resources: { coal: 0.4, steel: 0.3, iron: 0.2 } },
    { id: 'eu_nl',  name: '低地国家',   x: 470, y: 100, w: 50,  h: 40, terrain: 'plain',    resources: {} },
    { id: 'eu_en',  name: '英国',       x: 430, y: 80,  w: 50,  h: 40, terrain: 'forest',   resources: { iron: 0.2, energy: 0.2 } },
    { id: 'eu_it',  name: '意大利',     x: 470, y: 190, w: 60,  h: 50, terrain: 'plain',    resources: { steel: 0.2 } },
    { id: 'eu_ch',  name: '瑞士',       x: 460, y: 160, w: 30,  h: 30, terrain: 'mountain', resources: {} },
    { id: 'eu_au',  name: '奥地利',     x: 480, y: 150, w: 40,  h: 35, terrain: 'mountain', resources: { iron: 0.2 } },
    { id: 'eu_pl',  name: '波兰',       x: 520, y: 120, w: 70,  h: 50, terrain: 'plain',    resources: { coal: 0.3, iron: 0.2 } },
    { id: 'eu_cs',  name: '捷克',       x: 500, y: 140, w: 50,  h: 40, terrain: 'plain',    resources: { steel: 0.3, coal: 0.2 } },
    { id: 'eu_hu',  name: '匈牙利',     x: 510, y: 170, w: 45,  h: 35, terrain: 'plain',    resources: {} },
    { id: 'eu_ro',  name: '罗马尼亚',   x: 540, y: 180, w: 50,  h: 45, terrain: 'plain',    resources: { oil: 0.4 } },
    { id: 'eu_bg',  name: '保加利亚',   x: 560, y: 185, w: 40,  h: 40, terrain: 'plain',    resources: {} },
    { id: 'eu_gr',  name: '希腊',       x: 540, y: 210, w: 50,  h: 40, terrain: 'mountain', resources: {} },
    { id: 'eu_yu',  name: '南斯拉夫',   x: 510, y: 200, w: 55,  h: 45, terrain: 'mountain', resources: { iron: 0.2 } },
    { id: 'eu_sk',  name: '斯堪的纳维亚', x: 470, y: 40, w: 80, h: 70, terrain: 'forest',   resources: { iron: 0.3, timber: 0.3 } },
    { id: 'eu_fi',  name: '芬兰',       x: 550, y: 60,  w: 50,  h: 50, terrain: 'tundra',   resources: { timber: 0.3 } },
    { id: 'eu_es2', name: '西班牙属北非', x: 370, y: 230, w: 40, h: 40, terrain: 'desert', resources: {} },
    // ===== 北非 / 非洲 =====
    { id: 'af_mor', name: '摩洛哥',     x: 360, y: 240, w: 50,  h: 45, terrain: 'desert',   resources: {} },
    { id: 'af_alg', name: '阿尔及利亚', x: 370, y: 270, w: 55,  h: 50, terrain: 'desert',   resources: { oil: 0.2 } },
    { id: 'af_tg',  name: '突尼斯',     x: 420, y: 250, w: 40,  h: 35, terrain: 'plain',    resources: {} },
    { id: 'af_lib', name: '利比亚',     x: 430, y: 280, w: 60,  h: 55, terrain: 'desert',   resources: { oil: 0.3 } },
    { id: 'af_eg',  name: '埃及',       x: 470, y: 270, w: 55,  h: 50, terrain: 'desert',   resources: {} },
    { id: 'af_nu',  name: '努比亚',     x: 490, y: 310, w: 50,  h: 50, terrain: 'desert',   resources: {} },
    { id: 'af_west',name: '西非',       x: 360, y: 320, w: 60,  h: 60, terrain: 'forest',   resources: { rubber: 0.2 } },
    { id: 'af_e',   name: '东非',       x: 490, y: 350, w: 50,  h: 55, terrain: 'desert',   resources: {} },
    { id: 'af_s',   name: '南非',       x: 470, y: 430, w: 70,  h: 60, terrain: 'plain',    resources: { gold: 0.3, iron: 0.2 } },
    { id: 'af_congo', name: '刚果',     x: 410, y: 390, w: 55,  h: 55, terrain: 'forest',   resources: { rubber: 0.4, copper: 0.3 } },
    { id: 'ma_m',   name: '马达加斯加', x: 530, y: 430, w: 30,  h: 40, terrain: 'forest',   resources: {} },
    // ===== 中东 =====
    { id: 'me_tur', name: '土耳其',     x: 560, y: 190, w: 60,  h: 55, terrain: 'mountain', resources: {} },
    { id: 'me_syr', name: '叙利亚',     x: 570, y: 230, w: 45,  h: 40, terrain: 'desert',   resources: {} },
    { id: 'me_ir',  name: '伊朗',       x: 600, y: 210, w: 60,  h: 55, terrain: 'desert',   resources: { oil: 0.4 } },
    { id: 'me_irq', name: '伊拉克',     x: 560, y: 260, w: 45,  h: 40, terrain: 'desert',   resources: { oil: 0.4 } },
    { id: 'me_ara', name: '阿拉伯',     x: 580, y: 290, w: 60,  h: 45, terrain: 'desert',   resources: { oil: 0.5 } },
    { id: 'me_pal', name: '巴勒斯坦',   x: 555, y: 250, w: 30,  h: 30, terrain: 'desert',   resources: {} },
    // ===== 亚洲 =====
    { id: 'as_soviet_w', name: '苏联西部', x: 580, y: 90, w: 90, h: 60, terrain: 'plain', resources: { iron: 0.3, coal: 0.3 } },
    { id: 'as_soviet_c', name: '苏联中部', x: 660, y: 80, w: 100, h: 70, terrain: 'plain', resources: { iron: 0.2 } },
    { id: 'as_soviet_e', name: '苏联东部', x: 740, y: 90, w: 80, h: 70, terrain: 'tundra', resources: { timber: 0.3 } },
    { id: 'as_sib',  name: '西伯利亚',   x: 700, y: 40,  w: 120, h: 60, terrain: 'tundra',   resources: { timber: 0.4, iron: 0.2 } },
    { id: 'as_ind',  name: '印度',       x: 640, y: 300, w: 70,  h: 70, terrain: 'plain',    resources: { cotton: 0.3 } },
    { id: 'as_bur',  name: '缅甸',       x: 700, y: 310, w: 50,  h: 55, terrain: 'forest',   resources: { rubber: 0.3 } },
    { id: 'as_ch',   name: '中国',       x: 720, y: 230, w: 90,  h: 80, terrain: 'plain',    resources: { coal: 0.3, iron: 0.2 } },
    { id: 'as_mon',  name: '蒙古',       x: 700, y: 180, w: 60,  h: 45, terrain: 'desert',   resources: {} },
    { id: 'as_indo', name: '东南亚',     x: 740, y: 350, w: 70,  h: 55, terrain: 'forest',   resources: { rubber: 0.5 } },
    { id: 'as_jp',   name: '日本',       x: 820, y: 180, w: 55,  h: 55, terrain: 'mountain', resources: { iron: 0.2 } },
    { id: 'as_kr',   name: '朝鲜',       x: 770, y: 195, w: 45,  h: 40, terrain: 'plain',    resources: { iron: 0.2 } },
    { id: 'as_phi',  name: '菲律宾',     x: 800, y: 320, w: 40,  h: 45, terrain: 'forest',   resources: {} },
    { id: 'as_til',  name: '东印度',     x: 760, y: 370, w: 60,  h: 50, terrain: 'forest',   resources: { rubber: 0.5, oil: 0.2 } },
    // ===== 大洋洲 =====
    { id: 'oc_au',   name: '澳大利亚',   x: 830, y: 400, w: 80,  h: 60, terrain: 'desert',   resources: { iron: 0.3 } },
    { id: 'oc_nz',   name: '新西兰',     x: 880, y: 430, w: 35,  h: 35, terrain: 'forest',   resources: {} },
    // ===== 海洋（背景，不可占） =====
    { id: 'oc_pac',  name: '太平洋',   x: 700, y: 150, w: 300, h: 200, terrain: 'ocean',   resources: {} },
    { id: 'oc_atl',  name: '大西洋',   x: 200, y: 100, w: 200, h: 250, terrain: 'ocean',   resources: {} },
    { id: 'oc_ind',  name: '印度洋',   x: 600, y: 380, w: 250, h: 100, terrain: 'ocean',   resources: {} },
    { id: 'oc_arc',  name: '北冰洋',   x: 200, y: 0,   w: 800, h: 40,  terrain: 'ocean',   resources: {} },
];

/* ---------- 国家定义 ---------- */
// 每个国家：id, name, 旗帜emoji, 主色, 意识形态, 起始属性, 所属省份id列表, AI人格
const COUNTRIES = [
    {
        id: 'germany', name: '德国', flag: '🇩🇪', color: '#c84a4a', ideology: 'fascism',
        tag: 'GER', aiTags: ['aggressive', 'industry', 'tech_focus'],
        manpower: 40, factories: 32, civilianFactories: 20, militaryFactories: 12,
        stability: 85, warSupport: 80, population: 70,
        provinces: ['eu_de', 'eu_pl', 'eu_cs', 'eu_au', 'eu_hu', 'eu_ro', 'eu_bg', 'eu_yu', 'eu_gr', 'me_irq', 'me_pal', 'me_syr'],
    },
    {
        id: 'usa', name: '美国', flag: '🇺🇸', color: '#4a7ac8', ideology: 'democracy',
        tag: 'USA', aiTags: ['industry', 'navy', 'tech_focus'],
        manpower: 100, factories: 60, civilianFactories: 45, militaryFactories: 15,
        stability: 95, warSupport: 70, population: 130,
        provinces: ['us_w', 'us_c', 'us_e', 'us_s', 'na_ne'],
    },
    {
        id: 'uk', name: '英国', flag: '🇬🇧', color: '#5a8ac8', ideology: 'democracy',
        tag: 'ENG', aiTags: ['navy', 'diplomacy', 'industry'],
        manpower: 35, factories: 28, civilianFactories: 18, militaryFactories: 10,
        stability: 90, warSupport: 75, population: 45,
        provinces: ['eu_en', 'eu_nl'],
    },
    {
        id: 'soviet', name: '苏联', flag: '🇨🇩', color: '#c88a4a', ideology: 'communism',
        tag: 'SOV', aiTags: ['industry', 'army', 'tech_focus'],
        manpower: 90, factories: 40, civilianFactories: 28, militaryFactories: 12,
        stability: 70, warSupport: 75, population: 120,
        provinces: ['as_soviet_w', 'as_soviet_c', 'as_soviet_e', 'as_sib', 'eu_fi'],
    },
    {
        id: 'japan', name: '日本', flag: '🇯🇵', color: '#c84a4a', ideology: 'fascism',
        tag: 'JAP', aiTags: ['aggressive', 'navy', 'army'],
        manpower: 35, factories: 25, civilianFactories: 15, militaryFactories: 10,
        stability: 85, warSupport: 85, population: 50,
        provinces: ['as_jp', 'as_kr', 'as_phi', 'as_til'],
    },
    {
        id: 'france', name: '法国', flag: '🇫🇷', color: '#5a8ac8', ideology: 'democracy',
        tag: 'FRA', aiTags: ['industry', 'army', 'diplomacy'],
        manpower: 38, factories: 30, civilianFactories: 20, militaryFactories: 10,
        stability: 88, warSupport: 72, population: 42,
        provinces: ['eu_fr', 'eu_ib', 'eu_ch'],
    },
    {
        id: 'italy', name: '意大利', flag: '🇮🇹', color: '#5ac84a', ideology: 'fascism',
        tag: 'ITA', aiTags: ['aggressive', 'industry'],
        manpower: 30, factories: 22, civilianFactories: 15, militaryFactories: 7,
        stability: 75, warSupport: 78, population: 38,
        provinces: ['eu_it', 'eu_gr', 'eu_es2'],
    },
    {
        id: 'china', name: '中国', flag: '🇨🇳', color: '#c8a04a', ideology: 'democracy',
        tag: 'CHI', aiTags: ['army', 'diplomacy'],
        manpower: 120, factories: 15, civilianFactories: 10, militaryFactories: 5,
        stability: 55, warSupport: 65, population: 200,
        provinces: ['as_ch', 'as_mon', 'as_bur'],
    },
    {
        id: 'spain', name: '西班牙', flag: '🇪🇸', color: '#c84a4a', ideology: 'fascism',
        tag: 'SPA', aiTags: ['aggressive', 'army'],
        manpower: 28, factories: 18, civilianFactories: 12, militaryFactories: 6,
        stability: 65, warSupport: 70, population: 30,
        provinces: ['eu_ib'],
    },
    {
        id: 'india', name: '印度', flag: '🇮🇳', color: '#c8a04a', ideology: 'democracy',
        tag: 'IND', aiTags: ['army', 'industry'],
        manpower: 80, factories: 18, civilianFactories: 12, militaryFactories: 6,
        stability: 70, warSupport: 65, population: 100,
        provinces: ['as_ind'],
    },
    {
        id: 'brazil', name: '巴西', flag: '🇧🇷', color: '#5ac84a', ideology: 'democracy',
        tag: 'BRA', aiTags: ['industry'],
        manpower: 35, factories: 16, civilianFactories: 11, militaryFactories: 5,
        stability: 72, warSupport: 60, population: 40,
        provinces: ['sa_c'],
    },
    {
        id: 'australia', name: '澳大利亚', flag: '🇦🇺', color: '#5a8ac8', ideology: 'democracy',
        tag: 'AUS', aiTags: ['navy', 'army'],
        manpower: 15, factories: 12, civilianFactories: 8, militaryFactories: 4,
        stability: 85, warSupport: 70, population: 18,
        provinces: ['oc_au', 'oc_nz'],
    },
];

/* ---------- 科技树 ---------- */
// id, 名称, 类别, 图标, 耗时(天), 前置科技id列表, 效果描述, 效果对象
const TECHS = [
    // ===== 陆军 =====
    { id: 'infantry_weapons', name: '步兵武器', cat: 'army', icon: '🔫', time: 120, requires: [], effect: '提升步兵师攻击力 10%', target: { divisionType: 'infantry', attack: 0.1 } },
    { id: 'artillery', name: '火炮技术', cat: 'army', icon: '💣', time: 180, requires: [], effect: '提升所有师攻击力 10%', target: { attack: 0.1 } },
    { id: 'infantry_tactics', name: '步兵战术', cat: 'army', icon: '🪖', time: 150, requires: ['infantry_weapons'], effect: '提升步兵师防御 15%', target: { divisionType: 'infantry', defense: 0.15 } },
    { id: 'support_weapon', name: '支援武器', cat: 'army', icon: '🎯', time: 200, requires: ['artillery'], effect: '提升所有师攻击力 8%', target: { attack: 0.08 } },
    { id: 'mountain_warfare', name: '山地作战', cat: 'army', icon: '🏔', time: 180, requires: ['infantry_tactics'], effect: '解锁山地师，山地地形防御+50%', target: { unlockTemplate: 'mountain' } },
    { id: 'mechanized_infantry', name: '机械步兵', cat: 'army', icon: '🚜', time: 240, requires: ['infantry_tactics', 'automotive'], effect: '解锁机械师', target: { unlockTemplate: 'mechanized' } },
    { id: 'armored_tactics', name: '装甲战术', cat: 'army', icon: '🛡', time: 270, requires: ['mechanized_infantry', 'medium_tank_design'], effect: '解锁装甲师，装甲师攻击力+15%', target: { unlockTemplate: 'armor', divisionType: 'armor', attack: 0.15 } },
    { id: 'cavalry_tactics', name: '骑兵战术', cat: 'army', icon: '🐎', time: 120, requires: [], effect: '解锁骑兵师，移动速度+1', target: { unlockTemplate: 'cavalry', divisionType: 'cavalry', speed: 1 } },
    { id: 'military_engineering', name: '军事工程', cat: 'army', icon: '🔧', time: 220, requires: ['infantry_tactics'], effect: '提升所有师防御 10%', target: { defense: 0.1 } },
    // ===== 工业 / 经济 =====
    { id: 'automotive', name: '汽车工业', cat: 'industry', icon: '🚚', time: 150, requires: [], effect: '民用工厂产出+10%', target: { civilianFactory: 0.1 } },
    { id: 'industrial_engineering', name: '工业工程', cat: 'industry', icon: '⚙', time: 200, requires: ['automotive'], effect: '民用工厂产出+15%', target: { civilianFactory: 0.15 } },
    { id: 'advanced_engineering', name: '高级工程', cat: 'industry', icon: '🏭', time: 280, requires: ['industrial_engineering'], effect: '所有工厂产出+10%', target: { factory: 0.1 } },
    { id: 'steel_alloys', name: '合金钢', cat: 'industry', icon: '🔩', time: 220, requires: ['industrial_engineering'], effect: '军用工厂产出+15%', target: { militaryFactory: 0.15 } },
    { id: 'railways', name: '铁路工程', cat: 'industry', icon: '🛤', time: 180, requires: ['automotive'], effect: '基建建设速度+25%', target: { construction: 0.25 } },
    { id: 'synthetic_refining', name: '合成炼油', cat: 'industry', icon: '🛢', time: 300, requires: ['advanced_engineering'], effect: '石油产量+30%', target: { resourceOil: 0.3 } },
    // ===== 海军 =====
    { id: 'naval_engineering_1', name: '海军工程(初)', cat: 'navy', icon: '🚢', time: 150, requires: [], effect: '舰船建造速度+10%', target: { navyBuild: 0.1 } },
    { id: 'destroyer_hull', name: '驱逐舰船体', cat: 'navy', icon: '🚢', time: 180, requires: ['naval_engineering_1'], effect: '解锁驱逐舰', target: { unlockEquipment: 'destroyer' } },
    { id: 'cruiser_hull', name: '巡洋舰船体', cat: 'navy', icon: '🚢', time: 240, requires: ['destroyer_hull'], effect: '解锁巡洋舰', target: { unlockEquipment: 'cruiser' } },
    { id: 'carrier_hull', name: '航母船体', cat: 'navy', icon: '🚢', time: 320, requires: ['cruiser_hull', 'naval_engineering_2'], effect: '解锁航母', target: { unlockEquipment: 'carrier' } },
    { id: 'naval_engineering_2', name: '海军工程(高)', cat: 'navy', icon: '⚓', time: 280, requires: ['cruiser_hull'], effect: '舰船建造速度+15%', target: { navyBuild: 0.15 } },
    // ===== 空军 =====
    { id: 'aero_dynamics', name: '空气动力学', cat: 'air', icon: '✈️', time: 180, requires: [], effect: '飞机建造速度+10%', target: { airBuild: 0.1 } },
    { id: 'fighter_design', name: '战斗机设计', cat: 'air', icon: '✈️', time: 200, requires: ['aero_dynamics'], effect: '解锁战斗机', target: { unlockEquipment: 'fighter' } },
    { id: 'bomber_design', name: '轰炸机设计', cat: 'air', icon: '🛩', time: 240, requires: ['aero_dynamics'], effect: '解锁轰炸机', target: { unlockEquipment: 'bomber' } },
    { id: 'tactical_bomber', name: '战术轰炸机', cat: 'air', icon: '🛩', time: 280, requires: ['bomber_design'], effect: '解锁战术轰炸机', target: { unlockEquipment: 'tactical_bomber' } },
    { id: 'radar_tech', name: '雷达技术', cat: 'air', icon: '📡', time: 300, requires: ['fighter_design'], effect: '对空防御+20%，解锁雷达', target: { airDefense: 0.2, unlockEquipment: 'radar' } },
    // ===== 武器设计（装备解锁） =====
    { id: 'light_tank_design', name: '轻坦设计', cat: 'army', icon: '🚜', time: 180, requires: ['automotive'], effect: '解锁轻坦', target: { unlockEquipment: 'light_tank' } },
    { id: 'medium_tank_design', name: '中坦设计', cat: 'army', icon: '🚜', time: 260, requires: ['light_tank_design', 'steel_alloys'], effect: '解锁中坦', target: { unlockEquipment: 'medium_tank' } },
    { id: 'heavy_tank_design', name: '重坦设计', cat: 'army', icon: '🚜', time: 340, requires: ['medium_tank_design', 'advanced_engineering'], effect: '解锁重坦', target: { unlockEquipment: 'heavy_tank' } },
    { id: 'infantry_equipment', name: '步兵装备', cat: 'army', icon: '🔫', time: 100, requires: [], effect: '解锁步兵武器', target: { unlockEquipment: 'infantry_weapon' } },
    { id: 'artillery_design', name: '火炮设计', cat: 'army', icon: '💣', time: 160, requires: ['infantry_equipment'], effect: '解锁火炮', target: { unlockEquipment: 'artillery' } },
    // ===== 政治 / 其它 =====
    { id: 'cipher_machine', name: '密码机', cat: 'support', icon: '🔐', time: 240, requires: [], effect: '情报效率+25%', target: { intelligence: 0.25 } },
    { id: 'paratroopers', name: '空降兵', cat: 'army', icon: '🪂', time: 300, requires: ['aero_dynamics', 'infantry_tactics'], effect: '空降师攻击+20%', target: { divisionType: 'infantry', attack: 0.2 } },
    { id: 'nuclear_fission', name: '核裂变', cat: 'support', icon: '☢', time: 420, requires: ['advanced_engineering', 'radar_tech'], effect: '解锁核武器，巨大威慑', target: { nuclear: true } },
];

/* ---------- 国家焦点（国家焦点树，简化版） ---------- */
// id, 名称, 图标, 前置焦点, 效果, 所属国家(空=通用)
const FOCUSES = [
    { id: 'f_industry_1', name: '重建工业', icon: '🏭', requires: [], effect: '+2 民用工厂', target: { civilianFactories: 2 } },
    { id: 'f_industry_2', name: '工业扩张', icon: '🏭', requires: ['f_industry_1'], effect: '+3 民用工厂', target: { civilianFactories: 3 } },
    { id: 'f_army_1', name: '扩军备战', icon: '🪖', requires: [], effect: '+10 战争支持', target: { warSupport: 10 } },
    { id: 'f_army_2', name: '全民动员', icon: '🎖', requires: ['f_army_1'], effect: '+20 人力，+5 战争支持', target: { manpower: 20, warSupport: 5 } },
    { id: 'f_tech_1', name: '科研资助', icon: '🔬', requires: [], effect: '+1 科研槽', target: { researchSlots: 1 } },
    { id: 'f_tech_2', name: '科学突破', icon: '🔬', requires: ['f_tech_1'], effect: '研究速度+15%', target: { researchSpeed: 0.15 } },
    { id: 'f_econ_1', name: '经济改革', icon: '📈', requires: [], effect: '稳定度+15', target: { stability: 15 } },
    { id: 'f_econ_2', name: '贸易协定', icon: '🤝', requires: ['f_econ_1'], effect: '资源收入+20%', target: { resourceIncome: 0.2 } },
    { id: 'f_diplo_1', name: '外交斡旋', icon: '🕊', requires: [], effect: '与所有国家关系+10', target: { relations: 10 } },
    { id: 'f_navy_1', name: '海军建设', icon: '🚢', requires: [], effect: '+2 军用工厂', target: { militaryFactories: 2 } },
    { id: 'f_navy_2', name: '舰队扩张', icon: '⚓', requires: ['f_navy_1'], effect: '海军建造速度+20%', target: { navyBuild: 0.2 } },
    { id: 'f_air_1', name: '空军建设', icon: '✈️', requires: [], effect: '+1 军用工厂', target: { militaryFactories: 1 } },
    { id: 'f_air_2', name: '航空扩张', icon: '🛩', requires: ['f_air_1'], effect: '空军建造速度+20%', target: { airBuild: 0.2 } },
    { id: 'f_claim_1', name: '领土诉求', icon: '🗺', requires: [], effect: '获得对邻国的外交要求(可制造借口)', target: { casusBelli: true } },
    { id: 'f_nuclear_1', name: '核计划', icon: '☢', requires: ['f_tech_1'], effect: '加速核裂变研究', target: { researchTech: 'nuclear_fission' } },
];

/* ---------- 事件 ---------- */
// id, 触发条件(函数或条件对象), 标题, 描述, 选项[{text, effect}]
const EVENTS = [
    {
        id: 'e_first_focus',
        trigger: { type: 'after_days', days: 30 },
        title: '国家方向',
        text: '我们的国家正面临历史的十字路口。请选择今后的发展方向。',
        choices: [
            { text: '优先发展工业与经济', effect: { civilianFactories: 1, stability: 5 } },
            { text: '优先发展军事', effect: { militaryFactories: 1, warSupport: 8 } },
            { text: '优先发展科研', effect: { researchSlots: 1 } },
        ],
    },
    {
        id: 'e_election',
        trigger: { type: 'after_days', days: 120 },
        title: '大选来临',
        text: '国内即将举行大选，政治格局可能因此改变。',
        choices: [
            { text: '承诺发展经济，稳固支持', effect: { stability: 10, warSupport: -5 } },
            { text: '承诺强化军力，鼓舞士气', effect: { warSupport: 12, stability: -3 } },
            { text: '承诺推进改革，激发活力', effect: { researchSpeed: 0.1, stability: -5 } },
        ],
    },
    {
        id: 'e_resource_boom',
        trigger: { type: 'random', chance: 0.15, after_days: 90 },
        title: '资源发现',
        text: '勘探队在本土发现了新的资源矿藏，这对我们的工业是重大利好。',
        choices: [
            { text: '立即开发，增加产出', effect: { resourceIncome: 0.15 } },
            { text: '保护环境，暂缓开发', effect: { stability: 8 } },
        ],
    },
    {
        id: 'e_conscription',
        trigger: { type: 'on_war', isWar: true },
        title: '征兵令',
        text: '战争需要更多兵员，是否全面动员？',
        choices: [
            { text: '全面动员，扩充军队', effect: { manpower: 15, warSupport: -8, stability: -5 } },
            { text: '有限动员，维持稳定', effect: { manpower: 8, warSupport: 5 } },
            { text: '拒绝动员，保民生', effect: { manpower: 5, stability: 8, warSupport: -10 } },
        ],
    },
    {
        id: 'e_spy_scandal',
        trigger: { type: 'random', chance: 0.1, after_days: 150 },
        title: '间谍丑闻',
        text: '情报部门破获了一起间谍案，涉及机密泄露，社会舆论哗然。',
        choices: [
            { text: '严惩不贷，彰显决心', effect: { stability: 6, intelligence: 0.1 } },
            { text: '低调处理，避免风波', effect: { stability: -5 } },
        ],
    },
    {
        id: 'e_industrial_breakthrough',
        trigger: { type: 'on_tech_complete', tech: 'advanced_engineering' },
        title: '工业突破',
        text: '我们的工业技术取得重大突破，生产效率大幅提升，举国欢庆。',
        choices: [
            { text: '扩大生产，抢占市场', effect: { civilianFactories: 2, factory: 0.1 } },
            { text: '投入军用，强化武备', effect: { militaryFactories: 2 } },
        ],
    },
];

// 暴露到全局
if (typeof window !== 'undefined') {
    window.GAME = GAME;
    window.IDEOLOGY = IDEOLOGY;
    window.RESOURCES = RESOURCES;
    window.EQUIPMENT = EQUIPMENT;
    window.DIVISION_TEMPLATES = DIVISION_TEMPLATES;
    window.TERRAIN = TERRAIN;
    window.PROVINCES = PROVINCES;
    window.COUNTRIES = COUNTRIES;
    window.TECHS = TECHS;
    window.FOCUSES = FOCUSES;
    window.EVENTS = EVENTS;
}
