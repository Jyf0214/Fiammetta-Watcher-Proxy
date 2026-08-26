/**
 * error-response.ts 代理错误响应构造核心测试
 *
 * 覆盖（对齐模块语义契约）：
 * - openai 基础体：{ error: { message, type } }，键序与三端现有输出一致
 * - retry_after 字段形态：扁平键位于 error 内、值原样透出不二次取整、
 *   未提供时不出现该键
 * - anthropic 分叉：与 formatAnthropicError 输出逐字节一致；retryAfterSeconds
 *   被忽略（三端现状即丢弃 extra）
 * - 默认 type 映射：type 缺省/空串时按 status 经 toAnthropicErrorType 映射，
 *   显式 type 覆盖默认
 * - 文案零归一化：message 原样进入响应体
 * - 参数非法显式抛错
 */

import { describe, it, expect } from "vitest";
import { buildProxyError } from "../proxy-core/error-response";
import { formatAnthropicError, toAnthropicErrorType } from "@/lib/anthropic";

describe("buildProxyError — openai 基础体", () => {
  it("输出 status/body/contentType，body 为 {error:{message,type}}", () => {
    const payload = buildProxyError({
      protocol: "openai",
      status: 400,
      message: "缺少 model 参数",
      type: "invalid_request_error",
    });
    expect(payload.status).toBe(400);
    expect(payload.contentType).toBe("application/json");
    // 与三端现状 { error: { message, type, ...extra } } 的序列化逐字节一致
    expect(payload.body).toBe('{"error":{"message":"缺少 model 参数","type":"invalid_request_error"}}');
  });

  it("error 对象键序固定为 message → type（无附加字段时）", () => {
    const parsed = JSON.parse(
      buildProxyError({ protocol: "openai", status: 500, message: "此模型不存在", type: "server_error" }).body
    );
    expect(Object.keys(parsed.error)).toEqual(["message", "type"]);
    expect(parsed.error.message).toBe("此模型不存在");
    expect(parsed.error.type).toBe("server_error");
  });

  it("文案零归一化：空格/标点/换行原样保留", () => {
    const raw = "  平台 \"X\" 无可用 API Key！\n第二行  ";
    const parsed = JSON.parse(
      buildProxyError({ protocol: "openai", status: 500, message: raw, type: "server_error" }).body
    );
    expect(parsed.error.message).toBe(raw);
  });
});

describe("buildProxyError — retry_after 字段形态", () => {
  it("提供 retryAfterSeconds 时附加扁平键 retry_after，值原样透出", () => {
    const payload = buildProxyError({
      protocol: "openai",
      status: 429,
      message: "上游平台请求频率超限",
      type: "rate_limit_error",
      retryAfterSeconds: 30,
    });
    // 键序 message → type → retry_after（与 ...extra 展开序一致）
    expect(payload.body).toBe(
      '{"error":{"message":"上游平台请求频率超限","type":"rate_limit_error","retry_after":30}}'
    );
    const parsed = JSON.parse(payload.body);
    expect(parsed.error.retry_after).toBe(30);
    expect(Object.keys(parsed.error)).toEqual(["message", "type", "retry_after"]);
  });

  it("小数秒数不做二次取整（取整由调用方 Math.ceil 负责）", () => {
    const payload = buildProxyError({
      protocol: "openai",
      status: 429,
      message: "API Key 请求频率超限",
      type: "rate_limit_error",
      retryAfterSeconds: 12.5,
    });
    expect(JSON.parse(payload.body).error.retry_after).toBe(12.5);
  });

  it("未提供时 body 中不出现 retry_after 键", () => {
    const payload = buildProxyError({
      protocol: "openai",
      status: 504,
      message: "上游请求超时（2 分钟），请稍后重试",
      type: "timeout_error",
    });
    const parsed = JSON.parse(payload.body);
    expect("retry_after" in parsed.error).toBe(false);
  });

  it("retryAfterSeconds 为 undefined 视为未提供，为 NaN/Infinity 时抛错", () => {
    expect(() =>
      buildProxyError({ protocol: "openai", status: 429, message: "m", type: "t", retryAfterSeconds: undefined })
    ).not.toThrow();
    expect(() =>
      buildProxyError({ protocol: "openai", status: 429, message: "m", type: "t", retryAfterSeconds: NaN })
    ).toThrow(TypeError);
    expect(() =>
      buildProxyError({ protocol: "openai", status: 429, message: "m", type: "t", retryAfterSeconds: Infinity })
    ).toThrow(TypeError);
  });
});

describe("buildProxyError — anthropic 分叉", () => {
  it("与 formatAnthropicError(status, message, type) 的序列化逐字节一致", () => {
    const payload = buildProxyError({
      protocol: "anthropic",
      status: 400,
      message: "请求体格式错误",
      type: "invalid_request_error",
    });
    expect(payload.status).toBe(400);
    expect(payload.contentType).toBe("application/json");
    expect(payload.body).toBe(JSON.stringify(formatAnthropicError(400, "请求体格式错误", "invalid_request_error")));
    const parsed = JSON.parse(payload.body);
    expect(parsed).toEqual({ type: "error", error: { type: "invalid_request_error", message: "请求体格式错误" } });
  });

  it("status 决定最终 error.type（toAnthropicErrorType 语义，openaiType 仅兜底提示）", () => {
    // 与三端现状一致：400 恒映射 invalid_request_error，即使传入其他 openaiType
    const payload = buildProxyError({
      protocol: "anthropic",
      status: 400,
      message: "上游 URL 不安全: http://127.0.0.1",
      type: "timeout_error",
    });
    expect(JSON.parse(payload.body).error.type).toBe(formatAnthropicError(400, "x", "timeout_error").error.type);
    expect(JSON.parse(payload.body).error.type).toBe("invalid_request_error");
  });

  it("retryAfterSeconds 在 anthropic 分支被忽略（三端现状即丢弃 extra）", () => {
    const withRetry = buildProxyError({
      protocol: "anthropic",
      status: 429,
      message: "上游平台请求频率超限",
      type: "rate_limit_error",
      retryAfterSeconds: 30,
    });
    const withoutRetry = buildProxyError({
      protocol: "anthropic",
      status: 429,
      message: "上游平台请求频率超限",
      type: "rate_limit_error",
    });
    expect(withRetry.body).toBe(withoutRetry.body);
    expect("retry_after" in JSON.parse(withRetry.body).error).toBe(false);
  });
});

describe("buildProxyError — 默认 type 映射", () => {
  it("openai 协议缺省 type 时按 status 经 toAnthropicErrorType 映射", () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_request_error"],
      [401, "authentication_error"],
      [403, "permission_error"],
      [404, "not_found_error"],
      [429, "rate_limit_error"],
      [500, "api_error"],
      [502, "api_error"],
      [503, "api_error"],
      [504, "timeout_error"],
      [529, "overloaded_error"],
    ];
    for (const [status, expected] of cases) {
      const parsed = JSON.parse(buildProxyError({ protocol: "openai", status, message: "m" }).body);
      expect(parsed.error.type).toBe(expected);
      expect(expected).toBe(toAnthropicErrorType(status));
    }
  });

  it("未知状态码缺省 type 时回退 api_error", () => {
    const parsed = JSON.parse(buildProxyError({ protocol: "openai", status: 418, message: "m" }).body);
    expect(parsed.error.type).toBe("api_error");
  });

  it("空字符串 type 与缺省同义（两协议一致，对齐 toAnthropicErrorType 对空 openaiType 的处理）", () => {
    const openaiParsed = JSON.parse(buildProxyError({ protocol: "openai", status: 404, message: "m", type: "" }).body);
    expect(openaiParsed.error.type).toBe("not_found_error");
    const anthropicParsed = JSON.parse(
      buildProxyError({ protocol: "anthropic", status: 404, message: "m", type: "" }).body
    );
    expect(anthropicParsed.error.type).toBe("not_found_error");
  });

  it("显式 type 覆盖默认映射（三端现有调用点全部走此路径）", () => {
    // 三端现状：5xx 显式传 server_error / upstream_error / timeout_error
    const serverError = JSON.parse(buildProxyError({ protocol: "openai", status: 500, message: "重试耗尽", type: "server_error" }).body);
    expect(serverError.error.type).toBe("server_error");
    const upstreamError = JSON.parse(
      buildProxyError({ protocol: "openai", status: 502, message: "上游请求失败（网络错误），请稍后重试", type: "upstream_error" }).body
    );
    expect(upstreamError.error.type).toBe("upstream_error");
  });
});

describe("buildProxyError — 参数非法显式抛错", () => {
  it("protocol 非 openai/anthropic 抛 TypeError", () => {
    expect(() =>
      buildProxyError({ protocol: "graphql" as unknown as "openai", status: 400, message: "m" })
    ).toThrow(TypeError);
  });

  it("status 非整数或越界抛 RangeError", () => {
    expect(() => buildProxyError({ protocol: "openai", status: 99.5, message: "m" })).toThrow(RangeError);
    expect(() => buildProxyError({ protocol: "openai", status: NaN, message: "m" })).toThrow(RangeError);
    expect(() => buildProxyError({ protocol: "openai", status: Infinity, message: "m" })).toThrow(RangeError);
  });

  it("message 非字符串抛 TypeError", () => {
    expect(() =>
      buildProxyError({ protocol: "openai", status: 500, message: 123 as unknown as string })
    ).toThrow(TypeError);
  });
});
