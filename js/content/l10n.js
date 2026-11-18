/* ============================================================
 * 内容层 · 本地化（l10n.js）
 * key 分层：country.GER / event.danzig_demand.a / focus.rearmament
 * 缺 key：开发模式抛错，生产模式回退默认语言。
 * 支持 {country} / {date} / {value} 占位插值，避免拼接句子导致语序问题。
 * ============================================================ */

let dict = {};
let lang = 'zh';
let strict = true;   // 开发模式：缺 key 抛错

/** 加载某语言的字典 */
export function loadL10n(data, language = 'zh') {
    dict = data || {};
    lang = language;
    return dict;
}

/** 切换严格模式（开发/测试抛错，生产回退） */
export function setL10nStrict(v) { strict = !!v; }

/**
 * 取翻译。支持插值：t('msg', { country: 'GER', value: 5 })
 * 占位格式 {country}，缺失占位参数时保留原样。
 * 兼容 `l10n.` 前缀：剧本中常写 `l10n.country.GER`，字典键为 `country.GER`。
 */
export function t(key, params) {
    let s = dict[key];
    if (s === undefined && key.startsWith('l10n.')) s = dict[key.slice(5)];
    if (s === undefined) {
        if (strict) throw new Error(`[l10n] 缺失翻译 key: ${key}（语言 ${lang}）`);
        s = key;
    }
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            s = s.replaceAll(`{${k}}`, String(v));
        }
    }
    return s;
}

/** 当前语言 */
export function currentLang() { return lang; }
