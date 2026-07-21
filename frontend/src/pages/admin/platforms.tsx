import { useState, useEffect } from "react";
import { platformsApi, type Platform } from "../../lib/api";
import { Server, Plus, Pencil, Trash2, ChevronDown, ChevronUp } from "lucide-react";

export function PlatformsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Platform>>({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const res = await platformsApi.list();
      setPlatforms(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!form.name || !form.baseUrl || !form.apiKey) {
      setError("name、baseUrl、apiKey 为必填项");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await platformsApi.update(editingId, form);
      } else {
        await platformsApi.create(form);
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
    if (!confirm("确定删除此平台？")) return;
    try {
      await platformsApi.delete(id);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleToggle = async (p: Platform) => {
    try {
      await platformsApi.update(p.id, { enabled: !p.enabled });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Server size={24} /> 平台管理</h1>
        <button onClick={() => { setShowForm(true); setEditingId(null); setForm({}); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-blue-700">
          <Plus size={16} /> 添加平台
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      {showForm && (
        <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
          <h3 className="font-semibold mb-3">{editingId ? "编辑平台" : "添加平台"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="名称" value={form.name || ""} onChange={e => setForm({ ...form, name: e.target.value })} className="border rounded px-3 py-2" />
            <input placeholder="Base URL" value={form.baseUrl || ""} onChange={e => setForm({ ...form, baseUrl: e.target.value })} className="border rounded px-3 py-2" />
            <input placeholder="API Key" value={form.apiKey || ""} onChange={e => setForm({ ...form, apiKey: e.target.value })} className="border rounded px-3 py-2" />
            <select value={form.type || "openai"} onChange={e => setForm({ ...form, type: e.target.value })} className="border rounded px-3 py-2">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="custom">自定义</option>
            </select>
            <input type="number" placeholder="优先级" value={form.priority ?? 0} onChange={e => setForm({ ...form, priority: Number(e.target.value) })} className="border rounded px-3 py-2" />
            <input type="number" placeholder="权重" value={form.weight ?? 1} onChange={e => setForm({ ...form, weight: Number(e.target.value) })} className="border rounded px-3 py-2" />
            <input type="number" placeholder="RPM 限制" value={form.rpmLimit ?? ""} onChange={e => setForm({ ...form, rpmLimit: e.target.value ? Number(e.target.value) : null })} className="border rounded px-3 py-2" />
            <input type="number" placeholder="TPM 限制" value={form.tpmLimit ?? ""} onChange={e => setForm({ ...form, tpmLimit: e.target.value ? Number(e.target.value) : null })} className="border rounded px-3 py-2" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleSave} disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">{saving ? "保存中..." : "保存"}</button>
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="border px-4 py-2 rounded hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}

      {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
        <div className="space-y-2">
          {platforms.map(p => (
            <div key={p.id} className="bg-white border rounded-lg shadow-sm">
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${p.status === "healthy" ? "bg-green-500" : p.status === "degraded" ? "bg-yellow-500" : "bg-red-500"}`} />
                  <div>
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-sm text-gray-500 ml-2">{p.baseUrl}</span>
                    <span className="text-xs text-gray-400 ml-2">P{p.priority} W{p.weight}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleToggle(p)} className={`px-2 py-1 rounded text-xs ${p.enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {p.enabled ? "已启用" : "已禁用"}
                  </button>
                  <button onClick={() => setExpandedId(expandedId === p.id ? null : p.id)} className="p-1 hover:bg-gray-100 rounded">
                    {expandedId === p.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                  <button onClick={() => { setEditingId(p.id); setForm(p); setShowForm(true); }} className="p-1 hover:bg-gray-100 rounded"><Pencil size={16} /></button>
                  <button onClick={() => handleDelete(p.id)} className="p-1 hover:bg-red-50 text-red-600 rounded"><Trash2 size={16} /></button>
                </div>
              </div>
              {expandedId === p.id && (
                <div className="border-t p-4 text-sm text-gray-600 grid grid-cols-3 gap-2">
                  <div>类型: {p.type}</div>
                  <div>失败次数: {p.failCount}</div>
                  <div>RPM: {p.rpmLimit || "无限制"}</div>
                  <div>TPM: {p.tpmLimit || "无限制"}</div>
                  <div>创建: {new Date(p.createdAt).toLocaleString()}</div>
                  <div>更新: {new Date(p.updatedAt).toLocaleString()}</div>
                </div>
              )}
            </div>
          ))}
          {platforms.length === 0 && <div className="text-center py-8 text-gray-500">暂无平台</div>}
        </div>
      )}
    </div>
  );
}
