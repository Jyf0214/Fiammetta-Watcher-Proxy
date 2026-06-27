'use client';

import { useEffect, useState } from 'react';

interface SharejsConfig {
  enable: boolean;
  sites: string;
}

interface AddtoanyConfig {
  enable: boolean;
  item: string;
}

interface ShareConfig {
  sharejs: SharejsConfig;
  addtoany: AddtoanyConfig;
}

interface MainToneConfig {
  enable: boolean;
  mode: 'cdn' | 'api' | 'both';
}

interface FooterOwnerConfig {
  enable: boolean;
  since: number;
}

interface FooterRuntimeConfig {
  enable: boolean;
  launchTime: string;
}

interface FooterConfig {
  owner: FooterOwnerConfig;
  customText: string;
  runtime: FooterRuntimeConfig;
}

export interface FrontendConfig {
  share?: ShareConfig;
  mainTone?: MainToneConfig;
  footer?: FooterConfig;
  highlight?: { theme: string; copy: boolean; lang: boolean; shrink: boolean; heightLimit: number; wordWrap: boolean };
  cover?: { indexEnable: boolean; asideEnable: boolean; archivesEnable: boolean; position: string; defaultCover: string[] };
  errorImg?: { flink: string; postPage: string };
  postMeta?: {
    page: { dateType: string; dateFormat: string; categories: boolean; tags: boolean; label: boolean };
    post: { dateType: string; dateFormat: string; categories: boolean; tags: boolean; label: boolean; unread: boolean };
  };
  wordcount?: { enable: boolean; postWordcount: boolean; min2read: boolean; totalWordcount: boolean };
  toc?: { post: boolean; page: boolean; number: boolean; expand: boolean; styleSimple: boolean };
  copy?: { enable: boolean; copyright: { enable: boolean; limitCount: number } };
  copyright?: {
    enable: boolean; decode: boolean; authorHref: string; location: string;
    license: string; licenseUrl: string; avatarSinks: boolean;
    authorImgBack: string; authorImgFront: string; authorLink: string;
  };
  reward?: { enable: boolean; qrCodes: { img: string; link: string; text: string }[] };
  authorStatus?: { enable: boolean; statusImg: string; skills: string[] };
  postEdit?: { enable: boolean; github: string | false };
  site?: { title: string; description: string; lang: string };
  auth?: { allowRegistration: boolean };
}

let cachedConfig: FrontendConfig | null = null;
let pendingPromise: Promise<FrontendConfig> | null = null;

export function useConfig(): {
  config: FrontendConfig | null;
  loading: boolean;
  error: string | null;
} {
  const [config, setConfig] = useState<FrontendConfig | null>(cachedConfig);
  const [loading, setLoading] = useState(!cachedConfig);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cachedConfig) {
      return;
    }

    if (pendingPromise) {
      pendingPromise.then(setConfig).catch(e => setError(e.message)).finally(() => setLoading(false));
      return;
    }

    pendingPromise = fetch('/api/config')
      .then(res => {
        if (!res.ok) throw new Error('无法加载配置');
        return res.json();
      })
      .then((data: FrontendConfig) => {
        cachedConfig = data;
        return data;
      });

    pendingPromise.then(setConfig).catch(e => setError(e.message)).finally(() => {
      setLoading(false);
      pendingPromise = null;
    });
  }, []);

  return { config, loading, error };
}
