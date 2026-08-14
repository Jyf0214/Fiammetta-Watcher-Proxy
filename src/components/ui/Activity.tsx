"use client";

import { type ReactNode } from "react";

export interface ActivityProps {
  active: boolean;
  children: ReactNode;
}

/**
 * 简易保活组件 — active=false 时隐藏 DOM 但不卸载，保持组件状态
 *
 * hidden 时 display:none + position:absolute，避免占位影响布局
 */
export function Activity({ active, children }: ActivityProps) {
  if (active) {
    return <>{children}</>;
  }

  return (
    <div
      style={{
        display: "none",
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

export default Activity;
