"use client";

import { UserProvider } from "@/context/user";
import AdminLayoutClient from "./AdminLayoutClient";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <UserProvider>
      <AdminLayoutClient>{children}</AdminLayoutClient>
    </UserProvider>
  );
}
