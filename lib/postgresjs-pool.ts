/**
 * postgres.js → pg.Pool 兼容层
 *
 * postgres.js 是 Cloudflare Hyperdrive 推荐的 PostgreSQL 驱动，
 * 但 @prisma/adapter-pg 只接受 pg.Pool。
 *
 * 本文件将 postgres.js 包装为 pg.Pool 兼容接口，
 * 让 PrismaPg 适配器能使用 postgres.js 而非 pg。
 *
 * 关键：PrismaPg 的 queryRaw 会解构 { fields, rows }，
 * 所以 query() 必须返回包含 fields 的完整 pg.QueryResult 结构。
 */

import postgres from "postgres";

/** pg.QueryResult 兼容结构 */
interface PgQueryResult {
  rows: unknown[];
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
  command: string;
  oid: number;
}

/** 最小化 pg.Pool 兼容接口 */
interface MinimalPool {
  connect(): Promise<MinimalPoolClient>;
  end(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  options: { connectionString?: string };
}

interface MinimalPoolClient {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  release(): void;
}

/**
 * 从 SQL SELECT 语句中解析列名
 * Prisma 生成的查询都是显式列名（SELECT "col1", "col2"），不会用 *
 */
function parseColumnNames(sql: string): string[] {
  const selectMatch = sql.match(/SELECT\s+([\s\S]+?)\s+FROM/i);
  if (!selectMatch) return [];

  const colsStr = selectMatch[1];
  // 匹配 "column_name" 或 table."column" 或 alias."column"
  const colMatches = colsStr.matchAll(/"([^"]+)"(?=\s*(?:,|$|\s+(?:AS|FROM|WHERE|ORDER|GROUP|LIMIT|HAVING|UNION|INTERSECT|EXCEPT)))/gi);
  const names = Array.from(colMatches, (m) => m[1]);

  // 去重（DISTINCT 等场景）
  return [...new Set(names)];
}

/**
 * postgres.js Pool Client 兼容层
 * 将 postgres.js 的 tagged template API 适配为 pg 的 query(text, values) 接口
 */
class PostgresJsPoolClient implements MinimalPoolClient {
  private sql: ReturnType<typeof postgres>;

  constructor(sql: ReturnType<typeof postgres>) {
    this.sql = sql;
  }

  async query(text: string, values?: unknown[]): Promise<PgQueryResult> {
    const result = values && values.length > 0
      ? await this.sql.unsafe(text, values as any[])
      : await this.sql.unsafe(text);

    // 从 SQL 解析列名（Prisma 生成的都是显式列名）
    const columnNames = parseColumnNames(text);

    return {
      rows: result as unknown[],
      rowCount: (result as any).count ?? (result as unknown[]).length,
      fields: columnNames.map((name) => ({ name, dataTypeID: 0 })),
      command: "SELECT",
      oid: 0,
    };
  }

  release(): void {
    // postgres.js 不需要显式 release
  }
}

/**
 * postgres.js → pg.Pool 兼容包装器
 *
 * 使用方式：
 *   const pool = new PostgresJsPool(connectionString);
 *   const adapter = new PrismaPg(pool as any);
 */
export class PostgresJsPool implements MinimalPool {
  private sql: ReturnType<typeof postgres>;
  options: { connectionString?: string };

  constructor(connectionString: string) {
    this.options = { connectionString };
    this.sql = postgres(connectionString, {
      max: 5,              // Workers 限制 6 并发连接
      prepare: true,       // 启用 prepared statement 缓存（Hyperdrive 缓存需要）
      fetch_types: false,  // 减少延迟
    });
  }

  async connect(): Promise<PostgresJsPoolClient> {
    return new PostgresJsPoolClient(this.sql);
  }

  async end(): Promise<void> {
    await this.sql.end();
  }

  async query(text: string, values?: unknown[]): Promise<PgQueryResult> {
    const result = values && values.length > 0
      ? await this.sql.unsafe(text, values as any[])
      : await this.sql.unsafe(text);

    const columnNames = parseColumnNames(text);

    return {
      rows: result as unknown[],
      rowCount: (result as any).count ?? (result as unknown[]).length,
      fields: columnNames.map((name) => ({ name, dataTypeID: 0 })),
      command: "SELECT",
      oid: 0,
    };
  }
}
