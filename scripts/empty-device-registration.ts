// ================================================================
// CF no-op stub: src/lib/device-registration
//
// 部署矩阵：
//   - Cloudflare 部署（DEPLOY_PLATFORM=cf）：Worker + Pages 全部 stub。
//     device-registration.ts 不会被导入，整个模块链（@/lib/prisma、@/lib/node-name）
//     不打进 Pages Function bundle，避免拉入 Prisma 方言 client / 启动期数据库写。
//
// 行为契约：
//   - registerDevice() 返回"未注册"结果（registered: false），调用方可正常处理，
//     不需要额外分支防御；
//   - __resetDeviceRegistrationForTests() 同步空函数，单测无影响。
//
// 为什么需要 stub：Cloudflare 部署下设备注册属于"不属于该部署形态"的功能，
// Pages Function 体积本就接近 3 MiB 上限，多带一个 Prisma 表读写模块就可能
// 突破；alias 到空 stub 让 import 图在该路径上不触达真实实现。
// ================================================================

export interface DeviceRegistrationResult {
  registered: false;
  uuid: null;
  id: null;
  deviceName: null;
  platform: null;
}

export function registerDevice(_address?: string | null): Promise<DeviceRegistrationResult> {
  return Promise.resolve({
    registered: false,
    uuid: null,
    id: null,
    deviceName: null,
    platform: null,
  });
}

export function __resetDeviceRegistrationForTests(): void {
  // no-op
}