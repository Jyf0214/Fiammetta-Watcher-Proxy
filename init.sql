-- ================================================================
-- Fiammetta Watcher Proxy — D1 (SQLite) 建表脚本
-- 从 main 分支 Prisma/MySQL 迁移到 Cloudflare D1
-- 转换规则：String→TEXT, Boolean→INTEGER(0/1),
--           DateTime→INTEGER(Unix秒时间戳), Decimal/Float→REAL, BigInt→INTEGER
-- ================================================================

-- 1. 管理员账户
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 2. 上游平台
CREATE TABLE IF NOT EXISTS platforms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_keys TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL DEFAULT 'openai',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  status TEXT NOT NULL DEFAULT 'healthy',
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER,
  cooldown_end INTEGER,
  forward_headers TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 3. 代理池
CREATE TABLE IF NOT EXISTS proxy_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 4. 代理
CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  pool_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'healthy',
  fail_count INTEGER NOT NULL DEFAULT 0,
  ban_count INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER,
  cooldown_end INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (pool_id) REFERENCES proxy_pools(id) ON DELETE SET NULL
);

-- 5. 套餐模板
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_quota INTEGER NOT NULL DEFAULT 0,
  call_limit INTEGER NOT NULL DEFAULT 0,
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  tpm_limit INTEGER NOT NULL DEFAULT 0,
  reset_period TEXT NOT NULL DEFAULT 'monthly',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 6. API 密钥
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan_id TEXT,
  quota REAL,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  token_limit INTEGER,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  call_limit INTEGER,
  call_used INTEGER NOT NULL DEFAULT 0,
  reset_period TEXT DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL
);

-- 7. 模型映射
CREATE TABLE IF NOT EXISTS model_maps (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  target_model TEXT NOT NULL,
  platform_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(alias, platform_id),
  FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE SET NULL
);

-- 8. 平台模型（自动发现）
CREATE TABLE IF NOT EXISTS platform_models (
  id TEXT PRIMARY KEY,
  platform_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  owned_by TEXT,
  model_name TEXT,
  type TEXT NOT NULL DEFAULT 'chat',
  source TEXT NOT NULL DEFAULT 'auto',
  enabled INTEGER NOT NULL DEFAULT 1,
  fetched_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(platform_id, model_id),
  FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE
);

-- 9. 请求日志
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  key_id TEXT,
  key_name TEXT,
  platform_id TEXT,
  proxy_id TEXT,
  model TEXT NOT NULL,
  endpoint TEXT,
  method TEXT,
  status INTEGER NOT NULL,
  latency INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  ttft INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  is_error INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE SET NULL,
  FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE SET NULL
);

-- 10. 每日统计（30天前自动归档）
CREATE TABLE IF NOT EXISTS daily_stats (
  id TEXT PRIMARY KEY,
  date INTEGER NOT NULL,
  key_id TEXT,
  key_name TEXT,
  platform_id TEXT,
  platform_name TEXT,
  model TEXT NOT NULL,
  total_requests INTEGER NOT NULL DEFAULT 0,
  error_requests INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  total_completion_tokens INTEGER NOT NULL DEFAULT 0,
  avg_ttft REAL NOT NULL DEFAULT 0,
  avg_duration REAL NOT NULL DEFAULT 0,
  max_ttft INTEGER NOT NULL DEFAULT 0,
  max_duration INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(date, key_id, model)
);

-- 11. 系统配置
CREATE TABLE IF NOT EXISTS configs (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 12. 系统事件
CREATE TABLE IF NOT EXISTS system_events (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- 13. 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
);

-- 14. 请求模板
CREATE TABLE IF NOT EXISTS request_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  method TEXT NOT NULL DEFAULT 'POST',
  endpoint TEXT NOT NULL DEFAULT 'all',
  headers TEXT NOT NULL DEFAULT '{}',
  body_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- ================================================================
-- 索引
-- ================================================================

CREATE INDEX IF NOT EXISTS idx_platforms_enabled_status ON platforms(enabled, status);
CREATE INDEX IF NOT EXISTS idx_proxies_pool_enabled ON proxies(pool_id, enabled, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_api_keys_status_expires ON api_keys(status, expires_at);

-- 11. 系统 API 密钥（管理后台专用，不可用于 v1 代理）
CREATE TABLE IF NOT EXISTS system_api_keys (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_system_api_keys_key ON system_api_keys(key);

CREATE INDEX IF NOT EXISTS idx_platform_models_platform_id ON platform_models(platform_id);
CREATE INDEX IF NOT EXISTS idx_platform_models_model_id ON platform_models(model_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_key_id ON request_logs(key_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_platform_id ON request_logs(platform_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_key_created ON request_logs(key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_platform_created ON request_logs(platform_id, created_at);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_key_date ON daily_stats(key_id, date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_platform_date ON daily_stats(platform_id, date);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_level ON system_events(level);
CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at);

-- 新增列由 Python 部署脚本逐条执行并捕获 "duplicate column" 错误
-- 示例：ALTER TABLE platform_models ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
