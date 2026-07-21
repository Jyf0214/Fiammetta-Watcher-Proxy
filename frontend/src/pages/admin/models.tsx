import { useState, useEffect } from "react";
import { modelsApi, platformsApi, type ModelMap, type Platform } from "../../lib/api";
import { Waypoints, Plus, Pencil, Trash2 } from "lucide-react";

export function ModelsPage() {
  const [models, setModels] = useState<ModelMap[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<ModelMap>>({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [mRes, pRes] = await Promise.all([modelsApi.list(), platformsApi.list()]);
      setModels(mRes.data);
      setPlatforms(pRes.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!form.alias || !form.targetModel || !form.platformId) {
      setError("别名、目标模型、平台为必填项");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await modelsApi.update(editingId, form);
      } else {
        await modelsApi.create(form);
      }
      setShowForm(false);
      setEditingId(null);
      setForm({});
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除此映射？")) return;
    try {
      await modelsApi.delete(id);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Waypoints size={24} /> 模型映射</h1>
        <button onClick={() => { setShowForm(true); setEditingId(null); setForm({}); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-blue-700">
          <Plus size={16} /> 添加映射
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      {showForm && (
        <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
          <h3 className="font-semibold mb-3">{editingId ? "编辑映射" : "添加映射"}</h3>
          <div className="grid grid-cols-3 gap-3">
            <input placeholder="别名 (如 gpt-4)" value={form.alias || ""} onChange={e => setForm({ ...form, alias: e.target.value })} className="border rounded px-3 py-2" />
            <input placeholder="目标模型" value={form.targetModel || ""} onChange={e => setForm({ ...form, targetModel: e.target.value })} className="border rounded px-3 py-2" />
            <select value={form.platformId || ""} onChange={e => setForm({ ...form, platformId: e.target.value })} className="border rounded px-3 py-2">
              <option value="">选择平台</option>
              {platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleSave} disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">{saving ? "保存中..." : "保存"}</button>
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="border px-4 py-2 rounded hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}

      {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3">别名</th>
                <th className="text-left px-4 py-3">目标模型</th>
                <th className="text-left px-4 py-3">平台</th>
                <th className="text-right px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono">{m.alias}</td>
                  <td className="px-4 py-3 font-mono">{m.targetModel}</td>
                  <td className="px-4 py-3">{m.platformName || m.platformId}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => { setEditingId(m.id); setForm(m); setShowForm(true); }} className="p-1 hover:bg-gray-100 rounded"><Pencil size={14} /></button>
                    <button onClick={() => handleDelete(m.id)} className="p-1 hover:bg-red-50 text-red-600 rounded"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
              {models.length === 0 && <tr><td colSpan={4} className="text-center py-8 text-gray-500">暂无映射</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
