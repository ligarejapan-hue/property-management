"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  fetchOwnerCorrectionCandidates,
  fetchCorporateCandidates,
  type OwnerCorrectionCandidate,
  type OwnerCorrectionCandidatesResponse,
  type CorporateCandidateFilterType,
  type CorporateCandidateRowDTO,
  type CorporateCandidatesResponse,
} from "@/lib/api-client";
import { AddressFillButton } from "@/components/owners/AddressFillButton";
import { OwnerArchiveButton } from "@/components/owners/OwnerArchiveButton";
import { OwnerMergePreviewButton } from "@/components/owners/OwnerMergePreviewButton";
import {
  applyMasterSelection,
  applySourceSelection,
} from "@/lib/owner-merge-pair";

type FilterType =
  | "all"
  | "orphan"
  | "address_null"
  | "duplicate"
  | "corporate_number";

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
    // Phase E: 法人番号タブは別 API なので、ここでは何もしない
    // （CorporateNumberCandidatesPanel が自前で fetch する）。
    if (type === "corporate_number") {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchOwnerCorrectionCandidates(
        type as "all" | "orphan" | "address_null" | "duplicate",
      );
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
    // Phase E: 法人番号タブ。件数は子コンポーネント側 fetch のため上位では表示しない。
    { key: "corporate_number", label: "法人番号" },
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

      {loading && filterType !== "corporate_number" && (
        <p className="py-8 text-center text-sm text-gray-400">読み込み中...</p>
      )}
      {error && filterType !== "corporate_number" && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {filterType === "corporate_number" && <CorporateNumberCandidatesPanel />}

      {filterType !== "corporate_number" && data && !loading && (
        <>
          <p className="mb-3 text-sm text-gray-500">
            {data.total} 件の確認候補
          </p>

          {/* duplicate タブでは「重複グループサマリー」を上部に追加表示。
              client-side で types.includes("duplicate") の候補を name+address で
              グルーピングし、各グループ内の owner ペアに対して preview を取得できる。
              既存のフラットリストは下にそのまま残す（破壊的変更なし）。 */}
          {filterType === "duplicate" && (
            <DuplicateGroupSummary
              candidates={data.candidates}
              onExecuted={() => load(filterType)}
            />
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
  onExecuted?: () => void;
}

function DuplicateGroupSummary({
  candidates,
  onExecuted,
}: DuplicateGroupSummaryProps) {
  // duplicate グループは API 側で server-side の正規化キーで判定済み。
  // UI は duplicateGroupId（opaque）で再構築するだけ。raw display value で
  // grouping すると masking / 表記揺れで正しい重複が分断される。
  const dups = candidates.filter(
    (c): c is OwnerCorrectionCandidate & { duplicateGroupId: string } =>
      c.duplicateGroupId !== null && c.duplicateGroupId !== undefined,
  );
  if (dups.length === 0) return null;

  const groups = new Map<string, OwnerCorrectionCandidate[]>();
  for (const c of dups) {
    const arr = groups.get(c.duplicateGroupId!) ?? [];
    arr.push(c);
    groups.set(c.duplicateGroupId!, arr);
  }

  // duplicateGroupSize が >= 2 のグループのみ表示（API 側でも同条件）。
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
            onExecuted={onExecuted}
          />
        ))}
      </div>
    </div>
  );
}

interface DuplicateGroupCardProps {
  groupIndex: number;
  members: OwnerCorrectionCandidate[];
  onExecuted?: () => void;
}

function DuplicateGroupCard({
  groupIndex,
  members,
  onExecuted,
}: DuplicateGroupCardProps) {
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

  // master / source は disabled にしない（disabled だと一度選んだ後に役割を
  // 入れ替えられない）。代わりに、既に相手側に選ばれている owner を選んだら
  // pure 関数 (applyMasterSelection / applySourceSelection) で自動 swap する。
  // これにより 2 人グループでの「入れ替え」も、3 人以上のグループでの選び直しも
  // 自然に動く。
  const handleSelectMaster = (id: string) => {
    const next = applyMasterSelection({ masterId, sourceId }, id);
    setMasterId(next.masterId);
    setSourceId(next.sourceId);
  };

  const handleSelectSource = (id: string) => {
    const next = applySourceSelection({ masterId, sourceId }, id);
    setMasterId(next.masterId);
    setSourceId(next.sourceId);
  };

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
                  onChange={() => handleSelectMaster(m.id)}
                />
              </td>
              <td className="px-2 py-1">
                <input
                  type="radio"
                  name={`source-${groupIndex}`}
                  checked={sourceId === m.id}
                  onChange={() => handleSelectSource(m.id)}
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
        // key を pair ID にして、選択ペア変更時にコンポーネントを remount し
        // 古い preview 結果が残らないことを保証する（OwnerMergePreviewButton
        // 内の useEffect と併せた多重防御）。
        <OwnerMergePreviewButton
          key={`${masterId}:${sourceId}`}
          masterId={masterId}
          sourceId={sourceId}
          masterLabel={`${masterId.slice(0, 8)}…`}
          sourceLabel={`${sourceId.slice(0, 8)}…`}
          onExecuted={onExecuted}
        />
      ) : (
        <p className="text-xs text-gray-400">
          master と source をそれぞれ選択してください
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase E: 法人番号 dry-run 候補パネル
// ---------------------------------------------------------------------------
// /api/admin/owners/correction/corporate-number-candidates から取得して
// type サブフィルタ + cursor pagination で表示する。実反映は Phase C の
// 詳細画面 lookup/apply UI に誘導する（このパネル内ではバルク操作を持たない）。

type CorporateSubFilter = "default" | "missing" | "conflict" | "multi" | "same";

const CORPORATE_TYPE_LABEL: Record<
  CorporateCandidateRowDTO["type"],
  string
> = {
  missing: "未登録",
  conflict: "競合",
  multi: "複数候補",
  same: "一致",
};

const CORPORATE_TYPE_BADGE: Record<
  CorporateCandidateRowDTO["type"],
  string
> = {
  missing: "bg-yellow-100 text-yellow-800",
  conflict: "bg-red-100 text-red-700",
  multi: "bg-gray-100 text-gray-700",
  same: "bg-green-100 text-green-700",
};

const DETECTED_IN_LABEL: Record<"name" | "address" | "note", string> = {
  name: "氏名",
  address: "住所",
  note: "メモ",
};

function CorporateNumberCandidatesPanel() {
  const [subFilter, setSubFilter] = useState<CorporateSubFilter>("default");
  const [data, setData] = useState<CorporateCandidatesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);

  // subFilter -> API query type への変換（"default" = "all"）
  const apiType: CorporateCandidateFilterType =
    subFilter === "default" ? "all" : subFilter;

  const load = useCallback(
    async (type: CorporateCandidateFilterType, cur: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchCorporateCandidates(type, {
          cursor: cur ?? undefined,
        });
        setData(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : "エラーが発生しました");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    // サブフィルタ変更時は cursor をリセット
    setCursor(null);
    setCursorStack([]);
    load(apiType, null);
  }, [apiType, load]);

  const subTabs: { key: CorporateSubFilter; label: string }[] = [
    { key: "default", label: "未登録+競合+複数候補" },
    { key: "missing", label: "未登録のみ" },
    { key: "conflict", label: "競合のみ" },
    { key: "multi", label: "複数候補のみ" },
    { key: "same", label: "一致（参考）" },
  ];

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        所有者の氏名・住所・メモから法人番号候補を検出して dry-run で表示します。
        反映は各 Owner 詳細画面（Phase B/C UI）から手動で確認のうえ実行してください。
        この画面では一括操作は提供しません。
      </p>

      <div className="flex flex-wrap gap-1">
        {subTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setSubFilter(tab.key)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              subFilter === tab.key
                ? "border-blue-500 bg-blue-100 text-blue-800"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {tab.label}
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
          <div className="flex flex-wrap gap-2 text-xs text-gray-600">
            <span>合計 {data.summary.totalCandidates} 件</span>
            <span>/ 未登録 {data.summary.missing}</span>
            <span>/ 競合 {data.summary.conflict}</span>
            <span>/ 複数候補 {data.summary.multi}</span>
            <span>/ 一致 {data.summary.same}</span>
            {data.truncated && (
              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-orange-700">
                スキャン上限到達（一部のみ表示）
              </span>
            )}
          </div>

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
                      既存法人番号
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      検出候補
                    </th>
                    <th className="px-3 py-2 text-left font-medium">種別</th>
                    <th className="px-3 py-2 text-left font-medium">
                      検出箇所
                    </th>
                    <th className="px-3 py-2 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.candidates.map((c) => (
                    <tr key={c.ownerId} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium text-gray-900">
                        {c.ownerNameMasked ?? (
                          <span className="text-gray-400">***</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.ownerAddressMasked ?? (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-700">
                        {c.existingCorporateNumberMasked ?? (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-700">
                        {c.candidateCorporateNumberMasked ?? (
                          <span className="text-gray-400">
                            {c.candidateCount === "many" ? "複数" : "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${CORPORATE_TYPE_BADGE[c.type]}`}
                        >
                          {CORPORATE_TYPE_LABEL[c.type]}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {c.detectedIn.map((f) => (
                            <span
                              key={f}
                              className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600"
                            >
                              {DETECTED_IN_LABEL[f]}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={c.detailUrl}
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        >
                          Owner 詳細を開く
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 text-xs">
            <button
              type="button"
              onClick={() => {
                if (cursorStack.length === 0) return;
                const prev = cursorStack[cursorStack.length - 1] ?? null;
                setCursorStack((s) => s.slice(0, -1));
                setCursor(prev);
                load(apiType, prev);
              }}
              disabled={cursorStack.length === 0}
              className="rounded-md border border-gray-300 px-3 py-1 text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-gray-50"
            >
              前へ
            </button>
            <button
              type="button"
              onClick={() => {
                if (!data.hasNextPage || !data.nextCursor) return;
                setCursorStack((s) => [...s, cursor]);
                setCursor(data.nextCursor);
                load(apiType, data.nextCursor);
              }}
              disabled={!data.hasNextPage || !data.nextCursor}
              className="rounded-md border border-gray-300 px-3 py-1 text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-gray-50"
            >
              次へ
            </button>
          </div>
        </>
      )}
    </div>
  );
}
