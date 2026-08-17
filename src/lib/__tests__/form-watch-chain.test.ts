/**
 * 回归测试：平台详情页「基本信息弹窗」字段读取链路（antd 6 行为回归防护）
 *
 * 背景：antd 5 → 6 升级后 getFieldsValue() 无参只返回「已注册字段」
 * （有 Form.Item 挂载）的值。平台详情页编辑模式下 name/baseUrl/type
 * 无对应 Form.Item（basic 面板仅在新建模式渲染），Form.useWatch 默认
 * 读取路径恒为 undefined → 弹窗字段全空。修复：useWatch 第二参传
 * { form, preserve: true }，强制走 getFieldsValue(true) 全量路径。
 */
import { describe, it, expect, vi } from "vitest";
import { FormStore } from "@rc-component/form/es/hooks/useForm.js";
import { HOOK_MARK } from "@rc-component/form/es/FieldContext.js";
import { getValue, getNamePath } from "@rc-component/form/es/utils/valueUtil.js";

// 注：@rc-component/form 是 antd 的传递依赖（antd 6 Form 内部实现），
// 测试直接驱动其 store 层验证 useWatch 的取值链路（preserve 语义）。
type RcForm = ReturnType<FormStore["getForm"]>;

function registerWatch(form: RcForm, cb: (values: unknown, allValues: unknown) => void) {
  const hooks = form.getInternalHooks(HOOK_MARK);
  if (!hooks) throw new Error("HOOK_MARK 未注册");
  return hooks.registerWatch(cb);
}

/** 模拟 PlatformConfigForm 的 useWatch 读取（preserve: true 路径） */
function readWithPreserve(form: RcForm, name: string): unknown {
  const full = form.getFieldsValue(true);
  return getValue(full, getNamePath(name));
}

describe("平台详情页基本信息弹窗：useWatch preserve 读取链路", () => {
  it("未注册字段（编辑模式 basic 字段无 Form.Item）setFieldsValue 后 preserve 路径可读", async () => {
    const store = new FormStore(() => {});
    const form = store.getForm();

    // 模拟详情页 useLayoutEffect：form.setFieldsValue({ ...platform, ... })
    const platform = {
      id: "test-platform-1",
      name: "Test Platform",
      baseUrl: "https://example.com/v1",
      apiKeys: [{ name: "密钥1", key: "test-key" }],
      type: "openai",
      presetId: null,
      enabled: true,
      priority: 0,
      weight: 1,
      rpmLimit: null,
      tpmLimit: null,
      status: "healthy",
      failCount: 0,
      lastFailAt: null,
      cooldownEnd: null,
      forwardHeaders: [],
      injectStreamOptions: true,
      whitelisted: true,
      reuseUserAgent: false,
      customUserAgent: "",
      extraHeaders: "{}",
      createdAt: 1786862074,
      updatedAt: 1786877196,
    };
    form.setFieldsValue({ ...platform, forwardHeaders: "", extraHeaders: "" });

    // 挂载后初始读取（useWatch 挂载 effect 的 triggerUpdate() 无参路径）
    expect(readWithPreserve(form, "name")).toBe("Test Platform");
    expect(readWithPreserve(form, "baseUrl")).toBe("https://example.com/v1");
    expect(readWithPreserve(form, "type")).toBe("openai");

    // 变化通知路径（watcher 回调收到 allValues 全量）
    let watched: Record<string, unknown> | null = null;
    const unregister = registerWatch(form, (values, allValues) => {
      const watchValue = allValues ?? form.getFieldsValue(true);
      watched = {
        name: getValue(watchValue, getNamePath("name")),
        baseUrl: getValue(watchValue, getNamePath("baseUrl")),
        type: getValue(watchValue, getNamePath("type")),
      };
      void values;
    });
    form.setFieldsValue({ name: "改名后的平台" });
    // notifyWatch 经 macroTask（MessageChannel）异步派发，条件等待回调到达
    await vi.waitFor(() => {
      expect(watched).not.toBeNull();
    });
    const w = watched as unknown as Record<string, unknown>;
    expect(w.name).toBe("改名后的平台");
    expect(w.baseUrl).toBe("https://example.com/v1");
    unregister();
  });

  it("回归对照：默认（非 preserve）路径读不到未注册字段——证明 preserve 是必需项", async () => {
    const store = new FormStore(() => {});
    const form = store.getForm();
    form.setFieldsValue({ name: "Test", baseUrl: "https://x.com/v1", type: "openai" });

    // 默认 useWatch 路径：values ?? getFieldsValue() —— 未注册字段读不到
    expect(getValue(form.getFieldsValue(), getNamePath("name"))).toBeUndefined();
    // preserve 路径：allValues ?? getFieldsValue(true) —— 可读
    expect(getValue(form.getFieldsValue(true), getNamePath("name"))).toBe("Test");
  });
});