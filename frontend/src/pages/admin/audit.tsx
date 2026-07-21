import { useState, useEffect } from "react";
import { auditApi, type AuditLog } from "../../lib/api";
import { Shield } from "lucide-react";

export function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setLoading(true);
      const res = await auditApi.list(page);
      setLogs(res.data.items);
      setTotal(res.data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [page]);

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold flex items-center gap-2 mb-6"><Shield size={24} /> 审计日志</h1>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3">时间</th>
                <th className="text-left px-4 py-3">管理员</th>
                <th className="text-left px-4 py-3">操作</th>
                <th className="text-left px-4 py-3">详情</th>
                <th className="text-left px-4 py-3">IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2 text-xs">{new Date(l.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2">{l.adminUsername || l.adminId}</td>
                  <td className="px-4 py-2"><span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">{l.action}</span></td>
                  <td className="px-4 py-2 text-xs max-w-xs truncate">{l.detail || "-"}</td>
                  <td className="px-4 py-2 text-xs font-mono">{l.ip || "-"}</td>
                </tr>
              ))}
              {logs.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-500">暂无审计记录</td></tr>}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="flex justify-between items-center px-4 py-3 border-t">
              <span className="text-sm text-gray-500">共 {total} 条</span>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 border rounded text-sm disabled:opacity-50">上一页</button>
                <span className="px-3 py-1 text-sm">{page}/{totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-3 py-1 border rounded text-sm disabled:opacity-50">下一页</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
