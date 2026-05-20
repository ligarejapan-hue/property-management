"use client";

import { useState, useEffect, useCallback } from "react";
import {
  fetchOwnerCorrectionCandidates,
  type OwnerCorrectionCandidate,
  type OwnerCorrectionCandidatesResponse,
} from "@/lib/api-client";
import { AddressFillButton } from "@/components/owners/AddressFillButton";
import { OwnerArchiveButton } from "@/components/owners/OwnerArchiveButton";
import { OwnerMergePreviewButton } from "@/components/owners/OwnerMergePreviewButton";

type FilterType = "all" | "orphan" | "address_null" | "duplicate";

const TYPE_LABELS: Record<string, string> = {
  orphan: "孤立",
  address_null: "住所なし",
  duplicate: "重複候補",
};

const TYPE_BADGE: Record<string, string> = {
  orphan: "bg-orange-100 text-orange-700",
  address_null: "bg-yellow-100 text-yellow-700",
  duplicate: "bg-purple-100 text-purple-700",
};

const ACTION_LABELS: Record<string, string> = {
  hold: "保留",
  review: "要確認",
  delete_candidate: "削除候補",
  merge_candidate: "統合候補",
};

const ACTION_BADGE: Record<string, string> = {
  hold: "bg-gray-100 text-gray-500",
  review: "bg-blue-100 text-blue-700",
  delete_candidate: "bg-red-100 text-red-700",
  merge_candidate: "bg-purple-100 text-purple-700",
};

const BLOCK_REASON_LABELS: Record<string, string> = {
  property_owner_exists: "物件紐づきあり",
  changelog_exists: "変更履歴あり",
  version_gt_1: "手動編集あり",
  external_link_key_exists: "外部キーあり",
  note_exists: "メモあり",
  import_source_unknown: "取込元不明",
  import_row_not_success: "取込行未解決",
};

export default function OwnerCorrectionPage() {
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [data, setData] = useState<OwnerCorrectionCandidatesResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (type: FilterType) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchOwnerCorrectionCandidates(type);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filterType);
  }, [filterType, load]);

  const tabs: { key: FilterType; label: string; count?: number }[] = [
    { key: "all", label: "全て", count: data?.summary.allCount },
    { key: "orphan", label: "孤立", count: data?.summary.orphanCount },
    {
      key: "address_null",
      label: "住所なし",
      count: data?.summary.addressNullCount,
    },
    {
      key: "duplicate",
      label: "重複候補",
      count: data?.summary.duplicateCount,
    },
  ];

  return (
    <div className="p-6">
      <div className="mb-1">
        <h1 className="text-xl font-bold text-gray-900">
          所有者補正候補 (dry-run)
        </h1>
      </div>
      <p className="mb-6 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
        「住所なし」タブの候補には住所補完、「孤立」タブの削除候補にはアーカイブ（soft-delete）、「重複候補」タブの同一キーグループには統合プレビュー（dryRun のみ）を個別実行できます。統合実行・再リンクは未実装です。
      </p>

      {/* Filter tabs */}
      <div className="mb-4 flex gap-0 border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilterType(tab.key)}
            className={`-mb-px px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              filterType === tab.key
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && (
        <p className="py-8 text-center text-sm text-gray-400">読み込み中...</p>
      )}
      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {data && !loading && (
        <>
          <p className="mb-3 text-sm text-gray-500">
            {data.total} 件の確認候補
          </p>

          {/* duplicate タブでは「重複グループサマリー」を上部に追加表示。
              client-side で types.includes("duplicate") の候補を name+address で
              グルーピングし、各グループ内の owner ペアに対して preview を取得できる。
              既存のフラットリストは下にそのまま残す（破壊的変更なし）。 */}
          {filterType === "duplicate" && (
            <DuplicateGroupSummary candidates={data.candidates} />
          )}

          {data.candidates.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              該当する候補はありません
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">氏名</th>
                    <th className="px-3 py-2 text-left font-medium">住所</th>
                    <th className="px-3 py-2 text-left font-medium">
                      郵便番号
                    </th>
                    <th className="px-3 py-2 text-left font-medium">電話</th>
                    <th className="px-3 py-2 text-center font-medium">
                      紐づき数
                    </th>
                    <th className="px-3 py-2 text-center font-medium">
                      変更履歴
                    </th>
                    <th className="px-3 py-2 text-center font-medium">ver</th>
                    <th className="px-3 py-2 text-left font-medium">取込元</th>
                    <th className="px-3 py-2 text-left font-medium">種別</th>
                    <th className="px-3 py-2 text-left font-medium">
                      ブロック理由
                    </th>
                    <th className="px-3 py-2 text-left font-medium">推奨</th>
                    <th className="px-3 py-2 text-left font-medium">ID</th>
                    <th className="px-3 py-2 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.candidates.map((c: OwnerCorrectionCandidate) => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium text-gray-900">
                        {c.name ?? (
                          <span className="text-gray-400">***</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.address ?? (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.zip ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.phone ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span
                          className={
                            c.propertyOwnerCount === 0
                              ? "font-medium text-orange-600"
                              : "text-gray-700"
                          }
                        >
                          {c.propertyOwnerCount}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center text-gray-700">
                        {c.changeLogCount}
                      </td>
                      <td className="px-3 py-2 text-center text-gray-700">
                        {c.version}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-500">
                        {c.importFileName ? (
                          `${c.importFileName}:${c.importRowNumber}行`
                        ) : (
                          <span className="text-gray-400">不明</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {c.types.map((t) => (
                            <span
                              key={t}
                              className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${
                                TYPE_BADGE[t] ?? "bg-gray-100 text-gray-600"
                              }`}
                            >
                              {TYPE_LABELS[t] ?? t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {c.blockReasons.map((r) => (
                            <span
                              key={r}
                              className="rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500"
                            >
                              {BLOCK_REASON_LABELS[r] ?? r}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            ACTION_BADGE[c.recommendedAction] ??
                            "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {ACTION_LABELS[c.recommendedAction] ??
                            c.recommendedAction}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-gray-400">
                        {c.id.slice(0, 8)}…
                      </td>
                      <td className="px-3 py-2">
                        {c.types.includes("address_null") && (
                          <AddressFillButton
                            ownerId={c.id}
                            ownerVersion={c.version}
                            previewAddress={null}
                            onSuccess={() => load(filterType)}
                          />
                        )}
                        {filterType === "orphan" &&
                          c.recommendedAction === "delete_candidate" && (
                            <OwnerArchiveButton
                              ownerId={c.id}
                              ownerVersion={c.version}
                              onSuccess={() => load(filterType)}
                            />
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-4 text-xs text-gray-400">
            ※ 統合実行・再リンクの実行機能は Phase 2-B-β 以降で対応予定です。
            （重複候補の dryRun preview のみ Phase 2-B-α で利用可能）
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 重複候補のグループサマリー
// ---------------------------------------------------------------------------
// 同一 (name + address) の候補を client-side でグループ化し、各グループに
// owner 一覧 + master/source ペア選択 + 統合プレビューボタンを表示する。
//
// 注意:
//   - master/source の選択は operator に明示させる（自動推奨はヒントのみ）。
//   - PII は API レスポンスの maskValue 済みの値をそのまま表示する。
//   - 推奨ハイライト: ChangeLog 件数 / PropertyOwner 件数 / version が多い方を
//     「master 推奨」表示する（強制せず注記のみ）。

interface DuplicateGroupSummaryProps {
  candidates: OwnerCorrectionCandidate[];
}

function DuplicateGroupSummary({ candidates }: DuplicateGroupSummaryProps) {
  // duplicate 種別のみ対象
  const dups = candidates.filter((c) => c.types.includes("duplicate"));
  if (dups.length === 0) return null;

  // (name + address) でグループ化。masked 結果でも同値ならまとめる。
  const groups = new Map<string, OwnerCorrectionCandidate[]>();
  for (const c of dups) {
    const key = `${c.name ?? "(unknown)"}|||${c.address ?? "(unknown)"}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const groupList = Array.from(groups.entries()).filter(
    ([, arr]) => arr.length >= 2,
  );
  if (groupList.length === 0) return null;

  return (
    <div className="mb-6 rounded-md border border-purple-200 bg-purple-50 p-3">
      <h2 className="mb-2 text-sm font-semibold text-purple-900">
        重複グループ ({groupList.length} 件)
      </h2>
      <p className="mb-3 text-xs text-purple-700">
        同一 (氏名 + 住所) の所有者をまとめて表示しています。各グループ内で master / source を選び、統合プレビュー（dryRun）を取得できます。
      </p>
      <div className="space-y-3">
        {groupList.map(([key, members], idx) => (
          <DuplicateGroupCard
            key={key}
            groupIndex={idx + 1}
            members={members}
          />
        ))}
      </div>
    </div>
  );
}

interface DuplicateGroupCardProps {
  groupIndex: number;
  members: OwnerCorrectionCandidate[];
}

function DuplicateGroupCard({ groupIndex, members }: DuplicateGroupCardProps) {
  // master / source の選択（明示・operator まかせ）
  const [masterId, setMasterId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);

  // 推奨ロジック: ChangeLog 件数 → PropertyOwner 件数 → version の降順で master 推奨。
  // 同値時は最初に現れた owner を推奨。強制しない（ヒントのみ）。
  const recommendedMaster = [...members].sort((a, b) => {
    if (b.changeLogCount !== a.changeLogCount)
      return b.changeLogCount - a.changeLogCount;
    if (b.propertyOwnerCount !== a.propertyOwnerCount)
      return b.propertyOwnerCount - a.propertyOwnerCount;
    return b.version - a.version;
  })[0];

  const canPreview = masterId && sourceId && masterId !== sourceId;
  const sample = members[0];

  return (
    <div className="rounded-md border border-purple-200 bg-white p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-xs font-medium text-purple-700">
          グループ {groupIndex}
        </span>
        <span className="text-xs text-gray-500">
          氏名: {sample.name ?? "***"} / 住所: {sample.address ?? "—"} （
          {members.length} 件）
        </span>
      </div>

      <table className="mb-3 w-full text-xs">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-2 py-1 text-left">master</th>
            <th className="px-2 py-1 text-left">source</th>
            <th className="px-2 py-1 text-left">推奨</th>
            <th className="px-2 py-1 text-left">ID</th>
            <th className="px-2 py-1 text-center">物件</th>
            <th className="px-2 py-1 text-center">変更履歴</th>
            <th className="px-2 py-1 text-center">ver</th>
            <th className="px-2 py-1 text-left">取込元</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {members.map((m) => (
            <tr key={m.id} className="hover:bg-gray-50">
              <td className="px-2 py-1">
                <input
                  type="radio"
                  name={`master-${groupIndex}`}
                  checked={masterId === m.id}
                  onChange={() => setMasterId(m.id)}
                  disabled={sourceId === m.id}
                />
              </td>
              <td className="px-2 py-1">
                <input
                  type="radio"
                  name={`source-${groupIndex}`}
                  checked={sourceId === m.id}
                  onChange={() => setSourceId(m.id)}
                  disabled={masterId === m.id}
                />
              </td>
              <td className="px-2 py-1 text-purple-700">
                {m.id === recommendedMaster.id ? "master 推奨" : ""}
              </td>
              <td className="px-2 py-1 font-mono text-[10px] text-gray-400">
                {m.id.slice(0, 8)}…
              </td>
              <td className="px-2 py-1 text-center">{m.propertyOwnerCount}</td>
              <td className="px-2 py-1 text-center">{m.changeLogCount}</td>
              <td className="px-2 py-1 text-center">{m.version}</td>
              <td className="px-2 py-1 font-mono text-[10px] text-gray-500">
                {m.importFileName
                  ? `${m.importFileName}:${m.importRowNumber}行`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canPreview && masterId && sourceId ? (
        <OwnerMergePreviewButton
          masterId={masterId}
          sourceId={sourceId}
          masterLabel={`${masterId.slice(0, 8)}…`}
          sourceLabel={`${sourceId.slice(0, 8)}…`}
        />
      ) : (
        <p className="text-xs text-gray-400">
          master と source をそれぞれ選択してください
        </p>
      )}
    </div>
  );
}
