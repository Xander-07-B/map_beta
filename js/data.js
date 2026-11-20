/* ============================================================
 * 钢铁雄心4 网页版 - 界面常量 data.js
 * 只保留纯展示用的常量表。游戏规则数据（装备、科技、部队模板、
 * 剧本、国策、事件）已全部迁到 data/ 下的内容文件，由战役核心
 * （js/core/、js/content/）加载与校验，本文件不再重复定义。
 * ============================================================ */

/* ---------- 意识形态 ---------- */
const IDEOLOGY = {
    democracy:   { name: '民主',   color: '#5d7fa8', icon: '⚖' },
    fascism:     { name: '法西斯', color: '#b8504a', icon: '▲' },
    communism:   { name: '共产主义', color: '#a8743f', icon: '★' },
    neutrality:  { name: '中立',   color: '#6b7484', icon: '○' },
    // 战役核心（指南）的意识形态取值，与上表同义
    democratic:  { name: '民主',   color: '#5d7fa8', icon: '⚖' },
    fascist:     { name: '法西斯', color: '#b8504a', icon: '▲' },
    communist:   { name: '共产主义', color: '#a8743f', icon: '★' },
    neutral:     { name: '中立',   color: '#6b7484', icon: '○' },
};

/* ---------- 资源定义（仅展示用，产出数值在剧本 economy 中） ---------- */
const RESOURCES = {
    steel:     { name: '钢铁',   icon: '⬢', color: '#8a9099' },
    iron:      { name: '铁矿',   icon: '◆', color: '#a8623a' },
    oil:       { name: '石油',   icon: '●', color: '#4a8a5a' },
    rubber:    { name: '橡胶',   icon: '❋', color: '#5a8a5a' },
    energy:    { name: '电力',   icon: '⚡', color: '#b8985a' },
    aluminium: { name: '铝',     icon: '⬡', color: '#7a8a9a' },
    supplies:  { name: '补给',   icon: '▢', color: '#8a7a6a' },
    munitions: { name: '弹药',   icon: '✸', color: '#b85a52' },
    rare:      { name: '稀有材料', icon: '✦', color: '#8a5a9a' },
};

/* ---------- 地形（展示用；结算用的修正值在 js/core/war.js） ---------- */
const TERRAIN = {
    plain:    { name: '平原', color: '#3a5a3a', defBonus: 0,   moveBonus: 0 },
    plains:   { name: '平原', color: '#3a5a3a', defBonus: 0,   moveBonus: 0 },
    hills:    { name: '丘陵', color: '#4a6a42', defBonus: 0.15, moveBonus: -0.1 },
    forest:   { name: '森林', color: '#1a4028', defBonus: 0.3,  moveBonus: -0.2 },
    mountain: { name: '山地', color: '#5a5a5a', defBonus: 0.5,  moveBonus: -0.5 },
    desert:   { name: '沙漠', color: '#8a7a4a', defBonus: 0.1,  moveBonus: -0.1 },
    tundra:   { name: '苔原', color: '#6a7a8a', defBonus: 0.2,  moveBonus: -0.3 },
    ocean:    { name: '海洋', color: '#10304a', defBonus: 0,    moveBonus: 0 },
    coast:    { name: '海岸', color: '#1a4a6a', defBonus: 0,    moveBonus: 0 },
};

// 暴露到全局
if (typeof window !== 'undefined') {
    window.IDEOLOGY = IDEOLOGY;
    window.RESOURCES = RESOURCES;
    window.TERRAIN = TERRAIN;
}
