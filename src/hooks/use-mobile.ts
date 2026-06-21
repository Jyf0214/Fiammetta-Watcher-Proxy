'use client';
import { useMediaQuery } from '@/hooks/use-media-query';
export const useIsMobile = () => useMediaQuery('(max-width: 767px)');
