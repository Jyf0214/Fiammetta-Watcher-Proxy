/**
 * 上游总超时守卫（proxy-core 第三块）
 *
 * 三入口（worker/src/proxy.ts 全量版、worker/src/proxy-lite.ts lite 版、
 * pages/api/v1/[[...v1]].ts Pages 版）在发送上游 fetch 前各自内联了完全
 * 相同的一段：
 *   const upstreamController = new AbortController();
 *   const upstreamTimeoutId = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
 * 并在多个退出分支各自 clearTimeout(upstreamTimeoutId)。本模块把该模式收敛
 * 为单一实现：守卫内聚 AbortController，到点执行 onTimeout（通常即
 * controller.abort()），clear() 幂等清理定时器。
 *
 * 语义契约（逐条对齐三端现状）：
 * 1. 到点只做调用方传入的 onTimeout，回调外不添加任何逻辑；onTimeout 内的
 *    异常不被吞掉（与内联 setTimeout 回调行为一致，直接向上冒泡）；
 * 2. clear() 仅 clearTimeout，不 abort、不做任何附带动作（对齐现状中各退出
 *    分支「只清定时器」的写法）；clearTimeout 对已清理/已触发的定时器重复
 *    调用是无害 no-op——三端现状正是多个退出分支各自 clearTimeout 的写法，
 *    因此 clear 天然幂等，无需额外状态位；
 * 3. signal 与 controller 同时暴露的原因：三端现状均把 controller.signal 传给
 *    fetch，失败后再读 upstreamController.signal.aborted 区分「总超时中止
 *    （504 timeout_error）」与其他网络错误（500）；暴露 controller 保持该判定
 *    写法不变，signal 为其便捷别名（恒等于 controller.signal）。
 *
 * 范围裁剪（宁可少抽象不可错抽象）：本模块只收「上游总超时守卫」。以下两类
 * 超时刻意不收：
 * - Pages 的 WRITE_DRAIN_TIMEOUT_MS（30s 写背压守卫）：drain/close/超时三路
 *   竞态一次性 settle，且回调内改写外部状态（clientClosed）并取消上游流读取，
 *   语义与入口强耦合，强行抽象会引入行为漂移风险；
 * - 流式空闲超时：Worker 全量/lite 已共用 stream-guard.ts 的 withIdleTimeout
 *   （逐块重挂定时器），Pages 用 setInterval 看门狗轮询实现同一目标，机制本就
 *   不同，且 Worker 侧已有共享实现，无需再造。
 */

/** 上游总超时守卫 */
export interface TimeoutGuard {
  /** 传给 fetch 的中止信号：onTimeout 触发后变为 aborted（便捷别名） */
  readonly signal: AbortSignal;
  /**
   * 守卫内聚的 AbortController：供调用方按三端现状以
   * controller.signal.aborted 判定「超时中止」与其他网络错误
   */
  readonly controller: AbortController;
  /** 幂等清理定时器：可安全重复调用（含触发后调用） */
  clear(): void;
}

/** createUpstreamTimeoutGuard 入参 */
export interface CreateUpstreamTimeoutGuardOptions {
  /** 总超时时长（毫秒），如三端的 UPSTREAM_TIMEOUT_MS = 120_000 */
  timeoutMs: number;
  /** 到点回调：通常传 () => guard.controller.abort()；异常不被吞掉 */
  onTimeout: () => void;
}

/**
 * 创建上游总超时守卫
 *
 * 纯定时器编排：无 I/O、无副作用。setTimeout 对非法时长会静默退化
 * （负数/NaN 按立即触发处理）、onTimeout 非函数则到点才抛更难定位，
 * 故创建时显式校验报错，拒绝糊弄。
 */
export function createUpstreamTimeoutGuard(
  opts: CreateUpstreamTimeoutGuardOptions
): TimeoutGuard {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new RangeError(`timeoutMs 必须为正的有限数值，收到: ${String(opts.timeoutMs)}`);
  }
  if (typeof opts.onTimeout !== "function") {
    throw new TypeError(`onTimeout 必须为函数，收到: ${typeof opts.onTimeout}`);
  }

  const controller = new AbortController();
  const timerId = setTimeout(() => {
    // 契约第 1 条：只执行 onTimeout，不包裹 try/catch，异常原样冒泡
    opts.onTimeout();
  }, opts.timeoutMs);

  return {
    controller,
    get signal() {
      return controller.signal;
    },
    clear() {
      // 契约第 2 条：仅清定时器。clearTimeout 幂等，重复调用安全
      clearTimeout(timerId);
    },
  };
}
