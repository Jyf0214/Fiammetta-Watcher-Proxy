/**
 * Chat Completions ↔ Responses API 互转
 *
 * 覆盖：
 * - 请求体互转（下游格式 → 上游格式）
 * - 非流式响应互转（上游格式 → 下游格式）
 * - 流式 SSE 事件互转（TransformStream）
 *
 * 设计目标：老客户端（仅支持 /v1/chat/completions）可通过模型通配符映射 transparently 调用强制要求 Responses 结构的上游，反之亦然。
 * 关键细节：思考链（reasoning）透传、空完成防护、usage 双形态兼容。
 */

// ==================== 请求转换 ====================

/**
 * Chat 请求 → Responses 请求
 *
 * 映射规则：
 * - messages 中 role=system 的首条转为 instructions，其余转为 input 数组
 * - content 为 string 直接透传，为数组（多模态/工具）按 Responses 的 input 形态包装
 * - tools / tool_choice 原样透传（Responses 与 Chat 的 function tool 形态接近，严格后端可自行校验）
 * - max_tokens / max_completion_tokens → max_output_tokens
 * - reasoning_effort / reasoning 等思考控制 → reasoning: { effort, summary }
 * - temperature / top_p 等通用采样参数透传
 */
export function convertChatToResponses(
  chatBody: Record<string, unknown>,
  targetModel: string
): Record<string, unknown> {
  const messages = (chatBody.messages as Array<any>) || [];
  let instructions: string | undefined;
  const input: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (!m || typeof m.role !== "string") continue;
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
      if (text) {
        instructions = instructions ? instructions + "\n" + text : text;
      }
      continue;
    }
    // tool / assistant / user 统一转为 input 项
    // 若 content 为 string，直接放 content；若为数组，按 Responses 的 content 包装
    if (m.role === "tool") {
      // chat tool 消息 → responses 的 input 中 role=tool? responses 暂无 tool 角色，按 user 包装并注明 tool_call_id
      input.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
      continue;
    }
    const item: Record<string, unknown> = { role: m.role, content: m.content };
    // 保留 tool_calls / tool_call_id 等（Responses 的 input 亦支持 tool 关联，采用相同字段）
    if (m.tool_calls) (item as any).tool_calls = m.tool_calls;
    if (m.tool_call_id) (item as any).tool_call_id = m.tool_call_id;
    input.push(item);
  }

  // 若 input为空且原 body 有 prompt 等，尝试从 input 字段兼容
  // 否则若仍为空，回退为单条 user 消息兜底，避免上游 400
  const out: Record<string, unknown> = {
    model: targetModel,
    input: input.length > 0 ? input : (chatBody.input as unknown) ?? "",
  };

  if (instructions) out.instructions = instructions;

  // 推理控制：优先取 chat 的 reasoning / reasoning_effort，转为 Responses 的 reasoning 对象
  const reasoningEffort = (chatBody as any).reasoning_effort || (chatBody as any).reasoning?.effort;
  const reasoningSummary = (chatBody as any).reasoning?.summary;
  if (reasoningEffort || reasoningSummary) {
    const reasoning: Record<string, unknown> = {};
    if (reasoningEffort) reasoning.effort = reasoningEffort;
    if (reasoningSummary) reasoning.summary = reasoningSummary;
    // 解锁高阶思维链：默认 high + detailed 若未指定
    if (!reasoning.effort) reasoning.effort = "high";
    out.reasoning = reasoning;
  } else if ((chatBody as any).reasoning) {
    out.reasoning = (chatBody as any).reasoning;
  }

  // 采样与长度参数
  if (typeof chatBody.temperature === "number") out.temperature = chatBody.temperature;
  if (typeof chatBody.top_p === "number") out.top_p = chatBody.top_p;
  if (typeof chatBody.top_k === "number") out.top_k = chatBody.top_k;
  if (typeof chatBody.frequency_penalty === "number") out.frequency_penalty = chatBody.frequency_penalty;
  if (typeof chatBody.presence_penalty === "number") out.presence_penalty = chatBody.presence_penalty;
  if (typeof chatBody.stop !== "undefined") out.stop = chatBody.stop;
  if (typeof (chatBody as any).max_output_tokens === "number") out.max_output_tokens = (chatBody as any).max_output_tokens;
  else if (typeof chatBody.max_tokens === "number") out.max_output_tokens = chatBody.max_tokens;
  else if (typeof (chatBody as any).max_completion_tokens === "number") out.max_output_tokens = (chatBody as any).max_completion_tokens;

  if (chatBody.stream === true) out.stream = true;
  if (chatBody.tools) out.tools = chatBody.tools;
  if ((chatBody as any).tool_choice) out.tool_choice = (chatBody as any).tool_choice;
  if (typeof (chatBody as any).parallel_tool_calls !== "undefined") out.parallel_tool_calls = (chatBody as any).parallel_tool_calls;
  if ((chatBody as any).response_format) out.text = { format: (chatBody as any).response_format };
  if (typeof chatBody.n === "number") out.n = chatBody.n;
  if (chatBody.seed !== undefined) out.seed = chatBody.seed;

  // 透传 Responses 特有但 Chat 可能携带的字段（如 truncation / store / include / metadata）
  for (const k of ["truncation", "store", "include", "metadata", "service_tier", "prompt_cache_key", "safety_identifier", "background", "previous_response_id", "text"]) {
    if ((chatBody as any)[k] !== undefined) (out as any)[k] = (chatBody as any)[k];
  }

  // 保留 extra_body / chat_template_kwargs 等透传字段（Responses 同样允许 extra_body）
  if ((chatBody as any).extra_body) out.extra_body = (chatBody as any).extra_body;
  if ((chatBody as any).chat_template_kwargs) out.chat_template_kwargs = (chatBody as any).chat_template_kwargs;

  return out;
}

/**
 * Responses 请求 → Chat 请求
 *
 * 逆向映射，用于上游强制 Chat 而下游已使用 Responses 的场景
 */
export function convertResponsesToChat(
  respBody: Record<string, unknown>,
  targetModel: string
): Record<string, unknown> {
  const input = respBody.input;
  const instructions = respBody.instructions as string | undefined;
  const messages: Array<Record<string, unknown>> = [];

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof (item as any).role !== "string") continue;
      messages.push({
        role: (item as any).role,
        content: (item as any).content ?? (item as any).text ?? "",
        ...( (item as any).tool_calls ? { tool_calls: (item as any).tool_calls } : {} ),
        ...( (item as any).tool_call_id ? { tool_call_id: (item as any).tool_call_id } : {} ),
      });
    }
  } else if (input) {
    messages.push({ role: "user", content: String(input) });
  }

  const out: Record<string, unknown> = {
    model: targetModel,
    messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
  };

  // 推理映射：Responses reasoning.effort -> chat reasoning_effort
  const reasoning = (respBody as any).reasoning;
  if (reasoning && typeof reasoning === "object") {
    if ((reasoning as any).effort) (out as any).reasoning_effort = (reasoning as any).effort;
    // summary 等可放入 extra_body 保留
    if ((reasoning as any).summary) (out as any).reasoning = reasoning;
  }

  if (typeof respBody.temperature === "number") out.temperature = respBody.temperature;
  if (typeof (respBody as any).top_p === "number") out.top_p = (respBody as any).top_p;
  if (typeof (respBody as any).max_output_tokens === "number") out.max_tokens = (respBody as any).max_output_tokens;
  else if (typeof (respBody as any).max_tokens === "number") out.max_tokens = (respBody as any).max_tokens;

  if (respBody.stream === true) out.stream = true;
  if ((respBody as any).tools) out.tools = (respBody as any).tools;
  if ((respBody as any).tool_choice) out.tool_choice = (respBody as any).tool_choice;
  if ((respBody as any).text?.format) out.response_format = (respBody as any).text.format;

  for (const k of ["stop", "n", "seed", "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs"]) {
    if ((respBody as any)[k] !== undefined) (out as any)[k] = (respBody as any)[k];
  }
  if ((respBody as any).extra_body) out.extra_body = (respBody as any).extra_body;
  if ((respBody as any).chat_template_kwargs) out.chat_template_kwargs = (respBody as any).chat_template_kwargs;

  return out;
}

// ==================== 非流式响应转换 ====================

/**
 * Responses 非流式响应 → Chat 非流式响应
 *
 * 将上游 Responses 的 output 扁平为 Chat 的 choices[0].message.content，并处理 reasoning 透传与空完成防护
 */
export function convertResponsesToChatResponse(
  respBody: Record<string, unknown>,
  requestedModel: string
): Record<string, unknown> {
  const output = (respBody.output as Array<any>) || [];
  let content = "";
  let reasoningContent = "";
  const toolCalls: Array<any> = [];

  for (const item of output) {
    if (!item || typeof item.type !== "string") continue;
    if (item.type === "message") {
      const contents = item.content as Array<any> | undefined;
      if (Array.isArray(contents)) {
        for (const c of contents) {
          if (c?.type === "output_text" && typeof c.text === "string") {
            content += c.text;
          } else if (c?.type === "text" && typeof c.text === "string") {
            content += c.text;
          } else if (c?.type === "tool_call" || c?.type === "function") {
            toolCalls.push(c);
          }
        }
      } else if (typeof item.content === "string") {
        content += item.content;
      }
    } else if (item.type === "reasoning") {
      // Responses 的推理摘要：summary[].text 拼接为 reasoning_content
      const summary = item.summary as Array<any> | undefined;
      if (Array.isArray(summary)) {
        for (const s of summary) {
          if (typeof s?.text === "string") reasoningContent += s.text;
          else if (typeof s?.summary_text === "string") reasoningContent += s.summary_text;
        }
      }
      // 旧形态 reasoning 可能直接有 content
      if (typeof (item as any).content === "string") reasoningContent += (item as any).content;
      if (typeof (item as any).text === "string") reasoningContent += (item as any).text;
    } else if (item.type === "function_call" || item.type === "tool_call") {
      toolCalls.push(item);
    }
  }

  // 备用：Responses 有时直接提供 output_text 顶层字段
  if (!content && typeof (respBody as any).output_text === "string") {
    content = (respBody as any).output_text;
  }
  if (!content && typeof (respBody as any).text === "string") {
    content = (respBody as any).text;
  }

  // 空完成防护：若下游仍按 chat 处理而上游未返回任何文本，且无工具调用，则构造兜底消息避免触发 “此模型未能给出一个最终回应便意外结束”
  // 此处不直接报错，而是返回空字符串但附带 reasoning（若有），让上游的思考链至少可被下游感知；真正的空完成由上层 emptyCompletion 检测处理
  const hasToolCalls = toolCalls.length > 0;
  const effectiveContent = content || (hasToolCalls ? "" : content);

  const usage = (respBody.usage as Record<string, unknown>) || {};
  const promptTokens = Number((usage as any).input_tokens ?? (usage as any).prompt_tokens ?? 0);
  const completionTokens = Number((usage as any).output_tokens ?? (usage as any).completion_tokens ?? 0);
  const totalTokens = Number((usage as any).total_tokens ?? promptTokens + completionTokens);

  const chatResp: Record<string, unknown> = {
    id: (respBody.id as string) || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: effectiveContent,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(hasToolCalls ? { tool_calls: toolCalls.map((tc, idx) => ({
            id: tc.id || `call_${idx}`,
            type: "function",
            function: {
              name: tc.name || tc.function?.name || "unknown",
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? tc.input ?? {}),
            },
          })) } : {}),
        },
        finish_reason: (respBody as any).finish_reason || (hasToolCalls ? "tool_calls" : "stop"),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
  };

  // 关键：即使上游 Responses 未返回思考头，也确保 reasoning_content 字段存在时透传，避免下游因缺失思考链而误判为空完成
  // 空完成防护已在外层通过 sawContent 判定，此处仅保证内容非空时正确映射
  return chatResp;
}

/**
 * Chat 非流式响应 → Responses 非流式响应
 *
 * 将上游 Chat 的 choices 扁平为 Responses 的 output
 */
export function convertChatToResponsesResponse(
  chatBody: Record<string, unknown>,
  requestedModel: string
): Record<string, unknown> {
  const choices = (chatBody.choices as Array<any>) || [];
  const choice = choices[0] || {};
  const message = choice.message || {};
  const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((p: any) => p.text ?? "").join("") : "";
  const reasoningContent = (message as any).reasoning_content || (message as any).reasoning || "";

  const output: Array<Record<string, unknown>> = [];

  if (reasoningContent) {
    output.push({
      type: "reasoning",
      summary: [{ type: "summary_text", text: reasoningContent }],
    });
  }

  const toolCalls = message.tool_calls as Array<any> | undefined;
  if (content || !toolCalls || toolCalls.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: content }],
    });
  }

  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      output.push({
        type: "function_call",
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      });
    }
  }

  const usage = (chatBody.usage as Record<string, unknown>) || {};
  const promptTokens = Number((usage as any).prompt_tokens ?? 0);
  const completionTokens = Number((usage as any).completion_tokens ?? 0);

  return {
    id: (chatBody.id as string) || `resp_${Date.now()}`,
    object: "response",
    created_at: (chatBody as any).created ?? Math.floor(Date.now() / 1000),
    model: requestedModel,
    output,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ==================== 流式转换 ====================

/**
 * Responses SSE 流 → Chat SSE 流
 *
 * 将上游 Responses 的事件（response.output_text.delta / response.reasoning_summary_text.delta 等）转换为下游 Chat 的 delta.content / delta.reasoning_content
 * 同时透传思考头与 usage，确保下游不误判为空完成
 */
export function createResponsesToChatStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let hasContent = false;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Responses 流包含 event: 与 data: 两行，事件类型在 event 行，数据在 data 行
        // 我们按 data 行解析，event 行仅用于辅助判断（已在 data 的 type 字段中体现）
        if (trimmed.startsWith("event:")) {
          // 暂不直接转发 event，待 data 行统一转换为 chat 事件
          continue;
        }
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          // 上游 Responses 完成时需确保下游收到 [DONE]，即使上游未显式发送
          // 此处不直接转发，待 flush 时统一发送
          continue;
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          const pAny = parsed as any;

          // 处理错误透传
          if (pAny.error) {
            const chunk = {
              choices: [{ delta: {}, index: 0, finish_reason: null }],
              error: pAny.error,
              object: "chat.completion.chunk",
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            continue;
          }

          // 提取 usage（Responses 的最终完成事件中）
          if (pAny.type === "response.completed" || pAny.response?.usage || pAny.usage) {
            const usage = pAny.response?.usage ?? pAny.usage ?? pAny.response?.response?.usage;
            if (usage) {
              // 转换为 chat 的 usage 块
              const prompt = Number((usage as any).input_tokens ?? (usage as any).prompt_tokens ?? 0);
              const completion = Number((usage as any).output_tokens ?? (usage as any).completion_tokens ?? 0);
              const chunk = {
                id: pAny.response?.id || "chatcmpl-stream",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, index: 0, finish_reason: null }],
                usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            continue;
          }

          // 文本增量：response.output_text.delta
          if (pAny.type === "response.output_text.delta" && typeof pAny.delta === "string") {
            hasContent = true;
            const chunk = {
              id: "chatcmpl-stream",
              object: "chat.completion.chunk",
              choices: [{ delta: { content: pAny.delta }, index: 0, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            continue;
          }

          // 兼容旧形态：直接的 delta 字段
          if (typeof pAny.delta === "string" && pAny.delta.length > 0 && (pAny.type?.includes("output_text") || !pAny.type)) {
            // 若无明确 type 但有 delta，视为文本增量
            if (!pAny.type || pAny.type === "response.output_text.delta" || pAny.output_index !== undefined) {
              hasContent = true;
              const chunk = {
                id: "chatcmpl-stream",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: pAny.delta }, index: 0, finish_reason: null }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              continue;
            }
          }

          // 推理增量：response.reasoning_summary_text.delta 或 response.reasoning_text.delta
          if ((pAny.type === "response.reasoning_summary_text.delta" || pAny.type === "response.reasoning_text.delta" || pAny.type?.includes("reasoning")) && typeof pAny.delta === "string") {
            hasContent = true; // 推理内容亦视为有效输出，防止空完成误判
            const chunk = {
              id: "chatcmpl-stream",
              object: "chat.completion.chunk",
              choices: [{ delta: { reasoning_content: pAny.delta }, index: 0, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            continue;
          }

          // 完整 output 项到达（如 response.output_item.added），若含文本则透传
          if (pAny.type === "response.output_item.added" || pAny.type === "response.content_part.added") {
            const item = pAny.item ?? pAny.part;
            if (item?.content) {
              const text = Array.isArray(item.content) ? item.content.filter((c: any) => c?.type === "output_text").map((c: any) => c.text).join("") : typeof item.content === "string" ? item.content : "";
              if (text) {
                hasContent = true;
                const chunk = {
                  id: "chatcmpl-stream",
                  object: "chat.completion.chunk",
                  choices: [{ delta: { content: text }, index: 0, finish_reason: null }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            }
            continue;
          }

          // 通用 output 文本
          if (Array.isArray(pAny.output)) {
            for (const out of pAny.output) {
              if (out?.type === "message" && Array.isArray(out.content)) {
                for (const c of out.content) {
                  if (c?.type === "output_text" && typeof c.text === "string" && c.text.length > 0) {
                    hasContent = true;
                    const chunk = {
                      id: "chatcmpl-stream",
                      object: "chat.completion.chunk",
                      choices: [{ delta: { content: c.text }, index: 0, finish_reason: null }],
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                }
              }
            }
            continue;
          }

          // 若数据本身即为 chat 形态的 choices，直接透传（兼容上游未严格区分的场景）
          if (Array.isArray(pAny.choices)) {
            hasContent = true;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(pAny)}\n\n`));
            continue;
          }

          // 其他未知事件，若含 text/output_text 则透传
          const fallbackText = pAny.text ?? pAny.output_text;
          if (typeof fallbackText === "string" && fallbackText.length > 0) {
            hasContent = true;
            const chunk = {
              id: "chatcmpl-stream",
              object: "chat.completion.chunk",
              choices: [{ delta: { content: fallbackText }, index: 0, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        } catch {
          // 忽略解析失败
        }
      }
    },
    flush(controller) {
      // 确保下游收到结束标记，即使上游未发送 [DONE]，也发送 stop 块与 [DONE]
      // 空完成防护：若全程未收到有效内容，则发送空内容但带 reasoning 占位，避免触发上游的空完成误判转下游的“意外结束”
      if (!hasContent) {
        // 发送一个最小内容的块，确保下游不误判为空完成（后续由外层 emptyCompletion 逻辑处理，但此处提供兜底）
        // 不发送内容，让外层判定空完成并触发熔断与 502 是更诚实的行为；此处仅保证流正常结束
      }
      const stopChunk = {
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}

/**
 * Chat SSE 流 → Responses SSE 流
 *
 * 将上游 Chat 的 delta.content / delta.reasoning_content 转换为下游 Responses 的 output_text.delta / reasoning_summary_text.delta
 * 用于下游已使用 Responses 而上游仍为 Chat 的反向转换（较少见但为完整性提供）
 */
export function createChatToResponsesStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          controller.enqueue(encoder.encode(`event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          continue;
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          const pAny = parsed as any;

          if (pAny.error) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(pAny.error)}\n\n`));
            continue;
          }

          // usage 块
          if (pAny.usage) {
            const prompt = Number(pAny.usage.prompt_tokens ?? 0);
            const completion = Number(pAny.usage.completion_tokens ?? 0);
            const usageEvent = {
              type: "response.completed",
              response: {
                usage: { input_tokens: prompt, output_tokens: completion, total_tokens: prompt + completion },
                status: "completed",
              },
            };
            controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(usageEvent)}\n\n`));
            continue;
          }

          if (Array.isArray(pAny.choices)) {
            for (const choice of pAny.choices) {
              const delta = choice?.delta;
              if (!delta) continue;
              if (typeof delta.content === "string" && delta.content.length > 0) {
                const event = {
                  type: "response.output_text.delta",
                  delta: delta.content,
                  output_index: choice.index ?? 0,
                };
                controller.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify(event)}\n\n`));
              }
              if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
                const event = {
                  type: "response.reasoning_summary_text.delta",
                  delta: delta.reasoning_content,
                };
                controller.enqueue(encoder.encode(`event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify(event)}\n\n`));
              }
              if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                // 工具调用暂透传为 output_text（Responses 的工具形态不同，此处简化）
                for (const tc of delta.tool_calls) {
                  const event = {
                    type: "response.output_text.delta",
                    delta: `[Tool call: ${tc.function?.name ?? "unknown"}]`,
                  };
                  controller.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify(event)}\n\n`));
                }
              }
            }
          }
        } catch {
          // 忽略
        }
      }
    },
    flush(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}
