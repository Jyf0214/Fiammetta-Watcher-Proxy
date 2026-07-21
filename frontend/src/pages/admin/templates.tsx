import { useState, useEffect } from "react";
import { templatesApi, type RequestTemplate } from "../../lib/api";
import { FileCode, Plus, Trash2, ToggleLeft, ToggleRight } from "lucide-react";

export function TemplatesPage() {
  const [templates, setTemplates] = useState<RequestTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Partial<RequestTemplate>>({ mergeBody: {} });
  const [bodyText, setBodyText] = useState("{}");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const res = await templatesApi.list();
      setTemplates(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!form.name) { setError("名称不能为空"); return; }
    let mergeBody: Record<string, unknown>;
    try {
      mergeBody = JSON.parse(bodyText);
    } catch {
      setError("mergeBody JSON 格式错误");
      return;
    }
    setSaving(true);
    try {
      await templatesApi.save({ ...form, mergeBody, id: form.id || crypto.randomUUID() } as RequestTemplate);
      setShowForm(false);
      setForm({ mergeBody: {} });
      setBodyText("{}");
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除？")) return;
    try { await templatesApi.delete(id); load(); } catch (e: unknown) { setError(e instanceof Error ? e.message : "删除失败"); }
  };

  const handleToggle = async (t: RequestTemplate) => {
    try {
      await templatesApi.save({ ...t, enabled: !t.enabled });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "操作失败"); }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><FileCode size={24} /> 请求模板</h1>
        <button onClick={() => { setShowForm(true); setForm({ mergeBody: {} }); setBodyText("{}"); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-blue-700">
          <Plus size={16} /> 添加模板
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      {showForm && (
        <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
          <h3 className="font-semibold mb-3">{form.id ? "编辑模板" : "添加模板"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="名称" value={form.name || ""} onChange={e => setForm({ ...form, name: e.target.value })} className="border rounded px-3 py-2" />
            <input placeholder="描述" value={form.description || ""} onChange={e => setForm({ ...form, description: e.target.value })} className="border rounded px-3 py-2" />
            <select value={form.endpoint || "all"} onChange={e => setForm({ ...form, endpoint: e.target.value })} className="border rounded px-3 py-2">
              <option value="all">所有端点</option>
              <option value="chat/completions">Chat Completions</option>
              <option value="completions">Completions</option>
              <option value="embeddings">Embeddings</option>
            </select>
          </div>
          <div className="mt-3">
            <label className="text-sm text-gray-600">Merge Body (JSON)</label>
            <textarea value={bodyText} onChange={e => setBodyText(e.target.value)} className="w-full border rounded px-3 py-2 font-mono text-sm h-32 mt-1" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleSave} disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">{saving ? "保存中..." : "保存"}</button>
            <button onClick={() => { setShowForm(false); setForm({ mergeBody: {} }); }} className="border px-4 py-2 rounded hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}

      {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
        <div className="space-y-2">
          {templates.map(t => (
            <div key={t.id} className="bg-white border rounded-lg p-4 shadow-sm flex items-center justify-between">
              <div>
                <span className="font-semibold">{t.name}</span>
                <span className="text-sm text-gray-500 ml-2">{t.endpoint}</span>
                {t.description && <span className="text-xs text-gray-400 ml-2">{t.description}</span>}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleToggle(t)} className="text-gray-500 hover:text-gray-700">
                  {t.enabled ? <ToggleRight size={20} className="text-green-500" /> : <ToggleLeft size={20} />}
                </button>
                <button onClick={() => { setForm(t); setBodyText(JSON.stringify(t.mergeBody, null, 2)); setShowForm(true); }} className="text-blue-600 text-sm">编辑</button>
                <button onClick={() => handleDelete(t.id)} className="p-1 hover:bg-red-50 text-red-600 rounded"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {templates.length === 0 && <div className="text-center py-8 text-gray-500">暂无模板</div>}
        </div>
      )}
    </div>
  );
}
