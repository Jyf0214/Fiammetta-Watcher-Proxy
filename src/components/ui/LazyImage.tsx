'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { ImageOff } from 'lucide-react';

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  width?: number;
  height?: number;
  /** 填充父容器模式（类似 next/image fill） */
  fill?: boolean;
}

export function LazyImage({
  src,
  alt,
  className,
  width,
  height,
  fill,
}: LazyImageProps) {
  const [status, setStatus] = useState<'idle' | 'loaded' | 'error'>('idle');
  const [isInView, setIsInView] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setIsInView(true);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(handleIntersection, {
      rootMargin: '200px 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleIntersection]);

  const containerStyle: React.CSSProperties = fill
    ? { position: 'absolute', inset: 0 }
    : {
        width: width ? `${width}px` : '100%',
        height: height ? `${height}px` : 'auto',
        aspectRatio: width && height ? `${width} / ${height}` : undefined,
      };

  if (status === 'error') {
    return (
      <div
        className={`bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center rounded-xl ${className ?? ''}`}
        style={containerStyle}
      >
        <ImageOff size={32} className="text-zinc-300 dark:text-zinc-600" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative" style={containerStyle}>
      {/* 占位符 */}
      {status === 'idle' && (
        <div
          className={`absolute inset-0 bg-zinc-100 dark:bg-zinc-800 animate-pulse rounded-xl ${className ?? ''}`}
        />
      )}

      {/* 实际图片 */}
      {isInView && (
        <img
          src={src}
          alt={alt}
          className={`lazy-image ${status === 'loaded' ? 'opacity-100' : 'opacity-0'} ${className ?? ''}`}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
        />
      )}
    </div>
  );
}
