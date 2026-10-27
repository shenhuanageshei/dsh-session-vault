/**
 * 全局搜索快捷键的**唯一实现**（设计档 §18.4 FR-P3-1 / §18.3 P3-D1 / A-P3-1）。
 *
 * 这个文件有两个消费者，逻辑只有这一份：
 *  ① scripts/build.mjs 剥掉 export 关键字后把整段内联进 lib/client.js 的单模块作用域
 *     （客户端的 keydown 捕获阶段监听器直接调它）；
 *  ② node --test 直接 import 它做纯函数断言（A-P3-1：shift+k 命中 / plain k 不命中 / 无修饰不命中）。
 *
 * 契约（与设计档逐字对齐）：
 *  - 命中 = (ctrl || meta) && shift && key === 'k'：shift 按住时浏览器给的 event.key 通常是 'K'，
 *    因此比较时小写化（'k' 与 'K' 都算命中）；
 *  - **普通 Ctrl/Cmd+K 不命中**，调用方对它**不得** preventDefault / stopPropagation ——
 *    那个键完全归宿主侧栏搜索（P3-D1：不注册、不拦截、不改写宿主行为）；
 *  - 无修饰的 k、只有 shift、只有 ctrl、其它键一律不命中；
 *  - 已经被别人处理过的事件（defaultPrevented）不重复命中：避免同一次按键把覆盖层开两遍。
 *
 *  - **按住不放的重复事件（repeat:true）不命中**（R6）：浏览器在长按时会连续派发 keydown，
 *    若每次都命中就会反复重开覆盖层/重派打开事件；这是「一次按键一次响应」的负向断言。
 *
 * 前置：eventShape 可以是任意值（null / 非对象 ⇒ 不命中，绝不抛）。
 * 后置：纯函数，无副作用、不读全局、不改入参。
 */
export function matchSearchShortcut(eventShape) {
  if (!eventShape || typeof eventShape !== 'object') return false;
  // R6：长按自动重复不得重开覆盖层（一次按键只响应一次）。
  if (eventShape.repeat === true) return false;
  const key = typeof eventShape.key === 'string' ? eventShape.key.toLowerCase() : '';
  if (key !== 'k') return false;
  const modifier = eventShape.ctrlKey === true || eventShape.metaKey === true;
  if (!modifier) return false;
  if (eventShape.shiftKey !== true) return false;
  if (eventShape.defaultPrevented === true) return false;
  return true;
}
