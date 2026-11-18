/* ============================================================
 * 钢铁雄心4 网页版 - AI（占位）
 * 旧实现直接操作 game.armies / game.production 等字段，已随模拟层
 * 重构（Game 退化为 Campaign 门面）而失效。
 *
 * 战役系统的 AI 按指南 §8 设计：效用打分（战略层/战术层），
 * 走同一套 Command 管道，计算分片放入 Worker。属于后续 W5 工作，
 * 此处仅保留占位，避免脚本引用失效。
 * ============================================================ */

const AI = {
    // TODO(W5): 效用打分 AI。届时由 Campaign 在月度结算中调用，
    // 通过 campaign.command() 下发决策，不开后门直接改状态。
    tickCountry(game, countryId) { /* 占位：旧经济/战斗 AI 已移除 */ },
};

if (typeof window !== 'undefined') window.AI = AI;
