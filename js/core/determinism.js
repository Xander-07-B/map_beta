/* ============================================================
 * 战役核心 · 确定性工具（determinism.js）
 * 定点数：跨端一致的数值用整数（×1000），避免浮点在不同引擎下不严格一致。
 * 有序容器：凡遍历顺序影响随机结果的集合，一律走显式排序，不依赖 Record 键序。
 * ============================================================ */

/** 定点数缩放系数：0~1 的量（稳定度、战争支持度等）以 ×1000 的整数存储 */
export const FP_SCALE = 1000;

/** 浮点 → 定点整数 */
export const toFP = (x) => Math.round(x * FP_SCALE);

/** 定点整数 → 浮点 */
export const fromFP = (x) => x / FP_SCALE;

/** 定点加法（整数运算） */
export const fpAdd = (a, b) => a + b;

/** 定点乘法：a * b，结果仍为 ×FP_SCALE 的定点整数 */
export const fpMul = (a, b) => Math.round((a * b) / FP_SCALE);

/** 定点加法就地累加，带上限钳制（用于稳定度等 0~1 量） */
export function fpAddClamp01(target, delta) {
    return Math.max(0, Math.min(FP_SCALE, target + delta));
}

/** Record 的字符串键升序列表——需要确定性遍历时使用 */
export function orderedKeys(record) {
    return Object.keys(record).sort();
}

/** Record 的数字 id 升序列表（省份/州等数值 id 用数值排序，避免字典序错乱） */
export function orderedNumericIds(record) {
    return Object.keys(record).map(Number).sort((a, b) => a - b);
}

/**
 * 深拷贝状态。优先 structuredClone（保留 TypedArray 类型）；
 * 老环境回退 JSON（仅用于过渡，存档主路径应使用 structuredClone/二进制）。
 */
export function cloneState(state) {
    if (typeof structuredClone === 'function') return structuredClone(state);
    return JSON.parse(JSON.stringify(state));
}

/**
 * 规范序列化：递归排序对象键、把 TypedArray 展开为普通数组。
 * 用于确定性测试中比较两份状态是否逐位一致（键序不敏感）。
 */
export function canonicalStringify(v) {
    if (ArrayBuffer.isView(v)) {
        return JSON.stringify({ __type: v.constructor.name, data: Array.from(v) });
    }
    if (Array.isArray(v)) {
        return '[' + v.map(canonicalStringify).join(',') + ']';
    }
    if (v && typeof v === 'object') {
        const keys = Object.keys(v).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
}
