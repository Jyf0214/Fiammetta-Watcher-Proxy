/**
 * V1 代理路由聚合
 *
 * 兼容 OpenAI SDK 的代理端点。
 * 包含：chat/completions、completions、embeddings、images、audio、models、responses
 */

import { Hono } from "hono";
import type { Env } from "../../types";
import { chatCompletions } from "./chat-completions";
import { completions } from "./completions";
import { embeddings } from "./embeddings";
import { images } from "./images";
import { audio } from "./audio";
import { models } from "./models";
import { responses } from "./responses";

export const v1Routes = new Hono<{ Bindings: Env }>();

v1Routes.post("/chat/completions", chatCompletions);
v1Routes.post("/completions", completions);
v1Routes.post("/embeddings", embeddings);
v1Routes.post("/images/generations", images);
v1Routes.post("/images/edits", images);
v1Routes.post("/images/variations", images);
v1Routes.post("/audio/speech", audio);
v1Routes.post("/audio/transcriptions", audio);
v1Routes.post("/audio/translations", audio);
v1Routes.get("/models", models);
v1Routes.get("/models/:model", models);
v1Routes.post("/responses", responses);
