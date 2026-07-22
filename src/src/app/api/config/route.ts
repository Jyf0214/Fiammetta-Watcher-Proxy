import { NextResponse } from "next/server";

/**
 * FrontendConfig 类型定义（与 src/hooks/use-config.ts 保持一致）
 */
interface FrontendConfig {
  share?: {
    sharejs?: { enable: boolean; sites: string };
    addtoany?: { enable: boolean; item: string };
  };
  mainTone?: { enable: boolean; mode: "cdn" | "api" | "both" };
  footer?: {
    owner?: { enable: boolean; since: number };
    customText: string;
    runtime?: { enable: boolean; launchTime: string };
  };
  highlight?: {
    theme: string;
    copy: boolean;
    lang: boolean;
    shrink: boolean;
    heightLimit: number;
    wordWrap: boolean;
  };
  cover?: {
    indexEnable: boolean;
    asideEnable: boolean;
    archivesEnable: boolean;
    position: string;
    defaultCover: string[];
  };
  errorImg?: { flink: string; postPage: string };
  postMeta?: {
    page: {
      dateType: string;
      dateFormat: string;
      categories: boolean;
      tags: boolean;
      label: boolean;
    };
    post: {
      dateType: string;
      dateFormat: string;
      categories: boolean;
      tags: boolean;
      label: boolean;
      unread: boolean;
    };
  };
  wordcount?: {
    enable: boolean;
    postWordcount: boolean;
    min2read: boolean;
    totalWordcount: boolean;
  };
  toc?: {
    post: boolean;
    page: boolean;
    number: boolean;
    expand: boolean;
    styleSimple: boolean;
  };
  copy?: {
    enable: boolean;
    copyright: { enable: boolean; limitCount: number };
  };
  copyright?: {
    enable: boolean;
    decode: boolean;
    authorHref: string;
    location: string;
    license: string;
    licenseUrl: string;
    avatarSinks: boolean;
    authorImgBack: string;
    authorImgFront: string;
    authorLink: string;
  };
  reward?: {
    enable: boolean;
    qrCodes: { img: string; link: string; text: string }[];
  };
  authorStatus?: {
    enable: boolean;
    statusImg: string;
    skills: string[];
  };
  postEdit?: { enable: boolean; github: string | false };
  site?: { title: string; description: string; lang: string };
  auth?: { allowRegistration: boolean };
}

/**
 * 获取默认前端配置
 * 当数据库中无配置时返回此默认值
 */
function getDefaultConfig(): FrontendConfig {
  return {
    site: {
      title: "Fiammetta Watcher Proxy",
      description: "A proxy service for AI models",
      lang: "zh-CN",
    },
    highlight: {
      theme: "night-owl",
      copy: true,
      lang: true,
      shrink: true,
      heightLimit: 500,
      wordWrap: true,
    },
    cover: {
      indexEnable: true,
      asideEnable: false,
      archivesEnable: false,
      position: "left",
      defaultCover: [],
    },
    errorImg: {
      flink: "",
      postPage: "",
    },
    postMeta: {
      page: {
        dateType: "date",
        dateFormat: "YYYY-MM-DD",
        categories: true,
        tags: true,
        label: false,
      },
      post: {
        dateType: "date",
        dateFormat: "YYYY-MM-DD",
        categories: true,
        tags: true,
        label: true,
        unread: true,
      },
    },
    wordcount: {
      enable: true,
      postWordcount: true,
      min2read: true,
      totalWordcount: true,
    },
    toc: {
      post: true,
      page: false,
      number: true,
      expand: true,
      styleSimple: false,
    },
    copy: {
      enable: true,
      copyright: { enable: true, limitCount: 50 },
    },
    copyright: {
      enable: false,
      decode: false,
      authorHref: "",
      location: "",
      license: "CC BY-NC-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
      avatarSinks: true,
      authorImgBack: "",
      authorImgFront: "",
      authorLink: "",
    },
    reward: {
      enable: false,
      qrCodes: [],
    },
    authorStatus: {
      enable: false,
      statusImg: "",
      skills: [],
    },
    postEdit: {
      enable: false,
      github: "",
    },
    share: {
      sharejs: { enable: false, sites: "" },
      addtoany: { enable: false, item: "" },
    },
    mainTone: { enable: false, mode: "cdn" },
    footer: {
      owner: { enable: false, since: 2024 },
      customText: "",
      runtime: { enable: false, launchTime: "" },
    },
    auth: { allowRegistration: false },
  };
}

/**
 * GET /api/config — 获取前端配置
 *
 * 返回前端所需的配置信息，用于初始化页面渲染。
 * 优先从数据库读取，如无配置则返回默认值。
 * 注意：Next.js App Router 仅导出 GET，其他方法自动返回 405。
 */
export async function GET() {
  try {
    // 尝试从数据库读取配置
    // 注意：如果数据库不可用，返回默认配置而非报错
    let config: FrontendConfig;

    try {
      const { prisma } = await import("@/lib/prisma");
      const dbConfig = await prisma.config.findUnique({
        where: { key: "frontend_config" },
      });

      if (dbConfig && dbConfig.value) {
        // 安全解析：验证 JSON 格式有效性
        const parsed = JSON.parse(dbConfig.value);
        if (parsed && typeof parsed === "object") {
          config = parsed as FrontendConfig;
        } else {
          // JSON 解析成功但数据格式无效，使用默认配置
          config = getDefaultConfig();
        }
      } else {
        config = getDefaultConfig();
      }
    } catch {
      // 数据库不可用、查询失败或 JSON 格式无效，返回默认配置
      config = getDefaultConfig();
    }

    return NextResponse.json(config);
  } catch (error) {
    // 仅输出错误信息，避免泄露完整堆栈
    console.error("[GET /api/config] 获取配置失败:", error instanceof Error ? error.message : String(error));
    // 即使出错也返回默认配置，确保前端可以正常渲染
    return NextResponse.json(getDefaultConfig());
  }
}
