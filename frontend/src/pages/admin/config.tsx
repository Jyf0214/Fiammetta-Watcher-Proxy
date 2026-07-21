import { useState, useEffect } from "react";
import { configApi, authApi } from "../../lib/api";
import { Settings, Save, Lock } from "lucide-react";

export function ConfigPage() {
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [pwForm, setPwForm] = useState({ current: "", new: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const res = await configApi.get();
      setConfigs(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await configApi.update(configs);
      setMsg("保存成功");
      setTimeout(() => setMsg(""), 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleChangePw = async () => {
    if (!pwForm.current || !pwForm.new) { setError("请填写完整"); return; }
    if (pwForm.new !== pwForm.confirm) { setError("两次密码不一致"); return; }
    setPwSaving(true);
    try {
      await authApi.changePassword(pwForm.current, pwForm.new);
      setPwForm({ current: "", new: "", confirm: "" });
      setMsg("密码修改成功");
      setTimeout(() => setMsg(""), 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "修改失败");
    } finally {
      setPwSaving(false);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold flex items-center gap-2 mb-6"><Settings size={24} /> 系统设置</h1>

      {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4">{error}<button onClick={() => setError("")} className="float-right">✕</button></div>}
      {msg && <div className="bg-green-50 text-green-700 p-3 rounded-lg mb-4">{msg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 配置项 */}
        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <h2 className="font-semibold mb-3">系统配置</h2>
          {loading ? <div className="text-gray-500">加载中...</div> : (
            <div className="space-y-3">
              {Object.entries(configs).map(([key, value]) => (
                <div key={key}>
                  <label className="text-sm text-gray-600">{key}</label>
                  <input value={value} onChange={e => setConfigs({ ...configs, [key]: e.target.value })} className="w-full border rounded px-3 py-2 text-sm mt-1" />
                </div>
              ))}
              {Object.keys(configs).length === 0 && <div className="text-gray-500 text-sm">暂无配置</div>}
              <button onClick={handleSave} disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded flex items-center gap-1 hover:bg-blue-700 disabled:opacity-50">
                <Save size={14} /> {saving ? "保存中..." : "保存配置"}
              </button>
            </div>
          )}
        </div>

        {/* 修改密码 */}
        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <h2 className="font-semibold mb-3 flex items-center gap-1"><Lock size={16} /> 修改密码</h2>
          <div className="space-y-3">
            <input type="password" placeholder="当前密码" value={pwForm.current} onChange={e => setPwForm({ ...pwForm, current: e.target.value })} className="w-full border rounded px-3 py-2" />
            <input type="password" placeholder="新密码" value={pwForm.new} onChange={e => setPwForm({ ...pwForm, new: e.target.value })} className="w-full border rounded px-3 py-2" />
            <input type="password" placeholder="确认新密码" value={pwForm.confirm} onChange={e => setPwForm({ ...pwForm, confirm: e.target.value })} className="w-full border rounded px-3 py-2" />
            <button onClick={handleChangePw} disabled={pwSaving} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">{pwSaving ? "修改中..." : "修改密码"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
