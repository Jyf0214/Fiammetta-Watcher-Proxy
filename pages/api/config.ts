/**
 * GET /api/config — 获取前端公开配置
 *
 * 返回前端所需的配置信息，用于初始化页面渲染。
 * 优先从数据库读取，如无配置则返回默认值。
 * 无需认证。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { eq } from "drizzle-orm";

/**
 * FrontendConfig 类型定义（与前端 use-config hook 保持一致）
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

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    let config: FrontendConfig;

    try {
      const db = createDb((globalThis as Record<string, unknown>).DB as D1Database);
      const rows = await db
        .select()
        .from(schema.configs)
        .where(eq(schema.configs.key, "frontend_config"))
        .limit(1);

      if (rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value);
        if (parsed && typeof parsed === "object") {
          config = parsed as FrontendConfig;
        } else {
          config = getDefaultConfig();
        }
      } else {
        config = getDefaultConfig();
      }
    } catch {
      // 数据库不可用、查询失败或 JSON 格式无效，返回默认配置
      config = getDefaultConfig();
    }

    res.status(200).json(config);
  } catch (error) {
    console.error(
      "[GET /api/config] 获取配置失败:",
      error instanceof Error ? error.message : String(error)
    );
    // 即使出错也返回默认配置，确保前端可以正常渲染
    res.status(200).json(getDefaultConfig());
  }
}
