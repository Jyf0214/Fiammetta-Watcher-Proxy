#!/usr/bin/env python3
"""
KV 命名空间创建

环境变量：
  CLOUDFLARE_ACCOUNT_ID  — Cloudflare 账户 ID
  CLOUDFLARE_API_TOKEN   — Cloudflare API Token（Edit 权限）
  KV_NAME                — KV 命名空间名称（默认 fiammetta-proxy）

输出（GITHUB_OUTPUT）：
  KV_ID — KV 命名空间 ID
"""
import os
import sys
import requests

# ==================== 配置 ====================

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
KV_NAME = os.environ.get("KV_NAME", "fiammetta-proxy")

API_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
HEADERS = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json",
}


def fail(msg: str):
    print(f"❌ {msg}")
    sys.exit(1)


def main():
    # 检测数据库类型：非 D1/SQLite 时跳过 KV 初始化
    database_url = os.environ.get("DATABASE_URL", "")
    if database_url.startswith("mysql://") or database_url.startswith("mysqls://"):
        print("⏭️  检测到 MySQL 数据库，跳过 KV 初始化")
        return
    if database_url.startswith("postgresql://") or database_url.startswith("postgres://"):
        print("⏭️  检测到 PostgreSQL 数据库，跳过 KV 初始化")
        return

    if not ACCOUNT_ID:
        fail("未设置 CLOUDFLARE_ACCOUNT_ID")
    if not API_TOKEN:
        fail("未设置 CLOUDFLARE_API_TOKEN")

    # ========== 1. 查找已有 KV 命名空间 ==========
    print(f"🔍 查找 KV 命名空间: {KV_NAME}")
    resp = requests.get(f"{API_BASE}/storage/kv/namespaces", headers=HEADERS)
    try:
        data = resp.json()
    except Exception:
        fail(f"KV 查询失败: HTTP {resp.status_code}")

    if not data.get("success"):
        fail(f"KV 查询失败: {data.get('errors', [{}])[0].get('message', '未知')}")

    kv_id = None
    for ns in data.get("result", []):
        if ns.get("title") == KV_NAME:
            kv_id = ns.get("id")
            break

    # ========== 2. 已存在则复用 ==========
    if kv_id:
        print(f"  ✅ 复用已有 KV 命名空间: {kv_id}")
    else:
        # ========== 3. 创建新的 KV 命名空间 ==========
        print(f"📦 创建 KV 命名空间: {KV_NAME}")
        resp = requests.post(
            f"{API_BASE}/storage/kv/namespaces",
            headers=HEADERS,
            json={"title": KV_NAME},
        )
        try:
            data = resp.json()
        except Exception:
            fail(f"KV 创建失败: HTTP {resp.status_code}")

        if data.get("success"):
            kv_id = data["result"]["id"]
            print(f"  ✅ KV 命名空间已创建: {kv_id}")
        else:
            msg = data.get("errors", [{}])[0].get("message", "未知")
            fail(f"KV 创建失败: {msg}")

    # ========== 4. 输出 KV_ID ==========
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"KV_ID={kv_id}\n")

    print(f"\n🎉 KV 初始化完成: {kv_id}")


if __name__ == "__main__":
    main()
