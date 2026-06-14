"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Loader2, Download, AlertTriangle } from "lucide-react";

// route の AuditResult と対応する最小型（クライアント表示用）。
interface AuditVariant {
  name: string;
  count: number;
  ids: string[];
}
interface AuditGroup {
  key: string;
  variants: AuditVariant[];
  totalRecords: number;
}
interface AuditResult {
  groups: AuditGroup[];
  truncated: boolean;
  /**
   * 権限不足でこの区分がスキャンされなかったことを示す（API が付与）。
   * true のとき groups は空だが「指摘ゼロ（clean）」ではなく「未取得（権限不足）」。
   */
  unavailable?: boolean;
}
interface AuditResponse {
  owner?: AuditResult;
  building?: AuditResult;
}

type Tab = "owner" | "building";

const TAB_LABEL: Record<Tab, string> = {
  owner: "所有者",
  building: "建物",
};

export default function DisplayNameAuditPage() {
  const [tab, setTab] = useState<Tab>("owner");
  const [data, setData] = useState<AuditResponse>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/display-name-audit");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? `取得に失敗しました (${res.status})`,
        );
      }
      const json: AuditResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "表示名監査の取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const current: AuditResult | undefined = data[tab];

  // Codex P1: owner タブは生の所有者名(PII)と正規化キーを表示し得る。既存
  // ScreenProtectionGuard は [data-pii-protected] 領域内でのみ copy/cut/contextmenu/print を
  // 抑止・client 監査するため、owner タブが active のときだけ結果領域を PII 保護領域にする。
  // building は非PII（既存方針）ゆえ無印のままにし、誤って owner surface を付けない。
  const piiSurfaceProps =
    tab === "owner"
      ? { "data-pii-protected": true, "data-pii-surface": "owner" as const }
      : {};

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin/users" className="hover:text-gray-700">
          管理
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">表示名監査</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">表示名監査</h1>
      <p className="text-sm text-gray-500 mb-6">
        同じ正規化名でも、保存されている表示名が全半角・空白違いなどで割れている群を一覧します。
        これは確認用のレポートです（自動統一・更新は行いません）。
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* タブ + CSV ダウンロード */}
      <div className="mb-4 flex items-center justify-between border-b border-gray-200">
        <div className="flex gap-1">
          {(["owner", "building"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                tab === t
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {TAB_LABEL[t]}
              {data[t] ? `（${data[t]!.groups.length}群）` : ""}
            </button>
          ))}
        </div>
        <a
          href={`/api/admin/display-name-audit?format=csv&entity=${tab}`}
          className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
        >
          <Download className="h-4 w-4" />
          CSV ダウンロード
        </a>
      </div>

      {current?.truncated && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            群が上限に達したため、一部のみ表示しています。CSV ダウンロードでも同じ上限が適用されます。
          </span>
        </div>
      )}

      <div
        className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"
        {...piiSurfaceProps}
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : !current || current.groups.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            {/* 3 状態を区別する:
                 - data[tab] === undefined: API がこの区分を返していない（区分非表示）
                 - current.unavailable: 権限不足で未スキャン（clean ではない）
                 - それ以外: 実スキャン済みで指摘ゼロ（clean）
                未認可を「表記ゆれなし」と誤認させない（Codex P2 是正）。 */}
            {data[tab] === undefined || current?.unavailable
              ? "権限が不足しているため、この区分は確認できませんでした（表記ゆれの有無は不明です）。"
              : "表記ゆれは見つかりませんでした。"}
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  正規化キー
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  表示名のバリアント（件数）
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  総レコード数
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {current.groups.map((group) => (
                <tr key={group.key} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-3 text-sm font-mono text-gray-700 break-all">
                    {group.key}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    <ul className="space-y-1">
                      {group.variants.map((v) => (
                        <li
                          key={v.name}
                          className="flex items-center gap-2"
                        >
                          <span className="break-all">{v.name}</span>
                          <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                            {v.count} 件
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium text-gray-700">
                    {group.totalRecords}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
