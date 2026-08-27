/**
 * 请求模板 mergeBody 字段黑名单（单一来源）
 *
 * 默认放行所有字段，仅拦截可能被滥用的危险键。
 * 由服务端清洗（pages/api/admin/request-templates.ts 的 sanitizeMergeBody）
 * 与运行时代理清洗（worker/src/request-templates.ts，Worker 全量/lite 与
 * Pages v1 共用）共同引用；前端提示消费的是保存接口返回的 droppedKeys，
 * 不直接引用本文件。
 */

/** chat 与 responses 共用黑名单：阻止模板覆盖路由/认证/流式控制等代理核心字段 */
export const MERGEBODY_BLOCKED_KEYS = new Set([
  "model",       // 模型路由由代理引擎决定，模板覆盖可绕过路由策略
  "api_key",     // 防止模板注入上游认证凭据
  "apikey",      // 同上（变体拼写）
  "stream",      // 流式/非流式由代理层根据客户端请求与上游能力决定
]);
