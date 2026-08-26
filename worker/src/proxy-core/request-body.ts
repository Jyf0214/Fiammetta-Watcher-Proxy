/**
 * 请求体解析核心（proxy-core 第六块）
 *
 * worker/src/proxy.ts 全量版与 worker/src/proxy-lite.ts lite 版此前各自内联
 * 实现了同一段 parseRequestBody（Content-Length 预检 → multipart 原始字节读取 +
 * model 字段提取 → JSON 解析），两份实现语义一致；Pages 版因传输层不同
 * （NextApiRequest 流式读取）保留自己的适配，但 multipart 的 model 字段提取
 * 三端统一走本模块的 extractMultipartModelField（latin1 保字节序实现）。
 *
 * multipart 提取统一说明：Worker 版此前用标准 formData() API、Pages 版用
 * latin1 手写切分。两者对「提取 model 文本字段」结果一致（model 为 ASCII
 * 文本字段；文件二进制不受 latin1 切分影响），统一为无平台依赖的 latin1
 * 实现——畸形表单（boundary 缺失/字段名不匹配）一律返回 null，由调用方按
 * 缺 model 400 处理。
 */

import { MAX_BODY_BYTES } from "./proxy-constants";

/** multipart/form-data 请求体解析结果：仅提取 model 字段用于路由，原始字节转发时透传 */
export interface MultipartBody {
  model: string | null;
  raw: Uint8Array;
  contentType: string;
}

/**
 * latin1（保字节序）解码：仅头部与文本字段为 ASCII，文件二进制不受影响。
 * 手动逐块 String.fromCharCode 而非 Buffer.toString("latin1")——本模块须在
 * Workers 运行时零 Node 依赖可用（与 proxy-core 其余模块一致）
 */
function decodeLatin1(raw: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < raw.length; i += CHUNK) {
    parts.push(String.fromCharCode(...raw.subarray(i, i + CHUNK)));
  }
  return parts.join("");
}

/**
 * 从 multipart body 中提取指定文本字段（latin1 保字节序：仅头部与文本字段为
 * ASCII，文件二进制不受影响；按 boundary 切分逐 part 查 Content-Disposition）
 */
export function extractMultipartField(
  raw: Uint8Array,
  contentType: string,
  field: string
): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = (m[1] ?? m[2]).trim();
  const text = decodeLatin1(raw);
  for (const part of text.split(`--${boundary}`)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd);
    const dm = /name="([^"]*)"/.exec(header);
    if (!dm || dm[1] !== field) continue;
    return part.slice(headerEnd + 4).replace(/\r\n$/, "").trim();
  }
  return null;
}

/** 从 multipart body 中提取 model 字段（三端统一的便捷封装） */
export function extractMultipartModel(
  raw: Uint8Array,
  contentType: string
): string | null {
  return extractMultipartField(raw, contentType, "model");
}

/** Worker Request 版请求体解析结果：error 分支携带已构造的错误 Response（调用方直接返回） */
export type WorkerParseBodyResult<T> =
  | { body: T }
  | { multipart: MultipartBody }
  | { error: Response };

/** 构造请求体解析错误响应（413 过大 / 400 读取失败或格式错误） */
function bodyError(status: number, message: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error" } },
    { status }
  );
}

/**
 * 解析 Worker Request 请求体（全量版与 lite 版共用）
 *
 * - Content-Length 预检快速拒绝超大请求，避免读取整个 body；
 * - multipart 读取原始字节（重试循环需可重放 body），仅提取 model 用于路由；
 * - JSON 文本体按字符串长度兜底限制（中文等多字节略偏小但足够做限制），
 *   空 body 不特判放行（JSON.parse("") 抛错走 400「请求体格式错误」）。
 */
export async function parseWorkerRequestBody<T>(
  request: Request
): Promise<WorkerParseBodyResult<T>> {
  // 优先用 Content-Length 头快速拒绝超大请求，避免读取整个 body
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return { error: bodyError(413, "请求体过大") };
  }

  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await request.arrayBuffer());
    } catch {
      return { error: bodyError(400, "读取请求体失败") };
    }

    // Content-Length 不存在或不准时，用实际字节数兜底
    if (raw.length > MAX_BODY_BYTES) {
      return { error: bodyError(413, "请求体过大") };
    }

    // 非标准 multipart（boundary 畸形等）：model 留 null，调用方按缺 model 400
    const model = extractMultipartModel(raw, contentType);
    return { multipart: { model, raw, contentType } };
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return { error: bodyError(400, "读取请求体失败") };
  }

  // Content-Length 不存在或不准时，用字符串长度兜底（chunked 编码时任意大的
  // 请求体会被整体读入内存，无上限保护）
  if (bodyText.length > MAX_BODY_BYTES) {
    return { error: bodyError(413, "请求体过大") };
  }

  try {
    return { body: JSON.parse(bodyText) as T };
  } catch {
    return { error: bodyError(400, "请求体格式错误") };
  }
}
