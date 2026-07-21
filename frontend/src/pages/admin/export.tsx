import { useState } from "react";
import { exportApi, importApi } from "../../lib/api";
import { Download, Upload } from "lucide-react";

export function ExportPage() {
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [importText, setImportText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleExport = async (type: string) => {
    setLoading(true);
    try {
      const res = await exportApi.data(type);
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fiammetta-export-${type}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg("导出成功");
      setTimeout(() => setMsg(""), 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "导出失败");
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!importText.trim()) { setError("请粘贴导出的 JSON 数据"); return; }
    setLoading(true);
    try {
      const data = JSON.parse(importText);
      const res = await importApi.data(data);
      setImportText("");
      setMsg(`导入成功: ${Object.entries(res.data).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      setTimeout(() => setMsg(""), 5000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold flex items-center gap-2 mb-6"><Download size={24} /> 数据管理</h1>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}
      {msg && <div className="bg-green-50 text-green-700 p-3 rounded-lg mb-4">{msg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 导出 */}
        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <h2 className="font-semibold mb-3 flex items-center gap-1"><Download size={16} /> 导出数据</h2>
          <p className="text-sm text-gray-500 mb-3">选择要导出的数据类型，将下载 JSON 文件。</p>
          <div className="space-y-2">
            <button onClick={() => handleExport("all")} disabled={loading} className="w-full border rounded px-4 py-2 text-left hover:bg-gray-50 disabled:opacity-50">
              <span className="font-medium">全部数据</span>
              <span className="text-sm text-gray-500 ml-2">平台、密钥、模型映射、代理、配置</span>
            </button>
            <button onClick={() => handleExport("system")} disabled={loading} className="w-full border rounded px-4 py-2 text-left hover:bg-gray-50 disabled:opacity-50">
              <span className="font-medium">系统数据</span>
              <span className="text-sm text-gray-500 ml-2">平台、模型映射、套餐、配置</span>
            </button>
            <button onClick={() => handleExport("data")} disabled={loading} className="w-full border rounded px-4 py-2 text-left hover:bg-gray-50 disabled:opacity-50">
              <span className="font-medium">业务数据</span>
              <span className="text-sm text-gray-500 ml-2">密钥、代理、代理池</span>
            </button>
          </div>
        </div>

        {/* 导入 */}
        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <h2 className="font-semibold mb-3 flex items-center gap-1"><Upload size={16} /> 导入数据</h2>
          <p className="text-sm text-gray-500 mb-3">粘贴之前导出的 JSON 数据。重复数据将自动跳过。</p>
          <textarea
            value={importText}
            onChange={e => setImportText(e.target.value)}
            placeholder='粘贴导出的 JSON 数据...'
            className="w-full border rounded px-3 py-2 font-mono text-sm h-48"
          />
          <button onClick={handleImport} disabled={loading || !importText.trim()} className="mt-3 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">
            {loading ? "导入中..." : "开始导入"}
          </button>
        </div>
      </div>
    </div>
  );
}
