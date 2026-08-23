"use client";

import { use, useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/ui/page-header";
import Link from "next/link";
import { Loader2, Save } from "lucide-react";
import { ROLE_LABELS } from "@/lib/role-labels";
import {
  DISPLAY_LEVEL_LABELS,
  isDisplayLevelAction,
  isDisplayLevelResource,
  withExclusiveDisplayLevel,
} from "@/lib/permission-display-levels";

// ⚠テンプレート編集画面（admin/templates/[id]）の RESOURCES と必ず同内容にすること
//   （片方だけだとテンプレ運用環境で付与できず必ず 403。sale_dm で実際に起きた事故）。
const RESOURCES = [
  { key: "property", label: "物件", actions: ["read", "write", "delete"] },
  { key: "owner", label: "オーナー", actions: ["read", "write", "delete"] },
  { key: "owner_name", label: "オーナー名", actions: ["hidden", "masked", "full"] },
  { key: "owner_name_kana", label: "オーナー名カナ", actions: ["hidden", "masked", "full"] },
  { key: "owner_phone", label: "オーナー電話番号", actions: ["hidden", "masked", "full"] },
  { key: "owner_zip", label: "オーナー郵便番号", actions: ["hidden", "masked", "full"] },
  // 住所は「一部表示」(先頭数文字だけ)を実際に使っている(現地担当用の既定)。
  { key: "owner_address", label: "オーナー住所", actions: ["hidden", "masked", "partial", "full"] },
  { key: "owner_email", label: "オーナーメールアドレス", actions: ["hidden", "masked", "full"] },
  // 備考は「閲覧のみ」と「編集可」を区別する(編集可だけがメモを書ける)。
  { key: "owner_note", label: "オーナー備考", actions: ["hidden", "masked", "read", "edit"] },
  // 法人番号は既に全テンプレートで設定されているのに、この画面に行が無かった。
  {
    key: "owner_corporate_number",
    label: "オーナー法人番号",
    actions: ["hidden", "masked", "full"],
  },
  { key: "csv_export", label: "CSVエクスポート", actions: ["read"] },
  { key: "csv_export_personal", label: "CSV個人情報エクスポート", actions: ["read"] },
  // 取込エラー行だけの CSV（個人情報を含むが、対象はその取込ジョブの失敗行のみ）。
  // 全件CSVを解禁せずに事務担当へ渡すための専用権限。
  // ⚠ templates 画面の RESOURCES と必ず同内容にすること。
  { key: "import_error_csv", label: "取込エラー行CSV", actions: ["read"] },
  // read_all = 他の担当者が実行した取込も見られる(既定は管理者のみ)。
  { key: "import", label: "インポート", actions: ["write", "read_all", "manage"] },
  { key: "user_management", label: "ユーザー管理", actions: ["read", "write", "delete"] },
  { key: "audit_log", label: "監査ログ", actions: ["read"] },
  // 現地調査。quick_capture(巡回なしで撮影) は移動軌跡が残らないため既定 admin のみ。
  // ⚠ templates 画面の RESOURCES と必ず同内容にすること(片方だけだとテンプレ運用環境で
  //   付与できず必ず 403 になる。sale_dm で実際に起きた事故)。
  {
    key: "field_survey",
    label: "現地調査",
    actions: ["read", "write", "read_all", "manage", "quick_capture"],
  },
  // PR2: 謄本自動取得（admin のみ既定付与。実 API/UIボタンは後続 PR）。
  { key: "registry", label: "謄本自動取得", actions: ["auto_fetch"] },
  // 売却促進DM の AI 生成（課金を伴う高リスク操作。謄本自動取得と同様に専用権限で限定）。
  // ⚠廃止（@codex #376 R7）。AI直結をやめたのでこの権限は何の効果も持たない。
  //   既存の付与を隠さないよう選択肢は残すが、ラベルで「効果なし」と明示する。
  { key: "sale_dm", label: "売却促進DM(廃止・効果なし)", actions: ["generate"] },
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
  // 謄本自動取得 / 売却促進DM(B-5: 英語コードの生表示を避ける)
  auto_fetch: "自動取得",
  generate: "AI生成",
  // 現地調査
  read_all: "全員分の閲覧",
  manage: "他の人の分も編集",
  quick_capture: "巡回なしで撮影",
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
    // 表示レベルは項目ごとに1つだけ効く。この項目に「このレベルにする」という個別
    // 指定があるなら、テンプレート側の別レベルはもう効かない（サーバ側の合成と同じ
    // 規則）。ここを揃えないと、画面では両方が有効に見えるのに実際は片方だけ、という
    // 食い違いが出る。
    if (isDisplayLevelResource(resource) && isDisplayLevelAction(action)) {
      const overriddenByAnotherLevel = overrides.some(
        (o) =>
          o.resource === resource &&
          o.granted &&
          isDisplayLevelAction(o.action) &&
          o.action !== action,
      );
      if (overriddenByAnotherLevel) {
        return { granted: false, source: "none" };
      }
    }
    if (isTemplateGranted(resource, action)) {
      return { granted: true, source: "template" };
    }
    return { granted: false, source: "none" };
  }

  function toggleOverride(resource: string, action: string) {
    // 表示レベルは**項目ごとに1つだけ**。ここは「付与/拒否/既定」の3状態ではなく、
    // 「このレベルにする / 個別指定をやめてテンプレートに戻す」の2状態にする
    // （レベルは択一なので「このレベルを拒否」という指定に意味がない）。
    // 1つ選ぶと同じ項目の他のレベル指定は外れる＝マスクを選んだのに全表示が
    // 残って生値が出続ける、という食い違いが起きない。
    if (isDisplayLevelResource(resource) && isDisplayLevelAction(action)) {
      setOverrides((prev) =>
        withExclusiveDisplayLevel(prev, resource, action, (r, a) => ({
          resource: r,
          action: a,
          granted: true,
        })),
      );
      return;
    }
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
        <Loader2 className="h-8 w-8 animate-spin text-gray-400 dark:text-gray-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6 dark:bg-gray-900">
      <nav className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/admin" className="hover:text-gray-700 dark:hover:text-gray-200">管理</Link>
        <span className="mx-2">/</span>
        <Link href="/admin/users" className="hover:text-gray-700 dark:hover:text-gray-200">ユーザー管理</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900 dark:text-gray-100">権限編集</span>
      </nav>

      <PageHeader
        title="ユーザー権限編集"
      />

      {/* User info */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">ユーザー名</dt>
            <dd className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
              {user?.name ?? "不明"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">ロール</dt>
            <dd className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
              {user ? (ROLE_LABELS[user.role] ?? user.role) : "不明"}
            </dd>
          </div>
        </dl>
      </div>

      {/* Template reference */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3 dark:text-gray-100">
          テンプレート参照（比較用）
        </h2>
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <select
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
            className="block w-full max-w-xs rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
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
        <h2 className="text-lg font-semibold text-gray-900 mb-3 dark:text-gray-100">個別権限上書き</h2>
        <p className="text-xs text-gray-500 mb-3 dark:text-gray-400">
          クリックで切り替え: 未設定 → 許可（上書き） → 拒否（上書き） → 未設定（テンプレートに従う）
        </p>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
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
                // 既に設定されているのに一覧に無いレベルも必ず出す。出さないと
                // 「設定されているのに画面ではどれも選ばれていない」状態になり、
                // うっかり別のレベルで上書きしてしまう。
                // ⚠granted で絞らない。拒否の指定（granted:false）も出さないと、
                // 一覧から外したレベル（例: 備考の「全表示」）に拒否が残っている
                // 場合に**画面から見えないのに保存時は往復し続け**、テンプレートを
                // 変えた途端に効き始める。見えなければ管理者は消せない。
                const storedLevels = isLevelRow
                  ? [...overrides, ...templatePerms]
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
                        const resolved = getResolved(res.key, action);
                        let bgColor = "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400";
                        let indicator = "";
                        if (
                          resolved.granted &&
                          resolved.source === "template"
                        ) {
                          bgColor = "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300";
                          indicator = " [T]";
                        } else if (
                          resolved.granted &&
                          resolved.source === "override"
                        ) {
                          bgColor = "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300";
                          indicator = " [O]";
                        } else if (
                          !resolved.granted &&
                          resolved.source === "override"
                        ) {
                          bgColor = "bg-red-100 text-red-800 line-through dark:bg-red-500/15 dark:text-red-300";
                          indicator = " [O]";
                        }
                        return (
                          <button
                            key={action}
                            type="button"
                            onClick={() => toggleOverride(res.key, action)}
                            className={`inline-flex items-center rounded px-2.5 py-1 text-xs font-medium ${bgColor} hover:opacity-80 transition-opacity cursor-pointer`}
                          >
                            {isLevelRow
                              ? (DISPLAY_LEVEL_LABELS[action] ?? action)
                              : (ACTION_LABELS[action] ?? action)}
                            {indicator}
                          </button>
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

        {/* Legend */}
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-600 dark:text-gray-300">
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-blue-100 border border-blue-300 dark:bg-blue-500/15 dark:border-blue-500/30" />
            テンプレートで許可 [T]
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-green-100 border border-green-300 dark:bg-green-500/15 dark:border-green-500/30" />
            上書きで許可 [O]
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-red-100 border border-red-300 dark:bg-red-500/15 dark:border-red-500/30" />
            上書きで拒否 [O]
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-gray-100 border border-gray-300 dark:bg-gray-800 dark:border-gray-700" />
            未許可
          </span>
        </div>
      </section>

      {/* Save button */}
      <div className="flex items-center justify-end gap-4">
        {message && (
          <span
            className={`text-sm ${message.includes("失敗") ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
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
