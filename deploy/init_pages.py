#!/usr/bin/env python3
"""
Pages 项目创建 + 绑定配置 + Secrets 设置

环境变量：
  CLOUDFLARE_ACCOUNT_ID  — Cloudflare 账户 ID
  CLOUDFLARE_API_TOKEN   — Cloudflare API Token（Edit 权限）
  PAGES_PROJECT          — Pages 项目名称（默认 fiammetta-watcher）
  D1_ID                  — D1 数据库 UUID（从 init_d1.py 获取）
  KV_ID                  — KV 命名空间 ID（从 init_kv.py 获取）
  ADMIN_USERNAME         — 管理员用户名（默认 admin）
  ADMIN_PASSWORD         — 管理员密码（必需）
  JWT_SECRET             — JWT 密钥（留空则自动生成）
  DATABASE_URL           — 数据库连接 URL（仅 PG/MySQL 时自动设置为 Pages Secret）

此脚本执行以下操作：
  1. 创建 Pages 项目（已存在则跳过）
  2. 配置 D1 绑定
  3. 配置 KV 绑定
  4. 设置 Pages Secrets（ADMIN_USERNAME、ADMIN_PASSWORD、JWT_SECRET）
  5. 当 DATABASE_URL 为 PostgreSQL/MySQL 时，自动设置为 Pages Secret
"""
import os
import sys
import secrets
import requests

# ==================== 配置 ====================

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
PAGES_PROJECT = os.environ.get("PAGES_PROJECT", "fiammetta-watcher")
D1_ID = os.environ.get("D1_ID", "")
KV_ID = os.environ.get("KV_ID", "")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
JWT_SECRET = os.environ.get("JWT_SECRET", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "")
WORKER_NAME = os.environ.get("WORKER_NAME", "fiammetta_worker")

API_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
HEADERS = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json",
}


def fail(msg: str):
    print(f"❌ {msg}")
    sys.exit(1)


def is_pg_or_mysql(url: str) -> bool:
    """检查 DATABASE_URL 是否为 PostgreSQL 或 MySQL"""
    return (
        url.startswith("postgresql://")
        or url.startswith("postgres://")
        or url.startswith("mysql://")
        or url.startswith("mysqls://")
    )


def api_request(method: str, path: str, json_data=None) -> dict:
    """发送 API 请求并返回解析后的 JSON"""
    url = f"{API_BASE}{path}"
    resp = requests.request(method, url, headers=HEADERS, json=json_data)
    try:
        return resp.json()
    except Exception:
        fail(f"API 请求失败: {method} {path} (HTTP {resp.status_code})")
        return {}  # unreachable, fail() exits


def main():
    global JWT_SECRET
    # 校验必需环境变量
    if not ACCOUNT_ID:
        fail("未设置 CLOUDFLARE_ACCOUNT_ID")
    if not API_TOKEN:
        fail("未设置 CLOUDFLARE_API_TOKEN")
    if not D1_ID:
        fail("未设置 D1_ID（请先运行 init_d1.py）")
    if not KV_ID:
        fail("未设置 KV_ID（请先运行 init_kv.py）")
    if not ADMIN_PASSWORD:
        fail("未设置 ADMIN_PASSWORD")

    # 自动生成 JWT_SECRET（如果未提供）
    if not JWT_SECRET:
        JWT_SECRET = secrets.token_urlsafe(32)
        print(f"🔑 已自动生成 JWT_SECRET")

    # ========== 1. 创建 Pages 项目（已存在则跳过） ==========
    print(f"📦 检查 Pages 项目: {PAGES_PROJECT}")
    data = api_request("GET", f"/pages/projects/{PAGES_PROJECT}")

    if data.get("success"):
        print(f"  ✅ Pages 项目已存在")
    else:
        print(f"  📦 创建 Pages 项目: {PAGES_PROJECT}")
        data = api_request("POST", "/pages/projects", {
            "name": PAGES_PROJECT,
            "production_branch": "main",
        })
        if data.get("success"):
            print(f"  ✅ Pages 项目已创建")
        else:
            msg = data.get("errors", [{}])[0].get("message", "未知")
            fail(f"Pages 项目创建失败: {msg}")

    # ========== 2. 配置 D1 绑定 ==========
    print(f"🔗 配置 D1 绑定: {D1_ID}")
    data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
        "deployment_configs": {
            "production": {
                "d1_databases": {
                    "DB": {"id": D1_ID}
                }
            }
        }
    })
    if data.get("success"):
        print(f"  ✅ D1 绑定成功")
    else:
        msg = data.get("errors", [{}])[0].get("message", "未知")
        fail(f"D1 绑定失败: {msg}")

    # ========== 3. 配置兼容性标志（nodejs_compat） ==========
    print(f"⚙️ 配置兼容性标志: nodejs_compat")
    data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
        "deployment_configs": {
            "production": {
                "compatibility_flags": ["nodejs_compat"]
            }
        }
    })
    if data.get("success"):
        print(f"  ✅ 兼容性标志设置成功")
    else:
        msg = data.get("errors", [{}])[0].get("message", "未知")
        print(f"  ⚠️ 兼容性标志设置失败（可能已存在）: {msg}")

    # ========== 4. 配置 KV 绑定 ==========
    print(f"🔗 配置 KV 绑定: {KV_ID}")
    data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
        "deployment_configs": {
            "production": {
                "kv_namespaces": {
                    "KV": {"namespace_id": KV_ID}
                }
            }
        }
    })
    if data.get("success"):
        print(f"  ✅ KV 绑定成功")
    else:
        msg = data.get("errors", [{}])[0].get("message", "未知")
        fail(f"KV 绑定失败: {msg}")

    # ========== 5. 配置 Service Binding（Worker 内网调用） ==========
    print(f"🔗 配置 Service Binding: {WORKER_NAME}")
    data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
        "deployment_configs": {
            "production": {
                "services": {
                    "WORKER": {
                        "service": WORKER_NAME,
                        "environment": "production"
                    }
                }
            }
        }
    })
    if data.get("success"):
        print(f"  ✅ Service Binding 设置成功")
    else:
        msg = data.get("errors", [{}])[0].get("message", "未知")
        print(f"  ⚠️ Service Binding 设置失败: {msg}")

    # ========== 6. 设置 Pages Secrets ==========
    secrets_to_set = {
        "ADMIN_USERNAME": ADMIN_USERNAME,
        "ADMIN_PASSWORD": ADMIN_PASSWORD,
        "JWT_SECRET": JWT_SECRET,
    }

    # 仅当 DATABASE_URL 为 PostgreSQL 或 MySQL 时才设置为 Secret（D1 不需要）
    if DATABASE_URL and is_pg_or_mysql(DATABASE_URL):
        secrets_to_set["DATABASE_URL"] = DATABASE_URL
        print(f"📦 检测到外部数据库，将设置 DATABASE_URL Secret")
    elif DATABASE_URL:
        print(f"📦 DATABASE_URL 为 D1/SQLite 格式，跳过 Secret 设置（D1 通过 binding 连接）")
    else:
        print(f"📦 未设置 DATABASE_URL，使用默认 D1 数据库")

    import subprocess
    for key, value in secrets_to_set.items():
        print(f"🔐 设置 Secret: {key}")
        # 使用 wrangler CLI 设置 secret（通过 stdin 传递值）
        result = subprocess.run(
            [
                "npx", "wrangler", "pages", "secret", "put", key,
                "--project-name", PAGES_PROJECT,
                "--env", "production",
            ],
            input=value.encode(),
            capture_output=True,
            timeout=30,
        )
        if result.returncode == 0:
            print(f"  ✅ {key} 已设置")
        else:
            err = result.stderr.decode().strip()
            fail(f"Secret {key} 设置失败: {err}")

    print(f"\n🎉 Pages 配置完成: {PAGES_PROJECT}")


if __name__ == "__main__":
    main()
