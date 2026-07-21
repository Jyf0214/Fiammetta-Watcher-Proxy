import { Routes, Route, Navigate } from "react-router-dom";
import { AdminLayout } from "./pages/admin/layout";
import { LoginPage } from "./pages/admin/login";
import { AdminDashboard } from "./pages/admin/page";
import { PlatformsPage } from "./pages/admin/platforms";
import { KeysPage } from "./pages/admin/keys";
import { ModelsPage } from "./pages/admin/models";
import { LogsPage } from "./pages/admin/logs";
import { UsagePage } from "./pages/admin/usage";
import { ProxiesPage } from "./pages/admin/proxies";
import { PoolsPage } from "./pages/admin/pools";
import { ConfigPage } from "./pages/admin/config";
import { AuditPage } from "./pages/admin/audit";
import { TemplatesPage } from "./pages/admin/templates";
import { ExportPage } from "./pages/admin/export";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/admin/login" element={<LoginPage />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminDashboard />} />
        <Route path="platforms" element={<PlatformsPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="proxies" element={<ProxiesPage />} />
        <Route path="pools" element={<PoolsPage />} />
        <Route path="config" element={<ConfigPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="export" element={<ExportPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
