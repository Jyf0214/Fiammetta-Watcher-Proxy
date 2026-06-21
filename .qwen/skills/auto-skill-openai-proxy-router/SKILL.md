---
name: openai-proxy-router
description: 构建 OpenAI 兼容 API 中转站的完整架构模式：路由引擎、负载均衡、熔断器、速率限制、SSE 流式透传
source: auto-skill
extracted_at: '2026-06-21T00:30:00.000Z'
---

# OpenAI 兼容 API 中转站架构

## 核心组件

### 1. 路由引擎（router.ts）

```
客户端请求 → 模型映射解析 → 平台选择（优先级 + 权重） → 转发
```

关键设计：
- **模型映射**：支持精确匹配和通配符匹配（`gpt-*` → `gpt-4o-2024-08-06`）
- **权重负载均衡**：同优先级平台按权重加权随机选择
- **缓存**：平台和映射数据缓存 30 秒，避免每次请求查库
- **熔断感知**：自动跳过处于熔断冷却期的平台

### 2. 熔断器（circuit-breaker.ts）

三态模型：`closed → open → half-open → closed`

```
连续失败 ≥ 阈值 → 触发熔断（open）→ 冷却期结束 → 半开（half-open）→ 成功 → 恢复（closed）
                                                                    → 失败 → 重新熔断
```

- 默认阈值：5 次连续失败触发熔断
- 默认冷却：60 秒
- 半开状态最多尝试 3 次
- **半开状态探测限制**：`halfOpenAttempts` 计数器在 recordFailure 中递增，达到 `halfOpenMaxAttempts` 后重新熔断
- **DB 操作容错**：所有 `prisma.platform.update` 必须包裹 try/catch，DB 失败不应影响内存状态
- **状态变更同步写入数据库 + 刷新路由缓存**

### 3. 速率限制器（rate-limiter.ts）

滑动窗口算法（内存实现，生产环境建议 Redis）：

```ts
checkPlatformRateLimit(platformId, rpmLimit, tpmLimit, tokenCount)
// 返回 { allowed, remaining, resetAt }
```

- 按平台维度限制 RPM（每分钟请求数）和 TPM（每分钟 token 数）
- 窗口过期自动重置
- 定期清理 2 分钟未活动的窗口
- **自初始化**：在模块底部调用 `startRateLimitCleanup()` 确保定时器启动，防止 Map 无限增长导致内存泄漏

### 4. SSE 流式透传 + Token 计费

流式响应必须拦截 SSE 事件以提取 usage 数据进行计费：

```ts
// 请求上游时强制要求返回 usage
const upstreamResponse = await fetch(upstreamUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    ...body,
    model: targetModel,
    stream: true,
    stream_options: { include_usage: true }, // 关键：请求上游返回 usage
  }),
});

// TransformStream 拦截 SSE 流，提取 usage 信息
let capturedUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

const usageTransformer = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk); // 原样透传
    try {
      const text = new TextDecoder().decode(chunk);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        if (parsed.usage) capturedUsage = parsed.usage;
      }
    } catch { /* 单行解析失败忽略 */ }
  },
  async flush() {
    // 流结束：事务内原子更新 token 用量
    const totalTokens = capturedUsage
      ? (capturedUsage.prompt_tokens || 0) + (capturedUsage.completion_tokens || 0)
      : 0;
    if (totalTokens > 0) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.apiKey.update({
          where: { id: apiKey.id },
          data: { usedTokens: { increment: totalTokens } },
          select: { usedTokens: true },
        });
        if (Number(updated.usedTokens) >= effectiveTokenLimit) {
          await tx.apiKey.update({ where: { id: apiKey.id }, data: { status: "disabled" } });
        }
      });
    }
  },
});

return new Response(stream.pipeThrough(usageTransformer), {
  status: 200,
  headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
});
```

**反向代理要求**：nginx 需对 `/v1/*` 路由禁用 `proxy_buffering`。

### 5. 请求日志

```ts
// 非流式：从 response.usage 提取 token 用量
const totalTokens = usage.prompt_tokens + usage.completion_tokens;

// 流式：从 TransformStream 的 flush 回调中提取（见上方代码）
```

### 6. API Key 额度控制（原子操作）

必须使用 Prisma 事务 + `increment` 避免并发竞态：

```ts
// ✅ 正确：原子递增 + 事务内检查额度
await prisma.$transaction(async (tx) => {
  const updated = await tx.apiKey.update({
    where: { id: apiKey.id },
    data: { usedTokens: { increment: totalTokens } },
    select: { usedTokens: true },
  });
  if (Number(updated.usedTokens) >= effectiveTokenLimit) {
    await tx.apiKey.update({ where: { id: apiKey.id }, data: { status: "disabled" } });
  }
});

// ❌ 错误：先读后写，并发请求会丢失 token 计数
const current = await prisma.apiKey.findUnique({ where: { id } });
await prisma.apiKey.update({ data: { usedTokens: current.usedTokens + totalTokens } });
```

## 请求处理流程

```
1. 验证 API Key（查库 + 检查状态/过期）
2. 解析请求体（model + messages/prompt）
3. 路由选择（模型映射 → 平台选择）
4. 速率限制检查
5. 转发到上游（fetch）
6. 错误处理 → 记录失败 → 熔断器更新
7. 成功处理 → 记录成功 → 提取 token 用量 → 更新 Key 额度 → 记录日志
8. 返回响应（流式/非流式）
```

## 平台状态管理

| 状态 | 含义 | 触发条件 |
|------|------|---------|
| healthy | 健康 | 默认状态 / 熔断恢复后 |
| degraded | 降级 | 失败次数达到阈值一半 |
| down | 故障 | 触发熔断 |

## 通知触发点

- 平台连续失败达到熔断阈值 → 通知管理员
- 平台从熔断恢复 → 通知管理员
- API Key 额度用尽 → 通知管理员
- 系统异常 → 通知管理员

## 关键修复经验（实战踩坑）

### 通配符模型映射 platformId 过滤

```ts
// ❌ 错误：通配符匹配忽略 platformId
const wildcardMatch = modelMapCache.find(
  (m) => m.alias.endsWith("*") && requestedModel.startsWith(m.alias.slice(0, -1))
);

// ✅ 正确：通配符匹配也需过滤 platformId
const wildcardMatch = modelMapCache.find(
  (m) => m.alias.endsWith("*") &&
    requestedModel.startsWith(m.alias.slice(0, -1)) &&
    (platformId ? m.platformId === platformId : true)
);
```

### 路由缓存原子更新

```ts
// ❌ 错误：分开赋值导致并发读取方看到不一致状态
platformCache = platforms.map(...);
modelMapCache = modelMaps.map(...);

// ✅ 正确：先赋给局部变量，再同步赋值
const newPlatforms = platforms.map(...);
const newModelMaps = modelMaps.map(...);
platformCache = newPlatforms;
modelMapCache = newModelMaps;
```

### notifier.ts 不可静默吞错

```ts
// ❌ 错误：空 catch 块
try { await prisma.systemEvent.create(...); } catch {}

// ✅ 正确：至少 console.error
try { await prisma.systemEvent.create(...); } catch (err) {
  console.error("[notifier] 写入系统事件失败:", err);
}
```

### Telegram 通知需设置超时

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
try {
  await fetch(url, { signal: controller.signal, ... });
} finally {
  clearTimeout(timeout);
}
```
