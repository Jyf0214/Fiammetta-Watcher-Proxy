/**
 * 请求模板 mergeBody 字段白名单（单一来源）
 *
 * 由服务端清洗（pages/api/admin/request-templates.ts 的 sanitizeMergeBody）
 * 与运行时代理清洗（worker/src/request-templates.ts，Worker 全量/lite 与
 * Pages v1 共用）共同引用；前端提示消费的是保存接口返回的 droppedKeys，
 * 不直接引用本文件。
 */

/** chat 模板白名单 */
export const CHAT_MERGEBODY_ALLOWED_KEYS = new Set([
  "system", "temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens",
  "frequency_penalty", "presence_penalty", "stop", "stream", "stream_options",
  "n", "logprobs", "top_logprobs", "response_format", "seed",
  // 思考控制类参数（deepseek/qwen 等厂商透传）
  "reasoning_effort", "chat_template_kwargs", "extra_body",
  // 厂商私有顶层字段：用于特定上游的思考控制开关，具体取值/语义以厂商 API 文档为准
  "thinking", "reasoning_split",
]);

/** responses 模板白名单：基于 OpenAI Responses API 规范，解锁高阶思维链 reasoning */
export const RESPONSES_MERGEBODY_ALLOWED_KEYS = new Set([
  "instructions", "reasoning", "max_output_tokens", "truncation", "text", "tools", "tool_choice",
  "parallel_tool_calls", "store", "include", "metadata", "service_tier", "prompt_cache_key",
  "safety_identifier", "background", "previous_response_id",
  "temperature", "top_p", "top_logprobs", "stream", "seed",
  "frequency_penalty", "presence_penalty", "stop", "n", "logprobs", "response_format",
  "reasoning_effort", "chat_template_kwargs", "extra_body",
]);
