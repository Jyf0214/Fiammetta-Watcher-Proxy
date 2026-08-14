/**
 * 前端 i18n 一致性检查（vitest）
 *
 * 结构约定（真命名空间）：
 *   - messages/zh.json 与 en.json 顶层即命名空间（common/validation/auth/admin/...），
 *     每个命名空间下为扁平 camelCase 键（小写字母开头，禁止下划线/中划线，禁止嵌套）
 *   - UI 文件通过 useTranslation("ns") 声明命名空间；t("key") 无前缀键解析到文件声明的
 *     命名空间，跨命名空间引用必须显式写 t("ns:key")
 *
 * 覆盖范围（仅前端 UI 代码）：
 *   - pages/**\/*.tsx（页面；pages/api/*.ts 为服务端不在此列）
 *   - src/components/**（组件）
 *   - src/lib/platform.ts（前端 UI 数据模块：类型图标标签等）
 * 排除：src/generated/**、*.test.{ts,tsx}、*.d.ts
 *
 * 检查项：
 *  1. 除注释外不允许出现硬编码中文字符串
 *  2. 禁止 t(...) || "文本" 形式的 fallback（中英文皆不允许）
 *  3. useTranslation 声明的命名空间必须存在于 zh/en
 *  4. 代码引用的 i18n 键必须存在于对应命名空间（含 ns: 前缀解析与动态拼接键）
 *  5. messages 中的键必须被代码引用，不允许死键
 *  6. 键名必须 camelCase：小写字母开头、仅字母数字，禁止下划线/中划线；zh/en 键完全对称
 *
 * 动态键解析：t(`prefix.${expr}`) 的静态前缀与代码中出现的字符串字面量
 * （对象值、变量字典如 ACTION_LABELS / STEP_LABELS / groupI18nKeys / MODEL_TYPE_CONFIG）
 * 拼接，能命中 zh 键即视为已引用；一个候选都拼不出时判定为无法解析的引用。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CJK = /[\u4e00-\u9fff]/;
const T_CALL = /\bt\s*\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
const NS_CALL = /useTranslation\s*\(\s*"([^"]+)"\s*\)/g;
const STRING_LIT = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;

// ---------- 文件收集 ----------
function collectUiFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "generated") continue;
        walk(abs);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        files.push(abs);
      }
    }
  };
  walk(path.join(ROOT, "pages"));
  walk(path.join(ROOT, "src", "components"));
  files.push(path.join(ROOT, "src", "lib", "platform.ts"));
  return files.filter((f) => fs.existsSync(f));
}

// 死键/字面量引用检查范围：全代码库（含 worker / pages/api / lib / scripts），
// 避免把服务端出现的键字面量误判为死键而删除
function collectAllFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".next", ".open-next", "generated"].includes(entry.name)) continue;
        walk(abs);
      } else if (
        /\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) &&
        !/\.test\./.test(entry.name) &&
        !/\.d\.ts$/.test(entry.name)
      ) {
        files.push(abs);
      }
    }
  };
  walk(ROOT);
  return files.filter((f) => fs.existsSync(f) && !f.startsWith(path.join(ROOT, "messages")));
}

function isUiFile(rel: string): boolean {
  if (!rel.endsWith(".tsx")) {
    // src/lib 下仅 platform.ts 属于前端 UI 模块，其余（auth/admin-security 等）为服务端逻辑
    return rel === path.join("src", "lib", "platform.ts");
  }
  return true;
}

// ---------- 注释剥离（字符串感知状态机） ----------
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n || "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 从 start（open 字符所在位置）起引号/注释感知地扫描匹配的 close 字符，返回其下标；未找到返回 -1 */
function blockEnd(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

interface Messages {
  nsKeys: Map<string, Set<string>>; // ns -> 键集合（扁平）
  allKeys: Set<string>; // "ns:key" 全限定形态
}

function loadMessages(): Messages {
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "messages", "zh.json"), "utf8"));
  const nsKeys = new Map<string, Set<string>>();
  const allKeys = new Set<string>();
  for (const [ns, obj] of Object.entries(zh)) {
    const set = new Set<string>(Object.keys(obj as Record<string, unknown>));
    nsKeys.set(ns, set);
    for (const k of set) allKeys.add(`${ns}:${k}`);
  }
  return { nsKeys, allKeys };
}

interface Issues {
  hardcodedZh: string[];
  tFallback: string[];
  badNs: string[]; // useTranslation 声明了不存在的命名空间
  missingKey: string[]; // 引用侧缺失
  dictKey: string[]; // t() 变量引用的字典值缺失
  unresolvableDynamic: string[]; // 动态键一个候选都拼不出
  unusedKey: string[]; // 死键
  badKeyName: string[]; // 键名格式违规
  asymmetry: string[]; // zh/en 不对称
  stepMismatch: string[]; // 前端步骤字典与服务端导入步骤不一致
}

function analyze(): Issues {
  const msgs = loadMessages();
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "messages", "en.json"), "utf8"));

  const issues: Issues = {
    hardcodedZh: [],
    tFallback: [],
    badNs: [],
    missingKey: [],
    dictKey: [],
    unresolvableDynamic: [],
    unusedKey: [],
    badKeyName: [],
    asymmetry: [],
    stepMismatch: [],
  };

  const usedKeys = new Set<string>(); // "ns:key"
  const globalLiterals = new Set<string>(); // 全库字符串字面量
  const uiLiterals = new Set<string>(); // 前端 UI 文件字符串字面量

  // ---------- 检查 6a：键名格式 + zh/en 对称 ----------
  const KEY_NAME_OK = /^[a-z][a-zA-Z0-9]*$/;
  const zhNs = Object.keys(zh);
  const enNs = Object.keys(en);
  const nsDiff = [...new Set([...zhNs, ...enNs])].filter(
    (ns) => !zhNs.includes(ns) || !enNs.includes(ns)
  );
  if (nsDiff.length > 0) {
    issues.asymmetry.push(`zh/en 命名空间不一致: ${nsDiff.join(" ")}`);
  }
  for (const ns of zhNs) {
    const zk = Object.keys(zh[ns] as Record<string, unknown>);
    const ek = Object.keys(en[ns] as Record<string, unknown>);
    const kDiff = [...new Set([...zk, ...ek])].filter((k) => !zk.includes(k) || !ek.includes(k));
    if (kDiff.length > 0) {
      issues.asymmetry.push(`[${ns}] zh/en 键不一致: ${kDiff.join(" ")}`);
    }
    for (const lang of [zh, en] as const) {
      for (const k of Object.keys(lang[ns] as Record<string, unknown>)) {
        if (!KEY_NAME_OK.test(k)) issues.badKeyName.push(`[${ns}] ${k}`);
        const v = (lang[ns] as Record<string, unknown>)[k];
        if (v && typeof v === "object") issues.badKeyName.push(`[${ns}] ${k} 为嵌套对象，键必须扁平`);
      }
    }
  }

  // ---------- UI 文件扫描 ----------
  for (const abs of collectUiFiles()) {
    const rel = path.relative(ROOT, abs);
    if (!isUiFile(rel)) continue;
    const src = fs.readFileSync(abs, "utf8");

    // 检查 1：剥离注释后不得有硬编码中文
    const stripped = stripComments(src);
    stripped.split("\n").forEach((line, idx) => {
      if (CJK.test(line)) issues.hardcodedZh.push(`${rel}:${idx + 1} ${line.trim().slice(0, 120)}`);
    });

    // 检查 3：useTranslation 命名空间必须存在
    const fileNs: string[] = [];
    for (const m of src.matchAll(NS_CALL)) {
      const ns = m[1];
      if (!msgs.nsKeys.has(ns)) issues.badNs.push(`${rel}:${src.slice(0, m.index).split("\n").length} 命名空间 "${ns}" 不存在`);
      fileNs.push(ns);
    }
    const nsSet = new Set(fileNs);

    // t() 变量引用的字典常量名收集（提前到 uiLiterals 之前，用于排除字典块）
    const tVarRefs = new Set<string>();
    for (const m of src.matchAll(/\bt\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[[.]/g)) {
      tVarRefs.add(m[1]);
    }
    for (const m of src.matchAll(/\bt\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\?\?|\))/g)) {
      const v = m[1];
      const assign = src.match(new RegExp(`(?:const|let)\\s+${v}\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\[`));
      if (assign) tVarRefs.add(assign[1]);
    }

    const fileLiterals = [...src.matchAll(STRING_LIT)]
      .map((m2) => m2[1] ?? m2[2] ?? m2[3])
      .filter((lit): lit is string => typeof lit === "string" && lit.length > 0 && lit.length < 80);

    // tVarRefs 字典常量块内的字符串已通过 usedKeys 正确标记引用，
    // 不再注入 uiLiterals，避免恰好同名的无关字符串值误保死键。
    // 收集这些块的字符区间用于排除。
    const dictLiteralRanges: Array<[number, number]> = [];
    for (const name of tVarRefs) {
      const defRe = new RegExp(`const\\s+${name}\\s*(?::[^=]*)?=\\s*\\{`);
      const dm = src.match(defRe);
      if (!dm || dm.index === undefined) continue;
      const blockStart = dm.index + dm[0].length - 1;
      const blockEndIdx = blockEnd(src, blockStart, "{", "}");
      if (blockEndIdx === -1) continue;
      dictLiteralRanges.push([dm.index, blockEndIdx + 1]);
    }
    const inDictBlock = (offset: number) =>
      dictLiteralRanges.some(([s, e]) => offset >= s && offset < e);
    for (const m2 of src.matchAll(STRING_LIT)) {
      const lit = m2[1] ?? m2[2] ?? m2[3];
      if (lit && lit.length > 0 && lit.length < 80 && !inDictBlock(m2.index ?? 0)) {
        uiLiterals.add(lit);
      }
    }

    // 解析单个键引用 → "ns:key"；返回 null 表示引用不合法
    // tryResolve 不产生报错（用于动态键候选筛选），resolve 会记录缺失
    const tryResolve = (key: string): string | null => {
      const idx = key.indexOf(":");
      if (idx !== -1) {
        const ns = key.slice(0, idx);
        const k = key.slice(idx + 1);
        if (!msgs.nsKeys.has(ns)) return null;
        if (!msgs.nsKeys.get(ns)!.has(k)) return null;
        return key;
      }
      if (nsSet.size === 0) {
        // 纯数据模块（如 src/lib/platform.ts）无 useTranslation 声明，
        // 字典值按任意命名空间解析
        const hit = [...msgs.nsKeys.keys()].find((ns) => msgs.nsKeys.get(ns)!.has(key));
        return hit ? `${hit}:${key}` : null;
      }
      const hit = [...nsSet].find((ns) => msgs.nsKeys.get(ns)!.has(key));
      return hit ? `${hit}:${key}` : null;
    };
    const resolve = (key: string, line: number, where: string): string | null => {
      const resolved = tryResolve(key);
      if (resolved) return resolved;
      const idx = key.indexOf(":");
      if (idx !== -1) {
        const ns = key.slice(0, idx);
        if (!msgs.nsKeys.has(ns)) {
          issues.missingKey.push(`${where} 命名空间 "${ns}" 不存在`);
          return null;
        }
        issues.missingKey.push(`${where} 键 "${key}" 不存在于 ${ns} 命名空间`);
        return null;
      }
      if (nsSet.size === 0) {
        issues.missingKey.push(`${where} 无前缀键 "${key}" 但文件未声明 useTranslation 命名空间`);
        return null;
      }
      issues.missingKey.push(`${where} 键 "${key}" 不存在于文件命名空间 [${[...nsSet].join("/")}]`);
      return null;
    };

    // 检查 2 + 4：解析 t() 调用
    for (const m of src.matchAll(T_CALL)) {
      const arg = m[1];
      const lineNo = src.slice(0, m.index).split("\n").length;
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 80).match(/^\s*\|\|\s*["'`]/);
      if (after) issues.tFallback.push(`${rel}:${lineNo} ${m[0].trim().slice(0, 90)} 不允许带原文 fallback`);

      if (arg.startsWith("`")) {
        const tmpl = arg.slice(1, -1);
        const dyn = tmpl.indexOf("${");
        if (dyn === -1) {
          if (tmpl) {
            const resolved = resolve(tmpl, lineNo, `${rel}:${lineNo}`);
            if (resolved) usedKeys.add(resolved);
          }
        } else {
          // 动态模板：前缀 + 文件字面量候选拼接（候选经 tryResolve 命中才视为引用）
          const prefix = tmpl.slice(0, dyn);
          const suffix = tmpl.slice(tmpl.lastIndexOf("}") + 1);
          const hitLits = fileLiterals.filter((lit) => tryResolve(`${prefix}${lit}${suffix}`) !== null);
          if (hitLits.length === 0) {
            issues.unresolvableDynamic.push(`${rel}:${lineNo} 动态键 \`${prefix}\${...}${suffix}\` 无法从 messages 解析出任何键`);
          }
          for (const lit of hitLits) {
            const resolved = tryResolve(`${prefix}${lit}${suffix}`);
            if (resolved) usedKeys.add(resolved);
          }
        }
      } else if (arg.startsWith('"') || arg.startsWith("'")) {
        const key = arg.slice(1, -1);
        if (key) {
          const resolved = resolve(key, lineNo, `${rel}:${lineNo}`);
          if (resolved) usedKeys.add(resolved);
        }
      }
    }

    // 检查 4b：t() 变量引用的字典常量值必须存在于命名空间
    // 覆盖三种消费形态：
    //   1) t(XXX[...]) / t(XXX.yyy) 直接引用
    //   2) 中间变量：const key = XXX[...]; t(key) / t(key ?? fallback)
    //   3) 结构化属性：labelKey/detailKey/nameKey 值（含 import 自其他文件的字典，如 MODEL_TYPE_CONFIG）
    for (const name of tVarRefs) {
      const defRe = new RegExp(`const\\s+${name}\\s*(?::[^=]*)?=\\s*\\{`);
      const dm = src.match(defRe);
      if (!dm || dm.index === undefined) continue; // import 或函数参数等非常量定义
      const blockStart = dm.index + dm[0].length - 1;
      const blockEndIdx = blockEnd(src, blockStart, "{", "}");
      if (blockEndIdx === -1) continue;
      const block = src.slice(blockStart, blockEndIdx + 1);
      const hasStructured = /(?:labelKey|detailKey|nameKey)\s*:/.test(block);
      if (hasStructured) {
        // 结构化字典（STEP_LABELS / MODEL_TYPE_CONFIG / EXAMPLE_BODIES）：只校验属性键值
        for (const vm of block.matchAll(/(?:labelKey|detailKey|nameKey):\s*"([^"]+)"/g)) {
          const v = vm[1];
          const r = tryResolve(v);
          if (r === null) issues.dictKey.push(`${rel} 字典 ${name} 的键值 "${v}" 不存在于文件命名空间`);
          else usedKeys.add(r);
        }
      } else {
        // 纯字符串字典（ACTION_LABELS / groupI18nKeys）：校验 camelCase 形态的字符串值，
        // 跳过颜色/CSS 类/URL 等非键值，避免混合用途字典误报
        for (const vm of block.matchAll(/:\s*"([^"]+)"/g)) {
          const v = vm[1];
          if (!/^[a-z][a-zA-Z0-9]+$/.test(v)) continue;
          const r = tryResolve(v);
          if (r === null) issues.dictKey.push(`${rel} 字典 ${name} 的值 "${v}" 不存在于文件命名空间`);
          else usedKeys.add(r);
        }
      }
    }
    // 跨文件字典兜底：labelKey/detailKey/nameKey 属性只在 i18n 字典出现，
    // 全文件扫描可覆盖 import 自其他文件（如 src/lib/platform.ts 的 MODEL_TYPE_CONFIG）的定义
    for (const vm of src.matchAll(/(?:labelKey|detailKey|nameKey):\s*"([^"]+)"/g)) {
      const v = vm[1];
      const r = tryResolve(v);
      if (r === null) issues.dictKey.push(`${rel} labelKey/detailKey/nameKey 值 "${v}" 不存在于文件命名空间`);
      else usedKeys.add(r);
    }
  }

  // ---------- 检查 4c：前端导入步骤字典与服务端导入步骤一致 ----------
  const dmPath = path.join(ROOT, "pages", "admin", "data-manager.tsx");
  const importPath = path.join(ROOT, "pages", "api", "admin", "import.ts");
  if (fs.existsSync(dmPath) && fs.existsSync(importPath)) {
    const dmSrc = fs.readFileSync(dmPath, "utf8");
    const importSrc = fs.readFileSync(importPath, "utf8");
    const dmMatch = dmSrc.match(/const\s+STEP_LABELS[\s\S]*?=\s*\{/);
    if (!dmMatch || dmMatch.index === undefined) {
      issues.stepMismatch.push("无法解析 data-manager.tsx 的 STEP_LABELS 定义");
    } else {
      const dmEnd = blockEnd(dmSrc, dmMatch.index + dmMatch[0].length - 1, "{", "}");
      if (dmEnd === -1) {
        issues.stepMismatch.push("无法解析 data-manager.tsx 的 STEP_LABELS 定义块");
      } else {
        const dmBlock = dmSrc.slice(dmMatch.index, dmEnd + 1);
        const dmKeys = new Set<string>();
        const entryRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/g;
        let em: RegExpExecArray | null;
        while ((em = entryRe.exec(dmBlock)) !== null) {
          const innerStart = em.index + em[0].length - 1;
          const innerEnd = blockEnd(dmBlock, innerStart, "{", "}");
          if (innerEnd === -1) continue;
          if (/labelKey\s*:/.test(dmBlock.slice(innerStart, innerEnd + 1))) dmKeys.add(em[1]);
        }
        const stepsMatch = importSrc.match(/const\s+steps[\s\S]*?=\s*\[/);
        if (!stepsMatch || stepsMatch.index === undefined) {
          issues.stepMismatch.push("无法解析 import.ts 的 steps 定义");
        } else {
          const stepsEnd = blockEnd(importSrc, stepsMatch.index + stepsMatch[0].length - 1, "[", "]");
          if (stepsEnd === -1) {
            issues.stepMismatch.push("无法解析 import.ts 的 steps 定义块");
          } else {
            const stepsBlock = importSrc.slice(stepsMatch.index, stepsEnd + 1);
            const stepKeys = new Set(
              [...stepsBlock.matchAll(/\{\s*key:\s*"([^"]+)"/g)].map((m) => m[1])
            );
            const onlyDm = [...dmKeys].filter((k) => !stepKeys.has(k));
            const onlyStep = [...stepKeys].filter((k) => !dmKeys.has(k));
            if (onlyDm.length > 0) issues.stepMismatch.push(`STEP_LABELS 多余步骤: ${onlyDm.join(" ")}`);
            if (onlyStep.length > 0) issues.stepMismatch.push(`import.ts 步骤缺少 STEP_LABELS: ${onlyStep.join(" ")}`);
          }
        }
      }
    }
  }

  // ---------- 检查 5：死键（UI 字面量 + 全限定形态 + 引用侧并集） ----------
  for (const abs of collectAllFiles()) {
    const src = fs.readFileSync(abs, "utf8");
    for (const m2 of src.matchAll(STRING_LIT)) {
      const lit = m2[1] ?? m2[2] ?? m2[3];
      if (lit && lit.length > 0 && lit.length < 80) globalLiterals.add(lit);
    }
  }
  for (const [ns, keys] of msgs.nsKeys) {
    for (const k of keys) {
      const full = `${ns}:${k}`;
      // 被引用判定：t() 显式/字典/动态引用，或 UI 文件存在同名键字面量（侧边栏 key 等），
      // 或全库存在全限定形态字面量（"ns:key" / "ns.key"）。服务端普通字符串不再保护键名。
      const referenced =
        usedKeys.has(full) ||
        uiLiterals.has(k) ||
        globalLiterals.has(full) ||
        globalLiterals.has(`${ns}.${k}`);
      if (!referenced) issues.unusedKey.push(full);
    }
  }

  return issues;
}

function expectNone(issueList: string[], label: string) {
  expect(issueList, `${label}:\n${issueList.join("\n")}`).toEqual([]);
}

describe("i18n 一致性检查", () => {
  const result = analyze();

  it("除注释外不允许硬编码中文", () => {
    expectNone(result.hardcodedZh, "以下位置存在硬编码中文");
  });

  it("禁止 t() 带原文 fallback（中英文皆不允许）", () => {
    expectNone(result.tFallback, "以下 t() 调用带原文 fallback");
  });

  it("useTranslation 声明的命名空间必须存在于 zh/en", () => {
    expectNone(result.badNs, "以下文件声明了不存在的命名空间");
  });

  it("代码引用的 i18n 键必须存在于对应命名空间", () => {
    expectNone(result.missingKey, "以下键缺失");
  });

  it("t() 变量引用的字典值必须存在于对应命名空间", () => {
    expectNone(result.dictKey, "以下字典值缺失");
  });

  it("动态键必须能解析出至少一个候选键", () => {
    expectNone(result.unresolvableDynamic, "以下动态键无法解析");
  });

  it("前端导入步骤字典必须与服务端导入步骤一致", () => {
    expectNone(result.stepMismatch, "以下步骤不一致");
  });

  it("不允许死键（所有键需被代码引用）", () => {
    expectNone(result.unusedKey, "以下键未被使用");
  });

  it("键名必须 camelCase（小写字母开头，禁用下划线/中划线，禁止嵌套）", () => {
    expectNone(result.badKeyName, "以下键名不合规");
  });

  it("zh/en 命名空间与键必须完全对称", () => {
    expectNone(result.asymmetry, "以下命名空间/键不对称");
  });
});
