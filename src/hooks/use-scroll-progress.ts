'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * 滚动进度 Hook — 监听页面滚动，返回 0-1 的阅读进度
 * 基于 scrollY / (scrollHeight - clientHeight) 计算
 */
export function useScrollProgress(): number {
  const [progress, setProgress] = useState(0);

  const handleScroll = useCallback(() => {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    if (scrollHeight <= 0) {
      setProgress(0);
      return;
    }
    const next = Math.min(Math.max(scrollTop / scrollHeight, 0), 1);
    setProgress(next);
  }, []);

  useEffect(() => {
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [handleScroll]);

  return progress;
}
