#!/usr/bin/env node
/**
 * 构建后预压缩静态文件
 *
 * 为 .next/static 和 public 目录下的静态资源生成 .gz (Gzip) 和 .br (Brotli) 副本
 * 原始文件保持不变，服务器可根据 Accept-Encoding 直接返回压缩版本
 *
 * 依赖：Node.js 内置 zlib（无需额外安装）
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const STATIC_DIRS = [
  path.resolve(__dirname, "../.next/static"),
  path.resolve(__dirname, "../public"),
];

const COMPRESSIBLE_EXT = new Set([
  ".js", ".css", ".html", ".htm", ".json", ".xml",
  ".svg", ".txt", ".ico", ".woff", ".woff2", ".ttf",
]);

const MIN_SIZE = 1024; // 小于 1KB 不压缩

let totalFiles = 0;
let totalSaved = 0;

function compressFile(filePath) {
  const content = fs.readFileSync(filePath);
  if (content.length < MIN_SIZE) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!COMPRESSIBLE_EXT.has(ext)) return;

  const originalSize = content.length;

  // Gzip
  const gzPath = filePath + ".gz";
  if (!fs.existsSync(gzPath)) {
    const gz = zlib.gzipSync(content, { level: 6 });
    if (gz.length < originalSize) {
      fs.writeFileSync(gzPath, gz);
      totalSaved += originalSize - gz.length;
    }
  }

  // Brotli
  const brPath = filePath + ".br";
  if (!fs.existsSync(brPath)) {
    const br = zlib.brotliCompressSync(content, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
      },
    });
    if (br.length < originalSize) {
      fs.writeFileSync(brPath, br);
      totalSaved += originalSize - br.length;
    }
  }

  totalFiles++;
}

function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full);
    } else {
      compressFile(full);
    }
  }
}

console.log("[compress] 开始预压缩静态文件...");

for (const dir of STATIC_DIRS) {
  if (fs.existsSync(dir)) {
    walkDir(dir);
  }
}

const savedKB = (totalSaved / 1024).toFixed(1);
console.log(`[compress] 完成：${totalFiles} 个文件已压缩，节省 ${savedKB} KB`);
