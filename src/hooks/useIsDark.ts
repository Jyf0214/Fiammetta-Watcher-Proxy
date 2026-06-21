'use client';
import { useMediaQuery } from '@/hooks/use-media-query';
export const useIsDark = () => useMediaQuery('(prefers-color-scheme: dark)');
