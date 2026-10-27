/**
 * 列表窗口化（虚拟滚动）的**唯一实现**（设计档 §16 UI 契约 ② / FR-P3-6 / A-P3-6 / P3-D7）。
 *
 * 两个消费者，逻辑只有一份：
 *  ① scripts/build.mjs 剥掉 export 关键字后内联进 lib/client.js 的单模块作用域（面板渲染它）；
 *  ② node --test 直接 import 它做纯函数断言（A-P3-6：>200 行窗口化、≤200 行全量渲染）。
 *
 * 契约（与设计档 §18.4 FR-P3-6 对齐）：
 *  - 阈值 = **200 行**：total > 200 才窗口化；total === 200 仍然全量渲染（「>200」是严格大于）；
 *  - 窗口 = 可视区行数 + 上下各 OVERSCAN 行（设计档「渲染可视区 ±20 行 + 上下占位」）；
 *  - 上下占位用像素高度表达（padTop / padBottom），保证滚动条长度与真实内容一致；
 *  - 空列表 / 非法入参一律返回空窗口（绝不抛，也不返回负高度）；
 *  - 纯函数：不读全局、不碰 DOM、不改入参。
 */

/** 窗口化阈值（行）：严格大于它才窗口化（A-P3-6）。 */
export const VIRTUAL_THRESHOLD = 200;
/** 单行固定高度（px）：窗口化按固定行高换算，UI 的行必须真的锁成这个高度。 */
export const VIRTUAL_ROW_HEIGHT = 56;
/** 可视区上下各多渲染的行数（设计档「±20 行」）。 */
export const VIRTUAL_OVERSCAN = 20;

function toFiniteInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.trunc(num);
}

/**
 * 计算要渲染的行窗口。
 *
 * 前置：total / scrollTop / viewport 允许任意值（非有限数按 0 处理）；
 *       options.rowHeight / options.overscan / options.threshold 可覆盖默认常量。
 * 后置：返回 { start, end, count, padTop, padBottom, virtual }：
 *       - [start, end) 是**应当渲染**的行下标区间（end 独占）；
 *       - padTop / padBottom 是上下占位的像素高度；
 *       - virtual=false 时 start=0、end=total、两个占位都是 0（全量渲染）。
 *
 * @param {number} total 总行数
 * @param {number} scrollTop 容器当前滚动位移（px）
 * @param {number} viewport 容器可视高度（px）
 * @param {{rowHeight?:number, overscan?:number, threshold?:number}} [options]
 * @returns {{start:number,end:number,count:number,padTop:number,padBottom:number,virtual:boolean}}
 */
export function windowRange(total, scrollTop, viewport, options) {
  const opts = options || {};
  const rowHeight = Math.max(1, toFiniteInt(opts.rowHeight, VIRTUAL_ROW_HEIGHT));
  const overscan = Math.max(0, toFiniteInt(opts.overscan, VIRTUAL_OVERSCAN));
  const threshold = Math.max(0, toFiniteInt(opts.threshold, VIRTUAL_THRESHOLD));
  const rows = Math.max(0, toFiniteInt(total, 0));
  const empty = { start: 0, end: 0, count: 0, padTop: 0, padBottom: 0, virtual: false };
  if (!rows) return empty;
  if (rows <= threshold) {
    return { start: 0, end: rows, count: rows, padTop: 0, padBottom: 0, virtual: false };
  }
  const scrolled = Math.max(0, toFiniteInt(scrollTop, 0));
  const height = Math.max(0, toFiniteInt(viewport, 0));
  const firstVisible = Math.floor(scrolled / rowHeight);
  const visibleRows = Math.ceil(height / rowHeight) + 1;
  const start = Math.max(0, Math.min(rows - 1, firstVisible - overscan));
  const end = Math.max(start, Math.min(rows, firstVisible + visibleRows + overscan));
  return {
    start,
    end,
    count: Math.max(0, end - start),
    padTop: start * rowHeight,
    padBottom: Math.max(0, (rows - end) * rowHeight),
    virtual: true,
  };
}
