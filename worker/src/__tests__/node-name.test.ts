/**
 * resolveNodeName 单元测试
 *
 * 验证请求日志 nodeName 列的取值规则：
 * - NODE_NAME 环境变量优先（env 参数 > process.env）
 * - 未设置时回退部署平台名（edgeone/vercel/docker/cf → 友好名称，均未设置时 local）
 * - 特殊字符（控制字符/逗号/引号）删除
 * - 显示宽度截断：中文等全角按 2 计、ASCII 按 1，上限 20（纯中文 10 字、纯英文 20 字）
 * - 清洗后为空时回退部署平台名
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

const { resolveNodeName } = await import("../token");

describe("resolveNodeName", () => {
  beforeEach(() => {
    delete process.env.NODE_NAME;
    delete process.env.DEPLOY_PLATFORM;
  });

  afterEach(() => {
    delete process.env.NODE_NAME;
    delete process.env.DEPLOY_PLATFORM;
  });

  it("NODE_NAME 已设置 → 原样使用（含中文与符号）", () => {
    process.env.NODE_NAME = "华东-节点1";
    expect(resolveNodeName()).toBe("华东-节点1");
  });

  it("env 参数优先于 process.env", () => {
    process.env.NODE_NAME = "env-进程";
    expect(resolveNodeName({ NODE_NAME: "env-传参" })).toBe("env-传参");
  });

  it("NODE_NAME 未设置 → 回退部署平台友好名称（edgeone/vercel/docker/cf）", () => {
    process.env.DEPLOY_PLATFORM = "edgeone";
    expect(resolveNodeName()).toBe("EdgeOne");
    process.env.DEPLOY_PLATFORM = "vercel";
    expect(resolveNodeName()).toBe("Vercel");
    process.env.DEPLOY_PLATFORM = "docker";
    expect(resolveNodeName()).toBe("Docker");
    process.env.DEPLOY_PLATFORM = "cf";
    expect(resolveNodeName()).toBe("Cloudflare");
  });

  it("未知 DEPLOY_PLATFORM 值 → 原样返回", () => {
    process.env.DEPLOY_PLATFORM = "custom";
    expect(resolveNodeName()).toBe("custom");
  });

  it("NODE_NAME 与 DEPLOY_PLATFORM 均未设置 → local", () => {
    expect(resolveNodeName()).toBe("local");
  });

  it("env 参数未设置 NODE_NAME 时回退 process.env 的 DEPLOY_PLATFORM", () => {
    process.env.DEPLOY_PLATFORM = "docker";
    expect(resolveNodeName({ DB_TYPE: "pg" })).toBe("Docker");
  });

  it("删除控制字符与逗号引号（\n \r \t 空字符 C1 , \" '）", () => {
    // process.env 受 POSIX 限制不允许 NUL 字节（赋值时静默截断到 NUL 前），
    // NUL 场景改走 env 参数路径验证（Worker 运行时 env 对象是普通 JS 对象，可含 NUL）
    process.env.NODE_NAME = '节\n点\r一,\t"引\'号\u0001空';
    expect(resolveNodeName()).toBe("节点一引号空");
    expect(resolveNodeName({ NODE_NAME: '节\n点\r一,\t"引\'号\u0000空' })).toBe("节点一引号空");
    // C1 控制字符（U+0080-U+009F，如 NEL U+0085）同样删除，防止破坏日志结构
    expect(resolveNodeName({ NODE_NAME: "节点\u0085名" })).toBe("节点名");
  });

  it("英文 20 字保留、21 字截断为 20", () => {
    process.env.NODE_NAME = "abcdefghijklmnopqrst"; // 20
    expect(resolveNodeName()).toBe("abcdefghijklmnopqrst");
    process.env.NODE_NAME = "abcdefghijklmnopqrstu"; // 21
    expect(resolveNodeName()).toBe("abcdefghijklmnopqrst");
  });

  it("代理对（emoji 等）按 2 列宽计：10 个保留、11 个截断为 10", () => {
    const ten = "😀".repeat(10); // 10 个 emoji，显示宽度 20
    process.env.NODE_NAME = ten;
    expect(resolveNodeName()).toBe(ten);
    process.env.NODE_NAME = "😀".repeat(11); // 11 个 emoji，显示宽度 22
    expect(resolveNodeName()).toBe(ten);
  });

  it("纯中文 10 字保留、11 字截断为 10", () => {
    const ten = "中文节点名称十个字符"; // 10 个汉字，宽度 20
    expect(ten.length).toBe(10);
    process.env.NODE_NAME = ten;
    expect(resolveNodeName()).toBe(ten);
    process.env.NODE_NAME = "中文节点名称十个字符加"; // 11 个汉字，宽度 22
    expect(resolveNodeName()).toBe(ten);
  });

  it("混合宽度按显示宽度截断（中文 2/ASCII 1，上限 20）", () => {
    // "ab" 2 + "中文节点" 8 = 10 宽度，再加 11 个 ASCII 达到 21 → 截掉末尾 1 个 ASCII
    process.env.NODE_NAME = "ab中文节点abcdefghijk"; // 2+8+11=21
    expect(resolveNodeName()).toBe("ab中文节点abcdefghij"); // 2+8+10=20
  });

  it("全为非法字符/空白 → 回退部署平台名", () => {
    process.env.NODE_NAME = "\n,\r\"'";
    process.env.DEPLOY_PLATFORM = "edgeone";
    expect(resolveNodeName()).toBe("EdgeOne");
    process.env.NODE_NAME = "   ";
    expect(resolveNodeName()).toBe("EdgeOne");
  });
});