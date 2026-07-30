-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "platforms" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "api_keys" TEXT NOT NULL DEFAULT '[]',
    "type" TEXT NOT NULL DEFAULT 'openai',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "rpm_limit" INTEGER,
    "tpm_limit" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "last_fail_at" INTEGER,
    "cooldown_end" INTEGER,
    "forward_headers" TEXT NOT NULL DEFAULT '[]',
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "proxy_pools" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "proxies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "pool_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "ban_count" INTEGER NOT NULL DEFAULT 0,
    "last_fail_at" INTEGER,
    "cooldown_end" INTEGER,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "token_quota" INTEGER NOT NULL DEFAULT 0,
    "call_limit" INTEGER NOT NULL DEFAULT 0,
    "rpm_limit" INTEGER NOT NULL DEFAULT 0,
    "tpm_limit" INTEGER NOT NULL DEFAULT 0,
    "reset_period" TEXT NOT NULL DEFAULT 'monthly',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan_id" TEXT,
    "quota" REAL,
    "used_tokens" INTEGER NOT NULL DEFAULT 0,
    "token_limit" INTEGER,
    "rpm_limit" INTEGER,
    "tpm_limit" INTEGER,
    "call_limit" INTEGER,
    "call_used" INTEGER NOT NULL DEFAULT 0,
    "reset_period" TEXT DEFAULT 'monthly',
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" INTEGER,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "system_api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" INTEGER,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "model_maps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alias" TEXT NOT NULL,
    "target_model" TEXT NOT NULL,
    "platform_id" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "platform_models" (
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
CREATE TABLE "request_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key_id" TEXT,
    "key_name" TEXT,
    "platform_id" TEXT,
    "proxy_id" TEXT,
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
    "error_message" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "daily_stats" (
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
    "avg_ttft" REAL NOT NULL DEFAULT 0,
    "avg_duration" REAL NOT NULL DEFAULT 0,
    "max_ttft" INTEGER NOT NULL DEFAULT 0,
    "max_duration" INTEGER NOT NULL DEFAULT 0,
    "created_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "system_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "admin_id" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "ip" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "request_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "endpoint" TEXT NOT NULL DEFAULT 'all',
    "headers" TEXT NOT NULL DEFAULT '{}',
    "body_template" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" INTEGER NOT NULL DEFAULT 0,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE INDEX "platforms_enabled_status_idx" ON "platforms"("enabled", "status");

-- CreateIndex
CREATE UNIQUE INDEX "proxy_pools_name_key" ON "proxy_pools"("name");

-- CreateIndex
CREATE INDEX "proxies_pool_id_enabled_status_idx" ON "proxies"("pool_id", "enabled", "status");

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_key" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX "api_keys_key_idx" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX "api_keys_status_expires_at_idx" ON "api_keys"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "system_api_keys_key_key" ON "system_api_keys"("key");

-- CreateIndex
CREATE INDEX "system_api_keys_key_idx" ON "system_api_keys"("key");

-- CreateIndex
CREATE UNIQUE INDEX "model_maps_alias_platform_id_key" ON "model_maps"("alias", "platform_id");

-- CreateIndex
CREATE INDEX "platform_models_platform_id_idx" ON "platform_models"("platform_id");

-- CreateIndex
CREATE INDEX "platform_models_model_id_idx" ON "platform_models"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_models_platform_id_model_id_key" ON "platform_models"("platform_id", "model_id");

-- CreateIndex
CREATE INDEX "request_logs_key_id_idx" ON "request_logs"("key_id");

-- CreateIndex
CREATE INDEX "request_logs_platform_id_idx" ON "request_logs"("platform_id");

-- CreateIndex
CREATE INDEX "request_logs_created_at_idx" ON "request_logs"("created_at");

-- CreateIndex
CREATE INDEX "request_logs_key_id_created_at_idx" ON "request_logs"("key_id", "created_at");

-- CreateIndex
CREATE INDEX "request_logs_platform_id_created_at_idx" ON "request_logs"("platform_id", "created_at");

-- CreateIndex
CREATE INDEX "daily_stats_date_idx" ON "daily_stats"("date");

-- CreateIndex
CREATE INDEX "daily_stats_key_id_date_idx" ON "daily_stats"("key_id", "date");

-- CreateIndex
CREATE INDEX "daily_stats_platform_id_date_idx" ON "daily_stats"("platform_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_stats_date_key_id_model_key" ON "daily_stats"("date", "key_id", "model");

-- CreateIndex
CREATE UNIQUE INDEX "configs_key_key" ON "configs"("key");

-- CreateIndex
CREATE INDEX "system_events_level_idx" ON "system_events"("level");

-- CreateIndex
CREATE INDEX "system_events_created_at_idx" ON "system_events"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_idx" ON "audit_logs"("admin_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
