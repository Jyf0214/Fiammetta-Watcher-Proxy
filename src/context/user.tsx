"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

interface User {
  adminId: string;
  username: string;
}

interface UserContextType {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
  refreshUser: () => void;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    const fetchUser = async () => {
      try {
        const res = await fetch("/api/admin/auth/me", { signal: controller.signal });
        const data = await res.json();
        if (data.success && data.data) {
          setUser(data.data);
        } else {
          setUser(null);
        }
      } catch {
        setUser(null);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchUser();
    return () => controller.abort();
  }, [refreshKey]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/admin/auth", { method: "DELETE" });
    } finally {
      setUser(null);
      window.location.href = "/admin/login";
    }
  }, []);

  const refreshUser = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <UserContext.Provider value={{ user, loading, logout, refreshUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}
