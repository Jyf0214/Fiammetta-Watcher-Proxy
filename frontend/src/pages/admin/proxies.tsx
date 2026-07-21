import { useState, useEffect } from "react";
import { proxiesApi, poolsApi, type Proxy, type ProxyPool } from "../../lib/api";
import { Wifi, Plus, Trash2, Upload } from "lucide-react";

export function ProxiesPage() {
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [pools, setPools] = useState<ProxyPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPoolId, setImportPoolId] = useState("");
  const [form, setForm] = useState<{ address: string; poolId?: string }>({ address: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [pRes, lRes] = await Promise.all([proxiesApi.list(), poolsApi.list()]);
      setProxies(pRes.data);
      setPools(lRes.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!form.address) { setError("地址不能为空"); return; }
    setSaving(true);
    try {
      await proxiesApi.create(form);
      setShowForm(false);
      setForm({ address: "" });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    const lines = importText.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { setError("请输入至少一个代理地址"); return; }
    setSaving(true);
    try {
      const res = await proxiesApi.import(lines, importPoolId || undefined);
      setShowImport(false);
      setImportText("");
      alert(`成功导入 ${res.data.imported} 个代理`);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除？")) return;
    try { await proxiesApi.delete(id); load(); } catch (e: unknown) { setError(e instanceof Error ? e.message : "删除失败"); }
  };

  const handleToggle = async (p: Proxy) => {
    try { await proxiesApi.update(p.id, { enabled: !p.enabled }); load(); } catch (e: unknown) { setError(e instanceof Error ? e.message : "操作失败"); }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Wifi size={24} /> 代理管理</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowImport(true)} className="bg-gray-600 text-white px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-gray-700"><Upload size={16} /> 批量导入</button>
          <button onClick={() => { setShowForm(true); setForm({ address: "" }); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-blue-700"><Plus size={16} /> 添加</button>
        </div>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      {showForm && (
        <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
          <h3 className="font-semibold mb-3">添加代理</h3>
          <div className="flex gap-3">
            <input placeholder="地址 (http://host:port)" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className="border rounded px-3 py-2 flex-1" />
            <select value={form.poolId || ""} onChange={e => setForm({ ...form, poolId: e.target.value || undefined })} className="border rounded px-3 py-2">
              <option value="">无池</option>
              {pools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button onClick={handleCreate} disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">添加</button>
            <button onClick={() => setShowForm(false)} className="border px-4 py-2 rounded hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}

      {showImport && (
        <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
          <h3 className="font-semibold mb-3">批量导入（每行一个地址）</h3>
          <textarea value={importText} onChange={e => setImportText(e.target.value)} placeholder="http://proxy1:8080&#10;http://proxy2:8080" className="border rounded px-3 py-2 w-full h-32 font-mono text-sm" />
          <div className="flex gap-3 mt-3">
            <select value={importPoolId} onChange={e => setImportPoolId(e.target.value)} className="border rounded px-3 py-2">
              <option value="">无池</option>
              {pools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button onClick={handleImport} disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">{saving ? "导入中..." : "导入"}</button>
            <button onClick={() => setShowImport(false)} className="border px-4 py-2 rounded hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}

      {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3">地址</th>
                <th className="text-left px-4 py-3">池</th>
                <th className="text-left px-4 py-3">状态</th>
                <th className="text-left px-4 py-3">失败</th>
                <th className="text-right px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {proxies.map(p => (
                <tr key={p.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">{p.address}</td>
                  <td className="px-4 py-2">{pools.find(l => l.id === p.poolId)?.name || "-"}</td>
                  <td className="px-4 py-2"><button onClick={() => handleToggle(p)} className={`px-2 py-0.5 rounded text-xs ${p.enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{p.enabled ? "启用" : "禁用"}</button></td>
                  <td className="px-4 py-2">{p.failCount}</td>
                  <td className="px-4 py-3 text-right"><button onClick={() => handleDelete(p.id)} className="p-1 hover:bg-red-50 text-red-600 rounded"><Trash2 size={14} /></button></td>
                </tr>
              ))}
              {proxies.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-500">暂无代理</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
