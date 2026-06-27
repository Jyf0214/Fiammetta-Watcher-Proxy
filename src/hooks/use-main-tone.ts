'use client';

import { useEffect, useState } from 'react';

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

async function getDominantColorFromCanvas(imageUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageUrl;

    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }

      const size = 50;
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(img, 0, 0, size, size);

      const imageData = ctx.getImageData(0, 0, size, size).data;
      const colorMap: Record<string, number> = {};

      for (let i = 0; i < imageData.length; i += 16) {
        const r = Math.round(imageData[i]! / 16) * 16;
        const g = Math.round(imageData[i + 1]! / 16) * 16;
        const b = Math.round(imageData[i + 2]! / 16) * 16;
        const key = `${r},${g},${b}`;
        colorMap[key] = (colorMap[key] ?? 0) + 1;
      }

      let maxCount = 0;
      let dominantKey = '';
      for (const [key, count] of Object.entries(colorMap)) {
        if (count > maxCount) {
          maxCount = count;
          dominantKey = key;
        }
      }

      if (!dominantKey) { resolve(null); return; }
      const [r = 0, g = 0, b = 0] = dominantKey.split(',').map(Number);
      resolve(rgbToHex(r, g, b));
    };

    img.onerror = () => resolve(null);
  });
}

function isValidHexColor(color: string | null): color is string {
  return !!color && /^#[0-9a-f]{6}$/i.test(color);
}

interface MainToneResult {
  mainColor: string | null;
  loading: boolean;
}

export function useMainTone(
  imageUrl: string | null | undefined,
  mode: 'cdn' | 'api' | 'both' | undefined,
  enabled: boolean | undefined,
): MainToneResult {
  const [mainColor, setMainColor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!imageUrl || !enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMainColor(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const extract = async () => {
      let color: string | null = null;

      if (mode === 'cdn' || mode === 'both') {
        const cdnUrl = imageUrl.includes('?') ? `${imageUrl}&imageAve` : `${imageUrl}?imageAve`;
        try {
          const res = await fetch(cdnUrl, { method: 'HEAD' });
          if (res.ok) {
            const checkImg = new Image();
            checkImg.crossOrigin = 'anonymous';
            await new Promise<void>((resolve2, reject) => {
              checkImg.onload = () => resolve2();
              checkImg.onerror = () => reject();
              checkImg.src = cdnUrl;
            });
            color = await getDominantColorFromCanvas(cdnUrl);
          } else {
            console.warn('CDN 色调检测 HEAD 请求失败:', res.status);
          }
        } catch {
          console.warn('CDN 色调检测请求异常');
        }
      }

      if (!color && (mode === 'api' || mode === 'both')) {
        color = await getDominantColorFromCanvas(imageUrl);
      }

      if (!cancelled) {
        setMainColor(isValidHexColor(color) ? color : null);
        setLoading(false);
      }
    };

    void extract();

    return () => { cancelled = true; };
  }, [imageUrl, mode, enabled]);

  return { mainColor, loading };
}
