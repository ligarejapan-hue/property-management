"use client";

import { use, useState, useEffect, useCallback } from "react";
import Link from "next/link";
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

interface Override {
  resource: string;
  action: string;
  granted: boolean;
}

interface Template {
  id: string;
  name: string;
  description: string | null;
  templatePermissions: { resource: string; action: string; granted: boolean }[];
}

interface UserInfo {
  id: string;
  name: string | null;
  role: string;
}

export default function UserPermissionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${id}/permissions`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      setUser(json.user);
      setOverrides(json.overrides.map((o: Override & { id?: string }) => ({
        resource: o.resource,
        action: o.action,
        granted: o.granted,
      })));
      setTemplates(json.templates);
    } catch {
      console.error("Failed to fetch permissions");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Get template permissions for display
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const templatePerms = selectedTemplate?.templatePermissions ?? [];

  function isTemplateGranted(resource: string, action: string): boolean {
    return templatePerms.some(
      (p) => p.resource === resource && p.action === action && p.granted,
    );
  }

  function getOverride(resource: string, action: string): boolean | null {
    const o = overrides.find(
      (ov) => ov.resource === resource && ov.action === action,
    );
    if (!o) return null;
    return o.granted;
  }

  function getResolved(
    resource: string,
    action: string,
  ): { granted: boolean; source: "template" | "override" | "none" } {
    const override = getOverride(resource, action);
    if (override !== null) {
      return { granted: override, source: "override" };
    }
    if (isTemplateGranted(resource, action)) {
      return { granted: true, source: "template" };
    }
    return { granted: false, source: "none" };
  }

  function toggleOverride(resource: string, action: string) {
    setOverrides((prev) => {
      const existing = prev.find(
        (o) => o.resource === resource && o.action === action,
      );
      if (!existing) {
        // No override → add grant override
        return [...prev, { resource, action, granted: true }];
      }
      if (existing.granted) {
        // Grant override → deny override
        return prev.map((o) =>
          o.resource === resource && o.action === action
            ? { ...o, granted: false }
            : o,
        );
      }
      // Deny override → remove (back to template default)
      return prev.filter(
        (o) => !(o.resource === resource && o.action === action),
      );
    });
  }

  async function handleSave() {
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/users/${id}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "保存に失敗しました");
      }
      setMessage("権限を保存しました");
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
        <Link href="/admin/users" className="hover:text-gray-700">ユーザー管理</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">権限編集</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">ユーザー権限編集</h1>

      {/* User info */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs font-medium text-gray-500">ユーザー名</dt>
            <dd className="mt-1 text-sm font-semibold text-gray-900">
              {user?.name ?? "不明"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500">ロール</dt>
            <dd className="mt-1 text-sm font-semibold text-gray-900">
              {user?.role ?? "不明"}
            </dd>
          </div>
        </dl>
      </div>

      {/* Template reference */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          テンプレート参照（比較用）
        </h2>
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <select
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
            className="block w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="">テンプレートを選択して比較</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Individual overrides */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">個別権限上書き</h2>
        <p className="text-xs text-gray-500 mb-3">
          クリックで切り替え: 未設定 → 許可（上書き） → 拒否（上書き） → 未設定（テンプレートに従う）
        </p>
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
                        const resolved = getResolved(res.key, action);
                        let bgColor = "bg-gray-100 text-gray-500";
                        let indicator = "";
                        if (
                          resolved.granted &&
                          resolved.source === "template"
                        ) {
                          bgColor = "bg-blue-100 text-blue-800";
                          indicator = " [T]";
                        } else if (
                          resolved.granted &&
                          resolved.source === "override"
                        ) {
                          bgColor = "bg-green-100 text-green-800";
                          indicator = " [O]";
                        } else if (
                          !resolved.granted &&
                          resolved.source === "override"
                        ) {
                          bgColor = "bg-red-100 text-red-800 line-through";
                          indicator = " [O]";
                        }
                        return (
                          <button
                            key={action}
                            type="button"
                            onClick={() => toggleOverride(res.key, action)}
                            className={`inline-flex items-center rounded px-2.5 py-1 text-xs font-medium ${bgColor} hover:opacity-80 transition-opacity cursor-pointer`}
                          >
                            {ACTION_LABELS[action] ?? action}
                            {indicator}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-600">
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-blue-100 border border-blue-300" />
            テンプレートで許可 [T]
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-green-100 border border-green-300" />
            上書きで許可 [O]
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-red-100 border border-red-300" />
            上書きで拒否 [O]
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-gray-100 border border-gray-300" />
            未許可
          </span>
        </div>
      </section>

      {/* Save button */}
      <div className="flex items-center justify-end gap-4">
        {message && (
          <span
            className={`text-sm ${message.includes("失敗") ? "text-red-600" : "text-green-600"}`}
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
