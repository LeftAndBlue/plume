/**
 * 光标跳转历史（Alt + ← / →）与字号缩放纯函数。
 * 零外部依赖，既在 runtime.js 中接入编辑器，也可在 Node 单元测试中直接验证。
 */

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 28;
export const FONT_SIZE_DEFAULT = 16;

export function clampFontSize(size) {
  const n = Math.round(Number(size));
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n));
}

export function stepFontSize(current, delta) {
  const base = clampFontSize(current);
  const step = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  return clampFontSize(base + step);
}

/**
 * 光标跳转历史栈：
 * - 点击大纲、页内锚点、搜索命中、切换标签，或大跨度跳转（默认 >= 5 行）时记录原位置
 * - Alt+← 返回上一处编辑位置，Alt+→ 前进
 * - 同文档相近位置自动去重，避免栈内塞满相邻行
 */
export function createJumpHistory({ maxEntries = 50, minLineDelta = 5 } = {}) {
  /** @type {Array<{ path: string | null, pos: number, line: number }>} */
  const back = [];
  /** @type {Array<{ path: string | null, pos: number, line: number }>} */
  const forward = [];
  let navigating = false;

  const sameLoc = (a, b) => {
    if (!a || !b) return false;
    const pa = a.path ? String(a.path).toLowerCase() : null;
    const pb = b.path ? String(b.path).toLowerCase() : null;
    if (pa !== pb) return false;
    return Math.abs((a.line || 0) - (b.line || 0)) < minLineDelta;
  };

  function normalize(entry) {
    return {
      path: entry?.path ?? null,
      pos: Math.max(0, Number(entry?.pos) || 0),
      line: Math.max(1, Number(entry?.line) || 1),
    };
  }

  function record(entry, { force = false } = {}) {
    if (navigating || !entry) return false;
    const loc = normalize(entry);
    const top = back[back.length - 1];
    if (top && !force && sameLoc(top, loc)) {
      // 更新同一区域内的最新精确偏移，但不新增条目
      back[back.length - 1] = loc;
      return false;
    }
    if (top && top.path === loc.path && top.pos === loc.pos) return false;
    back.push(loc);
    if (back.length > maxEntries) back.shift();
    forward.length = 0;
    return true;
  }

  function goBack(current) {
    if (!back.length) return null;
    const target = back.pop();
    if (current) {
      const cur = normalize(current);
      const fwdTop = forward[forward.length - 1];
      if (!fwdTop || fwdTop.path !== cur.path || fwdTop.pos !== cur.pos) {
        forward.push(cur);
        if (forward.length > maxEntries) forward.shift();
      }
    }
    return target;
  }

  function goForward(current) {
    if (!forward.length) return null;
    const target = forward.pop();
    if (current) {
      const cur = normalize(current);
      const backTop = back[back.length - 1];
      if (!backTop || backTop.path !== cur.path || backTop.pos !== cur.pos) {
        back.push(cur);
        if (back.length > maxEntries) back.shift();
      }
    }
    return target;
  }

  function runNavigating(fn) {
    navigating = true;
    try {
      return fn();
    } finally {
      navigating = false;
    }
  }

  async function runNavigatingAsync(fn) {
    navigating = true;
    try {
      return await fn();
    } finally {
      navigating = false;
    }
  }

  function clear() {
    back.length = 0;
    forward.length = 0;
  }

  return {
    record,
    goBack,
    goForward,
    runNavigating,
    runNavigatingAsync,
    clear,
    isNavigating: () => navigating,
    canGoBack: () => back.length > 0,
    canGoForward: () => forward.length > 0,
    sizes: () => ({ back: back.length, forward: forward.length }),
  };
}
