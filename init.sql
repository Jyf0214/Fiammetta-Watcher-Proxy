-- CreateTable
CREATE TABLE IF NOT EXISTS "admins" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "platforms" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_keys" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'openai',
    "types" TEXT NOT NULL DEFAULT '[]',
    "preset_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "rpm_limit" INTEGER,
    "tpm_limit" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "last_fail_at" INTEGER,
    "cooldown_end" INTEGER,
    "forward_headers" TEXT NOT NULL,
    "inject_stream_options" BOOLEAN NOT NULL DEFAULT true,
    "whitelisted" BOOLEAN NOT NULL DEFAULT false,
    "reuse_user_agent" BOOLEAN NOT NULL DEFAULT false,
    "custom_user_agent" TEXT,
    "extra_headers" TEXT NOT NULL DEFAULT '{}',
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "used_tokens" BIGINT NOT NULL DEFAULT 0,
    "token_limit" INTEGER,
    "rpm_limit" INTEGER,
    "tpm_limit" INTEGER,
    "call_limit" INTEGER,
    "call_used" INTEGER NOT NULL DEFAULT 0,
    "reset_period" TEXT DEFAULT 'monthly',
    "allowed_ips" TEXT,
    "allowed_models" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" INTEGER,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "system_api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" INTEGER,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "platform_models" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "owned_by" TEXT,
    "model_name" TEXT,
    "type" TEXT NOT NULL DEFAULT 'chat',
    "source" TEXT NOT NULL DEFAULT 'auto',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fetched_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "request_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key_id" TEXT,
    "key_name" TEXT,
    "platform_id" TEXT,
    "model" TEXT NOT NULL,
    "endpoint" TEXT,
    "method" TEXT,
    "status" INTEGER NOT NULL,
    "latency" INTEGER NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "ttft" INTEGER NOT NULL DEFAULT 0,
    "cost" REAL NOT NULL DEFAULT 0,
    "is_error" BOOLEAN NOT NULL DEFAULT false,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "node_name" TEXT,
    "error_message" TEXT,
    "proxy_url" TEXT,
    "has_reasoning" BOOLEAN NOT NULL DEFAULT false,
    "created_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "daily_stats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" INTEGER NOT NULL,
    "key_id" TEXT,
    "key_name" TEXT,
    "platform_id" TEXT,
    "platform_name" TEXT,
    "model" TEXT NOT NULL,
    "total_requests" INTEGER NOT NULL DEFAULT 0,
    "error_requests" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_cost" REAL NOT NULL DEFAULT 0,
    "avg_ttft" REAL NOT NULL DEFAULT 0,
    "avg_duration" REAL NOT NULL DEFAULT 0,
    "avg_tps" REAL NOT NULL DEFAULT 0,
    "max_ttft" INTEGER NOT NULL DEFAULT 0,
    "max_duration" INTEGER NOT NULL DEFAULT 0,
    "max_tps" REAL NOT NULL DEFAULT 0,
    "created_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "admin_id" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "ip" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "platforms_enabled_status_idx" ON "platforms"("enabled", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_key" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "api_keys_key_idx" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "api_keys_status_expires_at_idx" ON "api_keys"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "system_api_keys_key_key" ON "system_api_keys"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "system_api_keys_key_idx" ON "system_api_keys"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "platform_models_platform_id_idx" ON "platform_models"("platform_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "platform_models_model_id_idx" ON "platform_models"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "platform_models_platform_id_model_id_key" ON "platform_models"("platform_id", "model_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "request_logs_created_at_idx" ON "request_logs"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "request_logs_key_id_created_at_idx" ON "request_logs"("key_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "request_logs_platform_id_created_at_idx" ON "request_logs"("platform_id", "created_at");
CREATE INDEX IF NOT EXISTS "request_logs_proxy_url_created_at_idx" ON "request_logs"("proxy_url", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "daily_stats_date_idx" ON "daily_stats"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "daily_stats_key_id_date_idx" ON "daily_stats"("key_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "daily_stats_platform_id_date_idx" ON "daily_stats"("platform_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "daily_stats_date_key_id_model_key" ON "daily_stats"("date", "key_id", "model");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "configs_key_key" ON "configs"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_admin_id_idx" ON "audit_logs"("admin_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
-- 登录限流"先写后查"与预检按 action+ip+createdAt 查询，复合索引避免全表扫描
CREATE INDEX IF NOT EXISTS "audit_logs_action_ip_created_at_idx" ON "audit_logs"("action", "ip", "created_at");

-- CreateTable
-- 事件冷却去重（替换原进程内 lastSentAt Map，多实例一致）
CREATE TABLE IF NOT EXISTS "notification_cooldowns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event_key" TEXT NOT NULL,
    "last_sent_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
-- Key 用量配额一次性提醒（80/95/100 档位分别记录，重启/多实例不重发）
CREATE TABLE IF NOT EXISTS "quota_notified" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key_id" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "notified_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
-- 通知 / 备份发送历史（管理后台"发送历史"页数据源；保留 N 天由 cron 清理）
CREATE TABLE IF NOT EXISTS "notification_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel_id" TEXT NOT NULL,
    "channel_name" TEXT NOT NULL,
    "channel_type" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "http_status" INTEGER,
    "error" TEXT,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "sent_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "notification_cooldowns_event_key_key" ON "notification_cooldowns"("event_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "quota_notified_key_id_threshold_key" ON "quota_notified"("key_id", "threshold");
CREATE INDEX IF NOT EXISTS "quota_notified_key_id_idx" ON "quota_notified"("key_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notification_history_sent_at_idx" ON "notification_history"("sent_at");
CREATE INDEX IF NOT EXISTS "notification_history_channel_id_sent_at_idx" ON "notification_history"("channel_id", "sent_at");
CREATE INDEX IF NOT EXISTS "notification_history_event_sent_at_idx" ON "notification_history"("event", "sent_at");


-- CreateTable
CREATE TABLE IF NOT EXISTS "device_registrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "device_name" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "address" TEXT,
    "app_version" TEXT,
    "first_seen_at" INTEGER NOT NULL DEFAULT 0,
    "last_seen_at" INTEGER NOT NULL DEFAULT 0,
    "boot_count" INTEGER NOT NULL DEFAULT 0,
    -- 本机 Cloudflare Warp 启用开关（与 5 方言 schema 同步）
    "warp_enabled" INTEGER NOT NULL DEFAULT 0,
    "warp_enabled_at" INTEGER NOT NULL DEFAULT 0,
    "warp_enabled_by" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "device_registrations_device_name_key" ON "device_registrations"("device_name");
CREATE UNIQUE INDEX IF NOT EXISTS "device_registrations_uuid_key" ON "device_registrations"("uuid");
CREATE INDEX IF NOT EXISTS "device_registrations_platform_idx" ON "device_registrations"("platform");
CREATE INDEX IF NOT EXISTS "device_registrations_last_seen_at_idx" ON "device_registrations"("last_seen_at");
