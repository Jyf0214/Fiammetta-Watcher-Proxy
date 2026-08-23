/**
 * UI Utility Library
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names with Tailwind CSS
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 复制文本到剪贴板，成功返回 true，失败返回 false
 *
 * navigator.clipboard 仅在安全上下文（HTTPS / localhost）可用：HTTP 局域网
 * 部署下该对象为 undefined，直接调用会同步抛 TypeError。因此优先尝试
 * Clipboard API，异常或不可用时降级为临时 textarea + execCommand("copy")；
 * 两条路径均失败时返回 false，由调用方提示用户手动复制。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒/文档非焦点等，继续走降级路径
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // 固定定位移出视口，避免插入时页面滚动跳动；不可见但仍可选中复制
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
