/**
 * 设置页整数输入的**唯一实现**（P3b / 代码评审 🔵：空串不得静默转成 0）。
 *
 * 旧实现 `update(field, Number(event.target.value))`：清空输入框 ⇒ Number('') === 0 ⇒ 保存后
 * archiveAgeDays=0（=关闭自动迁移）/ dailyBudgetCount=0（=当天一个都不迁）。用户只是「还没填完」，
 * 却静默关掉了一个功能 —— 这是本文件存在的唯一理由。
 *
 * 两个消费者：scripts/build.mjs 内联进 client bundle（设置页 onChange 用它）；node --test 直接 import。
 *
 * 契约：
 *  - 空串 / 纯空白 ⇒ {ok:false, reason:'empty'}（调用方保留旧值 + 提示，**不写 edits**）；
 *  - 非整数字面量（'1.5'、'abc'、'1e3'、'+3'）⇒ {ok:false, reason:'not-integer'}；
 *  - 超出 [min,max] ⇒ {ok:false, reason:'out-of-range'}；
 *  - 合法 ⇒ {ok:true, value}（整数）；
 *  - 纯函数：不读全局、不改入参；message 是给用户看的一句白话（含保留的原值）。
 */

function describeRange(options) {
  const hasMin = Number.isFinite(Number(options.min));
  const hasMax = Number.isFinite(Number(options.max));
  if (hasMin && hasMax) return '必须在 ' + Number(options.min) + '..' + Number(options.max) + ' 之间';
  if (hasMin) return '必须 ≥ ' + Number(options.min);
  if (hasMax) return '必须 ≤ ' + Number(options.max);
  return '取值非法';
}

/**
 * 解析一个整数输入框的值。
 *
 * @param {*} raw 输入框的当前原始值（event.target.value，允许 undefined / null）
 * @param {{min?:number, max?:number, fallback?:number, label?:string}} [options]
 *        fallback = 保留的旧值（写进提示文案；不参与解析）
 * @returns {{ok:boolean, value?:number, reason?:string, message?:string}}
 */
export function parseIntField(raw, options) {
  const opts = options || {};
  const label = typeof opts.label === 'string' && opts.label ? opts.label : '该字段';
  const hasFallback = Number.isFinite(Number(opts.fallback));
  const kept = hasFallback ? '（保留原值 ' + Number(opts.fallback) + '，未改动）' : '（未改动）';
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!text) {
    return { ok: false, reason: 'empty', message: label + '留空：' + kept };
  }
  // 只接受十进制整数字面量：'1.5' / '1e3' / '+3' / ' 3 4' 都不是「用户想填的整数」。
  if (!/^-?\d+$/.test(text)) {
    return { ok: false, reason: 'not-integer', message: label + '必须是整数' + kept };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'not-integer', message: label + '超出安全整数范围' + kept };
  }
  const hasMin = Number.isFinite(Number(opts.min));
  const hasMax = Number.isFinite(Number(opts.max));
  if ((hasMin && value < Number(opts.min)) || (hasMax && value > Number(opts.max))) {
    return { ok: false, reason: 'out-of-range', message: label + describeRange(opts) + '（收到 ' + value + '）' + kept };
  }
  return { ok: true, value };
}
