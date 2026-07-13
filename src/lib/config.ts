/**
 * 配置文件读取模块
 * 支持从 data/db-config.json 读取数据库配置
 * 优先级：环境变量 > 配置文件
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

interface DbConfig {
  type: "postgresql" | "mysql";
  hostname: string;
  port: number;
  dbName: string;
  username: string;
  password: string;
  ssl?: boolean;
}

const CONFIG_DIR = "data";
const CONFIG_FILE = "db-config.json";

/**
 * 获取配置文件路径
 */
function getConfigPath(): string {
  const dataDir = process.env.DATA_DIR || CONFIG_DIR;
  return join(process.cwd(), dataDir, CONFIG_FILE);
}

/**
 * 读取配置文件
 */
export function readDbConfig(): DbConfig | null {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as DbConfig;

    // 验证必需字段
    if (!config.type || !config.hostname || !config.dbName || !config.username || !config.password) {
      console.warn("[配置] db-config.json 缺少必需字段");
      return null;
    }

    // 验证数据库类型
    if (config.type !== "postgresql" && config.type !== "mysql") {
      console.warn(`[配置] 不支持的数据库类型: ${config.type}`);
      return null;
    }

    return config;
  } catch (error) {
    console.error("[配置] 读取 db-config.json 失败:", error);
    return null;
  }
}

/**
 * 将配置转换为 DATABASE_URL
 */
export function configToDatabaseUrl(config: DbConfig): string {
  const protocol = config.type === "postgresql" ? "postgresql" : "mysql";
  const port = config.port || (config.type === "postgresql" ? 5432 : 3306);
  const ssl = config.ssl ? "?ssl=true" : "";

  return `${protocol}://${config.username}:${config.password}@${config.hostname}:${port}/${config.dbName}${ssl}`;
}

/**
 * 保存配置到文件
 */
export function saveDbConfig(config: DbConfig): boolean {
  const dataDir = process.env.DATA_DIR || CONFIG_DIR;
  const configDir = join(process.cwd(), dataDir);

  try {
    // 确保目录存在
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const configPath = getConfigPath();
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    console.log(`[配置] 已保存数据库配置到 ${configPath}`);
    return true;
  } catch (error) {
    console.error("[配置] 保存 db-config.json 失败:", error);
    return false;
  }
}

/**
 * 检查是否已配置数据库
 * 优先级：环境变量 > 配置文件
 */
export function isDatabaseConfigured(): boolean {
  // 优先检查环境变量
  if (process.env.DATABASE_URL) {
    return true;
  }

  // 检查配置文件
  const config = readDbConfig();
  return config !== null;
}

/**
 * 获取数据库 URL
 * 优先级：环境变量 > 配置文件
 */
export function getDatabaseUrl(): string | null {
  // 优先使用环境变量
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // 从配置文件读取
  const config = readDbConfig();
  if (config) {
    return configToDatabaseUrl(config);
  }

  return null;
}

/**
 * 从配置文件加载配置到环境变量
 * 在启动时调用，确保环境变量可用
 */
export function loadConfigFromEnv(): void {
  const dbUrl = getDatabaseUrl();
  if (dbUrl && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = dbUrl;
    console.log("[配置] 已从配置文件加载 DATABASE_URL");
  }
}
