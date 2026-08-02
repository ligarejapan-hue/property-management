"use client";

import { use, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Save } from "lucide-react";
import {
  DISPLAY_LEVEL_LABELS,
  isDisplayLevelAction,
  isDisplayLevelResource,
  withExclusiveDisplayLevel,
} from "@/lib/permission-display-levels";

const RESOURCES = [
  { key: "property", label: "物件", actions: ["read", "write", "delete"] },
  { key: "owner", label: "オーナー", actions: ["read", "write", "delete"] },
  { key: "owner_name", label: "オーナー名", actions: ["hidden", "masked", "full"] },
  { key: "owner_name_kana", label: "オーナー名カナ", actions: ["hidden", "masked", "full"] },
  { key: "owner_phone", label: "オーナー電話番号", actions: ["hidden", "masked", "full"] },
  { key: "owner_zip", label: "オーナー郵便番号", actions: ["hidden", "masked", "full"] },
  // 住所は「一部表示」(先頭数文字だけ)を実際に使っている(現地担当用の既定)。
  // 選べる形にしていないと、画面上どれも選ばれていないように見えて全表示に
  // 上書きされてしまう。
  { key: "owner_address", label: "オーナー住所", actions: ["hidden", "masked", "partial", "full"] },
  { key: "owner_email", label: "オーナーメールアドレス", actions: ["hidden", "masked", "full"] },
  // 備考は「閲覧のみ」と「編集可」を区別する(編集可だけがメモを書ける)。
  { key: "owner_note", label: "オーナー備考", actions: ["hidden", "masked", "read", "edit"] },
  // 法人番号は既に全テンプレートで設定されているのに、この画面に行が無かった＝
  // 設定されていることが見えず変更もできなかった。
  {
    key: "owner_corporate_number",
    label: "オーナー法人番号",
    actions: ["hidden", "masked", "full"],
  },
  { key: "csv_export", label: "CSVエクスポート", actions: ["read"] },
  { key: "csv_export_personal", label: "CSV個人情報エクスポート", actions: ["read"] },
  // 取込エラー行だけの CSV（個人情報を含むが、対象はその取込ジョブの失敗行のみ）。
  // 全件CSVを解禁せずに事務担当へ渡すための専用権限。
  { key: "import_error_csv", label: "取込エラー行CSV", actions: ["read"] },
  // read_all = 他の担当者が実行した取込も見られる(既定は管理者のみ)。
  { key: "import", label: "インポート", actions: ["write", "read_all"] },
  { key: "user_management", label: "ユーザー管理", actions: ["read", "write", "delete"] },
  { key: "audit_log", label: "監査ログ", actions: ["read"] },
  // 現地調査。quick_capture(巡回なしで撮影) は移動軌跡が残らないため既定 admin のみ。
  // ⚠ users 個別権限画面の RESOURCES と必ず同内容にすること(片方だけだと付与できず 403)。
  {
    key: "field_survey",
    label: "現地調査",
    actions: ["read", "write", "read_all", "manage", "quick_capture"],
  },
  // PR2: 謄本自動取得（admin のみ既定付与。実 API/UIボタンは後続 PR）。
  { key: "registry", label: "謄本自動取得", actions: ["auto_fetch"] },
  // 売却促進DM の AI 生成（課金を伴う高リスク操作。謄本自動取得と同様に専用権限で限定。
  // テンプレートでも付与できるよう users 編集UI と同じ行を置く＝テンプレート運用環境で 403 を防ぐ）。
  { key: "sale_dm", label: "売却促進DM(AI生成・課金)", actions: ["generate"] },
  // S1b-1: 画面保護・謄本PDF権限の土台（enforcement は後続 PR）。
  { key: "screen_protection", label: "画面保護", actions: ["bypass"] },
  { key: "registry_pdf", label: "謄本PDF", actions: ["preview", "download"] },
];

const ACTION_LABELS: Record<string, string> = {
  read: "閲覧",
  write: "編集",
  delete: "削除",
  hidden: "非表示",
  masked: "マスク",
  full: "全表示",
  // S1b-1: 画面保護・謄本PDF権限の土台
  bypass: "保護免除",
  preview: "プレビュー",
  download: "ダウンロード",
  // 謄本自動取得 / 売却促進DM(未登録だと英語コードが生表示される)
  auto_fetch: "自動取得",
  generate: "AI生成",
  // 現地調査
  read_all: "全員分の閲覧",
  manage: "他の人の分も編集",
  quick_capture: "巡回なしで撮影",
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

  // 表示レベル（非表示/マスク/一部表示/閲覧のみ/全表示/編集可）は**項目ごとに1つだけ**。
  // 1つ選ぶと同じ項目の他のレベルは外れる。以前は複数チェックできてしまい、
  // 「マスク」を付けても「全表示」が残ると**生値が出続けた**（緩い方が優先されるため）。
  // 表示レベル以外は従来どおりの単純な on/off。
  function togglePermission(resource: string, action: string) {
    setPermissions((prev) =>
      withExclusiveDisplayLevel(
        prev,
        resource,
        action,
        (r, a) => ({ resource: r, action: a, granted: true }),
        // この画面に「拒否」の概念は無い（granted:false は未選択のチップに見える）。
        // 設定済み扱いにすると、押しても選択されず見えない行が消えるだけになる。
        { deniedRowsAreVisible: false },
      ),
    );
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
      <div className="flex items-center justify-center min-h-screen dark:bg-gray-900">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400 dark:text-gray-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <nav className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/admin" className="hover:text-gray-700 dark:hover:text-gray-200">管理</Link>
        <span className="mx-2">/</span>
        <Link href="/admin/templates" className="hover:text-gray-700 dark:hover:text-gray-200">権限テンプレート一覧</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900 dark:text-gray-100">テンプレート編集</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6">権限テンプレート編集</h1>

      {/* Template info */}
      <div className="mb-8 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="tpl-name" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              テンプレート名 *
            </label>
            <input
              id="tpl-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 dark:bg-gray-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="tpl-desc" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              説明
            </label>
            <textarea
              id="tpl-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 dark:bg-gray-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
        </div>
      </div>

      {/* Permission matrix */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">権限マトリクス</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  リソース
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400" colSpan={8}>
                  アクション
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {RESOURCES.map((res) => {
                const isLevelRow = isDisplayLevelResource(res.key);
                // 既に保存されているのに一覧に無いレベルも必ず出す。出さないと
                // 「設定されているのに画面ではどれも選ばれていない」状態になり、
                // うっかり別のレベルで上書きしてしまう。
                // granted で絞らない（拒否の指定も見えないと管理者が消せない）。
                const storedLevels = isLevelRow
                  ? permissions
                      .filter(
                        (p) =>
                          p.resource === res.key &&
                          isDisplayLevelAction(p.action) &&
                          !res.actions.includes(p.action),
                      )
                      .map((p) => p.action)
                  : [];
                const actions = [...res.actions, ...new Set(storedLevels)];
                return (
                <tr key={res.key} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {res.label}
                    {isLevelRow && (
                      <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">
                        （1つだけ）
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {actions.map((action) => {
                        const granted = isGranted(res.key, action);
                        return (
                          <label
                            key={action}
                            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors ${
                              granted
                                ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300"
                                : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                            }`}
                          >
                            <input
                              // 表示レベルは排他なので radio。選択済みをもう一度押すと
                              // 解除できるよう onChange ではなく onClick で拾う
                              // （radio は checked のとき change が発火しないため）。
                              type={isLevelRow ? "radio" : "checkbox"}
                              name={isLevelRow ? `level-${res.key}` : undefined}
                              checked={granted}
                              readOnly={isLevelRow}
                              onChange={
                                isLevelRow
                                  ? undefined
                                  : () => togglePermission(res.key, action)
                              }
                              onClick={
                                isLevelRow
                                  ? () => togglePermission(res.key, action)
                                  : undefined
                              }
                              className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-700 text-indigo-600 focus:ring-indigo-500 dark:text-indigo-400"
                            />
                            {isLevelRow
                              ? (DISPLAY_LEVEL_LABELS[action] ?? action)
                              : (ACTION_LABELS[action] ?? action)}
                          </label>
                        );
                      })}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Save button */}
      <div className="flex items-center justify-end gap-4">
        {message && (
          <span
            className={`text-sm ${message.includes("失敗") || message.includes("必須") ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
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
