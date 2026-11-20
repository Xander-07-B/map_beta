/* ============================================================
 * 战役核心 · 统一出口（core/index.js）
 * 浏览器：挂载到 window.Core，供现有经典脚本（game.js/ui.js 等）
 * 在后续集成阶段按模块取用；Node 测试直接 import 各模块。
 * ============================================================ */

export * from './rng.js';
export * from './clock.js';
export * from './determinism.js';
export * from './state.js';
export * from './commands.js';
export * from './rules.js';
export * from './economy.js';
export * from './war.js';
export * from './ai.js';
export * from '../content/schema.js';
export * from '../content/loader.js';
export * from '../content/conditions.js';
export * from '../content/l10n.js';
export * from '../campaign.js';

import * as rng from './rng.js';
import * as clock from './clock.js';
import * as determinism from './determinism.js';
import * as state from './state.js';
import * as commands from './commands.js';
import * as rules from './rules.js';
import * as economy from './economy.js';
import * as war from './war.js';
import * as ai from './ai.js';
import * as schema from '../content/schema.js';
import * as loader from '../content/loader.js';
import * as conditions from '../content/conditions.js';
import * as l10n from '../content/l10n.js';
import * as campaign from '../campaign.js';

if (typeof window !== 'undefined') {
    window.Core = {
        ...rng,
        ...clock,
        ...determinism,
        ...state,
        ...commands,
        ...rules,
        ...economy,
        ...war,
        ...ai,
        ...schema,
        ...loader,
        ...conditions,
        ...l10n,
        ...campaign,
    };
}
