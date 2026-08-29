/**
 * Worker 端共享：peek 客户端请求体中的 model 字段（不消费流）
 *
 * 用于 /v1/* 入口在 API Key 鉴权阶段拿到 requestedModel，以便走 per-key
 * 模型白名单（allowedModels 字段）。仅 Worker 端使用：
 * - Web Request.body.getReader() 读字节后 cancel，原 stream 未消费
 * - Pages 端 NextApiRequest body 是 for-await 一次性消费流，peek 二次消费
 *   会破坏现有单测与 mock；Pages 端 IP 白名单已生效，model 白名单仅在
 *   Worker 部署生效（部署权衡，非缺失）
 *
 * 失败语义：返回 null（白名单校验跳过）
 * - JSON 解析失败（含非 JSON / 大 body）→ null
 * - Content-Length 缺失或非法 → 尝试 peek，超大 body 直接 null
 * - multipart 形态 → null（模型 ID 不可在 multipart 顶层获取）
 */

const PEEK_MAX_BYTES = 256 * 1024; // 256KB 上限：超过则放弃 peek（防御异常 body 阻塞鉴权）

/**
 * Worker 端：从 Request clone 后 peek model 字段
 * 返回 { model } 或 null（解析失败）
 *
 * 实现：clone() 后读取字节（不消费原 stream），正则匹配 "model"\s*:\s*"..." 顶层字段。
 * 严格 JSON.parse 会消费整个 body，对 100MB body 不友好；正则只读 256KB 即停。
 */
export async function peekModelFromRequest(
  request: Request
): Promise<string | null> {
  try {
    const cloned = request.clone();
    const reader = cloned.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let totalRead = 0;
    while (totalRead < PEEK_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      totalRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      // 找到 "model":"..." 即停：避免读完大 body
      if (/"model"\s*:\s*"/.test(buf)) break;
    }
    try {
      reader.cancel();
    } catch {
      // 忽略 cancel 错误
    }
    // 顶层 "model":"..." 匹配（不跨字段、不跨嵌套对象层）
    const match = buf.match(/"model"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!match) return null;
    return match[1].replace(/\\(.)/g, "$1");
  } catch {
    return null;
  }
}

/**
 * Pages 端：从 NextApiRequest peek model 字段
 * Pages 端没有 clone()，用 buffer.concat 累积再 setBody 还原。
 */
