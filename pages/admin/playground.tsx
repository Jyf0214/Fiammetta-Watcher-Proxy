/**
 * Playground 调试台
 *
 * 以管理员所选 API Key 的身份向本实例 /v1/chat/completions 发起真实请求
 * （密钥由服务端注入，不落浏览器），用于快速验证模型连通性与输出质量。
 * 流式响应逐帧解析 SSE，展示首字延迟与 token 用量。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { message, Select } from "antd";
import { FlaskConical, Loader2, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import AdminLayout from "@/components/AdminLayout";

interface ChatMessage {
  role: string;
  content: string;
}

function PlaygroundContent() {
  const { t } = useTranslation("playground");
  const [models, setModels] = useState<string[]>([]);
  const [keys, setKeys] = useState<Array<{ id: string; name: string }>>([]);
  const [model, setModel] = useState<string>("");
  const [apiKeyId, setApiKeyId] = useState<string>("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [streamMode, setStreamMode] = useState(true);
  const [output, setOutput] = useState("");
  const [meta, setMeta] = useState<{ latencyMs?: number; tokens?: number; cost?: number } | null>(null);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/playground");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          success?: boolean;
          data?: { models?: string[]; keys?: Array<{ id: string; name: string }> };
        };
        if (!json?.success || cancelled) return;
        setModels(json.data?.models ?? []);
        setKeys(json.data?.keys ?? []);
      } catch (err) {
        if (!cancelled) message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // 输出区自动滚底
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [output]);

  /** 从 SSE 帧提取增量内容与 usage */
  const consumeFrame = useCallback((frame: string, acc: { text: string; tokens?: number; cost?: number }) => {
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") acc.text += delta;
        // 非流式分支的完整 content
        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content === "string" && !parsed?.choices?.[0]?.delta) {
          acc.text = content;
        }
        const usage = parsed?.usage ?? parsed?.response?.usage;
        if (usage && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          const total = Number(u.total_tokens);
          if (Number.isFinite(total) && total > 0) acc.tokens = total;
          const cost = Number(u.cost ?? u.total_cost);
          if (Number.isFinite(cost) && cost > 0) acc.cost = cost;
        }
      } catch {
        // 忽略不完整 JSON 帧
      }
    }
  }, []);

  const handleSend = async () => {
    if (!model) {
      message.error(t("errorNoModel"));
      return;
    }
    if (!userPrompt.trim()) {
      message.error(t("errorNoPrompt"));
      return;
    }

    const messages: ChatMessage[] = [];
    if (systemPrompt.trim()) messages.push({ role: "system", content: systemPrompt.trim() });
    messages.push({ role: "user", content: userPrompt.trim() });

    setSending(true);
    setOutput("");
    setMeta(null);
    const startedAt = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/admin/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          apiKeyId: apiKeyId || undefined,
          stream: streamMode,
        }),
      });

      // API 层错误（鉴权/回环失败等）：管理端 JSON 错误信封
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream") && !contentType.includes("application/json")) {
        throw new Error(`HTTP ${res.status}`);
      }

      if (!streamMode) {
        // 非流式：回环响应是 OpenAI 格式（无 {success} 信封），只解析一次 body
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
          usage?: Record<string, unknown>;
          error?: unknown;
        };
        if (!res.ok) {
          const errMsg =
            (json?.error as { message?: string })?.message ||
            (typeof json?.error === "string" ? json.error : null) ||
            `HTTP ${res.status}`;
          throw new Error(errMsg);
        }
        const acc = { text: "", tokens: undefined as number | undefined, cost: undefined as number | undefined };
        consumeFrame(JSON.stringify(json), acc);
        setOutput(acc.text);
        setMeta({
          latencyMs: Date.now() - startedAt,
          tokens: acc.tokens,
          cost: acc.cost,
        });
        return;
      }

      // 流式：reader 逐块解析 SSE
      const reader = res.body?.getReader();
      if (!reader) throw new Error("empty stream body");
      const decoder = new TextDecoder();
      let buffer = "";
      const acc = { text: "", tokens: undefined as number | undefined, cost: undefined as number | undefined };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          consumeFrame(frame, acc);
          setOutput(acc.text);
        }
      }
      if (buffer) consumeFrame(buffer, acc);
      setOutput(acc.text);
      setMeta({
        latencyMs: Date.now() - startedAt,
        tokens: acc.tokens,
        cost: acc.cost,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setMeta((m) => ({ ...m, latencyMs: Date.now() - startedAt }));
      } else {
        message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<FlaskConical size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("title")}
          description={t("desc")}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 输入区 */}
          <ProCard title={t("requestTitle")}>
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Select
                  showSearch
                  value={model || undefined}
                  onChange={(v) => setModel(v)}
                  placeholder={t("selectModel")}
                  options={models.map((m) => ({ value: m, label: m }))}
                  filterOption={(input, option) =>
                    String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())
                  }
                  className="w-full"
                  size="small"
                />
                <Select
                  value={apiKeyId || undefined}
                  onChange={(v) => setApiKeyId(v)}
                  allowClear
                  placeholder={t("selectKey")}
                  options={keys.map((k) => ({ value: k.id, label: k.name }))}
                  className="w-full"
                  size="small"
                />
              </div>

              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t("systemPlaceholder")}
                rows={3}
                className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500 resize-y"
              />
              <textarea
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
                placeholder={t("userPlaceholder")}
                rows={6}
                className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500 resize-y"
              />

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={streamMode}
                    onChange={(e) => setStreamMode(e.target.checked)}
                    className="w-4 h-4 accent-zinc-700 dark:accent-zinc-300"
                  />
                  {t("stream")}
                </label>
                <div className="flex-1" />
                {sending ? (
                  <Button variant="dangerGhost" size="sm" onClick={handleStop}>
                    <Square className="w-4 h-4 mr-1" />
                    {t("stop")}
                  </Button>
                ) : null}
                <Button variant="primary" size="sm" onClick={handleSend} disabled={sending}>
                  {sending ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-1" />
                  )}
                  {sending ? t("sending") : t("send")}
                </Button>
              </div>
            </div>
          </ProCard>

          {/* 输出区 */}
          <ProCard
            title={t("responseTitle")}
            extra={
              meta ? (
                <span className="text-[11px] text-zinc-400 tabular-nums">
                  {meta.latencyMs !== undefined && `${(meta.latencyMs / 1000).toFixed(2)}s`}
                  {meta.tokens !== undefined && ` · ${meta.tokens} tok`}
                  {meta.cost !== undefined && ` · $${meta.cost.toFixed(6)}`}
                </span>
              ) : undefined
            }
          >
            <div
              ref={outputRef}
              className="h-[420px] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 dark:bg-zinc-900 p-3 text-sm text-zinc-800 dark:text-zinc-200 border border-zinc-100 dark:border-zinc-800"
            >
              {output || <span className="text-zinc-400">{t("emptyHint")}</span>}
            </div>
          </ProCard>
        </div>
      </PageContainer>
    </AdminLayout>
  );
}

export default function AdminPlayground() {
  return <PlaygroundContent />;
}
