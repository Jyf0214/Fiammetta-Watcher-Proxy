'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import zhCN from '@/i18n/zh-CN.json';
import en from '@/i18n/en.json';

type Locale = 'zh-CN' | 'en';

interface I18nKeys {
  [key: string]: string | I18nKeys;
}

const translations: Record<Locale, I18nKeys> = {
  'zh-CN': zhCN,
  'en': en,
};

function getInitialLocale(): Locale {
  if (typeof window !== 'undefined') {
    const savedLocale = localStorage.getItem('locale') as Locale;
    if (savedLocale && translations[savedLocale]) {
      return savedLocale;
    }
    // 从浏览器检测语言
    const browserLocale = navigator.language;
    if (browserLocale.startsWith('zh')) return 'zh-CN';
    if (browserLocale.startsWith('en')) return 'en';
  }
  return 'zh-CN';
}

export function useI18n() {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
    }
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    if (typeof window !== 'undefined') {
      localStorage.setItem('locale', newLocale);
      // 可选：更新 html lang 属性
      document.documentElement.lang = newLocale;
    }
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const keys = key.split('.');
    let value: string | I18nKeys | undefined = translations[locale];
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return key;
      }
    }
    
    if (typeof value === 'string') {
      if (params) {
        let result = value;
        Object.entries(params).forEach(([k, v]) => {
          result = result.replace(new RegExp(`{${k}}`, 'g'), String(v));
        });
        return result;
      }
      return value;
    }
    
    return key;
  }, [locale]);

  return { locale, setLocale, t };
}
