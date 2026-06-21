'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

interface ErrorImgConfig {
  flink: string;
  postPage: string;
}

let cachedConfig: ErrorImgConfig | null = null;

function getHandler(type: 'flink' | 'postPage'): (e: React.SyntheticEvent<HTMLImageElement>) => void {
  return (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (cachedConfig?.[type]) {
      (e.target as HTMLImageElement).src = cachedConfig[type];
    }
  };
}

export function useErrorImg() {
  const [loaded, setLoaded] = useState(!!cachedConfig);
  const onPostErrorRef = useRef(getHandler('postPage'));
  const onFlinkErrorRef = useRef(getHandler('flink'));

  useEffect(() => {
    if (cachedConfig) { setLoaded(true); return; }
    const fetchConfig = async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const data = await res.json();
          cachedConfig = data.errorImg as ErrorImgConfig;
          setLoaded(true);
        } else {
          console.warn('错误图片配置获取失败:', res.status);
        }
      } catch {
        console.warn('错误图片配置请求异常');
      }
    };
    void fetchConfig();
  }, []);

  const onPostError = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    onPostErrorRef.current(e);
  }, []);

  const onFlinkError = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    onFlinkErrorRef.current(e);
  }, []);

  return {
    loaded,
    onPostError,
    onFlinkError,
  };
}
