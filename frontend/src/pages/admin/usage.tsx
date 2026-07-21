import { useState, useEffect } from "react";
import { usageApi, type UsageTrend, type UsageByPlatform, type UsageByKey } from "../../lib/api";
import { BarChart3 } from "lucide-react";

type ViewType = "trend" | "platform" | "key";

export function UsagePage() {
  const [view, setView] = useState<ViewType>("trend");
  const [period, setPeriod] = useState("week");
  const [trend, setTrend] = useState<UsageTrend[]>([]);
  const [platformData, setPlatformData] = useState<UsageByPlatform[]>([]);
  const [keyData, setKeyData] = useState<UsageByKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setLoading(true);
      if (view === "trend") {
        const res = await usageApi.trend(period);
        setTrend(res.data);
      } else if (view === "platform") {
        const res = await usageApi.byPlatform(period);
        setPlatformData(res.data);
      } else {
        const res = await usageApi.byKey(period);
        setKeyData(res.data);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [view, period]);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold flex items-center gap-2 mb-6"><BarChart3 size={24} /> 用量统计</h1>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      <div className="flex gap-4 mb-4">
        <div className="flex gap-1">
          {(["trend", "platform", "key"] as const).map(v => (
            <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 rounded text-sm ${view === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>
              {v === "trend" ? "趋势" : v === "platform" ? "按平台" : "按密钥"}
            </button>
          ))}
        </div>
        <select value={period} onChange={e => setPeriod(e.target.value)} className="border rounded px-3 py-1 text-sm">
          <option value="today">今天</option>
          <option value="week">近 7 天</option>
          <option value="month">近 30 天</option>
          <option value="all">全部</option>
        </select>
      </div>

      {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          {view === "trend" && (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr><th className="text-left px-4 py-3">日期</th><th className="text-left px-4 py-3">请求数</th><th className="text-left px-4 py-3">Token</th></tr>
              </thead>
              <tbody>
                {trend.map((t, i) => (
                  <tr key={i} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2">{t.date}</td>
                    <td className="px-4 py-2">{t.totalRequests.toLocaleString()}</td>
                    <td className="px-4 py-2">{t.totalTokens.toLocaleString()}</td>
                  </tr>
                ))}
                {trend.length === 0 && <tr><td colSpan={3} className="text-center py-8 text-gray-500">暂无数据</td></tr>}
              </tbody>
            </table>
          )}

          {view === "platform" && (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr><th className="text-left px-4 py-3">平台</th><th className="text-left px-4 py-3">请求数</th><th className="text-left px-4 py-3">Token</th><th className="text-left px-4 py-3">错误</th></tr>
              </thead>
              <tbody>
                {platformData.map((p, i) => (
                  <tr key={i} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2">{p.platformName || p.platformId}</td>
                    <td className="px-4 py-2">{p.totalRequests.toLocaleString()}</td>
                    <td className="px-4 py-2">{p.totalTokens.toLocaleString()}</td>
                    <td className="px-4 py-2 text-red-600">{p.errorRequests.toLocaleString()}</td>
                  </tr>
                ))}
                {platformData.length === 0 && <tr><td colSpan={4} className="text-center py-8 text-gray-500">暂无数据</td></tr>}
              </tbody>
            </table>
          )}

          {view === "key" && (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr><th className="text-left px-4 py-3">密钥</th><th className="text-left px-4 py-3">请求数</th><th className="text-left px-4 py-3">Token</th><th className="text-left px-4 py-3">错误</th></tr>
              </thead>
              <tbody>
                {keyData.map((k, i) => (
                  <tr key={i} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2">{k.keyName || k.keyId}</td>
                    <td className="px-4 py-2">{k.totalRequests.toLocaleString()}</td>
                    <td className="px-4 py-2">{k.totalTokens.toLocaleString()}</td>
                    <td className="px-4 py-2 text-red-600">{k.errorRequests.toLocaleString()}</td>
                  </tr>
                ))}
                {keyData.length === 0 && <tr><td colSpan={4} className="text-center py-8 text-gray-500">暂无数据</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
