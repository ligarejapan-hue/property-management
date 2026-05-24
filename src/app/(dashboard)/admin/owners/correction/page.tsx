"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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

// Phase 2-A: duplicate タブ内のサブフィルタ。matchedBy で絞り込む。
// "all" は経路を問わず duplicate 全件、各 matchedBy はそれぞれの経路のみ。
type DuplicateSubFilter =
  | "all"
  | "name_address"
  | "corporate_number"
  | "external_link_key";

const DUPLICATE_SUB_FILTER_LABELS: Record<DuplicateSubFilter, string> = {
  all: "すべて",
  name_address: "氏名住所一致",
  corporate_number: "法人番号一致",
  external_link_key: "リンクキー一致",
};

const DUPLICATE_MATCHED_BY_LABEL: Record<
  "name_address" | "corporate_number" | "external_link_key",
  string
> = {
  name_address: "氏名住所一致",
  corporate_number: "法人番号一致",
  external_link_key: "リンクキー一致",
};

function parseDuplicateSubFilterFromQuery(
  value: string | null,
): DuplicateSubFilter {
  switch (value) {
    case "name_address":
    case "corporate_number":
    case "external_link_key":
    case "all":
      return value;
    default:
      return "all";
  }
}

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

// Phase F: タブ状態を URL query で永続化するためのヘルパ。
// 候補法人番号などの PII は URL に絶対に載せない。
function parseFilterTypeFromQuery(value: string | null): FilterType {
  switch (value) {
    case "orphan":
    case "address_null":
    case "duplicate":
    case "corporate_number":
    case "all":
      return value;
    default:
      return "all";
  }
}

// Phase F: Next.js 16 では useSearchParams を使うクライアントコンポーネントを
// Suspense で包む必要がある。インナーに本体を置き、default export 側で Suspense ラップする。
export default function OwnerCorrectionPage() {
  return (
    <Suspense
      fallback={<div className="p-6 text-sm text-gray-500">読み込み中...</div>}
    >
      <OwnerCorrectionPageInner />
    </Suspense>
  );
}

function OwnerCorrectionPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Phase F: tab を URL query (?tab=corporate_number 等) から復元する。
  // Owner 詳細ページから「補正候補に戻る」で遷移してきたときにタブを保持。
  const initialTab = parseFilterTypeFromQuery(searchParams?.get("tab") ?? null);
  const [filterType, setFilterTypeState] = useState<FilterType>(initialTab);
  // Phase 2-A: duplicate タブ内のサブフィルタ。?dup= で永続化する。
  // 値は enum のみで PII / 法人番号 / externalLinkKey 生値は URL に絶対に載せない。
  const initialDupSub = parseDuplicateSubFilterFromQuery(
    searchParams?.get("dup") ?? null,
  );
  const [duplicateSubFilter, setDuplicateSubFilterState] =
    useState<DuplicateSubFilter>(initialDupSub);
  const [data, setData] = useState<OwnerCorrectionCandidatesResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // タブ変更時は URL の ?tab=... も更新する（PII を含まない）。
  // 法人番号タブ以外への遷移時は法人番号タブ側 query (sub/cursor) を削除する。
  // duplicate タブ以外への遷移時は dup query も削除する。
  //
  // Codex P2: URL ↔ duplicateSubFilter state の同期を厳格化する。
  //   - duplicate タブから別タブへ移動 → URL から ?dup= を削除 +
  //     in-memory state も "all" にリセット（残ったまま再進入すると URL=all なのに
  //     画面が前回値で絞り込まれ、URL と画面表示が不一致になる）。
  //   - 別タブから duplicate タブへ戻る → URL の現在の ?dup= を尊重して state に
  //     反映する（無 / 不正値は parseDuplicateSubFilterFromQuery で "all" に
  //     フォールバック）。
  const setFilterType = useCallback(
    (next: FilterType) => {
      setFilterTypeState(next);
      const sp = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      if (next === "all") {
        sp.delete("tab");
      } else {
        sp.set("tab", next);
      }
      if (next !== "corporate_number") {
        sp.delete("sub");
        sp.delete("cursor");
      }
      if (next !== "duplicate") {
        sp.delete("dup");
        // Codex P2: duplicate タブ離脱時に in-memory state もリセット。
        // これがないと URL=all なのに画面は前回 filter のまま残る不一致が起きる。
        setDuplicateSubFilterState("all");
      } else {
        // Codex P2: 別タブから duplicate へ戻る時は URL の現在値を state に反映。
        // 無 / 不正値は "all" にフォールバック（parseDuplicateSubFilterFromQuery）。
        setDuplicateSubFilterState(
          parseDuplicateSubFilterFromQuery(sp.get("dup")),
        );
      }
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

  // Phase 2-A: duplicate サブフィルタ変更時の URL 同期。
  // PII を URL に載せないため値は enum のみ。"all" のときは query を消す。
  const setDuplicateSubFilter = useCallback(
    (next: DuplicateSubFilter) => {
      setDuplicateSubFilterState(next);
      const sp = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      if (next === "all") {
        sp.delete("dup");
      } else {
        sp.set("dup", next);
      }
      // dup は duplicate タブ専用 query なので tab=duplicate を維持。
      sp.set("tab", "duplicate");
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

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
          {/* Phase 2-A: duplicate タブ専用のサブフィルタ。matchedBy で絞り込む。
              client-side フィルタ（API 再 fetch なし、PII / 法人番号生値を URL に載せない）。 */}
          {filterType === "duplicate" && (
            <DuplicateSubFilterBar
              value={duplicateSubFilter}
              onChange={setDuplicateSubFilter}
              counts={data.summary.duplicateMatchedByCounts}
              totalDuplicateCount={data.summary.duplicateCount}
            />
          )}

          {(() => {
            // Phase 2-A: duplicate タブのみサブフィルタを適用する。
            // 他タブでは duplicateSubFilter を無視（フィルタ範囲を広げないため）。
            const visibleCandidates =
              filterType === "duplicate" && duplicateSubFilter !== "all"
                ? data.candidates.filter(
                    (c) => c.duplicateMatchedBy === duplicateSubFilter,
                  )
                : data.candidates;

            return (
              <>
                <p className="mb-3 text-sm text-gray-500">
                  {visibleCandidates.length} 件の確認候補
                  {filterType === "duplicate" &&
                    duplicateSubFilter !== "all" &&
                    `（${DUPLICATE_SUB_FILTER_LABELS[duplicateSubFilter]} のみ）`}
                </p>

                {/* duplicate タブでは「重複グループサマリー」を上部に追加表示。
                    client-side で duplicateGroupId（opaque）でグルーピング。
                    Phase 2-A: visibleCandidates をそのまま渡してサブフィルタを反映する。 */}
                {filterType === "duplicate" && (
                  <DuplicateGroupSummary
                    candidates={visibleCandidates}
                    onExecuted={() => load(filterType)}
                  />
                )}

                {visibleCandidates.length === 0 ? (
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
                        {visibleCandidates.map((c: OwnerCorrectionCandidate) => (
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
                  </>
                );
              })()}

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

// ---------------------------------------------------------------------------
// Phase 2-A: duplicate タブのサブフィルタバー
// ---------------------------------------------------------------------------
// duplicate タブ内で matchedBy 経路を切り替えるためのボタン群。
// 件数は API の summary.duplicateMatchedByCounts から取得（PII を含まない件数）。

interface DuplicateSubFilterBarProps {
  value: DuplicateSubFilter;
  onChange: (next: DuplicateSubFilter) => void;
  counts:
    | {
        name_address: number;
        corporate_number: number;
        external_link_key: number;
      }
    | undefined;
  totalDuplicateCount: number;
}

function DuplicateSubFilterBar({
  value,
  onChange,
  counts,
  totalDuplicateCount,
}: DuplicateSubFilterBarProps) {
  const subTabs: { key: DuplicateSubFilter; label: string; count: number }[] = [
    { key: "all", label: DUPLICATE_SUB_FILTER_LABELS.all, count: totalDuplicateCount },
    {
      key: "name_address",
      label: DUPLICATE_SUB_FILTER_LABELS.name_address,
      count: counts?.name_address ?? 0,
    },
    {
      key: "corporate_number",
      label: DUPLICATE_SUB_FILTER_LABELS.corporate_number,
      count: counts?.corporate_number ?? 0,
    },
    {
      key: "external_link_key",
      label: DUPLICATE_SUB_FILTER_LABELS.external_link_key,
      count: counts?.external_link_key ?? 0,
    },
  ];

  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {subTabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            value === tab.key
              ? "border-purple-500 bg-purple-100 text-purple-800"
              : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
          }`}
        >
          {tab.label}
          <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
            {tab.count}
          </span>
        </button>
      ))}
    </div>
  );
}

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
  // Phase 2-A: グループの一致経路（全 member 同一なので最初の 1 件を使う）。
  // raw 法人番号 / externalLinkKey は含まずラベル文字列のみ。
  const matchedBy = sample.duplicateMatchedBy;

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
        {matchedBy && (
          <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
            {DUPLICATE_MATCHED_BY_LABEL[matchedBy]}
          </span>
        )}
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

function parseCorporateSubFilter(value: string | null): CorporateSubFilter {
  switch (value) {
    case "missing":
    case "conflict":
    case "multi":
    case "same":
    case "default":
      return value;
    default:
      return "default";
  }
}

function CorporateNumberCandidatesPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Phase F: sub / cursor を URL query に保存し、Owner 詳細から戻ったとき位置を保つ。
  // PII（候補法人番号など）は URL に絶対に載せない。cursor は ownerId(uuid) なので非 PII。
  const initialSub = parseCorporateSubFilter(searchParams?.get("sub") ?? null);
  const initialCursor = searchParams?.get("cursor") ?? null;
  const [subFilter, setSubFilterState] =
    useState<CorporateSubFilter>(initialSub);
  const [data, setData] = useState<CorporateCandidatesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);

  const updateUrlQuery = useCallback(
    (nextSub: CorporateSubFilter, nextCursor: string | null) => {
      const sp = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      sp.set("tab", "corporate_number");
      if (nextSub === "default") {
        sp.delete("sub");
      } else {
        sp.set("sub", nextSub);
      }
      if (nextCursor) {
        sp.set("cursor", nextCursor);
      } else {
        sp.delete("cursor");
      }
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

  const setSubFilter = useCallback(
    (next: CorporateSubFilter) => {
      setSubFilterState(next);
      // サブフィルタ変更時は cursor リセットを含めて URL を更新
      updateUrlQuery(next, null);
    },
    [updateUrlQuery],
  );

  // Codex P2 対応: stale response ガード。
  // ユーザーがサブフィルタ/ページ切替を素早く操作した際に、古い遅いレスポンスで
  // 現在表示を上書きしないよう、リクエスト ID 単調増加 ref で「最新のみ反映」を保証する。
  // unmount 時の state 更新も mountedRef で抑止する。
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // subFilter -> API query type への変換（"default" = "all"）
  const apiType: CorporateCandidateFilterType =
    subFilter === "default" ? "all" : subFilter;

  const load = useCallback(
    async (type: CorporateCandidateFilterType, cur: string | null) => {
      const myReqId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      // Codex P2: subfilter/cursor 切替時に古い rows を即座に画面から消す。
      // 古いフィルタの行が新フィルタ下に表示されてオペレーターが誤った候補を
      // 開くリスクを排除する。
      setData(null);
      try {
        const res = await fetchCorporateCandidates(type, {
          cursor: cur ?? undefined,
        });
        // stale: 自分より新しいリクエストが既に開始されているなら無視。unmount でも無視。
        if (!mountedRef.current || myReqId !== requestIdRef.current) return;
        setData(res);
      } catch (e) {
        if (!mountedRef.current || myReqId !== requestIdRef.current) return;
        // Codex P2: 失敗時にも data を明示的に null 化し、stale rows の残留を防ぐ。
        setError(e instanceof Error ? e.message : "エラーが発生しました");
        setData(null);
      } finally {
        if (mountedRef.current && myReqId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [],
  );

  // Codex P2 追加修正: 初回マウント時は URL query の cursor を尊重して fetch する。
  // 旧実装は無条件に setCursor(null) + load(apiType, null) していたため、
  // `?tab=corporate_number&cursor=...` で戻ってきても 1 ページ目に戻ってしまっていた。
  //
  // hasInitializedRef で「初回 vs subFilter 切替」を区別する:
  //   - 初回: URL から復元済の cursor (state) のまま load → 保存ページが復元される
  //   - 2 回目以降の apiType 変更: cursor / cursorStack をリセットして 1 ページ目から
  //
  // cursorStack は URL から完全復元できないため空のままで OK（前へボタンは disabled）。
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      load(apiType, cursor);
      return;
    }
    setCursor(null);
    setCursorStack([]);
    load(apiType, null);
    // cursor は依存に入れない（次/前ボタンで明示的に load を呼ぶため）
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      {/* Codex P2: error 時は古いデータ表を一切描画しない。
          requestId guard と組み合わせて、失敗フィルタ・失敗ページ切替後に
          stale rows が画面に残らないことを保証する。 */}
      {data && !loading && !error && (
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
                // Phase F: cursor を URL query (?cursor=...) にも反映。
                // cursor は ownerId(uuid) なので非 PII。
                updateUrlQuery(subFilter, prev);
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
                updateUrlQuery(subFilter, data.nextCursor);
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
