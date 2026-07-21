import { useEffect, useState } from "react";
import { statsApi, ApiError } from "../../lib/api";
import { Activity, Server, Key, FileText, AlertCircle } from "lucide-react";

interface StatsData {
  platformCount?: number;
  keyCount?: number;
  requestCount?: number;
  errorCount?: number;
  totalTokens?: number;
}

/**
 * 管理后台仪表盘
 */
export function AdminDashboard() {
  const [stats, setStats] = useState<StatsData>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const result = await statsApi.overview();
      if (result.success && result.data) {
        setStats(result.data as StatsData);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
        <AlertCircle size={16} />
        {error}
      </div>
    );
  }

  const cards = [
    {
      label: "平台数量",
      value: stats.platformCount ?? 0,
      icon: Server,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      label: "API Key 数量",
      value: stats.keyCount ?? 0,
      icon: Key,
      color: "text-green-600",
      bg: "bg-green-50",
    },
    {
      label: "总请求数",
      value: stats.requestCount ?? 0,
      icon: FileText,
      color: "text-purple-600",
      bg: "bg-purple-50",
    },
    {
      label: "总 Token 用量",
      value: stats.totalTokens ?? 0,
      icon: Activity,
      color: "text-orange-600",
      bg: "bg-orange-50",
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">仪表盘</h1>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="bg-white rounded-xl border border-gray-200 p-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">{card.label}</p>
                  <p className="text-2xl font-bold text-gray-800 mt-1">
                    {typeof card.value === "number"
                      ? card.value.toLocaleString()
                      : card.value}
                  </p>
                </div>
                <div className={`p-3 rounded-lg ${card.bg}`}>
                  <Icon size={24} className={card.color} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 系统信息 */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">系统信息</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">运行时：</span>
            <span className="text-gray-800 font-medium">
              Cloudflare Workers
            </span>
          </div>
          <div>
            <span className="text-gray-500">数据库：</span>
            <span className="text-gray-800 font-medium">Cloudflare D1</span>
          </div>
          <div>
            <span className="text-gray-500">版本：</span>
            <span className="text-gray-800 font-medium">2.0.0</span>
          </div>
        </div>
      </div>
    </div>
  );
}
