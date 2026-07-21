/**
 * API 客户端 — 与 Cloudflare Pages Functions 后端通信
 *
 * 所有 API 请求统一通过此模块发出，自动携带认证 Cookie。
 * Admin API 由 Pages Functions 处理，代理 API 由 Workers 处理。
 */

const API_BASE = import.meta.env.VITE_API_BASE || "";

interface RequestOptions extends RequestInit {
  parseJson?: boolean;
}

async function request<T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { parseJson = true, ...fetchOptions } = options;

  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...fetchOptions.headers,
    },
    ...fetchOptions,
  });

  if (!response.ok) {
    let errorBody: string;
    try {
      errorBody = await response.text();
    } catch {
      errorBody = "无法读取错误响应";
    }

    let errorMessage: string;
    try {
      const parsed = JSON.parse(errorBody);
      errorMessage = parsed?.error?.message || parsed?.message || parsed?.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = errorBody || `HTTP ${response.status}`;
    }

    throw new ApiError(errorMessage, response.status, errorBody);
  }

  if (!parseJson) return undefined as T;

  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return response.json() as Promise<T>;
  }

  return response.text() as unknown as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ==================== Auth API ====================

export const authApi = {
  login(username: string, password: string) {
    return request<{ success: boolean; data?: { username: string } }>("/api/admin/auth", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },

  getCurrentUser() {
    return request<{ success: boolean; data: { username: string } }>("/api/admin/auth");
  },

  changePassword(currentPassword: string, newPassword: string) {
    return request<{ success: boolean; message: string }>("/api/admin/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  resetPassword(newPassword: string) {
    return request<{ success: boolean; message: string }>("/api/admin/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    });
  },
};

// ==================== Platforms API ====================

export const platformsApi = {
  list() {
    return request<{ success: boolean; data: Platform[] }>("/api/admin/platforms");
  },

  create(data: Partial<Platform>) {
    return request<{ success: boolean; data: { id: string } }>("/api/admin/platforms", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  update(id: string, data: Partial<Platform>) {
    return request<{ success: boolean }>(`/api/admin/platforms/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return request<{ success: boolean }>(`/api/admin/platforms/${id}`, {
      method: "DELETE",
    });
  },

  listModels(platformId: string) {
    return request<{ success: boolean; data: PlatformModel[] }>(`/api/admin/platforms/${platformId}/models`);
  },

  addModel(platformId: string, data: { modelId: string; ownedBy?: string; type?: string }) {
    return request<{ success: boolean; data: { id: string } }>(`/api/admin/platforms/${platformId}/models`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  deleteModel(platformId: string, modelId: string) {
    return request<{ success: boolean }>(`/api/admin/platforms/${platformId}/models?modelId=${modelId}`, {
      method: "DELETE",
    });
  },
};

// ==================== Keys API ====================

export const keysApi = {
  list() {
    return request<{ success: boolean; data: ApiKey[] }>("/api/admin/keys");
  },

  create(data: Partial<ApiKey>) {
    return request<{ success: boolean; data: { id: string } }>("/api/admin/keys", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  update(id: string, data: Partial<ApiKey>) {
    return request<{ success: boolean }>(`/api/admin/keys/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return request<{ success: boolean }>(`/api/admin/keys/${id}`, {
      method: "DELETE",
    });
  },
};

// ==================== Models API ====================

export const modelsApi = {
  list() {
    return request<{ success: boolean; data: ModelMap[] }>("/api/admin/models");
  },

  create(data: Partial<ModelMap>) {
    return request<{ success: boolean; data: { id: string } }>("/api/admin/models", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  update(id: string, data: Partial<ModelMap>) {
    return request<{ success: boolean }>(`/api/admin/models/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return request<{ success: boolean }>(`/api/admin/models/${id}`, {
      method: "DELETE",
    });
  },
};

// ==================== Logs API ====================

export const logsApi = {
  list(params: { page?: number; pageSize?: number; type?: string; keyId?: string; platformId?: string; model?: string; startDate?: string; endDate?: string } = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    if (params.type) query.set("type", params.type);
    if (params.keyId) query.set("keyId", params.keyId);
    if (params.platformId) query.set("platformId", params.platformId);
    if (params.model) query.set("model", params.model);
    if (params.startDate) query.set("startDate", params.startDate);
    if (params.endDate) query.set("endDate", params.endDate);
    return request<{ success: boolean; data: { items: unknown[]; total: number; page: number; pageSize: number } }>(
      `/api/admin/logs?${query}`
    );
  },
};

// ==================== Stats API ====================

export const statsApi = {
  overview() {
    return request<{ success: boolean; data: StatsOverview }>("/api/admin/stats");
  },
};

// ==================== Usage API ====================

export const usageApi = {
  trend(period: string = "week", keyId?: string) {
    const query = new URLSearchParams({ type: "trend", period });
    if (keyId) query.set("keyId", keyId);
    return request<{ success: boolean; data: UsageTrend[] }>(`/api/admin/usage?${query}`);
  },

  byPlatform(period: string = "week", keyId?: string) {
    const query = new URLSearchParams({ type: "platform", period });
    if (keyId) query.set("keyId", keyId);
    return request<{ success: boolean; data: UsageByPlatform[] }>(`/api/admin/usage?${query}`);
  },

  byKey(period: string = "week") {
    return request<{ success: boolean; data: UsageByKey[] }>(`/api/admin/usage?type=key&period=${period}`);
  },
};

// ==================== Config API ====================

export const configApi = {
  get() {
    return request<{ success: boolean; data: Record<string, string> }>("/api/admin/config");
  },

  update(data: Record<string, string>) {
    return request<{ success: boolean }>("/api/admin/config", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },
};

// ==================== Audit API ====================

export const auditApi = {
  list(page: number = 1, pageSize: number = 20) {
    return request<{ success: boolean; data: { items: AuditLog[]; total: number; page: number; pageSize: number } }>(
      `/api/admin/audit?page=${page}&pageSize=${pageSize}`
    );
  },
};

// ==================== Proxies API ====================

export const proxiesApi = {
  list() {
    return request<{ success: boolean; data: Proxy[] }>("/api/admin/proxies");
  },

  create(data: { address: string; poolId?: string }) {
    return request<{ success: boolean; data: { id: string } }>("/api/admin/proxies", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  import(addresses: string[], poolId?: string) {
    return request<{ success: boolean; data: { imported: number } }>("/api/admin/proxies", {
      method: "POST",
      body: JSON.stringify({ addresses, poolId }),
    });
  },

  update(id: string, data: Partial<Proxy>) {
    return request<{ success: boolean }>(`/api/admin/proxies/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return request<{ success: boolean }>(`/api/admin/proxies/${id}`, {
      method: "DELETE",
    });
  },
};

// ==================== Pools API ====================

export const poolsApi = {
  list() {
    return request<{ success: boolean; data: ProxyPool[] }>("/api/admin/pools");
  },

  create(data: { name: string; enabled?: boolean }) {
    return request<{ success: boolean; data: { id: string } }>("/api/admin/pools", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  update(id: string, data: Partial<ProxyPool>) {
    return request<{ success: boolean }>(`/api/admin/pools/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return request<{ success: boolean }>(`/api/admin/pools/${id}`, {
      method: "DELETE",
    });
  },
};

// ==================== Request Templates API ====================

export const templatesApi = {
  list() {
    return request<{ success: boolean; data: RequestTemplate[] }>("/api/admin/request-templates");
  },

  save(data: RequestTemplate) {
    return request<{ success: boolean }>("/api/admin/request-templates", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return request<{ success: boolean }>("/api/admin/request-templates", {
      method: "DELETE",
      body: JSON.stringify({ id }),
    });
  },
};

// ==================== Debug API ====================

export const debugApi = {
  info() {
    return request<{ success: boolean; data: Record<string, unknown> }>("/api/admin/debug");
  },
};

// ==================== Export/Import API ====================

export const exportApi = {
  data(type: string = "all") {
    return request<{ success: boolean; data: Record<string, unknown>; exportedAt: string }>(
      `/api/admin/export?type=${type}`
    );
  },
};

export const importApi = {
  data(data: Record<string, unknown>) {
    return request<{ success: boolean; data: Record<string, number> }>("/api/admin/import", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
};

// ==================== 类型定义 ====================

export interface Platform {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string[];
  type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: string;
  failCount: number;
  forwardHeaders: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PlatformModel {
  id: string;
  platformId: string;
  modelId: string;
  ownedBy: string | null;
  type: string;
  source: string;
  fetchedAt: string;
}

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  planId: string | null;
  planName: string | null;
  quota: number | null;
  usedTokens: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  callLimit: number | null;
  tokenLimit: number | null;
  resetPeriod: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelMap {
  id: string;
  alias: string;
  targetModel: string;
  platformId: string;
  platformName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Proxy {
  id: string;
  address: string;
  poolId: string | null;
  enabled: boolean;
  status: string;
  failCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyPool {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  mergeBody: Record<string, unknown>;
  enabled: boolean;
}

export interface AuditLog {
  id: string;
  adminId: string;
  adminUsername: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: string;
}

export interface StatsOverview {
  platformCount: number;
  keyCount: number;
  todayRequests: number;
  totalRequests: number;
  errorRequests: number;
  errorRate: string;
  adminUsername: string | null;
}

export interface UsageTrend {
  date: string;
  totalRequests: number;
  totalTokens: number;
}

export interface UsageByPlatform {
  platformId: string;
  platformName: string;
  totalRequests: number;
  totalTokens: number;
  errorRequests: number;
}

export interface UsageByKey {
  keyId: string;
  keyName: string;
  totalRequests: number;
  totalTokens: number;
  errorRequests: number;
}
