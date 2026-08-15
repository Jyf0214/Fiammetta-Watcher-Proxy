import type { PlatformPreset } from "./types";
import { part1 } from "./data/part1";
import { part2 } from "./data/part2";
import { part3 } from "./data/part3";

/** 全部预设平台（按 id 排序） */
export const PRESET_PLATFORMS: PlatformPreset[] = [...part1, ...part2, ...part3];

/** 按 id 查找预设平台 */
export function getPresetPlatform(id: string): PlatformPreset | undefined {
  return PRESET_PLATFORMS.find((p) => p.id === id);
}

export type { PlatformPreset } from "./types";
