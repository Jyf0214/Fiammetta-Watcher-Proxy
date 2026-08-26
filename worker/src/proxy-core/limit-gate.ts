/**
 * 限流门禁核心 — 「四段式限流门禁」的单一收敛实体（proxy-core 第一块）
 *
 * 三入口（worker/src/proxy.ts 全量版、worker/src/proxy-lite.ts lite 版、
 * pages/api/v1/[[...v1]].ts Pages 版）此前各自内联实现了同一段门禁流程：
 * 平台 RPM → Key RPM → 平台 TPM → Key TPM 依次检查，任一不允许即短路拒绝，
 * 并在各拒绝分支做半开探测槽位释放与平台级配额归还。三份平行实现曾在
 * 「哪些分支归还哪些配额、windowStart 是否随传、槽位是否无条件释放」上
 * 多处不对称（bug L5 及后续逐项修复），本模块把这些语义固化为唯一实现，
 * 三端以依赖注入方式接入：
 * - Worker 全量版：注入 worker/src/rate-limiter.ts（KV 版）四 check +
 *   两 release + load-balancer 的 releaseHalfOpenPending；
 * - Pages 版：注入 src/lib/v1-rate-limit.ts（内存版）同名函数 +
 *   releaseHalfOpenPending（Pages 侧同样从 worker/src/load-balancer 导出语义，
 *   由接入层闭包捕获 platformId）；
 * - lite 版：无限流段、无熔断器 —— 注入「恒 allowed 且无副作用」的空实现
 *   （见 __tests__ 中的 noopAdapters 组合），本模块对其不做任何特殊分支。
 *
 * 语义契约（逐条对齐三端现状已修复后的放行行为）：
 * 1. 检查顺序固定 pRpm → kRpm → pTpm → kTpm，任一不允许立即短路；
 * 2. 各拒绝分支仅在请求确实持有半开探测槽位（initialHalfOpenHeld）时释放，
 *    否则会误减其他并发探测请求持有的槽位（bug L5）；
 * 3. 配额归还集合：keyRpm 拒绝 → 仅归还平台 RPM；platformTpm 拒绝 → 归还
 *    平台 RPM（TPM 计数在 check 拒绝分支从未写入，归还 TPM 会误减其他已
 *    放行请求的真实用量，令有效上限膨胀）；keyTpm 拒绝 → 归还平台 RPM + TPM
 *    （「先扣平台后扣 Key」顺序下此时两者均已真实扣减）；platformRpm 拒绝
 *    → 无归还（check 拒绝分支自身未扣减）；
 * 4. 归还一律使用「扣减时刻」的平台级 check 结果中的 windowStart（pRpm /
 *    pTpm 的），绝不使用被拒 Key 级结果的窗口键 —— 跨分钟边界回滚时按
 *    归还时刻现算或误用他窗键都会误减新窗口计数（凭空放行下一窗口配额）；
 * 5. TPM 检查与归还使用同一个 estimatedTokens 预估值（由本模块统一下发，
 *    防止适配器两侧取值错位导致归还量与扣减量不一致）；
 * 6. 所有 release（含槽位释放）失败均 try/catch 吞掉，尽力而为，不阻断
 *    拒绝响应（Worker 版现状即此语义；Pages 版原无包裹，接入后为容错增强）；
 * 7. onGateRejected 钩子在槽位/配额清理完成之后调用（对应现状中
 *    recordRequestLog 与 429 响应发送位于清理之后的顺序）；钩子内异常不由
 *    本模块吞掉 —— 日志写入的容错由接入方在钩子内部自行处理（现状的
 *    try/catch 即写在各入口内联处）。
 *
 * 本模块为纯流程编排，不做任何 I/O：存储访问、平台/Key 上下文、日志与响应
 * 全部经 adapters 闭包与 onGateRejected 钩子留在调用侧。
 */

// ==================== 类型 ====================

/**
 * 单段限流检查结果的公共形状
 *
 * 双端 check（worker/src/rate-limiter.ts 的 KV 版、src/lib/v1-rate-limit.ts
 * 的内存版）返回的 RateLimitResult 均结构兼容本形状（多余的 remaining 字段
 * 不影响赋值）：
 * - allowed：是否放行；
 * - resetAt：当前窗口结束时间戳（毫秒），拒绝时供调用方计算 retry_after；
 * - windowStart：本次检查所用固定窗口键起点（毫秒）。所有走窗口键的分支
 *   （含拒绝）均携带；未触发窗口计数（limit 为 null 或 tokenCount <= 0）
 *   时省略 —— 此时对应的 release 也会因 limit 为 null / est <= 0 自行跳过。
 */
export interface RateLimitCheckResult {
  allowed: boolean;
  resetAt?: number;
  windowStart?: number;
}

/** 门禁四段的标识：platformRpm → keyRpm → platformTpm → keyTpm */
export type LimitGateStage =
  | "platformRpm"
  | "keyRpm"
  | "platformTpm"
  | "keyTpm";

/**
 * 限流门禁适配器集
 *
 * 全部由调用方注入；平台 ID、API Key、限额配置、KV/内存存储等上下文一律
 * 经闭包捕获，本接口刻意保持无上下文参数，使三端得以共用同一编排。
 */
export interface LimitGateAdapters {
  /** 平台级 RPM 检查（闭包捕获 platformId/rpmLimit/存储） */
  checkPlatformRpm(): Promise<RateLimitCheckResult>;
  /** API Key 级 RPM 检查（闭包捕获 apiKeyId/rpmLimit/存储） */
  checkApiKeyRpm(): Promise<RateLimitCheckResult>;
  /**
   * 平台级 TPM 检查。estimatedTokens 由本模块传入（取自 LimitGateInput），
   * 保证检查扣减与拒绝归还使用同一预估值。
   */
  checkPlatformTpm(estimatedTokens: number): Promise<RateLimitCheckResult>;
  /** API Key 级 TPM 检查，estimatedTokens 语义同上 */
  checkApiKeyTpm(estimatedTokens: number): Promise<RateLimitCheckResult>;
  /**
   * 归还一次平台级 RPM 扣减。windowStart 应传扣减时刻（checkPlatformRpm
   * 结果）的窗口键；未传时由底层退化为按当前时刻现算（向后兼容历史行为）。
   */
  releasePlatformRpm(windowStart?: number): Promise<void>;
  /**
   * 归还平台级 TPM 扣减。estimatedTokens 必须与 checkPlatformTpm 扣减时的
   * 预估一致（本模块恒传同一值）；windowStart 语义同 releasePlatformRpm，
   * 取自扣减时刻 checkPlatformTpm 结果的窗口键。
   */
  releasePlatformTpm(estimatedTokens: number, windowStart?: number): Promise<void>;
  /**
   * 释放半开探测槽位（闭包捕获 platformId，底层为 load-balancer 的
   * releaseHalfOpenPending）。仅当本请求确实持有时才会被调用。
   * lite 等无熔断端的注入 no-op。
   */
  releaseHalfOpenPending(): void | Promise<void>;
}

/** 门禁入参 */
export interface LimitGateInput {
  /**
   * 首轮路由（routeRequest/selectPlatform）是否已为本请求占用目标平台的
   * 半开探测槽位：映射直选路径恒 false，经 selectPlatform 选中的 half-open
   * 平台为 true。所有槽位释放据此条件化（bug L5）。
   */
  initialHalfOpenHeld: boolean;
  /** TPM 段预扣 token 数：同一值同时用于检查扣减与拒绝归还 */
  estimatedTokens: number;
  /**
   * 拒绝钩子：在槽位/配额清理完成后调用，供调用方记录请求日志并发送 429
   * 响应（本模块不负责任何 I/O）。result 为被拒段的原始检查结果（含
   * resetAt/windowStart）。钩子内部异常会向上传播，日志容错请由钩子自理
   * （与现状中各入口自行 try/catch recordRequestLog 一致）。
   */
  onGateRejected(
    stage: LimitGateStage,
    result: RateLimitCheckResult
  ): void | Promise<void>;
}

/** 门禁结果 */
export type LimitGateResult =
  /**
   * 四段全部通过。halfOpenHeld 回传当前的槽位持有状态（通过门禁不消费
   * 槽位，等于 initialHalfOpenHeld），供请求后续阶段的失败分支判断是否
   * 需要 releaseHalfOpenPending 归还（对应 proxy.ts 的 currentHalfOpenHeld
   * 与 [[...v1]].ts 的 curHoldsHalfOpenSlot 生命周期起点）。
   */
  | { allowed: true; halfOpenHeld: boolean }
  | {
      allowed: false;
      /** 被短路的段 */
      stage: LimitGateStage;
      /** 被拒段的窗口结束时间戳（毫秒），供计算 retry_after */
      resetAt?: number;
    };

// ==================== 核心流程 ====================

/**
 * 执行四段式限流门禁
 *
 * 编排语义见文件头「语义契约」。任一段拒绝即停止后续检查，完成该段对应的
 * 槽位释放与配额归还后触发 onGateRejected 并返回拒绝结果；四段全过则原样
 * 回传槽位持有状态。
 */
export async function runLimitGate(
  input: LimitGateInput,
  adapters: LimitGateAdapters
): Promise<LimitGateResult> {
  let halfOpenHeld = input.initialHalfOpenHeld;
  const est = input.estimatedTokens;

  /** 仅当本请求持有半开探测槽位时释放（bug L5：无条件释放会误减他人槽位） */
  const maybeReleaseSlot = async (): Promise<void> => {
    if (!halfOpenHeld) return;
    halfOpenHeld = false;
    try {
      await adapters.releaseHalfOpenPending();
    } catch {
      // 尽力而为：槽位释放失败不阻断拒绝响应（与现有实现一致）
    }
  };

  /** 配额归还尽力而为：失败不阻断主流程（与现有实现的 try/catch 一致） */
  const safeRelease = async (release: () => Promise<void>): Promise<void> => {
    try {
      await release();
    } catch {
      // 尽力而为：忽略归还失败
    }
  };

  // ── 1. 平台 RPM ──
  const pRpm = await adapters.checkPlatformRpm();
  if (!pRpm.allowed) {
    // check 拒绝分支自身未扣减计数，无配额可还，仅处理槽位
    await maybeReleaseSlot();
    await input.onGateRejected("platformRpm", pRpm);
    return { allowed: false, stage: "platformRpm", resetAt: pRpm.resetAt };
  }

  // ── 2. Key RPM ──
  const kRpm = await adapters.checkApiKeyRpm();
  if (!kRpm.allowed) {
    // 平台 RPM 已扣：归还（Key 级限流是客户端行为，不归还则平台共享配额被
    // 无关请求白白消耗）。窗口键必须用扣减时刻 pRpm.windowStart，
    // 不得用被拒 Key 级结果的窗口键
    await maybeReleaseSlot();
    await safeRelease(() => adapters.releasePlatformRpm(pRpm.windowStart));
    await input.onGateRejected("keyRpm", kRpm);
    return { allowed: false, stage: "keyRpm", resetAt: kRpm.resetAt };
  }

  // ── 3. 平台 TPM ──
  const pTpm = await adapters.checkPlatformTpm(est);
  if (!pTpm.allowed) {
    // 平台 TPM 计数从未写入（check 拒绝分支不扣减），不可归还 TPM——归还会
    // 误减其他已放行请求累计的真实用量，令有效上限膨胀；已扣的平台 RPM 属
    // 真实扣减，需归还（与 keyRpm 分支同一理由）
    await maybeReleaseSlot();
    await safeRelease(() => adapters.releasePlatformRpm(pRpm.windowStart));
    await input.onGateRejected("platformTpm", pTpm);
    return { allowed: false, stage: "platformTpm", resetAt: pTpm.resetAt };
  }

  // ── 4. Key TPM ──
  const kTpm = await adapters.checkApiKeyTpm(est);
  if (!kTpm.allowed) {
    // 平台 RPM/TPM 均已扣：一并归还，est 与扣减时保持同一预估值；
    // 窗口键分别传扣减时刻的 pRpm.windowStart / pTpm.windowStart 防跨窗口误减
    await maybeReleaseSlot();
    await safeRelease(() => adapters.releasePlatformRpm(pRpm.windowStart));
    await safeRelease(() => adapters.releasePlatformTpm(est, pTpm.windowStart));
    await input.onGateRejected("keyTpm", kTpm);
    return { allowed: false, stage: "keyTpm", resetAt: kTpm.resetAt };
  }

  // 四段全过：槽位不被门禁消费，原样回传持有状态供后续失败分支判断
  return { allowed: true, halfOpenHeld };
}
