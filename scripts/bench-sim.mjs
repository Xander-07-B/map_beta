/* ============================================================
 * 模拟核心性能基准（scripts/bench-sim.mjs）
 * 运行：npm run bench
 * 以 AI-only 模式推进 600 个游戏日（20 个月决策轮），输出
 * 总耗时、每 tick 平均耗时，并校验两轮运行结果一致。
 * ============================================================ */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Core from '../js/core/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fetchJson = async (url) => JSON.parse(readFileSync(path.join(ROOT, url), 'utf8'));

const loaded = await Core.loadScenario('1936', { fetchJson });
const DAYS = 600;

function runOnce() {
    const camp = new Core.Campaign(loaded, { seed: 0x1936 });
    camp.newGame();
    camp.setAI(true);
    const t0 = process.hrtime.bigint();
    camp.fastForward(DAYS);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { camp, ms };
}

const first = runOnce();
const second = runOnce();

for (const [label, r] of [['第 1 轮', first], ['第 2 轮', second]]) {
    console.log(`${label}: ${r.ms.toFixed(0)} ms（${(r.ms / DAYS).toFixed(2)} ms/日）`);
}
const s = first.camp.state;
console.log(`状态：${s.armies.length} 支陆军 / ${s.airForces.length} 个空军群 / ${s.fleets.length} 支舰队 / ${s.wars.length} 场战争`);
console.log(`确定性：${s.armies.length === second.camp.state.armies.length ? '一致 ✓' : '不一致 ✗'}`);
console.log(`吞吐：${(DAYS / (first.ms / 1000)).toFixed(1)} 游戏日/秒`);
