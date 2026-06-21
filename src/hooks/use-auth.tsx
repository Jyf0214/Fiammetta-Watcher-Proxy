'use client';

import { type ReactNode, useState, useEffect, createContext, useContext, useCallback, useMemo, useRef } from 'react';
import { message } from 'antd';
import { useI18n } from './use-i18n';

/** 2FA 验证需求错误 — 携带临时令牌供调用方跳转到 2FA 页面 */
export class TwoFactorRequiredError extends Error {
  constructor(public readonly tempToken: string) {
    super('2FA verification required');
    this.name = 'TwoFactorRequiredError';
  }
}

export type UserRole = 'user' | 'admin' | 'sudo';

export interface User {
  uid: string;
  email: string;
  name: string;
  displayName: string;
  role: UserRole;
  userGroup?: string;
  avatar?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  userRole: UserRole | null;
  isSudo: boolean;
  login: (email: string, pass: string) => Promise<void>;
  register: (email: string, pass: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clerkAvailable: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const { t } = useI18n();
  const clerkAvailable = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const abortControllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (timeoutMs = 10000) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      setLoading(true);
      const res = await fetch('/api/auth/me', { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data.authenticated) {
          setUser({ ...data.user, displayName: data.user.name });
        } else {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        console.warn('Auth refresh timed out');
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const login = useCallback(async (email: string, pass: string) => {
    try {
      setLoading(true);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: email, password: pass }),
      });

      if (res.status === 500) {
        message.error(t('error.500'));
        throw new Error(t('error.500'));
      }

      const data = await res.json();

      // 2FA 需求：密码正确但需要 TOTP 验证
      if (data.requires2FA && data.tempToken) {
        message.info('需要双因素认证验证');
        // 返回特殊标记让调用方跳转到 2FA 页面
        throw new TwoFactorRequiredError(data.tempToken);
      }

      if (res.ok && data.success) {
        setUser({ ...data.user, displayName: data.user.name });
        message.success(t('auth.loginSuccess'));
      } else {
        message.error(data.error ?? t('auth.loginFailed'));
        throw new Error(data.error ?? '操作失败');
      }
    } catch (err) {
      // TwoFactorRequiredError 需要向上抛出，由调用方处理跳转
      if (err instanceof TwoFactorRequiredError) {
        throw err;
      }
      console.error('登录错误:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [t]);

  const register = useCallback(async (email: string, pass: string, name: string) => {
    try {
      setLoading(true);
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass, name }),
      });

      if (res.status === 500) {
        message.error(t('error.500'));
        throw new Error(t('error.500'));
      }

      const data = await res.json();
      if (res.ok && data.success) {
        setUser({ ...data.user, displayName: data.user.name });
        message.success(t('auth.registerSuccess'));
      } else {
        message.error(data.error ?? t('auth.registerFailed'));
        throw new Error(data.error ?? '操作失败');
      }
    } catch (err) {
      console.error('注册错误:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [t]);

  const logout = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) {
        console.warn('登出请求失败:', res.status);
      }
      setUser(null);
      message.info(t('common.info'));
    } catch (err) {
      console.error('登出错误:', err);
      message.error(t('common.error') || '登出失败');
    }
  }, [t]);

  const contextValue = useMemo(() => ({
    user,
    loading,
    userRole: user?.role ?? null,
    isSudo: user?.role === 'sudo' || false,
    login,
    register,
    logout,
    refresh,
    clerkAvailable,
  }), [user, loading, login, register, logout, refresh, clerkAvailable]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth 必须在 AuthProvider 内使用');
  }
  return context;
};
