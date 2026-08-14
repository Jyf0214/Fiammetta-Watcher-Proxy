"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Modal } from "antd";

export interface ModalConfig {
  title?: ReactNode;
  content: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  onOk?: () => void | Promise<void>;
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

  return (
    <Modal
      open={isOpen}
      title={config.title}
      footer={config.footer ?? undefined}
      width={config.width ?? 520}
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
