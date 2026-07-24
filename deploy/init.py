#!/usr/bin/env python3
"""
Cloudflare 资源统一初始化

用法：
  python3 deploy/init.py pre     — 部署前：创建 D1/KV + 替换配置占位符
  python3 deploy/init.py post    — 部署后：创建 Pages + 绑定 + Secrets

环境变量：
  CLOUDFLARE_ACCOUNT_ID  — Cloudflare 账户 ID
  CLOUDFLARE_API_TOKEN   — Cloudflare API Token（Edit 权限）
  D1_NAME                — D1 数据库名称（默认 fiammetta_d1）
  KV_NAME                — KV 命名空间名称（默认 fiammetta-proxy）
  PAGES_PROJECT          — Pages 项目名称（默认 fiammetta-watcher）
  WORKER_NAME            — Worker 名称（默认 fiammetta_worker）
  ADMIN_USERNAME         — 管理员用户名（默认 admin）
  ADMIN_PASSWORD         — 管理员密码（Pages 部署时必需）
  JWT_SECRET             — JWT 密钥（留空则自动生成）
  DATABASE_URL           — 外部数据库 URL（仅 PG/MySQL 时设置为 Secret）
  INIT_SQL_PATH          — 建表 SQL 文件路径（默认 init.sql）

输出（GITHUB_OUTPUT）：
  D1_ID — D1 数据库 UUID
  KV_ID — KV 命名空间 ID
"""
import os
import sys
import json
import secrets
import subprocess
import requests

# ==================== 配置 ====================

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
D1_NAME = os.environ.get("D1_NAME", "fiammetta_d1")
KV_NAME = os.environ.get("KV_NAME", "fiammetta-proxy")
PAGES_PROJECT = os.environ.get("PAGES_PROJECT", "fiammetta-watcher")
WORKER_NAME = os.environ.get("WORKER_NAME", "fiammetta_worker")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
JWT_SECRET = os.environ.get("JWT_SECRET", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "")
INIT_SQL_PATH = os.environ.get("INIT_SQL_PATH", "init.sql")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPT_DIR, "..")
WRANGLER_TOML = os.path.join(PROJECT_ROOT, "worker", "wrangler.toml")
WRANGLER_JSONC = os.path.join(PROJECT_ROOT, "wrangler.jsonc")

API_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
HEADERS = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json",
}


# ==================== 工具函数 ====================

def fail(msg: str):
    print(f"❌ {msg}")
    sys.exit(1)


def is_pg_or_mysql(url: str) -> bool:
    return (
        url.startswith("postgresql://")
        or url.startswith("postgres://")
        or url.startswith("mysql://")
        or url.startswith("mysqls://")
    )


def api_request(method: str, path: str, json_data=None) -> dict:
    url = f"{API_BASE}{path}"
    resp = requests.request(method, url, headers=HEADERS, json=json_data)
    try:
        return resp.json()
    except Exception:
        fail(f"API 请求失败: {method} {path} (HTTP {resp.status_code})")
        return {}


def check_response(resp, action: str):
    try:
        data = resp.json()
    except Exception:
        fail(f"{action}: 响应解析失败 (HTTP {resp.status_code})")
    if not data.get("success"):
        errors = data.get("errors", [])
        msg = errors[0].get("message", "未知错误") if errors else "未知错误"
        code = errors[0].get("code", 0) if errors else 0
        return data, code, msg
    return data, 0, ""


def output_github(key: str, value: str):
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"{key}={value}\n")


def replace_placeholders(path: str, label: str, d1_id: str, kv_id: str):
    if not os.path.exists(path):
        print(f"  ⚠️ {label} 不存在，跳过")
        return
    with open(path, "r") as f:
        content = f.read()
    content = content.replace("placeholder-d1-id", d1_id)
    content = content.replace("placeholder-kv-id", kv_id)
    with open(path, "w") as f:
        f.write(content)
    print(f"  ✅ {label} 已更新")


def set_secret(key: str, value: str, extra_args: list):
    """通过 wrangler CLI 设置 Secret，extra_args 需包含完整的子命令路径"""
    print(f"🔐 设置 Secret: {key}")
    result = subprocess.run(
        ["npx", "wrangler"] + extra_args + [key],
        input=value.encode(),
        capture_output=True,
        timeout=60,
    )
    if result.returncode == 0:
        print(f"  ✅ {key} 已设置")
    else:
        err = result.stderr.decode().strip()
        fail(f"Secret {key} 设置失败: {err}")


# ==================== 阶段一：部署前 ====================

def init_d1() -> str:
    print(f"\n{'='*50}")
    print(f"📦 初始化 D1 数据库: {D1_NAME}")
    print(f"{'='*50}")

    resp = requests.post(f"{API_BASE}/d1/database", headers=HEADERS, json={"name": D1_NAME})
    data, code, msg = check_response(resp, "创建 D1")
    if data.get("success"):
        print(f"  ✅ D1 数据库已创建")
    elif code == 7502:
        print(f"  ✅ D1 数据库已存在，复用")
    else:
        fail(f"D1 创建失败: {msg}")

    resp = requests.get(f"{API_BASE}/d1/database?per_page=1000", headers=HEADERS)
    data, _, msg = check_response(resp, "查询 D1")
    d1_id = None
    for db in data.get("result", []):
        if db.get("name") == D1_NAME:
            d1_id = db.get("uuid")
            break
    if not d1_id:
        fail(f"无法找到 D1 数据库 '{D1_NAME}'")
    print(f"  ✅ D1_ID: {d1_id}")

    if os.path.exists(INIT_SQL_PATH):
        with open(INIT_SQL_PATH, "r") as f:
            init_sql = f.read()
        if init_sql.strip():
            print(f"📝 执行建表 SQL")
            statements = []
            for stmt in init_sql.split(";"):
                stripped = stmt.strip()
                if not stripped:
                    continue
                lines = [line.split("--")[0].strip() for line in stripped.split("\n")]
                clean = "\n".join(l for l in lines if l)
                if clean:
                    statements.append(clean)

            created = skipped = failed = 0
            for i, stmt in enumerate(statements, 1):
                is_migration = stmt.upper().startswith("ALTER TABLE")
                resp = requests.post(
                    f"{API_BASE}/d1/database/{d1_id}/query",
                    headers=HEADERS,
                    json={"sql": stmt},
                )
                data, code, msg = check_response(resp, f"语句 #{i}")
                if data.get("success"):
                    created += 1
                elif is_migration:
                    skipped += 1
                else:
                    failed += 1
                    print(f"  ❌ 语句 #{i} 失败: {msg}")
            if failed > 0:
                fail(f"Schema 初始化失败：{failed} 条语句执行失败")
            print(f"  ✅ Schema 完成（{created} 执行，{skipped} 跳过）")
    else:
        print(f"  ⚠️ 建表 SQL 不存在: {INIT_SQL_PATH}，跳过")

    output_github("D1_ID", d1_id)
    return d1_id


def init_kv() -> str:
    print(f"\n{'='*50}")
    print(f"📦 初始化 KV 命名空间: {KV_NAME}")
    print(f"{'='*50}")

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

    if kv_id:
        print(f"  ✅ 复用已有 KV: {kv_id}")
    else:
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
            print(f"  ✅ KV 已创建: {kv_id}")
        else:
            msg = data.get("errors", [{}])[0].get("message", "未知")
            fail(f"KV 创建失败: {msg}")

    output_github("KV_ID", kv_id)
    return kv_id


def run_pre(d1_id: str, kv_id: str):
    replace_placeholders(WRANGLER_TOML, "worker/wrangler.toml", d1_id, kv_id)
    replace_placeholders(WRANGLER_JSONC, "wrangler.jsonc", d1_id, kv_id)


# ==================== 阶段二：部署后 ====================

def run_post(d1_id: str, kv_id: str):
    global JWT_SECRET

    print(f"\n{'='*50}")
    print(f"📦 配置 Pages + Secrets")
    print(f"{'='*50}")

    if not JWT_SECRET:
        JWT_SECRET = secrets.token_urlsafe(32)
        print(f"🔑 已自动生成 JWT_SECRET")

    if not ADMIN_PASSWORD:
        fail("未设置 ADMIN_PASSWORD")

    # 创建 Pages 项目
    print(f"📦 检查 Pages 项目: {PAGES_PROJECT}")
    data = api_request("GET", f"/pages/projects/{PAGES_PROJECT}")
    if data.get("success"):
        print(f"  ✅ Pages 项目已存在")
    else:
        data = api_request("POST", "/pages/projects", {
            "name": PAGES_PROJECT,
            "production_branch": "main",
        })
        if data.get("success"):
            print(f"  ✅ Pages 项目已创建")
        else:
            msg = data.get("errors", [{}])[0].get("message", "未知")
            fail(f"Pages 项目创建失败: {msg}")

    # 配置 D1 绑定 + 兼容性标志
    print(f"🔗 配置 D1 绑定")
    data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
        "deployment_configs": {
            "production": {
                "d1_databases": {"DB": {"id": d1_id}},
                "compatibility_flags": ["nodejs_compat"],
            }
        }
    })
    if not data.get("success"):
        fail(f"D1 绑定失败: {data.get('errors', [{}])[0].get('message', '未知')}")
    print(f"  ✅ D1 + 兼容性标志成功")

    # 配置 KV 绑定
    print(f"🔗 配置 KV 绑定")
    data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
        "deployment_configs": {
            "production": {
                "kv_namespaces": {"KV": {"namespace_id": kv_id}}
            }
        }
    })
    if not data.get("success"):
        fail(f"KV 绑定失败: {data.get('errors', [{}])[0].get('message', '未知')}")
    print(f"  ✅ KV 绑定成功")

    # 配置 Service Binding
    print(f"🔗 配置 Service Binding")
    data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
        "deployment_configs": {
            "production": {
                "services": {
                    "WORKER": {"service": WORKER_NAME, "environment": "production"}
                }
            }
        }
    })
    if not data.get("success"):
        fail(f"Service Binding 失败: {data.get('errors', [{}])[0].get('message', '未知')}")
    print(f"  ✅ Service Binding 成功")

    # 设置 Pages Secrets
    pages_secrets = {
        "ADMIN_USERNAME": ADMIN_USERNAME,
        "ADMIN_PASSWORD": ADMIN_PASSWORD,
        "JWT_SECRET": JWT_SECRET,
    }
    if DATABASE_URL and is_pg_or_mysql(DATABASE_URL):
        pages_secrets["DATABASE_URL"] = DATABASE_URL

    for key, value in pages_secrets.items():
        set_secret(key, value, [
            "pages", "secret", "put",
            "--project-name", PAGES_PROJECT,
            "--env", "production",
        ])

    # 设置 Worker Secrets（仅 PG/MySQL，Worker 已部署）
    if DATABASE_URL and is_pg_or_mysql(DATABASE_URL):
        print(f"\n🔗 设置 Worker Secret: DATABASE_URL")
        set_secret("DATABASE_URL", DATABASE_URL, [
            "secret", "put",
            "--config", WRANGLER_TOML,
            "--name", WORKER_NAME,
        ])

    print(f"\n🎉 Pages({PAGES_PROJECT}) + Secrets 配置完成")


# ==================== 入口 ====================

def main():
    if not ACCOUNT_ID:
        fail("未设置 CLOUDFLARE_ACCOUNT_ID")
    if not API_TOKEN:
        fail("未设置 CLOUDFLARE_API_TOKEN")

    phase = sys.argv[1] if len(sys.argv) > 1 else ""
    if phase not in ("pre", "post"):
        fail(f"用法: python3 deploy/init.py [pre|post]")

    d1_id = os.environ.get("D1_ID", "")
    kv_id = os.environ.get("KV_ID", "")

    if phase == "pre":
        d1_id = init_d1()
        kv_id = init_kv()
        run_pre(d1_id, kv_id)
    elif phase == "post":
        if not d1_id:
            fail("post 阶段需要 D1_ID 环境变量")
        if not kv_id:
            fail("post 阶段需要 KV_ID 环境变量")
        run_post(d1_id, kv_id)

    print(f"\n🎉 {phase} 阶段完成")


if __name__ == "__main__":
    main()
