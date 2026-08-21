/**
 * @deprecated
 *
 * Chat Completions ↔ Responses API 双向转换已被移除（2026-08-21）。
 *
 * 原因：行业共识认为两种 API 的语义差异无法通过字段映射正确转换，
 * 强行转换会导致工具调用数据丢失、多模态输入损坏、finish_reason 误报等结构性问题。
 *
 * 当前行为：
 * - 下游 /v1/chat/completions → 上游 /v1/chat/completions：原样透传
 * - 下游 /v1/responses → 上游 /v1/responses：原样透传
 * - 下游 /v1/chat/completions → 上游 /v1/responses：不转换，直接透传（上游按 Responses 格式解析）
 * - 下游 /v1/responses → 上游 /v1/chat/completions：不转换，直接透传（上游按 Chat 格式解析）
 *
 * 如需 chat ↔ responses 互转，请在客户端或网关层实现。
 */
