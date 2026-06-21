'use client';

import { useState, useEffect, useCallback } from 'react';
import { ArrowUp } from 'lucide-react';

/**
 * 回到顶部按钮 — 固定在右下角，滚动超过 300px 后显示，点击平滑回到顶部
 */
export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  const handleScroll = useCallback(() => {
    setVisible(window.scrollY > 300);
  }, []);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <button
      onClick={scrollToTop}
      aria-label="回到顶部"
      className={`fixed bottom-8 right-8 z-50 w-11 h-11 rounded-full bg-zinc-900 text-white shadow-lg shadow-zinc-900/20 flex items-center justify-center transition-all duration-300 hover:bg-zinc-700 hover:scale-110 active:scale-95 ${
        visible
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
    >
      <ArrowUp size={18} strokeWidth={2.5} />
    </button>
  );
}
