"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Modal } from "antd";

export interface ModalConfig {
  title?: ReactNode;
  content: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  // 返回 false 表示阻止关闭；其余返回值（含 undefined）在触发后关闭弹窗
  onOk?: () => void | boolean | Promise<void | boolean>;
  onCancel?: () => void;
  okText?: string;
  cancelText?: string;
  loading?: boolean;
  maskClosable?: boolean;
}

export interface ModalInstance {
  open: () => void;
  close: () => void;
  update: (config: Partial<ModalConfig>) => void;
}

/**
 * 命令式 Modal 工厂 — 通过 createModal 创建可编程控制的 Modal 实例
 *
 * 返回的 ModalInstance 可在组件外部调用 open/close/update
 */
export function createModal(config: ModalConfig): ModalInstance {
  let isOpen = false;
  let currentConfig = { ...config };
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((l) => l());

  const instance: ModalInstance = {
    open: () => {
      isOpen = true;
      notify();
    },
    close: () => {
      isOpen = false;
      notify();
    },
    update: (patch: Partial<ModalConfig>) => {
      currentConfig = { ...currentConfig, ...patch };
      notify();
    },
  };

  // 暴露内部状态给 ImperativeModal 渲染
  (instance as ModalInstance & {
    _getState: () => { isOpen: boolean; config: ModalConfig };
  })._getState = () => ({ isOpen, config: currentConfig });

  // 暴露订阅
  (instance as ModalInstance & {
    _subscribe: (listener: () => void) => () => void;
  })._subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return instance;
}

/**
 * 渲染 ModalInstance 的容器组件 — 放在 JSX 中使用
 */
export function ImperativeModal({ instance }: { instance: ModalInstance }) {
  const [, forceUpdate] = useState(0);
  // 异步 onOk 执行中标记：期间禁用确定按钮并拦截重入，防止重复提交
  const [okPending, setOkPending] = useState(false);

  const triggerUpdate = useCallback(() => forceUpdate((n) => n + 1), []);

  // 订阅实例变更，卸载时自动取消订阅
  useEffect(() => {
    const inst = instance as ModalInstance & {
      _subscribe: (l: () => void) => () => void;
    };
    return inst._subscribe(triggerUpdate);
  }, [instance, triggerUpdate]);

  const inst = instance as ModalInstance & {
    _getState: () => { isOpen: boolean; config: ModalConfig };
  };
  const { isOpen, config } = inst._getState();

  // 确定按钮语义：先触发调用方 onOk；未传 onOk 或 onOk 返回非 false 时关闭弹窗。
  // （antd 受控 Modal 的 handleOk 只调 onOk?.() 后调 onClose?.()，而 onClose 仅在
  // closable 为非布尔对象时定义，因此不传 onOk 时点「确定」什么都不发生）
  const handleOk = async () => {
    if (okPending) return;
    const result = config.onOk?.();
    if (result instanceof Promise) {
      setOkPending(true);
      try {
        const shouldClose = (await result) !== false;
        if (shouldClose) instance.close();
      } finally {
        // 无论 resolve 还是 reject 都复位等待态（reject 时保持原有不关闭行为）
        setOkPending(false);
      }
      return;
    }
    if (result === false) return;
    instance.close();
  };

  return (
    <Modal
      open={isOpen}
      title={config.title}
      footer={config.footer ?? undefined}
      width={config.width ?? 520}
      onOk={handleOk}
      okText={config.okText}
      cancelText={config.cancelText}
      loading={config.loading || okPending}
      onCancel={() => {
        config.onCancel?.();
        instance.close();
      }}
      maskClosable={config.maskClosable ?? true}
      centered
      style={{ maxWidth: "90vw" }}
    >
      {config.content}
    </Modal>
  );
}

export default ImperativeModal;
