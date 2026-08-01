#!/usr/bin/env python3
"""
Cloudflare 资源统一初始化脚本 (严谨修复版)

用法：
  python3 deploy/init.py pre          — 部署前：创建 D1/KV/Hyperdrive + 替换配置文件占位符
  python3 deploy/init.py post         — 部署后：创建 Pages + 绑定 Secrets
  python3 deploy/init.py post-deploy  — 部署后：统一同步 Pages & Worker 的绑定与环境变量
  python3 deploy/init.py check        — 本地/CI 检查：校验 Schema 与 Client 生成产物
"""
import os
import sys
import re
import json
import secrets
import subprocess
from urllib.parse import urlparse

# ==================== 环境变量配置 ====================

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
D1_NAME = os.environ.get("D1_NAME", "fiammetta_d1")
KV_NAME = os.environ.get("KV_NAME", "fiammetta-proxy")
HYPERDRIVE_NAME = os.environ.get("HYPERDRIVE_NAME", "fiammetta-hyperdrive")
PAGES_PROJECT = os.environ.get("PAGES_PROJECT", "fiammetta-watcher")
WORKER_NAME = os.environ.get("WORKER_NAME", "fiammetta_worker")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
JWT_SECRET = os.environ.get("JWT_SECRET", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
INIT_SQL_PATH = os.environ.get("INIT_SQL_PATH", "init.sql")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPT_DIR, "..")
WRANGLER_TOML = os.path.join(PROJECT_ROOT, "worker", "wrangler.toml")
WRANGLER_JSONC = os.path.join(PROJECT_ROOT, "wrangler.jsonc")

# ==================== 工具函数 ====================

def fail(msg: str):
    print(f"✗ {msg}")
    sys.exit(1)


def get_db_type() -> str:
    """精准推断 DB_TYPE：显式设置优先 > 根据 DATABASE_URL 推断 > 默认 d1"""
    env_type = os.environ.get("DB_TYPE", "").strip().lower()
    if env_type:
        return env_type
    if DATABASE_URL:
        if DATABASE_URL.startswith(("mysql://", "mysqls://")):
            return "tidb"
        if DATABASE_URL.startswith("mariadb://"):
            fail("Cloudflare 平台不支持 MariaDB/纯 MySQL（mariadb 驱动走 TCP，workerd 运行时不可用），请使用 d1/tidb/pg")
        if DATABASE_URL.startswith(("postgresql://", "postgres://")):
            return "pg"
    return "d1"


def cf_api(method: str, path: str, json_data=None, ok_codes: list = None) -> tuple:
    """
    严谨的 Cloudflare API 请求助手
    返回 tuple: (response_data, error_code, error_message)
    - 成功时 error_code 为 0
    - 如果失败且 error_code 属于允许的 ok_codes (如表/项目已存在)，返回 code 供外层判断
    - 遇到未预期的错误，直接 fail() 终止程序，决不静默吞错误
    """
    import requests
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}{path}"
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.request(method, url, headers=headers, json=json_data)
        data = resp.json()
    except Exception as e:
        fail(f"API 网络请求失败 [{method} {path}]: {e}")

    if data.get("success"):
        return data, 0, ""

    errors = data.get("errors", [])
    code = errors[0].get("code", 0) if errors else 0
    msg = errors[0].get("message", "未知错误") if errors else "未知错误"

    if ok_codes and code in ok_codes:
        return data, code, msg

    fail(f"API 请求失败 [{method} {path}]: {msg} (错误码 {code})")
    return {}, code, msg


def clean_sql_statements(sql_content: str) -> list:
    """安全清洗 SQL，按行处理注释，避免误切字符串内部的 '--' 导致语句断行破坏"""
    statements = []
    raw_stmts = sql_content.split(";")
    for raw in raw_stmts:
        lines = []
        for line in raw.split("\n"):
            stripped = line.strip()
            # 过滤独立的单行注释和空行
            if not stripped or stripped.startswith("--"):
                continue
            # 处理行尾注释（仅当 -- 前有空格时才判定为注释，防止切断字符串）
            if " --" in line:
                line = line.split(" --")[0]
            lines.append(line.rstrip())
        stmt = "\n".join(lines).strip()
        if stmt:
            statements.append(stmt)
    return statements


def output_github(key: str, value: str):
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output and value:
        with open(github_output, "a", encoding="utf-8") as f:
            f.write(f"{key}={value}\n")


def update_config_files(d1_id: str, kv_id: str, hyperdrive_id: str, db_type: str):
    """更新 wrangler.toml 与 wrangler.jsonc 中的占位符与 DB_TYPE (使用 MULTILINE 避免跨行破坏)"""
    replacements = {
        "placeholder-d1-id": d1_id,
        "placeholder-kv-id": kv_id,
        "placeholder-hyperdrive-id": hyperdrive_id,
    }
    for path in [WRANGLER_TOML, WRANGLER_JSONC]:
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()

        for k, v in replacements.items():
            if v:
                content = content.replace(k, v)

        # 当 hyperdrive_id 为空时，移除 Hyperdrive 绑定块（避免 wrangler 校验 placeholder UUID 失败）
        if not hyperdrive_id:
            if path.endswith(".toml"):
                content = re.sub(
                    r'\n*# Hyperdrive 绑定[^\n]*\n+\[\[hyperdrive\]\]\n.*?\n.*?\n',
                    '\n', content, flags=re.DOTALL,
                )
            else:
                content = re.sub(
                    r',?\s*"hyperdrive"\s*:\s*\[[\s\S]*?\]',
                    '', content,
                )

        # 仅替换独立的 DB_TYPE 行（精确匹配行首缩进与双引号/单引号配置）
        # 注意：不能用 f'\1' —— Python f-string 会把 \1 解释为 SOH 控制字符，破坏 TOML key
        if path.endswith(".toml"):
            content = re.sub(
                r'(^\s*DB_TYPE\s*=\s*)"[^"]*"',
                lambda m: m.group(1) + f'"{db_type}"',
                content, flags=re.MULTILINE,
            )
        else:
            content = re.sub(
                r'(^\s*"DB_TYPE"\s*:\s*)"[^"]*"',
                lambda m: m.group(1) + f'"{db_type}"',
                content, flags=re.MULTILINE,
            )

        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"  ✓ 已更新配置文件: {os.path.relpath(path, PROJECT_ROOT)}")


def set_secret(key: str, value: str, extra_args: list):
    """通过 Wrangler CLI 设置 Secret"""
    res = subprocess.run(
        ["npx", "wrangler"] + extra_args + [key],
        input=value.encode(), capture_output=True, timeout=60
    )
    if res.returncode == 0:
        print(f"  Secret 已设置: {key}")
    else:
        fail(f"Secret {key} 设置失败: {res.stderr.decode().strip()}")


# ==================== 阶段实现 ====================

def init_d1() -> str:
    print(f"\n初始化 D1 数据库: {D1_NAME}")
    cf_api("POST", "/d1/database", {"name": D1_NAME}, ok_codes=[7502])
    
    data, _, _ = cf_api("GET", "/d1/database?per_page=1000")
    dbs = data.get("result", [])
    d1_id = next((db["uuid"] for db in dbs if db.get("name") == D1_NAME), None)
    if not d1_id:
        fail(f"无法找到 D1 数据库 '{D1_NAME}'")
    print(f"  ✓ D1_ID: {d1_id}")

    # 安全执行 SQL 语句并严格校验返回值
    if os.path.exists(INIT_SQL_PATH):
        with open(INIT_SQL_PATH, "r", encoding="utf-8") as f:
            sql_content = f.read()
        statements = clean_sql_statements(sql_content)
        if statements:
            print(f"正在执行建表 SQL ({len(statements)} 条语句)...")
            success_count = 0
            skipped_count = 0
            failed_stmts = []

            for i, stmt in enumerate(statements, 1):
                res, code, msg = cf_api(
                    "POST", f"/d1/database/{d1_id}/query",
                    {"sql": stmt},
                    ok_codes=[7000, 7500, 7502]
                )
                if res.get("success"):
                    success_count += 1
                elif code in (7000, 7500, 7502) or "already exists" in msg.lower():
                    skipped_count += 1
                else:
                    failed_stmts.append((i, msg))
                    print(f"  ✗ 语句 #{i} 执行出错: {msg}")

            print(f"  ✓ Schema SQL 执行完成（成功 {success_count} 条，已存在跳过 {skipped_count} 条）")
            if failed_stmts:
                fail(f"D1 Schema 建表有 {len(failed_stmts)} 条 SQL 失败，中止部署！")

    migrate_platform_keys_d1(d1_id)

    output_github("D1_ID", d1_id)
    return d1_id


def migrate_platform_keys_d1(d1_id: str):
    """合并 platforms.api_key 主字段到 api_keys JSON 数组（删除双密钥格式前的数据迁移）

    幂等容错：
    - 全新库没有 api_key 列 → 查询报 no such column（7500）→ 跳过
    - 已迁移过的库同样跳过
    - 数据合并后执行 DROP COLUMN api_key，失败不影响部署（打印提示）
    """
    print("正在迁移平台密钥（合并 api_key → api_keys）...")

    res, code, msg = cf_api(
        "POST", f"/d1/database/{d1_id}/query",
        {"sql": "SELECT id, api_key, api_keys FROM platforms"},
        ok_codes=[7500],
    )
    if not res.get("success"):
        print("  - api_key 列不存在（全新库或已迁移），跳过合并")
        return

    results = res.get("result", [])
    rows = results[0].get("results", []) if results else []

    def normalize_keys(raw: str, legacy_key: str):
        """规范化平台密钥为命名对象数组；无有效密钥返回 None"""
        named = []
        if raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    for item in parsed:
                        if isinstance(item, str) and item.strip():
                            named.append({"name": f"密钥{len(named) + 1}", "key": item.strip()})
                        elif isinstance(item, dict) and isinstance(item.get("key"), str):
                            key = item["key"].strip()
                            if key:
                                entry = {
                                    "name": (item.get("name") or "").strip() or f"密钥{len(named) + 1}",
                                    "key": key,
                                }
                                if item.get("whitelisted") is True:
                                    entry["whitelisted"] = True
                                named.append(entry)
            except (ValueError, TypeError):
                pass
        if legacy_key and legacy_key.strip() and not any(n["key"] == legacy_key for n in named):
            named.insert(0, {"name": "主密钥", "key": legacy_key.strip()})
        if not named:
            return None
        return json.dumps(named, ensure_ascii=False)

    updated = 0
    for row in rows:
        raw = row.get("api_keys") or ""
        legacy_key = row.get("api_key") or ""
        new_raw = normalize_keys(raw, legacy_key)
        if new_raw is None or new_raw == raw:
            continue
        esc_key = new_raw.replace("'", "''")
        esc_id = str(row.get("id", "")).replace("'", "''")
        cf_api(
            "POST", f"/d1/database/{d1_id}/query",
            {"sql": f"UPDATE platforms SET api_keys = '{esc_key}' WHERE id = '{esc_id}'"},
        )
        updated += 1

    print(f"  ✓ 平台密钥合并完成（更新 {updated} 条）")

    res, code, msg = cf_api(
        "POST", f"/d1/database/{d1_id}/query",
        {"sql": "ALTER TABLE platforms DROP COLUMN api_key"},
        ok_codes=[7500],
    )
    if res.get("success"):
        print("  ✓ 已删除 api_key 列")
    elif code == 7500:
        print("  - api_key 列不存在（全新库），跳过删除")
    else:
        print(f"  ✗ DROP COLUMN api_key 失败: {msg}（不影响部署，请手动处理）")


def init_kv() -> str:
    print(f"\n初始化 KV 命名空间: {KV_NAME}")
    data, _, _ = cf_api("GET", "/storage/kv/namespaces")
    namespaces = data.get("result", [])
    kv_id = next((ns["id"] for ns in namespaces if ns.get("title") == KV_NAME), None)
    if not kv_id:
        res, _, _ = cf_api("POST", "/storage/kv/namespaces", {"title": KV_NAME})
        kv_id = res["result"]["id"]
    print(f"  ✓ KV_ID: {kv_id}")
    output_github("KV_ID", kv_id)
    return kv_id


def init_hyperdrive() -> str:
    print(f"\n初始化 Hyperdrive: {HYPERDRIVE_NAME}")
    if not DATABASE_URL:
        fail("Hyperdrive 模式需要 DATABASE_URL 环境变量")

    p = urlparse(DATABASE_URL)
    origin = {
        "scheme": p.scheme, "host": p.hostname or "", "port": p.port or 5432,
        "database": p.path.lstrip("/"), "user": p.username or "", "password": p.password or ""
    }
    data, _, _ = cf_api("GET", "/hyperdrive/configs")
    cfgs = data.get("result", [])
    hd_id = next((c["id"] for c in cfgs if c.get("name") == HYPERDRIVE_NAME), None)
    if not hd_id:
        res, _, _ = cf_api("POST", "/hyperdrive/configs", {"name": HYPERDRIVE_NAME, "origin": origin})
        hd_id = res["result"]["id"]
    print(f"  ✓ HYPERDRIVE_ID: {hd_id}")
    output_github("HYPERDRIVE_ID", hd_id)
    return hd_id


def sync_env_and_bindings(d1_id: str, kv_id: str, hyperdrive_id: str, db_type: str):
    """统一同步 Pages 的绑定与环境变量（Worker 变量由 wrangler.toml 在部署时自动生效）"""
    print(f"\n同步 Pages 部署配置 (DB_TYPE={db_type})...")

    db_vars = {"DB_TYPE": {"type": "plain_text", "value": db_type}}
    if db_type != "d1" and DATABASE_URL:
        db_vars["DATABASE_URL"] = {"type": "plain_text", "value": DATABASE_URL}
        if db_type == "tidb":
            db_vars["TIDB_URL"] = {"type": "plain_text", "value": DATABASE_URL}
        elif db_type in ("pg", "hyperdrive"):
            db_vars["PG_URL"] = {"type": "plain_text", "value": DATABASE_URL}

    # 同步 Pages 项目配置 (D1, KV, WORKER service, Hyperdrive, env_vars)
    prod_config = {
        "compatibility_flags": ["nodejs_compat"],
        "d1_databases": {"DB": {"id": d1_id}} if d1_id else {},
        "kv_namespaces": {"KV": {"namespace_id": kv_id}} if kv_id else {},
        "services": {"WORKER": {"service": WORKER_NAME, "environment": "production"}},
        "env_vars": db_vars,
    }
    if db_type == "hyperdrive" and hyperdrive_id:
        prod_config["hyperdrive_bindings"] = {"HYPERDRIVE": {"id": hyperdrive_id}}

    cf_api("PATCH", f"/pages/projects/{PAGES_PROJECT}", {"deployment_configs": {"production": prod_config}})
    print("  ✓ Pages 绑定与环境变量同步成功")

    # Worker Secret 同步（非 D1 外部数据库模式下需要设置 DATABASE_URL）
    print(f"\n同步 Worker Secret (DB_TYPE={db_type})...")
    if db_type != "d1" and DATABASE_URL:
        set_secret("DATABASE_URL", DATABASE_URL, ["secret", "put", "--config", WRANGLER_TOML, "--name", WORKER_NAME])
    else:
        print(f"   跳过 Worker DATABASE_URL Secret（DB_TYPE={db_type}，非外部数据库模式）")


def run_post(db_type: str):
    """设置 Pages 项目与 Secrets"""
    global JWT_SECRET
    print(f"\n配置 Pages 项目与 Secrets...")
    if not JWT_SECRET:
        JWT_SECRET = secrets.token_urlsafe(32)
        print("  已自动生成 JWT_SECRET")
    if not ADMIN_PASSWORD:
        fail("未设置 ADMIN_PASSWORD 环境变量")

    # 显式查询与创建，不靠误吞错误盲撞 API
    data, code, _ = cf_api("GET", f"/pages/projects/{PAGES_PROJECT}", ok_codes=[800001])
    if data.get("success"):
        print(f"  ✓ Pages 项目已存在: {PAGES_PROJECT}")
    else:
        cf_api("POST", "/pages/projects", {"name": PAGES_PROJECT, "production_branch": "main"})
        print(f"  ✓ Pages 项目创建成功: {PAGES_PROJECT}")

    secrets_dict = {
        "ADMIN_USERNAME": ADMIN_USERNAME,
        "ADMIN_PASSWORD": ADMIN_PASSWORD,
        "JWT_SECRET": JWT_SECRET,
    }
    if db_type != "d1" and DATABASE_URL:
        secrets_dict["DATABASE_URL"] = DATABASE_URL

    for k, v in secrets_dict.items():
        set_secret(k, v, ["pages", "secret", "put", "--project-name", PAGES_PROJECT, "--env", "production"])

    if db_type != "d1" and DATABASE_URL:
        set_secret("DATABASE_URL", DATABASE_URL, ["secret", "put", "--config", WRANGLER_TOML, "--name", WORKER_NAME])


def run_check():
    """部署前检查产物完整性"""
    print(f"\n校验 Prisma Schema 与 Client 生成产物...")
    errors = []
    for path in ["prisma/schema.d1.prisma", "prisma/schema.mysql.prisma", "prisma/schema.pg.prisma"]:
        if not os.path.exists(os.path.join(PROJECT_ROOT, path)):
            errors.append(f"Schema 缺失: {path}")

    for path in ["src/generated/d1/client.ts", "src/generated/mysql/client.ts", "src/generated/pg/client.ts"]:
        if not os.path.exists(os.path.join(PROJECT_ROOT, path)):
            errors.append(f"Client 缺失: {path}")

    if errors:
        for err in errors:
            print(f"  ✗ {err}")
        fail("部署前校验失败")
    print("  ✓ 全部产物校验通过")


# ==================== 程序主入口 ====================

def main():
    phase = sys.argv[1] if len(sys.argv) > 1 else ""
    if phase not in ("pre", "post", "post-deploy", "check"):
        fail("用法: python3 deploy/init.py [pre|post|post-deploy|check]")

    if phase == "check":
        run_check()
        return

    if not ACCOUNT_ID or not API_TOKEN:
        fail("缺少 CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_API_TOKEN 环境变量")

    db_type = get_db_type()
    d1_id = os.environ.get("D1_ID", "")
    kv_id = os.environ.get("KV_ID", "")
    hyperdrive_id = os.environ.get("HYPERDRIVE_ID", "")

    print(f"执行阶段: [{phase}] | 识别到的数据库类型: [{db_type}]")

    if phase == "pre":
        d1_id = init_d1()
        kv_id = init_kv()
        if db_type == "hyperdrive":
            hyperdrive_id = init_hyperdrive()
        update_config_files(d1_id, kv_id, hyperdrive_id, db_type)

    elif phase == "post":
        if not kv_id:
            fail("post 阶段需要 KV_ID 环境变量")
        run_post(db_type)

    elif phase == "post-deploy":
        sync_env_and_bindings(d1_id, kv_id, hyperdrive_id, db_type)

    print(f"\n✓ [{phase}] 阶段顺利完成！")


if __name__ == "__main__":
    main()