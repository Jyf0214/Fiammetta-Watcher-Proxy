/**
 * 上游代理处理器
 *
 * 将下游请求转发到上游平台，支持：
 * - 流式响应（SSE TransformStream）
 * - 非流式响应（JSON 透传）
 * - 错误脱敏
 * - 熔断器状态记录
 * - 请求日志和 token 统计
 */

import { routeRequest, freezeAutoModel, isAutoModelRequest, getPlatformsForModel } from "./router";
import { getNextKey, getRandomKeyExcept, banKey, getAllKeys, isKeyBanned, isKeyDeprioritized, isKeyWhitelisted, recordKeyError } from "./platform-keys";
import { sendNotification } from "@/lib/notifier";
import { saveDebugLog } from "@/lib/debug-log";
import { recordSuccess, recordFailure, selectPlatform, releaseHalfOpenPending, checkAndUpdateCircuitBreakerState, recordPlatform429 } from "./load-balancer";
import { keyFingerprint } from "@/lib/key-status";
import {
  checkPlatformRpm,
  checkPlatformTpm,
  checkApiKeyRpm,
  checkApiKeyTpm,
  releasePlatformRpm,
  releasePlatformTpm,
} from "./rate-limiter";
import { runLimitGate } from "./proxy-core/limit-gate";
import type { LimitGateStage } from "./proxy-core/limit-gate";
import { buildProxyError } from "./proxy-core/error-response";
import { createUsageTransformer, recordRequestLog, extractClientInfo, updateKeyUsage } from "./token";
import { withIdleTimeout } from "./stream-guard";
import type { ProxyConfig } from "./endpoints";
import { extractForwardableHeaders, parseExtraHeaders } from "./forward-headers";
import { loadTemplates, getApplicableTemplates, applyTemplates } from "./request-templates";
import { isSafeUpstreamUrl } from "@/lib/ssrf";
import {
  convertOpenAIResponse,
  OpenAIToAnthropicStream,
  formatAnthropicError,
  AnthropicRequestError,
  estimateInputTokens,
  convertOpenAIRequest,
  OpenAIRequestError,
  convertAnthropicResponse,
  AnthropicToOpenAIStream,
} from "@/lib/anthropic";
import type { ApiKeyRecord } from "./auth";
import type { WorkerEnv } from "./config";

/**
 * 单请求 TPM 预估 token 数上界。
 * max_tokens 仅是输出上限，客户端可能传极大值（如 1000000），
 * 不钳制会一次烧尽整个 TPM 配额；8192 是高估但不离谱的单次输出预估值
 */
const MAX_ESTIMATED_TOKENS = 8192;

// ==================== 上游错误脱敏 ====================

/** 提取上游错误体中的可读消息 */
function extractUpstreamErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text);
    // parsed?.detail 可能是数组（FastAPI 标准格式）或对象，不能直接 String()，否则变成 "[object Object]"
    const raw = parsed?.error?.message || parsed?.message || parsed?.detail || "";
    if (typeof raw === "string") return raw.substring(0, 500);
    if (Array.isArray(raw)) return raw.map((r: unknown) => {
      const s = (r as Record<string, unknown>)?.msg || (r as Record<string, unknown>)?.detail || String(r);
      return typeof s === "string" ? s : "";
    }).filter(Boolean).join("; ").substring(0, 500);
    return String(raw).substring(0, 500);
  } catch {
    return "上游服务返回未知错误";
  }
}

/**
 * 对上游原始错误消息进行脱敏，防止敏感信息（如地区封锁策略、内部地址等）泄露给客户端
 * 403/401/429 返回通用消息，其余错误保留原始消息（5xx 错误信息通常不敏感）
 */
function sanitizeMessage(original: string, status: number): string {
  if (status === 403) return "上游访问被拒绝（HTTP 403）";
  if (status === 401) return "上游认证失败（HTTP 401）";
  if (status === 429) return "上游请求过多（HTTP 429）";
  return original;
}

/**
 * 脱敏上游错误响应，仅提取错误消息
 */
function sanitizeUpstreamError(errorText: string, upstreamStatus: number): string {
  return JSON.stringify({
    error: {
      message: sanitizeMessage(extractUpstreamErrorMessage(errorText), upstreamStatus),
      type: "upstream_error",
      upstream_status: upstreamStatus,
    },
  });
}

/**
 * 按协议构造错误响应：anthropic 用 {type:"error",error:{type,message}}，
 * openai 保持 {error:{message,type,...}}。状态码两边保持一致。
 * 响应体构造统一委托共享层 buildProxyError（三端同语义），本函数仅做薄适配：
 * protocol 未配置（undefined）时归入 openai，与历史 if 分支行为一致；
 * extra 仅透传数值型 retry_after——全文件唯一带 extra 的调用点即 429 门禁
 * 拒绝分支，恒传 { retry_after: <秒数整数> }；anthropic 分支丢弃 extra
 * （formatAnthropicError 无此参数），与历史行为一致。
 */
function v1ErrorResponse(
  cfg: ProxyConfig,
  status: number,
  message: string,
  type: string,
  extra?: Record<string, unknown>
): Response {
  const rawRetryAfter = extra?.["retry_after"];
  const payload = buildProxyError({
    protocol: cfg.protocol === "anthropic" ? "anthropic" : "openai",
    status,
    message,
    type,
    retryAfterSeconds:
      typeof rawRetryAfter === "number" ? rawRetryAfter : undefined,
  });
  return new Response(payload.body, {
    status: payload.status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 限流门禁四段被拒时的对外文案（与历史内联分支逐字一致）：
 * 平台级两段同时用作请求日志的 errorMessage，四段均用作下游 429 响应体 message
 */
const LIMIT_GATE_MESSAGES: Record<LimitGateStage, string> = {
  platformRpm: "上游平台请求频率超限",
  keyRpm: "API Key 请求频率超限",
  platformTpm: "上游平台 Token 速率超限",
  keyTpm: "API Key Token 速率超限",
};

// ==================== 流式空闲超时 ====================
// withIdleTimeout 已移至 stream-guard.ts（lite 版 Worker 共用），此处 re-export 保持兼容

export { withIdleTimeout };

// ==================== 上游超时与重试配置 ====================

/** 上游请求总超时（等待响应头 + 非流式响应体） */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** 流式响应空闲超时：距上次收到数据超过该时长即切断（正常持续传输的长流不受影响） */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * 可重试的上游错误状态码
 *
 * 429（限流）、401（密钥失效）、403（密钥无权限/被拦截）均表示当前 Key 或平台
 * 不可用，封禁当前 Key 并换 Key/换平台重试。5xx 等其它错误不重试，直接真实透传。
 */
const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 401, 403, 402]);

/**
 * 透传白名单禁透传头名（大小写不敏感）
 *
 * 认证类头（authorization/x-api-key 等）与请求语义关键头（content-type/host 等）
 * 一律不允许通过 forwardHeaders 白名单透传覆盖：白名单展开在认证头之后，
 * 若允许覆盖，任意下游客户端头可替换平台密钥（401 封禁循环或 BYOK 绕过计费），
 * content-type/host 等被覆盖则破坏请求语义甚至引发 SSRF 类错误路由。
 */
const FORBIDDEN_FORWARD_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "upgrade",
  "expect",
  // 下游伪造 x-forwarded-* 可污染日志 IP 与可信代理判定，统一禁止透传
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "eo-client-ip",
  "eo-connecting-ip",
  "x-vercel-forwarded-for",
]);

/**
 * 空响应哨兵：上游返回 2xx 但响应体为空（空 JSON / 空 SSE 流 / 空 multipart）。
 * handleUpstreamResponse 检测到后返回此哨兵，调用方将其判定为无效并纳入重试
 * （封禁当前 Key → 换 Key → 换平台），耗尽后返回 502 明确错误，绝不透传空响应。
 */
const EMPTY_UPSTREAM_RESPONSE = Symbol("empty-upstream-response");

// ==================== 请求体解析 ====================

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** multipart/form-data 请求体解析结果：仅提取 model 字段用于路由，原始字节转发时透传 */
type MultipartBody = { model: string | null; raw: Uint8Array; contentType: string };

async function parseRequestBody<T>(
  request: Request
): Promise<{ body: T } | { multipart: MultipartBody } | { error: Response }> {
  // 优先用 Content-Length 头快速拒绝超大请求，避免读取整个 body
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return {
      error: Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      ),
    };
  }

  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    // multipart（images/edits、audio/transcriptions 等）：此前只做 JSON.parse，
    // 标准客户端必然发送 multipart 导致固定 400「请求体格式错误」，端点形同虚设；
    // 现读取原始字节（重试循环需可重放 body），formData 仅用于提取 model 路由
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await request.arrayBuffer());
    } catch {
      return {
        error: Response.json(
          { error: { message: "读取请求体失败", type: "invalid_request_error" } },
          { status: 400 }
        ),
      };
    }

    // Content-Length 不存在或不准时，用实际字节数兜底
    if (raw.length > MAX_BODY_BYTES) {
      return {
        error: Response.json(
          { error: { message: "请求体过大", type: "invalid_request_error" } },
          { status: 413 }
        ),
      };
    }

    let model: string | null = null;
    try {
      const fd = await new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: raw,
      }).formData();
      const m = fd.get("model");
      model = typeof m === "string" && m.length > 0 ? m : null;
    } catch {
      // 非标准 multipart（boundary 畸形等）：model 留 null，调用方按缺 model 400
    }
    return { multipart: { model, raw, contentType } };
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return {
      error: Response.json(
        { error: { message: "读取请求体失败", type: "invalid_request_error" } },
        { status: 400 }
      ),
    };
  }

  // Content-Length 不存在或不准时，用字符串长度兜底（中文等多字节会略小，但足够做限制）
  if (bodyText.length > MAX_BODY_BYTES) {
    return {
      error: Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      ),
    };
  }

  let body: T;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      error: Response.json(
        { error: { message: "请求体格式错误", type: "invalid_request_error" } },
        { status: 400 }
      ),
    };
  }

  return { body };
}

// ==================== 统一代理入口 ====================
// ProxyConfig 类型已移至 endpoints.ts（lite 版 Worker 共用），此处 re-export 保持兼容

export type { ProxyConfig } from "./endpoints";

/**
 * 处理一个 V1 代理请求
 */
export async function proxyV1Request(
  request: Request,
  config: ProxyConfig,
  apiKey: ApiKeyRecord,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const logTag = `[v1-proxy:${config.upstreamPath}]`;

  // 提取 WorkerEnv 部分，供内部函数调用（避免 { DB, KV } & WorkerEnv 赋值给 WorkerEnv 的类型错误）
  const workerEnv: WorkerEnv = { DB_TYPE: env.DB_TYPE };

  // 客户端 IP/UA：所有请求日志（含错误分支）统一携带，日志页与导出的来源列依赖此值
  const clientInfo = extractClientInfo(request);

  // ── 1. 解析请求体 ──
  const parseResult = await parseRequestBody<Record<string, unknown>>(request);
  if ("error" in parseResult) {
    // 请求体解析错误（413 过大 / 400 读取失败或 JSON 格式错误）按协议格式化：
    // Anthropic 分支需要 {type:"error",error:{type,message}}，OpenAI 分支保持原错误形状
    const errRes = parseResult.error;
    const errBody = (await errRes.json().catch(() => ({}))) as { error?: { message?: string } };
    return v1ErrorResponse(config, errRes.status, errBody?.error?.message || "请求体解析失败", "invalid_request_error");
  }
  // multipart 请求（images/edits、audio/transcriptions 等）：model 从表单字段提取，
  // 原始字节在循环内原样透传上游（JSON 管道字段如 max_tokens/stream 不适用）
  let multipart: MultipartBody | null = null;
  if ("multipart" in parseResult) {
    multipart = parseResult.multipart;
    if (!multipart.model) {
      return v1ErrorResponse(config, 400, "缺少 model 参数", "invalid_request_error");
    }
  }
  // TS 联合收窄：in 运算符分支后 parseResult 类型被收窄到 { multipart }，
  // 不能直接写 .body；用 in 三元取回 body 分支（error 分支已提前 return）
  const rawBody = "body" in parseResult
    ? parseResult.body
    : { model: multipart!.model as string };
  let body = rawBody;

  // ── 2. 额外校验 ──
  if (config.validateBody) {
    const validationError = config.validateBody(body);
    if (validationError) return validationError;
  }

  // ── 2.5 Anthropic 协议：下游 /v1/messages 请求体 → OpenAI /chat/completions 请求体 ──
  // 转换后 model/max_tokens/stream 字段名与语义对齐，后续路由/限流/重试管道原样复用
  if (config.buildUpstreamBody) {
    try {
      body = config.buildUpstreamBody(body);
    } catch (err) {
      if (err instanceof AnthropicRequestError) {
        return Response.json(formatAnthropicError(400, err.message), { status: 400 });
      }
      throw err;
    }
  }

  // ── 3. 路由选择 ──
  const modelName = body.model as string | undefined;
  if (!modelName) {
    // 客户端漏传 model（/v1/models 之外所有端点必填）：按 4xx 返回，
    // 此前用 "__any__" 兜底恒路由失败返回 500，把客户端错误伪装成
    // 服务器故障并污染错误统计
    return v1ErrorResponse(config, 400, "缺少 model 参数", "invalid_request_error");
  }
  const requestedModel = modelName;
  // 根据端点判断下游来源 API：/responses 为 responses，其余按 chat 处理（与模板分类一致）
  const sourceApi = config.upstreamPath === "/responses" ? "responses" as const : "chat" as const;
  const route = await routeRequest(modelName, env.DB, workerEnv, sourceApi);

  if (!route) {
    // 路由失败（模型不存在/无平台支持）：platformId 未知记 null，补全请求失败记录
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: null,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 500,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: "此模型不存在",
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error(`${logTag} 日志写入失败:`, logError);
    }
    return v1ErrorResponse(config, 500, "此模型不存在", "server_error");
  }

  // ── 4. 速率限制检查（本地限制，不重试）──
  // 四段门禁（平台 RPM → Key RPM → 平台 TPM → Key TPM）的编排已收敛至
  // proxy-core/runLimitGate 统一实现：任一段拒绝即短路，仅当本请求确实持有
  // 半开探测槽位时才释放（bug L5），并按被拒段归还平台级配额——keyRpm 拒绝
  // 还平台 RPM、platformTpm 拒绝还平台 RPM（TPM 从未扣减不可还）、keyTpm
  // 拒绝还平台 RPM+TPM。
  // 行为差异（本批起）：
  // - 配额归还携带扣减时刻检查结果的窗口键（windowStart），替代原先按归还
  //   时刻现算——跨分钟边界回滚时现算窗口键会误减新窗口计数；
  // - platformTpm 拒绝不归还平台 TPM：旧版在此分支误还从未扣减的 TPM（check
  //   拒绝分支不写计数），会凭空膨胀有效上限——本批修正为仅归还已真实扣减的
  //   平台 RPM，并与 Pages 版既有正确行为对齐。
  // TPM 预扣 token 数：用请求体中的 max_tokens 作为预估 token 数
  // max_tokens 仅是输出上限，客户端可能传极大值，钳制到 MAX_ESTIMATED_TOKENS
  // Responses API 使用 max_output_tokens 字段，Chat 使用 max_tokens/max_completion_tokens，兼容两者。
  // multipart（图片/音频）请求体无 token 字段且实际消耗达数千至数万 token，
  // 按上限预扣（与 Pages 版 [[...v1]].ts 对齐），防止 TPM 配额被以 1 token 名义绕过
  const estimatedTokens = multipart
    ? MAX_ESTIMATED_TOKENS
    : Math.min(
        MAX_ESTIMATED_TOKENS,
        Math.max(1, Number((body as any).max_output_tokens || body.max_tokens || body.max_completion_tokens) || 1)
      );
  // Anthropic 转换器的 message_start.usage.input_tokens：用转换前请求体的输入估算
  // （max_tokens 是输出上限，语义不符；仅限流 TPM 继续用 estimatedTokens）
  const anthropicInputEstimate =
    config.protocol === "anthropic" ? estimateInputTokens(rawBody) : estimatedTokens;

  const gate = await runLimitGate(
    {
      initialHalfOpenHeld: route.halfOpenHeld === true,
      estimatedTokens,
      onGateRejected: async (stage) => {
        // 平台级限流反映平台过载/配额耗尽，计入该平台错误统计（Key 级限流是
        // 客户端行为，不记录避免污染平台评分——既有语义保持）
        if (stage !== "platformRpm" && stage !== "platformTpm") return;
        try {
          await recordRequestLog({
            keyId: apiKey.id,
            keyName: apiKey.name,
            platformId: route.platform.id,
            model: requestedModel,
            endpoint: config.upstreamPath,
            method: "POST",
            status: 429,
            tokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            ttft: 0,
            duration: Date.now() - startTime,
            isError: true,
            errorMessage: LIMIT_GATE_MESSAGES[stage],
            ipAddress: clientInfo.ipAddress,
            userAgent: clientInfo.userAgent,
            db: env.DB,
            env: workerEnv,
          });
        } catch (logError) {
          console.error(`${logTag} 日志写入失败:`, logError);
        }
      },
    },
    {
      checkPlatformRpm: () =>
        checkPlatformRpm(route.platform.id, route.platform.rpmLimit, env.KV),
      checkApiKeyRpm: () => checkApiKeyRpm(apiKey.id, apiKey.rpmLimit, env.KV),
      checkPlatformTpm: (est) =>
        checkPlatformTpm(route.platform.id, route.platform.tpmLimit, est, env.KV),
      checkApiKeyTpm: (est) =>
        checkApiKeyTpm(apiKey.id, apiKey.tpmLimit, est, env.KV),
      // 归还传扣减时刻窗口键（精确回滚），见上方「行为差异」说明
      releasePlatformRpm: (ws) =>
        releasePlatformRpm(route.platform.id, route.platform.rpmLimit, env.KV, ws),
      releasePlatformTpm: (est, ws) =>
        releasePlatformTpm(route.platform.id, route.platform.tpmLimit, est, env.KV, ws),
      releaseHalfOpenPending: () => releaseHalfOpenPending(route.platform.id),
    }
  );

  // ── 5. 上游错误自动重试（429/401/403：同平台换 Key → 换平台，最多 3 次）──
  const MAX_UPSTREAM_RETRIES = 3;

  let currentPlatform = route.platform;
  const currentTargetModel = route.targetModel;
  // 当前平台是否持有半开探测槽位：初值由限流门禁结果回传（通过门禁不消费
  // 槽位，等于 routeRequest 的 halfOpenHeld 标记，映射直选恒 false）；重试路径
  // 经 selectPlatform 换平台时同步更新，供循环内不走 recordSuccess/recordFailure
  // 的失败分支精确归还槽位（bug L5）
  let currentHalfOpenHeld: boolean;
  if (gate.allowed) {
    currentHalfOpenHeld = gate.halfOpenHeld;
  } else {
    // 门禁被拒（本地限制不重试）：按被拒段返回与原内联分支一致的 429 响应，
    // retry_after 由被拒段窗口结束时间换算为秒（KV 版拒绝必携带 resetAt，
    // ?? Date.now() 仅为可选类型的兜底，此时退化为 0 表示可立即重试）
    return v1ErrorResponse(
      config,
      429,
      LIMIT_GATE_MESSAGES[gate.stage],
      "rate_limit_error",
      { retry_after: Math.ceil(((gate.resetAt ?? Date.now()) - Date.now()) / 1000) }
    );
  }
  let currentKey = getNextKey(currentPlatform);
  const triedKeys = new Set<string>();
  const triedPlatforms = new Set<string>();

  // 如果初始平台没有可用 Key，尝试切换到其他有可用 Key 的平台
  if (!currentKey) {
    const allKeys = getAllKeys(currentPlatform);
    console.warn(
      `${logTag} 初始平台 "${currentPlatform.name}" (${currentPlatform.id}) 无可用 Key` +
      `（共 ${allKeys.length} 个 Key，封禁: ${allKeys.filter((k) => isKeyBanned(k, currentPlatform.id)).length}` +
      `，降级: ${allKeys.filter((k) => isKeyDeprioritized(k, currentPlatform.id)).length}` +
      `，白名单: ${allKeys.filter(isKeyWhitelisted).length}）` +
      `，尝试切换到其他平台`
    );
    triedPlatforms.add(currentPlatform.id);
    // 释放半开探测配额：仅当 routeRequest 经 selectPlatform 占用了该 half-open
    // 平台的探测槽位（halfOpenHeld=true，映射直选恒 false 未占用）才归还，否则
    // 会误减其他并发探测请求持有的槽位（bug L5）。不归还则槽位被无 Key 候选
    // 占满后该平台被排除探测，直到缓存重建（最长 30 秒）才恢复
    if (currentHalfOpenHeld) {
      releaseHalfOpenPending(currentPlatform.id);
      currentHalfOpenHeld = false;
    }

    // 与重试路径同语义：经 selectPlatform 过滤选择（熔断 open 排除/半开探测配额/
    // 高错误率降级/429 冷却/优先级排序），而非直接取第一个有 Key 候选——后者绕过
    // 全部负载均衡过滤，把请求打向已熔断或高错误率平台（bug M7）
    const availablePlatforms = [
      ...getPlatformsForModel(currentTargetModel, triedPlatforms),
    ];
    // 循环会逐个剔除无 Key 候选，提前快照候选总数供兜底日志统计
    const totalCandidates = availablePlatforms.length;
    let switched = false;
    while (availablePlatforms.length > 0 && !switched) {
      const nextPlatform = selectPlatform(availablePlatforms);
      if (!nextPlatform) break;
      const key = getNextKey(nextPlatform);
      if (key) {
        // 紧随 selectPlatform 同步判定占用状态（中间无 await，与 router.ts
        // heldHalfOpenSlot 同理）：选中即可能已为本次选择占用半开探测槽位，
        // 后续失败分支据此精确归还（bug L5）
        currentHalfOpenHeld =
          checkAndUpdateCircuitBreakerState(nextPlatform.id) === "half-open";
        currentPlatform = nextPlatform;
        currentKey = key;
        switched = true;
        console.log(
          `${logTag} 已切换到平台 "${nextPlatform.name}" (${nextPlatform.id})`
        );
      } else {
        // 该候选无可用 Key：剔除后继续尝试下一个候选。
        // 同时释放半开探测配额：nextPlatform 刚由上方 selectPlatform 选中
        // 且至此无 await 间隔——若其为 half-open 则 selectPlatform 必已为
        // 本次选择占用一个槽位，此处无条件释放恰好归还自己的占用；非
        // half-open 时 releaseHalfOpenPending 为无操作，无需 halfOpenHeld 标记。
        // 不释放则探测槽位被无 Key 候选占满后该平台被排除，直到缓存重建
        // （最长 30 秒）才恢复探测
        releaseHalfOpenPending(nextPlatform.id);
        availablePlatforms.splice(availablePlatforms.indexOf(nextPlatform), 1);
      }
    }

    if (!switched) {
      console.error(
        `${logTag} 所有平台均无可用 Key，` +
        `已检查 ${totalCandidates + 1} 个平台`
      );
      // 全部平台无可用 Key：平台维度未知记 null（配置问题，不计入任何平台评分）
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: null,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: 500,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: "所有平台均无可用 API Key",
          ipAddress: clientInfo.ipAddress,
          userAgent: clientInfo.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      // 告警：所有平台均无可用 Key（服务已不可用，最高优先级事件）
      void sendNotification(
        "all_unavailable",
        "所有平台均无可用 API Key",
        `模型 ${requestedModel} 的请求无任何可用平台/Key，已返回 500`,
        { db: env.DB, env: workerEnv }
      );
      return v1ErrorResponse(config, 500, "所有平台均无可用 API Key", "server_error");
    }
  }

  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    // 记录本次尝试的 Key 和平台
    if (currentKey) triedKeys.add(currentKey);
    triedPlatforms.add(currentPlatform.id);

    // 无可用 Key
    if (!currentKey) {
      const platformKeys = getAllKeys(currentPlatform);
      console.error(
        `${logTag} 平台 "${currentPlatform.name}" (${currentPlatform.id}) ` +
        `已无可用 Key（共 ${platformKeys.length} 个，` +
        `已尝试: ${triedKeys.size}，` +
        `封禁: ${platformKeys.filter((k) => isKeyBanned(k, currentPlatform.id)).length}，` +
        `降级: ${platformKeys.filter((k) => isKeyDeprioritized(k, currentPlatform.id)).length}）`
      );
      // 当前平台 Key 耗尽（同平台换 Key 失败）：计入该平台错误统计
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: 500,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: `平台 "${currentPlatform.name}" 无可用 API Key`,
          ipAddress: clientInfo.ipAddress,
          userAgent: clientInfo.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      return v1ErrorResponse(config, 500, `平台 "${currentPlatform.name}" 无可用 API Key`, "server_error");
    }

    // 上游为 Anthropic 协议（官方 Anthropic / GitHub Copilot / Vercel AI 网关）：
    // 请求体转回 /v1/messages 格式，URL 指向 /v1/messages，认证用 x-api-key + anthropic-version
    const upstreamIsAnthropic = currentPlatform.type === "anthropic";

    // chat↔responses 互转已移除（语义不可转换）：下游端点与上游端点原样透传，
    // effectiveTargetApi 仅用于选择命中的模板类型（responses 端点只命中 responses 模板）
    const effectiveTargetApi = config.upstreamPath === "/responses" ? "responses" as const : "chat" as const;
    const effectiveUpstreamPath = config.upstreamPath;

    // 构建上游请求体：模板先作用于原始 OpenAI 请求体。
    // Anthropic 分支随后转换——convertOpenAIRequest 白名单会剥离模板中的 OpenAI 专属字段
    // （stream_options/n/response_format 等），避免 Anthropic 严格后端 422 extra_forbidden
    // Responses 与 Chat 分流：当下游使用 /v1/responses 时，仅应用 responses 类型模板（解锁高阶思维链 reasoning 等）；
    // 普通 v1/chat 链路仅应用 chat 类型模板，互不干扰
    let upstreamBody: Record<string, unknown> = { ...body, model: currentTargetModel };
    // multipart 请求体无法注入 JSON 模板字段（表单已定形），跳过模板应用
    if (!multipart) {
      try {
        const templates = await loadTemplates(env.DB, workerEnv);
        const templateType = effectiveTargetApi;
        const applicable = getApplicableTemplates(templates, requestedModel, templateType);
        if (applicable.length > 0) {
          upstreamBody = applyTemplates(upstreamBody, applicable);
        }
      } catch (tplErr) {
        console.error(`${logTag} 加载请求模板失败:`, tplErr);
      }
    }

    if (upstreamIsAnthropic) {
      try {
        upstreamBody = convertOpenAIRequest(upstreamBody);
      } catch (convertError) {
        if (convertError instanceof OpenAIRequestError) {
          return v1ErrorResponse(config, 400, convertError.message, "invalid_request_error");
        }
        throw convertError;
      }
    }

    // 流式判定以模板应用后的结果为准：模板可改写 stream 字段，若按原始请求体预判定，
    // 模板开流而原始请求未开流时上游返回 SSE 而代理走非流式 JSON 分支，
    // JSON.parse 失败后原样透传 SSE 文本 + application/json，客户端必解析失败
    const effectiveIsStream = config.supportsStreaming !== false && upstreamBody.stream === true;

    // 流式请求注入 stream_options：仅当平台开启了注入开关时添加
    // 部分严格后端（Mistral 等 FastAPI/pydantic 校验）拒绝未知字段，返回 422 extra_forbidden
    // 用户可在平台管理页关闭此选项以兼容这类上游
    // Anthropic 协议上游同样拒绝未知字段，且 convertOpenAIRequest 已白名单剥离
    // Responses 端点不注入 stream_options（Responses 的流式 usage 由独立事件携带，注入旧字段可能被严格后端拒绝）
    if (effectiveIsStream && currentPlatform.injectStreamOptions !== false && !upstreamIsAnthropic && effectiveUpstreamPath !== "/responses") {
      upstreamBody.stream_options = { include_usage: true };
    }

    // 解析透传头（只保留合法 header 名，Workers fetch 对非法名会抛 TypeError）
    const rawForwardHeaders = extractForwardableHeaders(
      request.headers,
      currentPlatform.forwardHeaders
    );
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawForwardHeaders)) {
      // 只保留合法 header 名
      if (!/^[a-zA-Z0-9-]+$/.test(k)) continue;
      // 丢弃认证类/请求语义关键头（大小写不敏感）：白名单展开在认证头与
      // extraHeaders 之前，若允许 authorization/x-api-key/content-type/host 等
      // 透传覆盖，下游客户端可替换平台密钥或破坏请求语义
      if (FORBIDDEN_FORWARD_HEADERS.has(k.toLowerCase())) continue;
      forwardHeaders[k] = v;
    }

    const upstreamUrl = upstreamIsAnthropic
      ? `${currentPlatform.baseUrl.replace(/\/+$/, "")}/v1/messages`
      : `${currentPlatform.baseUrl.replace(/\/+$/, "")}${effectiveUpstreamPath}`;

    // SSRF 防护：校验上游 URL
    const urlCheck = isSafeUpstreamUrl(currentPlatform.baseUrl);
    if (!urlCheck.safe) {
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: 400,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: `上游 URL 不安全: ${urlCheck.reason}`,
          ipAddress: clientInfo.ipAddress,
          userAgent: clientInfo.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      return v1ErrorResponse(config, 400, `上游 URL 不安全: ${urlCheck.reason}`, "invalid_request_error");
    }

    // 发送上游请求
    // 注意：fetch resolve 后不立即 clearTimeout，signal 继续保护后续响应体读取；
    // 各分支（流式/非流式/错误）按需清理。
    let upstreamResponse: Response;
    const upstreamController = new AbortController();
    const upstreamTimeoutId = setTimeout(
      () => upstreamController.abort(),
      UPSTREAM_TIMEOUT_MS
    );
    try {
      const headers: Record<string, string> = {
        // multipart 请求：Content-Type 必须保留原始 boundary，否则上游无法解析表单
        "Content-Type": multipart ? multipart.contentType : "application/json",
        // Anthropic 协议上游：x-api-key + anthropic-version（extraHeaders 可覆盖为
        // Authorization 等，GitHub Copilot 等 OAuth 网关需用户自行配置）
        ...(upstreamIsAnthropic
          ? { "x-api-key": currentKey, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${currentKey}` }),
        ...forwardHeaders,
        // 高级设置：自定义请求头（强制覆盖），优先级高于下游透传头
        ...parseExtraHeaders(currentPlatform.extraHeaders),
      };
      // 高级设置：UA 复用（自定义 UA 优先级最高，覆盖 extraHeaders 中的 User-Agent）
      if (currentPlatform.reuseUserAgent && currentPlatform.customUserAgent) {
        headers["User-Agent"] = currentPlatform.customUserAgent;
      }
      upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: multipart ? multipart.raw : JSON.stringify(upstreamBody),
        signal: upstreamController.signal,
        // 禁止跟随重定向：isSafeUpstreamUrl 只校验初始 URL，
        // 跟随 3xx 可能将请求重定向到内网（SSRF / DNS rebinding TOCTOU）
        redirect: "manual",
      });
    } catch (fetchError) {
      clearTimeout(upstreamTimeoutId);
      // 网络层失败（总超时中止 / DNS 解析失败 / 连接拒绝等）统一补记请求日志并
      // 触发平台熔断，再返回明确错误——此前零记录零熔断（非 AbortError 直接 throw
      // 冒泡到入口 500），坏平台永远不会被降级，可用率高估、负载均衡反复撞上它
      const isAbort =
        (fetchError instanceof DOMException ||
          fetchError instanceof Error) &&
        fetchError.name === "AbortError";
      const status = isAbort ? 504 : 502;
      const errorMessage = isAbort
        ? `上游请求超时（${UPSTREAM_TIMEOUT_MS / 1000} 秒无响应头）`
        : `上游请求失败: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;

      try {
        await recordFailure(currentPlatform.id, env.DB, env);
      } catch (recordError) {
        console.error(
          `${logTag} 熔断器记录失败:`,
          recordError instanceof Error ? recordError.message : String(recordError)
        );
      }
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage,
          ipAddress: clientInfo.ipAddress,
          userAgent: clientInfo.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }

      if (isAbort) {
        return v1ErrorResponse(config, 504, "上游请求超时（2 分钟），请稍后重试", "timeout_error");
      }
      return v1ErrorResponse(config, 502, "上游请求失败（网络错误），请稍后重试", "upstream_error");
    }

    // ── 2xx 成功响应：正常处理（流式/非流式）──
    // 上游返回空响应（2xx + 空 body/空流）时 handleUpstreamResponse 返回哨兵，
    // 判定为无效，与 429/401/403 一样纳入重试（封禁当前 Key → 换 Key → 换平台）
    // 注意：redirect:"manual" 后 3xx 不再进入此分支，落入下方不可重试分支透传
    let isEmptyResponse = false;
    if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
      const handled = await handleUpstreamResponse(
        upstreamResponse,
        currentPlatform,
        apiKey,
        currentKey,
        requestedModel,
        config,
        effectiveIsStream,
        startTime,
        env,
        ctx,
        estimatedTokens,
        anthropicInputEstimate,
        logTag,
        upstreamController,
        upstreamTimeoutId,
        clientInfo
      );
      if (handled !== EMPTY_UPSTREAM_RESPONSE) return handled;
      isEmptyResponse = true;
    }

    // ── 5xx 等不可重试错误：真实透传状态码 + 熔断 + 错误日志 ──
    // 此前流式分支硬编码 200 透传任何非 429 状态，401/403/5xx 被伪装成成功，
    // 下游收到"200 + 空响应"，熔断器与 Key 封禁机制被完全架空。
    if (!isEmptyResponse && !RETRYABLE_UPSTREAM_STATUSES.has(upstreamResponse.status)) {
      // 上游 3xx（redirect:"manual" 不跟随）：重定向目标未经过 SSRF 校验，
      // 且 Location 头通常不会透传给下游，裸 3xx 对客户端无意义。这属于
      // 平台 baseUrl 配置错误而非平台故障，不计熔断失败，直接 502 明确提示
      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
        // 消费响应体释放连接（keep-alive 连接泄漏防护，与其他错误分支一致）
        try {
          await upstreamResponse.text();
        } catch {
          // 读取失败不影响流程
        }
        clearTimeout(upstreamTimeoutId);
        // 仅当当前平台持有半开探测槽位（首轮取 routeRequest 的 halfOpenHeld，
        // 重试轮取 selectPlatform 换平台时的占用标记）才归还；3xx 属配置错误
        // 不计熔断且不走 recordSuccess/recordFailure，必须在此显式归还（bug L5）
        if (currentHalfOpenHeld) {
          releaseHalfOpenPending(currentPlatform.id);
        }
        try {
          await recordRequestLog({
            keyId: apiKey.id,
            keyName: apiKey.name,
            platformId: currentPlatform.id,
            model: requestedModel,
            endpoint: config.upstreamPath,
            method: "POST",
            status: upstreamResponse.status,
            tokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            ttft: 0,
            duration: Date.now() - startTime,
            isError: true,
            errorMessage: `上游返回重定向（HTTP ${upstreamResponse.status}），请检查平台 baseUrl 配置`,
            ipAddress: clientInfo.ipAddress,
            userAgent: clientInfo.userAgent,
            db: env.DB,
            env: workerEnv,
          });
        } catch (logError) {
          console.error(`${logTag} 日志写入失败:`, logError);
        }
        return v1ErrorResponse(config, 502, "上游返回重定向，请检查平台 baseUrl 配置", "upstream_error");
      }
      let errorText = "";
      try {
        errorText = await upstreamResponse.text();
      } catch {
        // 读取错误体失败（如 signal 超时），保留空错误体
      }
      clearTimeout(upstreamTimeoutId);

      try {
        await recordFailure(currentPlatform.id, env.DB, env);
      } catch (recordError) {
        console.error(
          `${logTag} 熔断器记录失败:`,
          recordError instanceof Error ? recordError.message : String(recordError)
        );
      }

      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: upstreamResponse.status,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: errorText.substring(0, 1000),
          ipAddress: clientInfo.ipAddress,
          userAgent: clientInfo.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }

      // 自动模型冻结（bug L21）：不可重试 5xx 的提前 return 此前不经过重试
      // 耗尽处的冻结逻辑，自动模型分流选中的一次性坏模型不会被拉黑，后续
      // 请求仍会命中同一坏模型。守卫与最终失败处一致（isAutoModelRequest），
      // 仅冻结实际发送的目标模型（currentTargetModel），显式指定模型不受影响
      if (isAutoModelRequest(requestedModel)) {
        freezeAutoModel(currentTargetModel);
      }

      if (config.protocol === "anthropic") {
        return Response.json(
          formatAnthropicError(upstreamResponse.status, sanitizeMessage(extractUpstreamErrorMessage(errorText), upstreamResponse.status)),
          { status: upstreamResponse.status }
        );
      }
      return new Response(
        sanitizeUpstreamError(errorText, upstreamResponse.status),
        {
          status: upstreamResponse.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // ── 429/401/403/空响应：封禁当前 Key 并尝试切换 ──
    // 封禁与错误计数对每一轮（含最后一轮）都执行：此前只封禁可重试的中间轮次，
    // 最后一次尝试失败时该 Key 逃过 5 分钟封禁与 errorCount 累计，
    // 自动禁用阈值（5 次）被系统性稀释
    // 仅当当前平台持有半开探测槽位（首轮 routeRequest 的 halfOpenHeld / 重试轮
    // selectPlatform 换平台的占用标记）才显式归还：本路径不走
    // recordSuccess/recordFailure（二者内部会清零 pending），归还后立即清零标记，
    // 防止同平台换 Key 的下一轮失败在此重复释放误减他人槽位（bug L5）
    if (currentHalfOpenHeld) {
      releaseHalfOpenPending(currentPlatform.id);
      currentHalfOpenHeld = false;
    }
    await banKey(currentKey, undefined, currentPlatform.id, env.KV);
    // 平台级 429 冷却：429 是平台过载信号（区别于 Key 失效/越权），
    // 窗口内累计达阈值后平台进入冷却，调度层排除让上游限流窗口复位
    if (upstreamResponse.status === 429) recordPlatform429(currentPlatform.id);
    // 累加错误计数并持久化到数据库（429→+1, 401→+2, 402→+5, 其余→+1，达 5 次自动禁用）
    ctx.waitUntil(recordKeyError(currentKey, isEmptyResponse ? 502 : upstreamResponse.status, currentPlatform.id, env.DB, workerEnv).catch(() => {}));
    console.log(
      `${logTag} 上游 ${upstreamResponse.status}${isEmptyResponse ? "（空响应）" : ""} (平台: ${currentPlatform.name}, key: fingerprint:${keyFingerprint(currentKey)}, attempt: ${attempt + 1}/${MAX_UPSTREAM_RETRIES})，已封禁该 Key 5 分钟，尝试切换`
    );
    if (attempt < MAX_UPSTREAM_RETRIES) {
      // 本次尝试失败独立记日志：被重试覆盖的错误平台也必须进入平台错误统计，
      // 否则评分只见最终成功平台、错误率被严重低估
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: isEmptyResponse ? 502 : upstreamResponse.status,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: isEmptyResponse ? "上游返回空响应（重试切换）" : `上游 ${upstreamResponse.status}（已封禁该 Key 并重试切换）`,
          ipAddress: clientInfo.ipAddress,
          userAgent: clientInfo.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }

      // 清理本次尝试的超时定时器，避免泄漏
      clearTimeout(upstreamTimeoutId);

      // 策略 1：同平台换 Key
      const nextKey = getRandomKeyExcept(currentPlatform, triedKeys);
      if (nextKey) {
        // 消费响应体释放连接（429 是最高频上游错误，与 5xx 分支的 text() 消费对齐，
        // 避免连接滞留；仅真正重试时消费——无切换目标时下方需读取真实错误体）
        try {
          await upstreamResponse.text();
        } catch {
          // 读取失败（如 signal 超时）不影响重试流程
        }
        // 指数退避 + 抖动（防重试风暴）：同平台换 Key 后立即重打同一过载平台只会
        // 加剧 429（上游限流窗口未复位），等待 250ms×2^attempt（上限 2s）+
        // 0~250ms 随机抖动错峰后再发下一轮；换平台路径不加（新平台可能不忙）
        const backoffMs = Math.min(250 * Math.pow(2, attempt), 2000) + Math.random() * 250;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        currentKey = nextKey;
        continue;
      }

      // 策略 2：换平台（支持同一模型）——复用 selectPlatform 过滤熔断 open 平台并按优先级/权重
      // 选择；逐个尝试候选直到找到有可用 Key 的平台（选中平台 Key 全部封禁时若直接放弃，
      // 会漏掉其余候选直接 500，与循环外"初始平台无 Key 遍历全部候选"的行为不一致）
      const otherPlatforms = getPlatformsForModel(
        currentTargetModel,
        triedPlatforms
      );
      if (otherPlatforms.length > 0) {
        const candidates = [...otherPlatforms];
        let switched = false;
        while (candidates.length > 0 && !switched) {
          const nextPlatform = selectPlatform(candidates);
          if (!nextPlatform) break;
          const nextPlatformKey = getNextKey(nextPlatform);
          if (nextPlatformKey) {
            // 紧随 selectPlatform 同步判定占用状态（中间无 await，与 router.ts
            // heldHalfOpenSlot 同理）：选中即可能已为本次选择占用半开探测槽位，
            // 后续失败分支据此精确归还（bug L5）
            currentHalfOpenHeld =
              checkAndUpdateCircuitBreakerState(nextPlatform.id) === "half-open";
            // 消费响应体释放连接（同策略 1：仅真正重试时消费）
            try {
              await upstreamResponse.text();
            } catch {
              // 读取失败（如 signal 超时）不影响重试流程
            }
            currentPlatform = nextPlatform;
            currentKey = nextPlatformKey;
            switched = true;
          } else {
            // 该平台无可用 Key：剔除后继续尝试下一个候选。
            // 同时释放半开探测配额：nextPlatform 刚由上方 selectPlatform 选中
            // 且至此无 await 间隔——若其为 half-open 则 selectPlatform 必已为
            // 本次选择占用一个槽位，此处无条件释放恰好归还自己的占用；非
            // half-open 时 releaseHalfOpenPending 为无操作，无需 halfOpenHeld 标记。
            // 不释放则探测槽位被无 Key 候选占满后该平台被排除，直到缓存重建
            // （最长 30 秒）才恢复探测
            releaseHalfOpenPending(nextPlatform.id);
            candidates.splice(candidates.indexOf(nextPlatform), 1);
          }
        }
        if (switched) continue;
      }

      // 无更多可切换的目标
      console.log(
        `${logTag} 已无更多可切换的平台/Key，返回最后的 ${upstreamResponse.status} 响应`
      );
    }

    // 最后一次尝试或无处可切换：返回真实状态
    let errorText = "";
    try {
      errorText = await upstreamResponse.text();
    } catch {
      // 读取错误体失败（如 signal 超时），保留空错误体
    }
    clearTimeout(upstreamTimeoutId);
    try {
      await recordFailure(currentPlatform.id, env.DB, env);
    } catch (recordError) {
      console.error(
        `${logTag} 熔断器记录失败:`,
        recordError instanceof Error ? recordError.message : String(recordError)
      );
    }

    try {
      // 日志 status 记录实际返回下游的状态：空响应耗尽时下游收到 502，
      // 不再记上游的 200（此前记上游实际状态导致管理后台显示"成功"）
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: currentPlatform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: isEmptyResponse ? 502 : upstreamResponse.status,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: isEmptyResponse ? "上游返回空响应" : errorText.substring(0, 1000),
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error(`${logTag} 日志写入失败:`, logError);
    }

    // 自动模型冻结：冻结实际发送的目标模型（currentTargetModel）。
    // 此前冻结 requestedModel（自动模型场景下是自动模型 ID），与 routeRequest
    // 检查的候选具体模型名（frozenModels 键）不相等，冻结机制从未命中。
    if (isAutoModelRequest(requestedModel)) {
      freezeAutoModel(currentTargetModel);
    }

    // 失败请求留痕：置于空响应/协议分支之前，保证 anthropic 协议错误与
    // 空响应两类失败同样落库（与 Pages 版位置语义对齐）
    void saveDebugLog(env.DB, workerEnv?.DB_TYPE, {
      model: currentTargetModel,
      platformId: currentPlatform.id,
      status: upstreamResponse.status,
      requestBody: JSON.stringify(upstreamBody),
      responseSnippet: errorText,
    });

    // 空响应特判：绝不向下游透传空响应，返回 502 + 明确错误
    if (isEmptyResponse) {
      if (config.protocol === "anthropic") {
        return Response.json(formatAnthropicError(502, "上游返回空响应，请求已重试仍无内容"), { status: 502 });
      }
      return new Response(
        JSON.stringify({
          error: {
            message: "上游返回空响应，请求已重试仍无内容",
            type: "upstream_error",
            upstream_status: upstreamResponse.status,
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    if (config.protocol === "anthropic") {
      return Response.json(
        formatAnthropicError(upstreamResponse.status, sanitizeMessage(extractUpstreamErrorMessage(errorText), upstreamResponse.status)),
        { status: upstreamResponse.status }
      );
    }
    const errorBody = sanitizeUpstreamError(errorText, upstreamResponse.status);
    return new Response(errorBody, {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 不应到达此处，兜底返回
  return v1ErrorResponse(config, 503, "重试耗尽", "server_error");
}

// ==================== 上游响应处理 ====================

/**
 * OpenAI SSE → Anthropic SSE 的 TransformStream（Anthropic 协议分支专用）
 *
 * 接在 createUsageTransformer 之后：usage 提取/日志/截断检测仍作用于上游
 * OpenAI 流（语义不变），本转换器只把 OpenAI chunk 转成 Anthropic 事件
 * （message_start → content_block_* → message_delta → message_stop）
 */
function createAnthropicStreamTransformer(
  model: string,
  inputTokens: number
): TransformStream<Uint8Array, Uint8Array> {
  const streamer = new OpenAIToAnthropicStream({ model, inputTokens });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let errored = false;
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          // 流内 error：Anthropic 客户端靠 event: error 感知失败（与 Pages 侧语义一致）
          if (parsed.error) {
            const rawCode = parsed.error.code;
            const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" ? parseInt(rawCode, 10) : NaN;
            if (!Number.isNaN(code) && Number.isInteger(code) && code >= 400 && code <= 599) {
              errored = true;
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(formatAnthropicError(code, String(parsed.error.message || "").substring(0, 500)))}\n\n`));
              continue;
            }
          }
          // 纯 usage chunk（无 choices 键）也可能携带 output_tokens，不能过滤掉
          if (parsed.choices || parsed.usage) {
            const out = streamer.feedChunk(parsed);
            if (out) controller.enqueue(encoder.encode(out));
          }
        } catch {
          // 无法解析的行（非 JSON 数据）直接忽略，不影响流
        }
      }
    },
    flush(controller) {
      // 流内 error 已发事件，不再发正常收尾（message_stop）
      if (errored) return;
      const out = streamer.finish();
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}

/**
 * Anthropic SSE → OpenAI SSE 的 TransformStream（上游为 Anthropic 协议时专用）
 *
 * 接在 createUsageTransformer 之前：usage 提取/日志/截断检测作用于转换后的
 * OpenAI 流（语义不变），本转换器把 Anthropic 事件（message_start →
 * content_block_* → message_delta → message_stop）转成 OpenAI chunk，
 * 正常收尾输出 data: [DONE]（Anthropic 只有 message_stop，无 [DONE]）。
 */
function createOpenAIStreamTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const streamer = new AnthropicToOpenAIStream();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          const out = streamer.feedData(parsed);
          if (out) controller.enqueue(encoder.encode(out));
        } catch {
          // 无法解析的行（非 JSON 数据）直接忽略，不影响流
        }
      }
    },
    flush(controller) {
      const out = streamer.finish();
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}

/**
 * 处理上游成功响应（流式/非流式），记录日志和统计
 *
 * @param upstreamController 上游请求的 AbortController（signal 保护非流式响应体读取）
 * @param upstreamTimeoutId  上游请求总超时定时器（流式分支由空闲超时接管后清理）
 * @returns 正常响应，或 EMPTY_UPSTREAM_RESPONSE 哨兵（2xx 但响应体为空，交由调用方重试）
 */
async function handleUpstreamResponse(
  upstreamResponse: Response,
  platform: { id: string; name: string; type?: string },
  apiKey: ApiKeyRecord,
  /** 当前使用的平台上游 Key 明文：流内密钥类错误（429/401/402/403）时封禁+计数 */
  currentKey: string,
  requestedModel: string,
  config: ProxyConfig,
  isStream: boolean,
  startTime: number,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext,
  maxTokensEstimate: number,
  anthropicInputEstimate: number,
  logTag: string,
  upstreamController: AbortController,
  upstreamTimeoutId: ReturnType<typeof setTimeout>,
  /** 客户端 IP/UA（下游请求头提取）：所有日志分支落库来源信息 */
  clientInfo?: { ipAddress?: string; userAgent?: string }
): Promise<Response | typeof EMPTY_UPSTREAM_RESPONSE> {
  // 提取 WorkerEnv 部分，供内部函数调用
  const workerEnv: WorkerEnv = { DB_TYPE: env.DB_TYPE };
  // 上游是否为 Anthropic 协议：响应需先转成 OpenAI 内部格式再走 usage/下游转换管线
  const upstreamIsAnthropic = platform.type === "anthropic";
  // 流式响应（SSE）
  if (isStream) {
    const stream = upstreamResponse.body;
    if (!stream) {
      clearTimeout(upstreamTimeoutId);
      try {
        await recordFailure(platform.id, env.DB, env);
      } catch {
        console.error(`${logTag} 流式响应缺失时熔断器记录失败`);
      }
      return v1ErrorResponse(config, 500, "上游未返回流式响应", "server_error");
    }

    // 先读第一块判断是否为空流：200 + 空 SSE（首个 read 即 done）视为空响应，
    // 由调用方判定无效并重试；等待第一块仍受总超时（signal）保护
    const streamReader = stream.getReader();
    let firstChunk: ReadableStreamReadResult<Uint8Array>;
    try {
      firstChunk = await streamReader.read();
    } catch (readError) {
      clearTimeout(upstreamTimeoutId);
      if (upstreamController.signal.aborted) {
        return v1ErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
      }
      console.error(`${logTag} 流式响应首块读取失败:`, readError);
      await recordFailure(platform.id, env.DB, env);
      return v1ErrorResponse(config, 500, "读取上游响应失败", "server_error");
    }
    if (firstChunk.done) {
      clearTimeout(upstreamTimeoutId);
      streamReader.releaseLock();
      return EMPTY_UPSTREAM_RESPONSE;
    }

    // 总超时使命完成：流式响应允许长时间持续传输，改由空闲超时保护（无数据才切断）
    clearTimeout(upstreamTimeoutId);

    // 把已读到的第一块拼回流头部，继续透传
    const paddedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk.value);
      },
      pull(controller) {
        return streamReader.read().then(
          ({ done, value }) => {
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          },
          (err) => {
            // 上游流被取消（空闲超时切断）时 pending read 会 reject；控制器已关闭则忽略
            try {
              controller.error(err);
            } catch {
              // 控制器已关闭/error（cancel 路径），忽略二次错误
            }
          }
        );
      },
      cancel(reason) {
        return streamReader.cancel(reason);
      },
    });

    const transformer = createUsageTransformer({
      keyId: apiKey.id,
      keyName: apiKey.name,
      platformId: platform.id,
      model: requestedModel,
      startTime,
      // 流内密钥类错误（429/401/402/403）时封禁+计数：必须传当前平台上游 Key。
      // 传客户端 API Key 会让 recordKeyError 在平台 apiKeys 中查不到目标而静默
      // 跳过、banKey 产生永不命中的幽灵冷却条目，平台 Key 封禁机制被架空
      key: currentKey,
      endpoint: config.upstreamPath,
      // 上游未返回 usage 时以请求体 max_tokens 预估值兜底记账（防 tokenLimit 绕过）
      maxTokensEstimate,
      // 流内密钥类错误封禁时同步写 KV 持久化（CF 部署管理后台可见、冷启动恢复），
      // 与 HTTP 429 路径 banKey(..., env.KV) 键结构一致
      kv: env.KV,
      ipAddress: clientInfo?.ipAddress,
      userAgent: clientInfo?.userAgent,
      db: env.DB,
      env: workerEnv,
    });

    // 空闲超时置于 transformer 之前，直接包装上游流：只有上游真正无数据时才切断，
    // 下游消费慢（背压）不会误判。上游流正常结束时 transformer flush 写日志；
    // 挂起超时时 transformer 输入被 error 不会 flush，由 onTimeout 补记超时错误日志。
    const guardedStream = withIdleTimeout(
      paddedStream,
      UPSTREAM_IDLE_TIMEOUT_MS,
      () => {
        // 用 ctx.waitUntil 保护补记日志/熔断：超时路径下请求随即终结，
        // 在途 DB 写入会被 isolate 冻结截断
        ctx.waitUntil(
          // 挂起超时同样触发平台熔断（与 createUsageTransformer 截断分支一致）：
          // 只补记日志不打分的话，坏平台永远不会被降级，负载均衡反复撞上它
          recordFailure(platform.id, env.DB, env).catch((recordError) => {
            console.error(`${logTag} 空闲超时熔断器记录失败:`, recordError);
          })
        );
        ctx.waitUntil(
          recordRequestLog({
            keyId: apiKey.id,
            keyName: apiKey.name,
            platformId: platform.id,
            model: requestedModel,
            endpoint: config.upstreamPath,
            method: "POST",
            status: 504,
            tokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            ttft: 0,
            duration: Date.now() - startTime,
            isError: true,
            errorMessage: `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`,
            ipAddress: clientInfo?.ipAddress,
            userAgent: clientInfo?.userAgent,
            db: env.DB,
            env: workerEnv,
          }).catch((logError) => {
            console.error(`${logTag} 空闲超时日志写入失败:`, logError);
          })
        );
      }
    );
    // 上游 Anthropic 协议：先把 Anthropic 事件流转成 OpenAI chunk 流，
    // usage 提取/截断检测才能按 OpenAI 语义工作（[DONE] 收尾、usage 字段）
    let pipeline: ReadableStream<Uint8Array> = guardedStream;
    if (upstreamIsAnthropic) {
      pipeline = pipeline.pipeThrough(createOpenAIStreamTransformer());
    }
    const pipedStream = pipeline.pipeThrough(transformer);
    // Anthropic 协议：OpenAI SSE → Anthropic 事件流
    const finalStream = config.protocol === "anthropic"
      ? pipedStream.pipeThrough(createAnthropicStreamTransformer(requestedModel, anthropicInputEstimate))
      : pipedStream;
    // 不阻塞首字节：recordSuccess 在 half-open 恢复时会写库（TiDB/远端 DB 可达秒级），
    // 若在返回 Response 前 await，客户端 TTFB 会被拖到秒级（实测 9.95s）
    ctx.waitUntil(recordSuccess(platform.id, env.DB, env).catch(() => {}));

    return new Response(finalStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        // no-transform 防止中间代理/网关对 SSE 流做 gzip 缓冲
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // 非流式响应
  const responseContentType =
    upstreamResponse.headers.get("content-type") || "";

  // multipart 响应（audio/images）直接透传（同样受空闲超时保护）
  if (responseContentType.includes("multipart/")) {
    const multipartBody = upstreamResponse.body;
    if (!multipartBody) {
      clearTimeout(upstreamTimeoutId);
      return v1ErrorResponse(config, 500, "上游未返回响应体", "server_error");
    }
    // 先读第一块判断是否为空：空 multipart 视为空响应，交由调用方重试；
    // 等待第一块仍受总超时（signal）保护
    const multipartReader = multipartBody.getReader();
    let firstMultipart: ReadableStreamReadResult<Uint8Array>;
    try {
      firstMultipart = await multipartReader.read();
    } catch {
      clearTimeout(upstreamTimeoutId);
      if (upstreamController.signal.aborted) {
        return v1ErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
      }
      await recordFailure(platform.id, env.DB, env);
      return v1ErrorResponse(config, 500, "读取上游响应失败", "server_error");
    }
    if (firstMultipart.done) {
      clearTimeout(upstreamTimeoutId);
      multipartReader.releaseLock();
      return EMPTY_UPSTREAM_RESPONSE;
    }

    clearTimeout(upstreamTimeoutId);
    // 不阻塞首字节：multipart 响应同样在返回 Response 前把写库后置到 waitUntil（与流式分支一致）
    ctx.waitUntil(recordSuccess(platform.id, env.DB, env).catch(() => {}));

    ctx.waitUntil(
      recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: platform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 200,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: false,
        ipAddress: clientInfo?.ipAddress,
        userAgent: clientInfo?.userAgent,
        db: env.DB,
        env: workerEnv,
      }).catch((logError) => {
        console.error(`${logTag} 日志写入失败:`, logError);
      })
    );

    // 把已读到的第一块拼回流头部，继续透传
    const multipartPadded = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstMultipart.value);
      },
      pull(controller) {
        return multipartReader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        });
      },
      cancel(reason) {
        return multipartReader.cancel(reason);
      },
    });
    return new Response(
      withIdleTimeout(
        multipartPadded,
        UPSTREAM_IDLE_TIMEOUT_MS,
        () => {
          // 挂起超时补记 504 日志 + 触发熔断（与 SSE 分支一致）：此前无 onTimeout，
          // 音频/图片类 multipart 上游挂起 120s 被静默切断——无日志、无熔断、无计数
          ctx.waitUntil(
            recordFailure(platform.id, env.DB, env).catch((recordError) => {
              console.error(`${logTag} 空闲超时熔断器记录失败:`, recordError);
            })
          );
          ctx.waitUntil(
            recordRequestLog({
              keyId: apiKey.id,
              keyName: apiKey.name,
              platformId: platform.id,
              model: requestedModel,
              endpoint: config.upstreamPath,
              method: "POST",
              status: 504,
              tokens: 0,
              promptTokens: 0,
              completionTokens: 0,
              ttft: 0,
              duration: Date.now() - startTime,
              isError: true,
              errorMessage: `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`,
              ipAddress: clientInfo?.ipAddress,
              userAgent: clientInfo?.userAgent,
              db: env.DB,
              env: workerEnv,
            }).catch((logError) => {
              console.error(`${logTag} 空闲超时日志写入失败:`, logError);
            })
          );
        }
      ),
      {
        status: upstreamResponse.status,
        headers: { "Content-Type": responseContentType },
      }
    );
  }

  // JSON 响应（signal 继续保护响应体读取：120s 内未读完即中止）
  let responseBody: string;
  try {
    responseBody = await upstreamResponse.text();
  } catch {
    clearTimeout(upstreamTimeoutId);
    if (upstreamController.signal.aborted) {
      return v1ErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
    }
    await recordFailure(platform.id, env.DB, env);
    return v1ErrorResponse(config, 500, "读取上游响应失败", "server_error");
  } finally {
    clearTimeout(upstreamTimeoutId);
  }

  // 空响应：2xx 但响应体为空（上游返回空 body），判定无效交由调用方重试
  if (!responseBody.trim()) {
    return EMPTY_UPSTREAM_RESPONSE;
  }

  // 提取 usage 并更新统计（传入 max_tokens 预估值防篡改）
  let responseTokens = 0;
  let responsePromptTokens = 0;
  let responseCompletionTokens = 0;
  // 上游自报实时成本（usage.cost），成功日志优先采信
  let responseUpstreamCost: number | null = null;

  // 上游为 Anthropic 协议：先转成 OpenAI 内部格式（usage 提取与下游转换共用同一对象）；
  // 转换失败（非 JSON / 结构异常）时 openaiBody 为 null，交由下方 502 分支处理
  let openaiBody: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    openaiBody = upstreamIsAnthropic
      ? convertAnthropicResponse(parsed, requestedModel)
      : parsed;
    const usage = openaiBody.usage as Record<string, unknown> | undefined;
    if (usage) {
      const { extractUsage } = await import("./token");
      const extracted = extractUsage(usage, maxTokensEstimate);

      responseTokens = extracted.totalTokens;
      responsePromptTokens = extracted.promptTokens;
      responseCompletionTokens = extracted.completionTokens;
      responseUpstreamCost = extracted.upstreamCost;
    }
  } catch {
    // JSON 解析失败不影响响应
  }

  if (config.protocol === "anthropic") {
    // OpenAI chat.completion → Anthropic message（回显下游请求的模型名）
    try {
      if (!openaiBody) throw new Error("unparseable");
      const converted = JSON.stringify(
        convertOpenAIResponse(openaiBody, requestedModel)
      );
      // 转换成功后才更新用量/记成功日志，避免转换失败时 key usage 虚增
      if (responseTokens > 0) {
        const { updateKeyUsage } = await import("./token");
        ctx.waitUntil(updateKeyUsage(apiKey.id, responseTokens, env.DB, workerEnv).catch(() => {}));
      }
      // 不阻塞响应：成功日志/熔断记录后置到 waitUntil（与流式分支一致）
      ctx.waitUntil(
        recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: platform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: 200,
          tokens: responseTokens,
          promptTokens: responsePromptTokens,
          completionTokens: responseCompletionTokens,
          upstreamCost: responseUpstreamCost,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: false,
          ipAddress: clientInfo?.ipAddress,
          userAgent: clientInfo?.userAgent,
          db: env.DB,
          env: workerEnv,
        }).catch((logError) => {
          console.error(`${logTag} 日志写入失败:`, logError);
        })
      );
      ctx.waitUntil(recordSuccess(platform.id, env.DB, env).catch(() => {}));
      return new Response(converted, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      try {
        await recordFailure(platform.id, env.DB, env);
      } catch {
        // 熔断记录失败不影响响应
      }
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: platform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: 502,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: "上游响应格式错误",
          ipAddress: clientInfo?.ipAddress,
          userAgent: clientInfo?.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      return Response.json(formatAnthropicError(502, "上游响应格式错误"), { status: 502 });
    }
  }

  // 不阻塞响应：成功日志/熔断记录后置到 waitUntil（与流式分支一致）
  // 非流式直通成功记账：与 anthropic 转换分支对齐，此前缺失导致 stream:false
  // 请求绕过 tokenLimit/callUsed 扣减（计费漏洞）
  if (responseTokens > 0) {
    ctx.waitUntil(updateKeyUsage(apiKey.id, responseTokens, env.DB, workerEnv).catch(() => {}));
  }
  ctx.waitUntil(
    recordRequestLog({
      keyId: apiKey.id,
      keyName: apiKey.name,
      platformId: platform.id,
      model: requestedModel,
      endpoint: config.upstreamPath,
      method: "POST",
      status: upstreamResponse.status,
      tokens: responseTokens,
      promptTokens: responsePromptTokens,
      completionTokens: responseCompletionTokens,
      upstreamCost: responseUpstreamCost,
      ttft: 0,
      duration: Date.now() - startTime,
      isError: false,
      ipAddress: clientInfo?.ipAddress,
      userAgent: clientInfo?.userAgent,
      db: env.DB,
      env: workerEnv,
    }).catch((logError) => {
      console.error(`${logTag} 日志写入失败:`, logError);
    })
  );

  ctx.waitUntil(recordSuccess(platform.id, env.DB, env).catch(() => {}));

  // 上游为 Anthropic 协议时下游收到的是转换后的 OpenAI 格式（openaiBody 解析失败
  // 时保持透传原文，与 OpenAI 上游非 JSON 响应行为一致）
  // chat↔responses 互转已移除，非流式响应原样透传
  const finalBody = upstreamIsAnthropic && openaiBody ? JSON.stringify(openaiBody) : responseBody;
  return new Response(finalBody, {
    status: upstreamResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}
