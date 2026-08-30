// ================================================================
// 节点 / 设备名称解析（共享）
//
// 原本内联在 worker/src/token.ts 的 resolveNodeName / sanitizeNodeName /
// friendlyDeployPlatform 抽到此处，供设备注册（src/lib/device-registration）
// 与请求日志（worker/src/token.ts）共用同一清洗语义——设备注册按 deviceName
// 唯一索引查重，复用请求日志的清洗规则保证 nodeName 列与 deviceName 一致。
//
// 部署矩阵：
//   - Docker / EdgeOne / Vercel / Cloudflare：NODE_NAME 未设置时按
//     DEPLOY_PLATFORM 回退友好名（EdgeOne / Vercel / Docker / Cloudflare）；
//     均未设置时写 "local"
//   - Cloudflare 部署：CF stub alias 让 device-registration 不被调用，本模块
//     仍可被 worker 侧 token.ts 使用
// ================================================================

/** 节点名称最大显示宽度：中文等全角字符按 2 计、ASCII 按 1，上限 20（纯中文 10 字、纯英文 20 字） */
export const MAX_NODE_NAME_WIDTH = 20;

/** 部署平台名 → 友好名称映射（NODE_NAME 未设置时的回退值） */
const PLATFORM_NAME_MAP: Record<string, string> = {
  edgeone: "EdgeOne",
  vercel: "Vercel",
  docker: "Docker",
  cf: "Cloudflare",
};

/**
 * 部署平台名 → 友好名称映射（NODE_NAME 未设置时的回退值）。
 * 输入大小写不敏感；未知值原样返回小写；空值兜底 "local"。
 */
export function friendlyDeployPlatform(raw: string | undefined): string {
  const p = (raw ?? "").trim().toLowerCase();
  return PLATFORM_NAME_MAP[p] ?? (p || "local");
}

/**
 * 清洗节点名称：删除控制字符与逗号引号，按显示宽度截断（中文 2/ASCII 1，上限 20）。
 * 返回 null 表示清洗后为空字符串。
 */
export function sanitizeNodeName(value: string): string | null {
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
 * 解析并清洗节点/设备名称。
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
 *
 * env 参数接受任意结构（WorkerEnv、Pages env 等），仅按 NODE_NAME/DEPLOY_PLATFORM
 * 字段取值；保留向后兼容，调用方不必剥离无关字段。
 */
export function resolveNodeName(env?: unknown): string | null {
  const record = (env && typeof env === "object" ? env : null) as
    | { NODE_NAME?: unknown; DEPLOY_PLATFORM?: unknown }
    | null;
  const raw = (typeof record?.NODE_NAME === "string" ? record.NODE_NAME : process.env.NODE_NAME ?? "").trim();
  const cleaned = sanitizeNodeName(raw);
  if (cleaned) return cleaned;
  const platform = friendlyDeployPlatform(
    typeof record?.DEPLOY_PLATFORM === "string" ? record.DEPLOY_PLATFORM : process.env.DEPLOY_PLATFORM
  );
  return sanitizeNodeName(platform);
}