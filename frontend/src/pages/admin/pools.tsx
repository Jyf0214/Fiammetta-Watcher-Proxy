import { useState, useEffect } from "react";
import { poolsApi, type ProxyPool } from "../../lib/api";
import { Layers, Plus, Pencil, Trash2 } from "lucide-react";

export function PoolsPage() {
  const [pools, setPools] = useState<ProxyPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const res = await poolsApi.list();
      setPools(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!name) { setError("名称不能为空"); return; }
    setSaving(true);
    try {
      if (editingId) {
        await poolsApi.update(editingId, { name });
      } else {
        await poolsApi.create({ name });
      }
      setShowForm(false);
      setEditingId(null);
      setName("");
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除？")) return;
    try { await poolsApi.delete(id); load(); } catch (e: unknown) { setError(e instanceof Error ? e.message : "删除失败"); }
  };

  const handleToggle = async (p: ProxyPool) => {
    try { await poolsApi.update(p.id, { enabled: !p.enabled }); load(); } catch (e: unknown) { setError(e instanceof Error ? e.message : "操作失败"); }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Layers size={24} /> 代理池管理</h1>
        <button onClick={() => { setShowForm(true); setEditingId(null); setName(""); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-blue-700">
          <Plus size={16} /> 添加池
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      {showForm && (
        <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
          <h3 className="font-semibold mb-3">{editingId ? "编辑池" : "添加池"}</h3>
          <div className="flex gap-3">
            <input placeholder="池名称" value={name} onChange={e => setName(e.target.value)} className="border rounded px-3 py-2 flex-1" />
            <button onClick={handleSave} disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">保存</button>
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="border px-4 py-2 rounded hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}

      {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr><th className="text-left px-4 py-3">名称</th><th className="text-left px-4 py-3">状态</th><th className="text-right px-4 py-3">操作</th></tr>
            </thead>
            <tbody>
              {pools.map(p => (
                <tr key={p.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium">{p.name}</td>
                  <td className="px-4 py-2"><button onClick={() => handleToggle(p)} className={`px-2 py-0.5 rounded text-xs ${p.enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{p.enabled ? "启用" : "禁用"}</button></td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => { setEditingId(p.id); setName(p.name); setShowForm(true); }} className="p-1 hover:bg-gray-100 rounded"><Pencil size={14} /></button>
                    <button onClick={() => handleDelete(p.id)} className="p-1 hover:bg-red-50 text-red-600 rounded"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
              {pools.length === 0 && <tr><td colSpan={3} className="text-center py-8 text-gray-500">暂无代理池</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
