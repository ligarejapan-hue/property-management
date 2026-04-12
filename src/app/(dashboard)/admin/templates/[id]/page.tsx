"use client";

import { use, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Save } from "lucide-react";

const RESOURCES = [
  { key: "property", label: "物件", actions: ["read", "write", "delete"] },
  { key: "owner", label: "オーナー", actions: ["read", "write", "delete"] },
  { key: "owner_name", label: "オーナー名", actions: ["hidden", "masked", "full"] },
  { key: "owner_phone", label: "オーナー電話番号", actions: ["hidden", "masked", "full"] },
  { key: "owner_zip", label: "オーナー郵便番号", actions: ["hidden", "masked", "full"] },
  { key: "owner_address", label: "オーナー住所", actions: ["hidden", "masked", "full"] },
  { key: "owner_note", label: "オーナー備考", actions: ["hidden", "masked", "full"] },
  { key: "csv_export", label: "CSVエクスポート", actions: ["read"] },
  { key: "csv_export_personal", label: "CSV個人情報エクスポート", actions: ["read"] },
  { key: "import", label: "インポート", actions: ["write"] },
  { key: "user_management", label: "ユーザー管理", actions: ["read", "write", "delete"] },
  { key: "audit_log", label: "監査ログ", actions: ["read"] },
];

const ACTION_LABELS: Record<string, string> = {
  read: "閲覧",
  write: "編集",
  delete: "削除",
  hidden: "非表示",
  masked: "マスク",
  full: "全表示",
};

interface TemplatePermission {
  resource: string;
  action: string;
  granted: boolean;
}

export default function TemplateEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<TemplatePermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const fetchTemplate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/templates/${id}`);
      if (!res.ok) {
        if (res.status === 404) {
          router.push("/admin/templates");
          return;
        }
        throw new Error("Failed to fetch");
      }
      const json = await res.json();
      const tpl = json.data;
      setName(tpl.name);
      setDescription(tpl.description ?? "");
      setPermissions(
        tpl.templatePermissions.map((p: TemplatePermission) => ({
          resource: p.resource,
          action: p.action,
          granted: p.granted,
        })),
      );
    } catch {
      console.error("Failed to fetch template");
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    fetchTemplate();
  }, [fetchTemplate]);

  function isGranted(resource: string, action: string): boolean {
    return permissions.some(
      (p) => p.resource === resource && p.action === action && p.granted,
    );
  }

  function togglePermission(resource: string, action: string) {
    setPermissions((prev) => {
      const existing = prev.find(
        (p) => p.resource === resource && p.action === action,
      );
      if (existing) {
        // Remove it
        return prev.filter(
          (p) => !(p.resource === resource && p.action === action),
        );
      }
      // Add it
      return [...prev, { resource, action, granted: true }];
    });
  }

  async function handleSave() {
    if (!name.trim()) {
      setMessage("テンプレート名は必須です");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/templates/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          permissions,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "保存に失敗しました");
      }
      setMessage("テンプレートを保存しました");
      setTimeout(() => setMessage(""), 3000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin" className="hover:text-gray-700">管理</Link>
        <span className="mx-2">/</span>
        <Link href="/admin/templates" className="hover:text-gray-700">権限テンプレート一覧</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">テンプレート編集</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">権限テンプレート編集</h1>

      {/* Template info */}
      <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="tpl-name" className="block text-sm font-medium text-gray-700 mb-1">
              テンプレート名 *
            </label>
            <input
              id="tpl-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="tpl-desc" className="block text-sm font-medium text-gray-700 mb-1">
              説明
            </label>
            <textarea
              id="tpl-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
        </div>
      </div>

      {/* Permission matrix */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">権限マトリクス</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">
                  リソース
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500" colSpan={8}>
                  アクション
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {RESOURCES.map((res) => (
                <tr key={res.key} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">
                    {res.label}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {res.actions.map((action) => {
                        const granted = isGranted(res.key, action);
                        return (
                          <label
                            key={action}
                            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors ${
                              granted
                                ? "bg-indigo-100 text-indigo-800"
                                : "bg-gray-100 text-gray-500"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={granted}
                              onChange={() => togglePermission(res.key, action)}
                              className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            {ACTION_LABELS[action] ?? action}
                          </label>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Save button */}
      <div className="flex items-center justify-end gap-4">
        {message && (
          <span
            className={`text-sm ${message.includes("失敗") || message.includes("必須") ? "text-red-600" : "text-green-600"}`}
          >
            {message}
          </span>
        )}
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-6 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          保存
        </button>
      </div>
    </div>
  );
}
