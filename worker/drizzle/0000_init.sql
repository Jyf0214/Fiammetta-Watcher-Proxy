-- Fiammetta Watcher Proxy — D1 (SQLite) 初始迁移
-- 从 Prisma MySQL schema 转换而来
-- SQLite 差异：无 BigInt（用 INTEGER）、无原生 JSON（用 TEXT）、Boolean 用 INTEGER

-- 管理员账户
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 上游平台
CREATE TABLE IF NOT EXISTS platforms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_keys TEXT DEFAULT '[]',
  type TEXT DEFAULT 'openai',
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  weight INTEGER DEFAULT 1,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  status TEXT DEFAULT 'healthy',
  fail_count INTEGER DEFAULT 0,
  last_fail_at TEXT,
  cooldown_end TEXT,
  forward_headers TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 代理池
CREATE TABLE IF NOT EXISTS proxy_pools (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 代理
CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  pool_id TEXT REFERENCES proxy_pools(id) ON DELETE SET NULL,
  enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'healthy',
  fail_count INTEGER DEFAULT 0,
  ban_count INTEGER DEFAULT 0,
  last_fail_at TEXT,
  cooldown_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 套餐模板
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  token_quota INTEGER NOT NULL,
  call_limit INTEGER NOT NULL,
  rpm_limit INTEGER NOT NULL,
  tpm_limit INTEGER NOT NULL,
  reset_period TEXT DEFAULT 'monthly',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- API Key
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  plan_id TEXT REFERENCES plans(id),
  quota REAL,
  used_tokens INTEGER DEFAULT 0,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  call_limit INTEGER,
  token_limit INTEGER,
  reset_period TEXT DEFAULT 'monthly',
  status TEXT DEFAULT 'active',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 模型映射
CREATE TABLE IF NOT EXISTS model_maps (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  target_model TEXT NOT NULL,
  platform_id TEXT REFERENCES platforms(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 平台模型（自动发现）
CREATE TABLE IF NOT EXISTS platform_models (
  id TEXT PRIMARY KEY,
  platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  owned_by TEXT,
  type TEXT DEFAULT 'chat',
  source TEXT DEFAULT 'auto',
  fetched_at TEXT NOT NULL
);

-- 请求日志
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  key_id TEXT REFERENCES api_keys(id),
  platform_id TEXT REFERENCES platforms(id),
  proxy_id TEXT,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  tokens INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  ttft INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  is_error INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT REFERENCES admins(id),
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

-- 系统事件
CREATE TABLE IF NOT EXISTS system_events (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- 系统配置
CREATE TABLE IF NOT EXISTS configs (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 日志聚合统计
CREATE TABLE IF NOT EXISTS daily_stats (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  key_id TEXT,
  key_name TEXT,
  platform_id TEXT,
  platform_name TEXT,
  model TEXT NOT NULL,
  total_requests INTEGER DEFAULT 0,
  error_requests INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_prompt_tokens INTEGER DEFAULT 0,
  total_completion_tokens INTEGER DEFAULT 0,
  avg_ttft REAL DEFAULT 0,
  avg_duration REAL DEFAULT 0,
  max_ttft INTEGER DEFAULT 0,
  max_duration INTEGER DEFAULT 0
);

-- ==================== 复合唯一约束 ====================

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_maps_alias_platform ON model_maps(alias, platform_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_models_platform_model ON platform_models(platform_id, model_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_stats_date_key_model ON daily_stats(date, key_id, model);

-- ==================== 索引 ====================

CREATE INDEX IF NOT EXISTS idx_platforms_enabled_status ON platforms(enabled, status);
CREATE INDEX IF NOT EXISTS idx_proxies_pool_id_enabled_status ON proxies(pool_id, enabled, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_status_expires_at ON api_keys(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_platform_models_platform_id ON platform_models(platform_id);
CREATE INDEX IF NOT EXISTS idx_platform_models_model_id ON platform_models(model_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_key_id ON request_logs(key_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_platform_id ON request_logs(platform_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_key_id_created_at ON request_logs(key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_platform_id_created_at ON request_logs(platform_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_level ON system_events(level);
CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_key_id_date ON daily_stats(key_id, date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_platform_id_date ON daily_stats(platform_id, date);
