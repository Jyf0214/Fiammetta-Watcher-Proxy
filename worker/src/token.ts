/**
 * Token 计算和统计
 *
 * 从上游响应中提取 token 用量信息，
 * 更新 API Key 已用 token 数，记录请求日志。
 */

import { proxyStatKey } from "@/lib/upstream-proxy";
import { computeCost, ensurePricingLoaded, getPricingSnapshot } from "@/lib/model-pricing";
import { recordFailure, recordPlatform429 } from "./load-balancer";
import { banKey, recordKeyError, isPlatformWhitelisted } from "./platform-keys";
import { bufferKeyUsage, bufferRequestLog, initBatchedWriter } from "./batched-writer";
import type { WorkerEnv } from "./config";

/**
 * 提取上游自报的实时成本（美元）
 *
 * 部分上游（如 OpenRouter）在 usage 中直接返回本次请求成本（cost / total_cost）。
 * 实时计价优先于价格表估算：仅采信明确为正的上报值——0 与"未返回"无法区分，
 * 交由价格表估算兜底，避免把"未上报"误记成免费。
 * 上界钳制 1e6 美元：单请求成本超过该值只可能是脏数据/恶意构造，
 * 原样入库会经 _sum 放大到统计层。
 */
const UPSTREAM_COST_MAX = 1_000_000;

function extractUpstreamCost(usage: Record<string, unknown>): number | null {
  const raw = Number((usage as any).cost ?? (usage as any).total_cost);
  return Number.isFinite(raw) && raw > 0 && raw <= UPSTREAM_COST_MAX ? raw : null;
}

/**
 * 把上游实时成本注入响应体 usage.cost 字段
 *
 * OpenAI Chat/Responses/OpenRouter 均在 usage.cost 返回本次请求实际费用（美元）。
 * 上游未自报或非法值时 cost 为 null：调用方已走价格表估算兜底，但价格表估算值
 * 不入 usage.cost（仅记日志/统计），避免把估算与上游实时计费混在一起给客户端造成误读。
 *
 * 不可序列化值/usage 缺失/非对象等异常一律忽略——usage.cost 是增强字段，
 * 注入失败必须不影响主响应体下发。
 */
export function enrichUsageWithCost(bodyText: string, cost: number | null): string {
  if (cost === null) return bodyText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!parsed || typeof parsed !== "object") return bodyText;
  const obj = parsed as Record<string, unknown>;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return bodyText;
  (usage as Record<string, unknown>).cost = cost;
  return JSON.stringify(obj);
}

/**
 * 从 OpenAI 格式的 usage 对象中提取 token 数
 *
 * @param maxTokensEstimate - 请求体中的 max_tokens 预估值，用于防止上游返回 0 绕过配额
 */
export function extractUsage(
  usage: Record<string, unknown> | undefined,
  maxTokensEstimate: number = 0
): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 上游自报的实时成本（美元）；未上报或非法时为 null，调用方回退价格表估算 */
  upstreamCost: number | null;
} {
  const noUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, upstreamCost: null };
  if (!usage) {
    // 上游未返回 usage 时用请求体预估值兜底（与下方 totalTokens<=0 同一防绕过语义）
    if (maxTokensEstimate > 0) {
      return {
        promptTokens: maxTokensEstimate,
        completionTokens: 0,
        totalTokens: maxTokensEstimate,
        upstreamCost: null,
      };
    }
    return noUsage;
  }

  // 上游实时成本：只要 usage 存在即尝试提取（token 数被防篡改钳制的场景不影响成本上报）
  const upstreamCost = extractUpstreamCost(usage);
  // 兼容 Chat (prompt_tokens/completion_tokens) 与 Responses (input_tokens/output_tokens) 两种 usage 形态
  // Responses API 返回 input_tokens/output_tokens/total_tokens，且可能包含 reasoning_tokens
  let promptTokens = Number(usage.prompt_tokens ?? (usage as any).input_tokens) || 0;
  let completionTokens = Number(usage.completion_tokens ?? (usage as any).output_tokens) || 0;
  // reasoning_tokens 计入 completion（若单独返回）
  const reasoningTokens = Number((usage as any).reasoning_tokens) || 0;
  if (reasoningTokens > 0 && completionTokens === 0) {
    completionTokens = reasoningTokens;
  } else if (reasoningTokens > 0) {
    // reasoning_tokens 已包含在 output_tokens 时不重复累加；否则累加
    // 经验：output_tokens 已含 reasoning_tokens，故不额外加
  }
  const totalTokens =
    Number(usage.total_tokens) || promptTokens + completionTokens;

  // 某些上游只返回 total_tokens，不返回 prompt/completion 分项
  // 此时仅填充 promptTokens，completionTokens 保持 0，避免翻倍计入
  if (totalTokens > 0 && promptTokens === 0 && completionTokens === 0) {
    promptTokens = totalTokens;
    completionTokens = 0;
  }

  // 防止上游篡改 token 计数绕过配额：usage 为 0 时使用请求体预估值
  if (totalTokens <= 0 && maxTokensEstimate > 0) {
    return {
      promptTokens: maxTokensEstimate,
      completionTokens: 0,
      totalTokens: maxTokensEstimate,
      upstreamCost,
    };
  }

  // requestLogs 三个 token 列为 Int32（上限 2^31-1）：上游返回/恶意构造的
  // 超界值会让批量写入的 createMany 整批失败，同批合法日志一并丢失——统一钳制
  const INT32_MAX = 2_147_483_647;
  return {
    promptTokens: Math.min(promptTokens, INT32_MAX),
    completionTokens: Math.min(completionTokens, INT32_MAX),
    totalTokens: Math.min(totalTokens, INT32_MAX),
    upstreamCost,
  };
}

/**
 * 更新 API Key 的已用 token 数（批量缓冲，定期 flush）
 */
export async function updateKeyUsage(
  apiKeyId: string,
  tokenCount: number,
  db: D1Database,
  env?: WorkerEnv
): Promise<void> {
  if (tokenCount <= 0) return;
  initBatchedWriter(db, env);
  bufferKeyUsage(apiKeyId, tokenCount);
}

/** 节点名称最大显示宽度：中文等全角字符按 2 计、ASCII 按 1，上限 20（纯中文 10 字、纯英文 20 字） */
const MAX_NODE_NAME_WIDTH = 20;

/**
 * 解析并清洗节点/设备名称（请求日志 nodeName 列）
 *
 * 多实例部署（如 CDN 后多源站）时各实例设置 NODE_NAME 环境变量，用于在请求日志中
 * 区分请求来自哪个实例；未设置时回退部署平台名（edgeone/vercel/docker/cf 映射为
 * 友好名称，均未设置时写 local）。
 *
 * 清洗规则（防止名称破坏日志展示/导出结构）：
 * - 删除控制字符（换行/回车/Tab/空字符等）与逗号、单双引号
 * - 按显示宽度截断：中文等全角字符按 2 计算、ASCII 按 1，总宽度上限 20
 *   （即纯中文最多 10 字、纯英文最多 20 字），超出截断保留前缀
 * - 清洗后为空（NODE_NAME 全为非法字符）时回退部署平台名
 */
export function resolveNodeName(env?: WorkerEnv & { NODE_NAME?: string; DEPLOY_PLATFORM?: string }): string | null {
  const raw = (env?.NODE_NAME ?? process.env.NODE_NAME ?? "").trim();
  const cleaned = sanitizeNodeName(raw);
  if (cleaned) return cleaned;
  const platform = friendlyDeployPlatform(env?.DEPLOY_PLATFORM ?? process.env.DEPLOY_PLATFORM);
  return sanitizeNodeName(platform);
}

/** 部署平台名 → 友好名称映射（NODE_NAME 未设置时的回退值） */
function friendlyDeployPlatform(raw: string | undefined): string {
  const p = (raw ?? "").trim().toLowerCase();
  const map: Record<string, string> = {
    edgeone: "EdgeOne",
    vercel: "Vercel",
    docker: "Docker",
    cf: "Cloudflare",
  };
  return map[p] ?? (p || "local");
}

/** 清洗节点名称：删除控制字符与逗号引号，按显示宽度截断（中文 2/ASCII 1，上限 20） */
function sanitizeNodeName(value: string): string | null {
  // 宽度判定：CJK 统一表意文字、全角符号与代理对（emoji 等）按 2 列宽计，
  // 其余按 1（for...of 按码点迭代，代理对不拆半）
  const WIDE = /[\u3000-\u9fff\uff00-\uffef]/;
  // 删除会破坏日志展示/导出结构的字符：控制字符（换行/回车/Tab/空字符等，
  // 含 C1 控制字符 U+0080-U+009F）与逗号、单双引号（CSV/行式日志的分隔符
  // 与引用符）
  // 控制字符的匹配是刻意行为（正因会破坏日志结构才须删除），跳过 no-control-regex
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f,"']/g, "").trim();
  if (!cleaned) return null;
  // 码点宽度：全角/CJK 与代理对（length 2，如 emoji）按 2 计，其余按 1
  const widthOf = (ch: string) => (WIDE.test(ch) || ch.length === 2 ? 2 : 1);
  let width = 0;
  for (const ch of cleaned) width += widthOf(ch);
  if (width <= MAX_NODE_NAME_WIDTH) return cleaned;
  let out = "";
  width = 0;
  for (const ch of cleaned) {
    const w = widthOf(ch);
    if (width + w > MAX_NODE_NAME_WIDTH) break;
    width += w;
    out += ch;
  }
  return out || null;
}

/**
 * 记录请求日志
 */
export async function recordRequestLog(params: {
  keyId: string | null;
  keyName: string | null;
  platformId: string | null;
  model: string;
  endpoint: string;
  method: string;
  status: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  ttft: number;
  duration: number;
  isError: boolean;
  errorMessage?: string;
  /**
   * 上游自报的实时成本（美元）：usage 自带 cost 时由调用方传入并优先采信；
   * 缺省时回退价格表估算（无价格数据记 0）
   */
  upstreamCost?: number | null;
  /** 客户端真实 IP（从下游请求头提取，日志页展示用；不传写 null） */
  ipAddress?: string;
  /** 客户端 User-Agent（从下游请求头提取，日志页展示用；不传写 null） */
  userAgent?: string;
  /** 出站代理地址（仅 Docker 部署经代理的请求记录；直连/其他部署为空） */
  proxyUrl?: string;
  /** 是否检测到模型思考内容（reasoning/reasoning_content 等字段非空） */
  hasReasoning?: boolean;
  db: D1Database;
  env?: WorkerEnv;
}): Promise<void> {
  initBatchedWriter(params.db, params.env);
  // 成本核算：上游实时计价优先；缺省回退价格表估算（快照过期时懒加载刷新，
  // 失败沿用旧值计 0）。仅回退路径才需要加载价格快照，实时成本存在时零开销
  let cost = params.upstreamCost && params.upstreamCost > 0 && params.upstreamCost <= UPSTREAM_COST_MAX
    ? params.upstreamCost
    : null;
  if (cost === null) {
    try { await ensurePricingLoaded(params.db, params.env); } catch {}
    cost = computeCost(
      getPricingSnapshot(),
      params.model,
      params.promptTokens,
      params.completionTokens
    );
  }
  bufferRequestLog({
    keyId: params.keyId,
    keyName: params.keyName,
    platformId: params.platformId,
    model: params.model,
    endpoint: params.endpoint,
    method: params.method,
    status: params.status,
    latency: params.duration,
    tokens: params.tokens,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    cost,
    ttft: params.ttft,
    isError: params.isError,
    errorMessage: params.errorMessage ?? null,
    proxyUrl: params.proxyUrl ? proxyStatKey(params.proxyUrl) : null,
    nodeName: resolveNodeName(params.env),
    ipAddress: params.ipAddress ?? null,
    userAgent: params.userAgent ?? null,
    hasReasoning: params.hasReasoning ?? false,
  });
}

/**
 * 从下游请求提取客户端 IP/UA（请求日志展示用）
 *
 * Worker 部署由 Cloudflare 注入 cf-connecting-ip；其他部署回退
 * X-Forwarded-For 首项（取最左客户端项）。
 *
 * 同时兼容两类下游请求对象：
 * - Workers Request（headers 为 Headers 实例，Worker 全量版/lite 版入口使用）
 * - Pages NextApiRequest（headers 为 IncomingHttpHeaders 普通对象，键为小写、
 *   值可能为数组），Pages v1 入口据此接入日志的 ipAddress/userAgent 列
 */
export function extractClientInfo(
  request: Request | { headers: Record<string, string | string[] | undefined> }
): { ipAddress?: string; userAgent?: string } {
  const get = (name: string): string | undefined => {
    const headers = request.headers as unknown;
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const v = (request.headers as Record<string, string | string[] | undefined>)[name];
    return Array.isArray(v) ? v[0] : v || undefined;
  };
  const ipAddress =
    get("cf-connecting-ip") ||
    get("x-forwarded-for")?.split(",")[0]?.trim() ||
    undefined;
  return {
    ipAddress,
    userAgent: get("user-agent") || undefined,
  };
}

/**
 * 从流内 error 事件中解析 HTTP 状态码
 *
 * 上游网关对失败请求可能返回 200 + SSE 流内 `data: {"error": {"code": 503}}`，
 * 此时 HTTP 头无法反映失败。code 为 400-599 的整数时用原值；error 对象存在但
 * code 缺失或为非数字字符串枚举（如 Azure "content_filter"）时兜底 502——
 * error 事件本身即失败信号，不能回落 200 成功路径。仅 error 缺失返回 null。
 */
export function resolveStreamErrorStatus(error: Record<string, unknown> | undefined): number | null {
  if (!error || typeof error !== "object") return null;
  const raw = (error as Record<string, unknown>).code;
  const code =
    typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  // 必须是 400-599 的整数：浮点等病态 code 会触发 Prisma Int 列校验错误，
  // 导致整条失败日志丢失（外层 catch 吞掉）
  if (!Number.isNaN(code) && Number.isInteger(code) && code >= 400 && code <= 599) return code;
  // code 缺失或为非数字字符串枚举（如 Azure "content_filter"）：error 事件本身
  // 即失败信号，兜底 502 记账并触发熔断——否则流随后正常 [DONE] 收尾时会被记成
  // 200 成功，坏平台评分不降、日志误导排障
  return 502;
}

/**
 * Responses API 流事件检测
 *
 * 对 JSON.parse 后的单帧对象判断是否携带 Responses 协议的内容/完成信号。
 * sawContent 规则：delta / output_text / text+type 含 output_text /
 * output 数组 / response.output；sawDone 规则：response.completed /
 * response.done / response.status==="completed" / response.type==="response.completed"。
 * Worker 全量与 lite 共用此实现；Pages v1 的内联副本待接入本函数后消除漂移。
 */
export function detectResponsesStreamEvent(parsed: unknown): { sawContent: boolean; sawDone: boolean } {
  let sawContent = false;
  let sawDone = false;
  const pAny = parsed as any;
  if (typeof pAny.delta === "string" && pAny.delta.length > 0) sawContent = true;
  if (typeof pAny.output_text === "string" && pAny.output_text.length > 0) sawContent = true;
  if (typeof pAny.text === "string" && pAny.text.length > 0 && pAny.type && String(pAny.type).includes("output_text")) sawContent = true;
  if (Array.isArray(pAny.output) && pAny.output.length > 0) sawContent = true;
  if (pAny.response?.output) sawContent = true;
  if (pAny.type === "response.completed" || pAny.type === "response.done" || pAny.response?.status === "completed" || pAny.response?.type === "response.completed") {
    sawDone = true;
  }
  return { sawContent, sawDone };
}

/**
 * 创建 Usage 提取 TransformStream
 *
 * 在流式响应中逐块解析 SSE 数据，提取最后一个 usage 对象，
 * 请求完成后异步更新 API Key 用量和日志。
 *
 * 关键设计：
 * - 记录 TTFT（首字延迟）：第一个非空 chunk 到达时的时间差
 * - SSE buffer 拼接：处理 chunk 在 JSON 中间截断的情况
 */
export function createUsageTransformer(params: {
  keyId: string;
  keyName: string | null;
  platformId: string;
  model: string;
  startTime: number;
  /** 上游平台 Key 明文：流内密钥类错误（429/401/402/403）时封禁+计数；不传则跳过密钥级处理 */
  key?: string;
  /** 上游真实端点路径（如 /chat/completions）：请求日志 endpoint 字段落库值 */
  endpoint: string;
  /** max_tokens 预估值：上游未返回 usage 时兜底记账，防 tokenLimit 绕过 */
  maxTokensEstimate?: number;
  /**
   * CF 部署的 KV binding：流内密钥类错误封禁时同时写 KV 持久化
   * （管理后台 keyStatuses CF 模式读 KV 展示、Worker 冷启动 loadKeyStatusFromKV
   * 恢复封禁），与 proxy.ts HTTP 429 路径 banKey(..., kv) 的 KV 键结构一致；
   * 非 Cloudflare 部署（无 KV）可不传，封禁只写内存 + DB 错误计数。
   */
  kv?: KVNamespace;
  /** 客户端真实 IP（从下游请求头提取，随流式日志落库；不传写 null） */
  ipAddress?: string;
  /** 客户端 User-Agent（从下游请求头提取，随流式日志落库；不传写 null） */
  userAgent?: string;
  db: D1Database;
  env?: WorkerEnv;
}): TransformStream<Uint8Array, Uint8Array> {
  let sseBuffer = "";
  let lastUsage: Record<string, unknown> | undefined;
  // 最后一次 usage 事件自报的实时成本（美元）；未上报为 null，flush 时回退价格表估算
  let lastUpstreamCost: number | null = null;
  let streamError: { code: number; message: string } | undefined;
  // 上游正常结束的标志：SSE 流必须以 data: [DONE] 收尾。上游在思考中途截断
  // （EOF 但无 [DONE]）时若按成功记录，坏平台永远不会被熔断，负载均衡会反复撞上它
  let sawDone = false;
  // 空完成检测：是否收到过有效输出内容（content/reasoning_content 非空）。
  // 上游 200 + 只有 [DONE]/空 data 的伪成功流不触发空流哨兵/流内 error/截断/
  // 空闲超时任何检测，此前被记成 200 成功（管理后台常见"200 + 0 tokens +
  // 数十秒首字延迟"即此场景），坏平台评分不降、负载均衡反复撞上它
  let sawContent = false;
  // 开发模式下记录是否检测到模型思考内容（reasoning / reasoning_content /
  // reasoning_summary / reasoning.text 等字段非空即算思考）。
  // 仅在开发模式开启时写入 requestLogs.hasReasoning；关闭时恒 false。
  let sawReasoning = false;
  let ttft = 0;
  let isFirstChunk = true;
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      if (isFirstChunk) {
        ttft = Date.now() - params.startTime;
        isFirstChunk = false;
      }

      controller.enqueue(chunk);

      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") { sawDone = true; continue; }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          // 空完成检测：记录是否收到过有效输出内容（content/reasoning_content
          // 非空字符串；初始 role 占位 chunk 的 content 为空字符串不计）。
          // tool_calls 增量同样计入：纯工具调用流（无文本）不得误判空完成
          if (Array.isArray(parsed.choices)) {
            for (const c of parsed.choices) {
              const delta = c?.delta;
              if (delta && ((typeof delta.content === "string" && delta.content.length > 0) || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0))) {
                sawContent = true;
              }
              // 思考检测：delta.reasoning_content（DeepSeek/Qwen）、
              // delta.reasoning（OpenAI o1）任一非空即算
              if (delta && typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
                sawReasoning = true;
              }
              if (delta && typeof (delta as any).reasoning === "string" && (delta as any).reasoning.length > 0) {
                sawReasoning = true;
              }
            }
          }
          // 顶层字段检测：reasoning / reasoning_summary（OpenAI o3/o4 等非流式增量格式）
          if (typeof (parsed as any).reasoning === "string" && (parsed as any).reasoning.length > 0) {
            sawReasoning = true;
          }
          if (typeof (parsed as any).reasoning_summary === "string" && (parsed as any).reasoning_summary.length > 0) {
            sawReasoning = true;
          }
          // Responses API 推理检测：output 数组中 type:"reasoning" 项表示推理内容
          if (Array.isArray((parsed as any).output)) {
            for (const item of (parsed as any).output) {
              if (item && typeof item.type === "string" && item.type === "reasoning") {
                sawReasoning = true;
              }
            }
          }
          // Responses API 流式检测：适配 Responses 协议的 delta/output 等字段
          // Responses 的增量事件如 response.output_text.delta {delta:"..."} 或 output 数组
          const responsesEvent = detectResponsesStreamEvent(parsed);
          if (responsesEvent.sawContent) sawContent = true;
          if (responsesEvent.sawDone) sawDone = true;
          const pAny = parsed as any;
          // 兼容 Chat 与 Responses 两种 usage 形态：顶层 usage / response.usage
          const candidate = (pAny.usage ?? pAny.response?.usage ?? pAny.response?.response?.usage) as Record<string, unknown> | undefined;
          if (candidate) {
            lastUsage = candidate;
            lastUpstreamCost = extractUpstreamCost(candidate);
          }
          // 上游 200 + 流内 error 事件：失败语义由日志记录（status=error.code，isError=true）
          if (parsed.error) {
            const status = resolveStreamErrorStatus(parsed.error);
            if (status !== null) {
              streamError = {
                code: status,
                message: String(parsed.error.message || "").substring(0, 1000),
              };
            }
          }
        } catch {
          // 忽略不完整的 JSON 片段
        }
      }
    },

    async flush() {
      const { promptTokens, completionTokens, totalTokens } =
        extractUsage(lastUsage, params.maxTokensEstimate);
      const duration = Date.now() - params.startTime;

      // 上游流被截断：EOF 但未收到 [DONE]（如部分 zen-proxy 入口对长思考流 ~10s 截断）。
      // 客户端已收到 200 + 部分流无法改写状态码，但必须记失败并触发熔断，
      // 否则坏平台永远不会被降级，负载均衡会反复撞上它（此前一直记 200 成功）。
      // 含完全空输入（无任何 chunk）：真实链路（proxy.ts 首块 read 即 done）已
      // 拦截为空响应，此处防御直接调用 transformer 的场景，同样按截断记失败
      const truncated = !sawDone && !streamError;
      // 空完成：上游 200 + 流正常 [DONE] 收尾，但全程无有效内容（无 content/
      // reasoning_content）。免费模型排队超时或上游对代理 IP 降级时常返回这种
      // "伪成功"流，客户端收到 200 + 空完成（"empty completion"）；此前记 200
      // 成功且不触发熔断，坏平台评分不降。与截断同属失败（sawDone 使二者互斥）
      const emptyCompletion = sawDone && !streamError && !sawContent;
      // 流内 error / 截断 / 空完成同属失败：触发熔断（此前流内 error 和空完成
      // 只记日志不打分，坏平台永远不被降级，负载均衡反复撞上它）。
      // 软失败豁免：空完成对白名单平台不触发熔断（白名单=永不封禁语义），
      // 硬失败（流内 error/截断）照常熔断；白名单未加载时按非白名单处理
      if (streamError || truncated || (emptyCompletion && !isPlatformWhitelisted(params.platformId))) {
        try { await recordFailure(params.platformId, params.db, params.env); } catch {}
      }

      // 流内 error 为密钥类状态码（429/401/402/403）时与 HTTP 重试路径对齐：
      // 封禁 Key + 累加错误计数（DB errorCount 达阈值自动禁用）。仅当调用方
      // 传入 key 明文时执行；kv 由调用方在 CF 部署下传入（env.KV），封禁同时
      // 写 KV 持久化（与 proxy.ts HTTP 429 路径 banKey(..., kv) 一致，管理后台
      // 可见、冷启动可恢复），无 KV 时只写内存；404/503 等非密钥错误不打 Key 分
      if (streamError && params.key &&
          (streamError.code === 429 || streamError.code === 401 ||
           streamError.code === 402 || streamError.code === 403)) {
        const keyErrorCode = streamError.code;
        try { await banKey(params.key, undefined, params.platformId, params.kv); } catch {}
        try { await recordKeyError(params.key, keyErrorCode, params.platformId, params.db, params.env); } catch {}
        // 平台级 429 冷却：429 是平台过载信号（区别于 Key 失效/越权），
        // 与 HTTP 429 路径 recordPlatform429 对齐——流内 429 同样计入平台冷却。
        // 白名单平台跳过：selectPlatform 已豁免，429 冷却记录无意义
        if (keyErrorCode === 429 && !isPlatformWhitelisted(params.platformId)) recordPlatform429(params.platformId);
      }

      // 复用同一个 PrismaClient 完成所有 DB 操作
      initBatchedWriter(params.db, params.env);
      const failed = !!streamError || truncated || emptyCompletion;
      // 成本核算：失败请求计 0；成功请求上游实时计价优先，缺省回退价格表估算
      // （与 recordRequestLog 同口径）。仅回退路径才加载价格快照
      let cost = 0;
      if (!failed) {
        if (lastUpstreamCost != null) {
          cost = lastUpstreamCost;
        } else {
          try { await ensurePricingLoaded(params.db, params.env); } catch {}
          cost = computeCost(getPricingSnapshot(), params.model, promptTokens, completionTokens);
        }
      }
      // 流内 error / 截断 / 空完成均视为失败请求：不计入 Key 用量/次数
      if (!streamError && !truncated && !emptyCompletion && totalTokens > 0) {
        bufferKeyUsage(params.keyId, totalTokens);
      }

      bufferRequestLog({
        keyId: params.keyId,
        keyName: params.keyName,
        platformId: params.platformId,
        model: params.model,
        endpoint: params.endpoint,
        method: "POST",
        status: streamError ? streamError.code : truncated || emptyCompletion ? 502 : 200,
        latency: duration,
        tokens: streamError || truncated || emptyCompletion ? 0 : totalTokens,
        promptTokens: streamError || truncated || emptyCompletion ? 0 : promptTokens,
        completionTokens: streamError || truncated || emptyCompletion ? 0 : completionTokens,
        cost,
        ttft,
        isError: !!streamError || truncated || emptyCompletion,
        errorMessage: streamError?.message ?? (emptyCompletion ? "上游返回空完成（200 + 流内无有效内容）" : truncated ? "上游流未正常结束（EOF 但未收到 [DONE]），疑似上游截断" : null),
        nodeName: resolveNodeName(params.env),
        proxyUrl: null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        hasReasoning: sawReasoning,
      });
    },
  });
}
