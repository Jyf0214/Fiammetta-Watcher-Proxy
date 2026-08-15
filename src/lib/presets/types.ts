/**
 * 预设平台数据格式 — 平台模板 + 模型 ID 清单
 *
 * 预设平台仅作为"一键创建模板"使用：选定后按模板创建 platform 记录，
 * 模型 ID 批量写入 platform_models，其他字段（密钥/限额等）由用户后续配置。
 */

/** 平台类型（与 platforms 表一致）：anthropic = 上游 Anthropic 协议（/v1/messages） */
export type PresetPlatformType = "openai" | "azure" | "custom" | "anthropic";

/** 预设平台模板 */
export interface PlatformPreset {
  /** 平台标识（如 openai） */
  id: string;
  /** 平台显示名 */
  name: string;
  /** 平台一句话描述 */
  description?: string;
  /** 平台官网 */
  url?: string;
  /** 默认 API 地址；为空时创建流程要求用户填写 */
  baseUrl?: string;
  /** 平台类型 */
  type: PresetPlatformType;
  /** 预设模型 ID 列表 */
  models: string[];
}
