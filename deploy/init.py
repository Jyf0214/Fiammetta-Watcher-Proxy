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
DB_TYPE = os.environ.get("DB_TYPE", "")
RESOLVED_DB_TYPE = ""  # 保存 resolve_db_type() 的结果，供 run_post 使用（避免重新推断时丢失 DB_TYPE 环境变量）

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


def resolve_db_type() -> str:
    """根据 DB_TYPE 环境变量或 DATABASE_URL 推断数据库类型"""
    if DB_TYPE:
        return DB_TYPE
    if DATABASE_URL:
        if DATABASE_URL.startswith("mysql://") or DATABASE_URL.startswith("mysqls://"):
            return "tidb"
        if DATABASE_URL.startswith("postgresql://") or DATABASE_URL.startswith("postgres://"):
            return "pg"
    return "d1"


def update_db_type_in_config(path: str, label: str, db_type: str):
    """更新 wrangler 配置中的 DB_TYPE 值"""
    if not os.path.exists(path):
        print(f"  ⚠️ {label} 不存在，跳过")
        return
    with open(path, "r") as f:
        content = f.read()

    if path.endswith(".toml"):
        # TOML 格式：DB_TYPE = "d1"
        import re
        new_content = re.sub(
            r'(DB_TYPE\s*=\s*)"[^"]*"',
            f'\\1"{db_type}"',
            content,
        )
    elif path.endswith(".jsonc") or path.endswith(".json"):
        # JSONC 格式："DB_TYPE": "d1"
        import re
        new_content = re.sub(
            r'("DB_TYPE"\s*:\s*)"[^"]*"',
            f'\\1"{db_type}"',
            content,
        )
    else:
        return

    if new_content != content:
        with open(path, "w") as f:
            f.write(new_content)
        print(f"  ✅ {label} DB_TYPE 已更新为 \"{db_type}\"")
    else:
        print(f"  ✅ {label} DB_TYPE 已是 \"{db_type}\"")


def remove_d1_binding_from_worker_toml():
    """从 worker/wrangler.toml 中移除 D1/KV 绑定配置（外部数据库模式）"""
    if not os.path.exists(WRANGLER_TOML):
        print(f"  ⚠️ worker/wrangler.toml 不存在，跳过")
        return
    with open(WRANGLER_TOML, "r") as f:
        content = f.read()

    import re
    # 移除 [[d1_databases]] ... [[kv_namespaces]] 之前的所有 D1 块
    new_content = re.sub(
        r'\[\[d1_databases\]\].*?(?=\n\[|\Z)',
        '',
        content,
        flags=re.DOTALL,
    )
    # 移除 [[kv_namespaces]] ... [[triggers]] 之间的 KV 块（保留 triggers）
    new_content = re.sub(
        r'\[\[kv_namespaces\]\].*?(?=\n\[triggers\])',
        '',
        new_content,
        flags=re.DOTALL,
    )
    if new_content != content:
        with open(WRANGLER_TOML, "w") as f:
            f.write(new_content)
        print(f"  ✅ worker/wrangler.toml 已移除 D1/KV 绑定")
    else:
        print(f"  ✅ worker/wrangler.toml 无 D1/KV 绑定需要移除")


def run_pre(d1_id: str, kv_id: str):
    replace_placeholders(WRANGLER_TOML, "worker/wrangler.toml", d1_id, kv_id)
    replace_placeholders(WRANGLER_JSONC, "wrangler.jsonc", d1_id, kv_id)

    print(f"\n🔧 数据库类型: {RESOLVED_DB_TYPE}")

    update_db_type_in_config(WRANGLER_TOML, "worker/wrangler.toml", RESOLVED_DB_TYPE)
    update_db_type_in_config(WRANGLER_JSONC, "wrangler.jsonc", RESOLVED_DB_TYPE)

    # Worker 始终保留 D1 绑定（createDb 根据 DB_TYPE 选择适配器，env.DB 仅 D1 模式使用）
    print(f"🔧 Worker D1/KV 绑定保留（DB_TYPE={RESOLVED_DB_TYPE}）")


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

    # 使用 pre 阶段保存的 resolved_type（避免重新推断时丢失 DB_TYPE 环境变量）
    resolved_type = RESOLVED_DB_TYPE or resolve_db_type()
    print(f"🔧 使用数据库类型: {resolved_type}")

    if resolved_type == "d1":
        # D1 模式：绑定 D1 + 兼容性标志
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
    else:
        # 外部数据库模式：解绑 D1，避免 Pages 误连 D1
        print(f"🔗 外部数据库模式（{resolved_type}）：解绑 D1")
        data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
            "deployment_configs": {
                "production": {
                    "d1_databases": {},
                    "compatibility_flags": ["nodejs_compat"],
                }
            }
        })
        if not data.get("success"):
            fail(f"D1 解绑失败: {data.get('errors', [{}])[0].get('message', '未知')}")
        print(f"  ✅ D1 已解绑 + 兼容性标志成功")

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

    # Pages 环境变量（DB_TYPE）由 post-deploy 步骤在 wrangler pages deploy 之后设置
    # 不能在此处设置：wrangler pages deploy 会用 wrangler.jsonc 的 vars 覆盖 API 设置值

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


def run_post_deploy():
    """部署后设置 Pages 环境变量（必须在 wrangler pages deploy 之后运行）"""
    resolved_type = RESOLVED_DB_TYPE or resolve_db_type()

    print(f"\n{'='*50}")
    print(f"📦 设置 Pages 环境变量（post-deploy）")
    print(f"{'='*50}")

    pages_vars = {"DB_TYPE": resolved_type}
    print(f"🔗 设置 Pages vars: {pages_vars}")
    data = api_request("PATCH", f"/pages/projects/{PAGES_PROJECT}", {
        "deployment_configs": {
            "production": {
                "vars": pages_vars,
            }
        }
    })
    if not data.get("success"):
        fail(f"Pages 环境变量配置失败: {data.get('errors', [{}])[0].get('message', '未知')}")
    print(f"  ✅ Pages 环境变量已设置: {pages_vars}")


# ==================== 入口 ====================

def run_check():
    """部署前检查：Schema 文件 + 生成产物 + 环境变量配置"""
    print(f"\n{'='*50}")
    print(f"🔍 检查 Prisma 多方言配置")
    print(f"{'='*50}")

    errors = []

    # 1. 检查三个方言 Schema 文件
    schemas = [
        ("D1", "prisma/schema.d1.prisma"),
        ("MySQL", "prisma/schema.mysql.prisma"),
        ("PostgreSQL", "prisma/schema.pg.prisma"),
    ]
    for name, path in schemas:
        full = os.path.join(PROJECT_ROOT, path)
        if os.path.exists(full):
            print(f"  ✅ {name} Schema: {path}")
        else:
            print(f"  ❌ {name} Schema 缺失: {path}")
            errors.append(f"Schema 缺失: {path}")

    # 2. 检查生成的 Client 目录
    generated_dirs = [
        ("D1", "src/generated/d1"),
        ("MySQL", "src/generated/mysql"),
        ("PostgreSQL", "src/generated/pg"),
    ]
    for name, dirpath in generated_dirs:
        client_file = os.path.join(PROJECT_ROOT, dirpath, "client.ts")
        if os.path.exists(client_file):
            print(f"  ✅ {name} Client: {dirpath}/client.ts")
        else:
            print(f"  ❌ {name} Client 缺失: {dirpath}/client.ts")
            errors.append(f"Client 缺失: {dirpath}")

    # 3. 检查 DB_TYPE 在 wrangler 配置中
    for config_path, label in [
        ("worker/wrangler.toml", "Worker"),
        ("wrangler.jsonc", "Pages"),
    ]:
        full = os.path.join(PROJECT_ROOT, config_path)
        if not os.path.exists(full):
            print(f"  ⚠️ {label} 配置不存在: {config_path}")
            continue
        with open(full, "r") as f:
            content = f.read()
        if "DB_TYPE" in content:
            print(f"  ✅ {label} 已配置 DB_TYPE: {config_path}")
        else:
            print(f"  ❌ {label} 缺少 DB_TYPE: {config_path}")
            errors.append(f"DB_TYPE 缺失: {config_path}")

    # 汇总
    print(f"\n{'='*50}")
    if errors:
        print(f"❌ 检查失败：{len(errors)} 项问题")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print(f"✅ 全部检查通过")


def main():
    phase = sys.argv[1] if len(sys.argv) > 1 else ""
    if phase not in ("pre", "post", "post-deploy", "check"):
        fail(f"用法: python3 deploy/init.py [pre|post|post-deploy|check]")

    if phase == "check":
        run_check()
        return

    if phase == "post-deploy":
        run_post_deploy()
        return

    # check 阶段不需要 requests，延迟导入
    import requests as _requests  # noqa: F811
    globals()["requests"] = _requests

    if not ACCOUNT_ID:
        fail("未设置 CLOUDFLARE_ACCOUNT_ID")
    if not API_TOKEN:
        fail("未设置 CLOUDFLARE_API_TOKEN")

    # 推断数据库类型（pre/post 都需要）
    resolved_type = resolve_db_type()

    d1_id = os.environ.get("D1_ID", "")
    kv_id = os.environ.get("KV_ID", "")

    if phase == "pre":
        # 始终创建 D1（Worker 需要 D1 binding，createDb 根据 DB_TYPE 选择适配器）
        d1_id = init_d1()
        kv_id = init_kv()
        run_pre(d1_id, kv_id)
    elif phase == "post":
        # D1 模式需要 d1_id；外部数据库模式不需要
        if resolved_type == "d1" and not d1_id:
            fail("D1 模式下 post 阶段需要 D1_ID 环境变量")
        if not kv_id:
            fail("post 阶段需要 KV_ID 环境变量")
        run_post(d1_id, kv_id)

    print(f"\n🎉 {phase} 阶段完成")


if __name__ == "__main__":
    main()
