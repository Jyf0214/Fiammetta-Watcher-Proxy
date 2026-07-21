import { useState, useEffect } from "react";
import { keysApi, type ApiKey } from "../../lib/api";
import { Key, Plus, Pencil, Trash2, Copy, Check } from "lucide-react";

export function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<ApiKey>>({});
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const res = await keysApi.list();
      setKeys(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!form.name || !form.key) {
      setError("name 和 key 为必填项");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await keysApi.update(editingId, form);
      } else {
        await keysApi.create(form);
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
    if (!confirm("确定删除此密钥？")) return;
    try {
      await keysApi.delete(id);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleCopy = (key: string, id: string) => {
    navigator.clipboard.writeText(key);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const statusColor = (s: string) => s === "active" ? "bg-green-100 text-green-700" : s === "disabled" ? "bg-gray-100 text-gray-500" : "bg-red-100 text-red-700";
  const statusText = (s: string) => s === "active" ? "活跃" : s === "disabled" ? "已禁用" : "已过期";

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Key size={24} /> 密钥管理</h1>
        <button onClick={() => { setShowForm(true); setEditingId(null); setForm({}); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-blue-700">
          <Plus size={16} /> 添加密钥
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}

      {showForm && (
        <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
          <h3 className="font-semibold mb-3">{editingId ? "编辑密钥" : "添加密钥"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="名称" value={form.name || ""} onChange={e => setForm({ ...form, name: e.target.value })} className="border rounded px-3 py-2" />
            <input placeholder="API Key (sk-...)" value={form.key || ""} onChange={e => setForm({ ...form, key: e.target.value })} className="border rounded px-3 py-2 font-mono text-sm" />
            <input type="number" placeholder="Token 限额" value={form.tokenLimit ?? ""} onChange={e => setForm({ ...form, tokenLimit: e.target.value ? Number(e.target.value) : null })} className="border rounded px-3 py-2" />
            <input type="number" placeholder="调用次数限额" value={form.callLimit ?? ""} onChange={e => setForm({ ...form, callLimit: e.target.value ? Number(e.target.value) : null })} className="border rounded px-3 py-2" />
            <input type="number" placeholder="RPM 限制" value={form.rpmLimit ?? ""} onChange={e => setForm({ ...form, rpmLimit: e.target.value ? Number(e.target.value) : null })} className="border rounded px-3 py-2" />
            <input type="number" placeholder="TPM 限制" value={form.tpmLimit ?? ""} onChange={e => setForm({ ...form, tpmLimit: e.target.value ? Number(e.target.value) : null })} className="border rounded px-3 py-2" />
            <select value={form.resetPeriod || "monthly"} onChange={e => setForm({ ...form, resetPeriod: e.target.value })} className="border rounded px-3 py-2">
              <option value="monthly">每月重置</option>
              <option value="daily">每天重置</option>
              <option value="never">不重置</option>
            </select>
            <input type="date" placeholder="过期时间" value={form.expiresAt?.slice(0, 10) || ""} onChange={e => setForm({ ...form, expiresAt: e.target.value || null })} className="border rounded px-3 py-2" />
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
                <th className="text-left px-4 py-3">名称</th>
                <th className="text-left px-4 py-3">密钥</th>
                <th className="text-left px-4 py-3">状态</th>
                <th className="text-left px-4 py-3">已用/限额</th>
                <th className="text-left px-4 py-3">重置</th>
                <th className="text-right px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{k.name}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    <span className="flex items-center gap-1">
                      {k.key}
                      <button onClick={() => handleCopy(k.key, k.id)} className="text-gray-400 hover:text-gray-600">
                        {copiedId === k.id ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                      </button>
                    </span>
                  </td>
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded text-xs ${statusColor(k.status)}`}>{statusText(k.status)}</span></td>
                  <td className="px-4 py-3">{k.usedTokens.toLocaleString()} / {k.tokenLimit?.toLocaleString() || "∞"}</td>
                  <td className="px-4 py-3 text-xs">{k.resetPeriod === "monthly" ? "每月" : k.resetPeriod === "daily" ? "每天" : "不重置"}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => { setEditingId(k.id); setForm(k); setShowForm(true); }} className="p-1 hover:bg-gray-100 rounded"><Pencil size={14} /></button>
                    <button onClick={() => handleDelete(k.id)} className="p-1 hover:bg-red-50 text-red-600 rounded"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
              {keys.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-500">暂无密钥</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
