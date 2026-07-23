#!/usr/bin/env python3
"""
D1 数据库创建 + Schema 初始化

环境变量：
  CLOUDFLARE_ACCOUNT_ID  — Cloudflare 账户 ID
  CLOUDFLARE_API_TOKEN   — Cloudflare API Token（Edit 权限）
  D1_NAME                — D1 数据库名称（默认 fiammetta_d1）
  INIT_SQL_PATH          — 建表 SQL 文件路径（默认 init.sql）

输出（GITHUB_OUTPUT）：
  D1_ID — 数据库 UUID
"""
import os
import sys
import json
import requests

# ==================== 配置 ====================

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
D1_NAME = os.environ.get("D1_NAME", "fiammetta_d1")
INIT_SQL_PATH = os.environ.get("INIT_SQL_PATH", "init.sql")

API_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
HEADERS = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json",
}


def fail(msg: str):
    print(f"❌ {msg}")
    sys.exit(1)


def check_response(resp: requests.Response, action: str):
    """检查 API 响应，失败则退出"""
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


def main():
    # 校验环境变量
    if not ACCOUNT_ID:
        fail("未设置 CLOUDFLARE_ACCOUNT_ID")
    if not API_TOKEN:
        fail("未设置 CLOUDFLARE_API_TOKEN")

    # 读取建表 SQL
    if not os.path.exists(INIT_SQL_PATH):
        fail(f"建表 SQL 文件不存在: {INIT_SQL_PATH}")
    with open(INIT_SQL_PATH, "r") as f:
        init_sql = f.read()
    if not init_sql.strip():
        fail(f"建表 SQL 文件为空: {INIT_SQL_PATH}")

    # ========== 1. 创建 D1 数据库（已存在则跳过） ==========
    print(f"📦 创建 D1 数据库: {D1_NAME}")
    resp = requests.post(f"{API_BASE}/d1/database", headers=HEADERS, json={"name": D1_NAME})
    data, code, msg = check_response(resp, "创建 D1")

    if data.get("success"):
        print(f"  ✅ D1 数据库已创建")
    elif code == 7502:
        print(f"  ✅ D1 数据库已存在，复用")
    else:
        fail(f"D1 创建失败: {msg}")

    # ========== 2. 查询数据库 ID ==========
    print(f"🔍 查询 D1 数据库 ID")
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

    # ========== 3. 执行建表 SQL（逐条执行，迁移语句容错） ==========
    print(f"📝 执行建表 SQL")

    # 按分号拆分语句，跳过空语句和纯注释
    statements = []
    for stmt in init_sql.split(";"):
        stripped = stmt.strip()
        if not stripped or stripped.startswith("--"):
            continue
        # 去掉行内注释
        lines = []
        for line in stripped.split("\n"):
            line_clean = line.split("--")[0].strip()
            if line_clean:
                lines.append(line_clean)
        clean = "\n".join(lines)
        if clean:
            statements.append(clean)

    created_count = 0
    skipped_count = 0
    failed_count = 0

    for i, stmt in enumerate(statements, 1):
        is_migration = stmt.upper().startswith("ALTER TABLE")
        resp = requests.post(
            f"{API_BASE}/d1/database/{d1_id}/query",
            headers=HEADERS,
            json={"sql": stmt},
        )
        data, code, msg = check_response(resp, f"语句 #{i}")

        if data.get("success"):
            created_count += 1
        elif is_migration:
            # 迁移语句（ALTER TABLE）失败说明列已存在，跳过
            skipped_count += 1
            print(f"  ⏭️  迁移跳过（可能已执行）: {msg}")
        else:
            failed_count += 1
            print(f"  ❌ 语句 #{i} 失败: {msg}")

    if failed_count > 0:
        fail(f"Schema 初始化失败：{failed_count} 条语句执行失败")
    print(f"  ✅ Schema 初始化完成（{created_count} 条执行，{skipped_count} 条跳过）")

    # ========== 4. 输出 D1_ID ==========
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"D1_ID={d1_id}\n")

    print(f"\n🎉 D1 初始化完成: {d1_id}")


if __name__ == "__main__":
    main()
