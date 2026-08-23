/**
 * 请求模板 mergeBody 字段白名单（单一来源）
 *
 * 由服务端清洗（pages/api/admin/request-templates.ts 的 sanitizeMergeBody）
 * 与前端提示（pages/admin/request-templates.tsx）共同引用，
 * 避免两处各维护一份导致漂移。
 */

/** chat 模板白名单 */
export const CHAT_MERGEBODY_ALLOWED_KEYS = new Set([
  "system", "temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens",
  "frequency_penalty", "presence_penalty", "stop", "stream", "stream_options",
  "n", "logprobs", "top_logprobs", "response_format", "seed",
  // 思考控制类参数（deepseek/qwen 等厂商透传）
  "reasoning_effort", "chat_template_kwargs", "extra_body",
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
