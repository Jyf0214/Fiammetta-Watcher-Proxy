import { useState, useEffect } from "react";
import { logsApi } from "../../lib/api";
import { FileText, Database, AlertCircle } from "lucide-react";

type LogType = "requests" | "archive" | "events";

export function LogsPage() {
  const [type, setType] = useState<LogType>("requests");
  const [items, setItems] = useState<unknown[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setLoading(true);
      const res = await logsApi.list({ type, page, pageSize: 20 });
      setItems(res.data.items);
      setTotal(res.data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setPage(1); }, [type]);
  useEffect(() => { load(); }, [type, page]);

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold flex items-center gap-2 mb-6"><FileText size={24} /> 日志</h1>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      <div className="flex gap-2 mb-4">
        {([["requests", "请求日志", FileText], ["archive", "归档统计", Database], ["events", "系统事件", AlertCircle]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setType(t)} className={`flex items-center gap-1 px-3 py-1.5 rounded text-sm ${type === t ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              {type === "requests" && (
                <tr>
                  <th className="text-left px-4 py-3">时间</th>
                  <th className="text-left px-4 py-3">模型</th>
                  <th className="text-left px-4 py-3">状态</th>
                  <th className="text-left px-4 py-3">Token</th>
                  <th className="text-left px-4 py-3">耗时</th>
                </tr>
              )}
              {type === "archive" && (
                <tr>
                  <th className="text-left px-4 py-3">日期</th>
                  <th className="text-left px-4 py-3">模型</th>
                  <th className="text-left px-4 py-3">请求数</th>
                  <th className="text-left px-4 py-3">Token</th>
                </tr>
              )}
              {type === "events" && (
                <tr>
                  <th className="text-left px-4 py-3">时间</th>
                  <th className="text-left px-4 py-3">级别</th>
                  <th className="text-left px-4 py-3">消息</th>
                </tr>
              )}
            </thead>
            <tbody>
              {items.map((item: unknown, i: number) => {
                const r = item as Record<string, unknown>;
                return (
                <tr key={i} className="border-b hover:bg-gray-50">
                  {type === "requests" && (
                    <>
                      <td className="px-4 py-2 text-xs">{r.createdAt ? new Date(r.createdAt as string).toLocaleString() : "-"}</td>
                      <td className="px-4 py-2 font-mono text-xs">{String(r.model)}</td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${(r.status as number) < 400 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{String(r.status)}</span></td>
                      <td className="px-4 py-2">{String(r.tokens || 0)}</td>
                      <td className="px-4 py-2">{String(r.duration || 0)}ms</td>
                    </>
                  )}
                  {type === "archive" && (
                    <>
                      <td className="px-4 py-2">{String(r.date)}</td>
                      <td className="px-4 py-2 font-mono text-xs">{String(r.model)}</td>
                      <td className="px-4 py-2">{String(r.totalRequests || 0)}</td>
                      <td className="px-4 py-2">{String(r.totalTokens || 0)}</td>
                    </>
                  )}
                  {type === "events" && (
                    <>
                      <td className="px-4 py-2 text-xs">{r.createdAt ? new Date(r.createdAt as string).toLocaleString() : "-"}</td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${r.level === "error" ? "bg-red-100 text-red-700" : r.level === "warn" ? "bg-yellow-100 text-yellow-700" : "bg-blue-100 text-blue-700"}`}>{String(r.level)}</span></td>
                      <td className="px-4 py-2 text-xs max-w-md truncate">{String(r.message)}</td>
                    </>
                  )}
                </tr>
                );
              })}
              {items.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-500">暂无数据</td></tr>}
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
