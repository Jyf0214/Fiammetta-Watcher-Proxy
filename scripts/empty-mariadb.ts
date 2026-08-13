// 自动生成的空 stub — Cloudflare 构建专用（turbopack.resolveAlias）
// mariadb 驱动依赖 Node TCP（net/tls），Cloudflare workerd 不可用。
// Cloudflare 平台仅支持 d1/tidb/pg/hyperdrive，此 stub 保证 Cloudflare 构建不打包 TCP 驱动。
// 非 Cloudflare 平台（EdgeOne/Vercel/纯 Node）构建不使用此文件（transpilePackages 内联真实包）。
export class PrismaMariaDb {
  constructor(..._args: unknown[]) {
    throw new Error("MariaDB 仅支持非 Cloudflare 平台（EdgeOne/Vercel/纯 Node），请切换 DB_TYPE");
  }
}
