"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  fetchOwnerCorrectionCandidates,
  fetchCorporateCandidates,
  bulkApplyCorporateNumbers,
  type OwnerCorrectionCandidate,
  type OwnerCorrectionCandidatesResponse,
  type CorporateCandidateFilterType,
  type CorporateCandidateRowDTO,
  type CorporateCandidatesResponse,
} from "@/lib/api-client";
import {
  MAX_CORPORATE_BULK,
  isBulkEligible,
  eligibleOwnerIds,
  canSubmitBulk,
  buildBulkPayload,
  summarizeBulkResults,
  BULK_STATUS_LABEL,
  type BulkResultSummary,
} from "@/lib/corporate-bulk-ui";
import { AddressFillButton } from "@/components/owners/AddressFillButton";
import { OwnerArchiveButton } from "@/components/owners/OwnerArchiveButton";
import { OwnerMergePreviewButton } from "@/components/owners/OwnerMergePreviewButton";
import {
  applyMasterSelection,
  applySourceSelection,
} from "@/lib/owner-merge-pair";
import {
  fetchRegistryAddressCandidates,
  applyRegistryAddressCleanup,
  RegistryAddressCleanupClientError,
  type RegistryAddressCandidateFilter,
  type RegistryAddressCandidateRow,
  type RegistryAddressCandidatesResponse,
} from "@/lib/registry-address-cleanup-client";
import type { RegistryStringType } from "@/lib/registry-address-cleanup";

type FilterType =
  | "all"
  | "orphan"
  | "address_null"
  | "duplicate"
  | "corporate_number"
  | "registry_address";

// DQ-03: 自前 API で self-fetch するタブ（上位の data 駆動 fetch/描画から除外する）。
const SELF_FETCH_TABS: FilterType[] = ["corporate_number", "registry_address"];

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
  import_source_ambiguous: "取込元が複数（要確認）",
  import_row_not_success: "取込行未解決",
  // Codex P1 (round 3): non-name duplicate （法人番号 / 外部キー一致）に
  // 付与される「削除させず確認に回す」reason。raw 法人番号 / externalLinkKey は
  // 含まない非 PII enum。
  corporate_number_duplicate_requires_review: "法人番号重複（要確認）",
  external_link_key_duplicate_requires_review: "外部キー重複（要確認）",
};

// Phase F: タブ状態を URL query で永続化するためのヘルパ。
// 候補法人番号などの PII は URL に絶対に載せない。
function parseFilterTypeFromQuery(value: string | null): FilterType {
  switch (value) {
    case "orphan":
    case "address_null":
    case "duplicate":
    case "corporate_number":
    case "registry_address":
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
    // Phase E / DQ-03: self-fetch タブ（法人番号・住所の登記文字列）は別 API なので
    // ここでは何もしない（各 Panel が自前で fetch する）。
    if (SELF_FETCH_TABS.includes(type)) {
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
    // DQ-03: 住所の登記文字列タブ。件数は子コンポーネント側 fetch。
    { key: "registry_address", label: "住所の登記文字列" },
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
                ? "border-indigo-600 text-indigo-700"
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

      {loading && !SELF_FETCH_TABS.includes(filterType) && (
        <p className="py-8 text-center text-sm text-gray-400">読み込み中...</p>
      )}
      {error && !SELF_FETCH_TABS.includes(filterType) && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {filterType === "corporate_number" && <CorporateNumberCandidatesPanel />}
      {filterType === "registry_address" && <RegistryAddressCandidatesPanel />}

      {!SELF_FETCH_TABS.includes(filterType) && data && !loading && (
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

          {/* Codex P1 (round 2): corporate_number サブフィルタは
              displayConfig.corporateNumber === "full" のオペレーターのみ
              利用可能。権限不足時は API レスポンス側で候補が空になっているので、
              「該当なし」ではなく「権限不足」を明示して operator の誤解を防ぐ。
              flag 値は boolean のみで PII / 法人番号生値は含まない。 */}
          {filterType === "duplicate" &&
            duplicateSubFilter === "corporate_number" &&
            data.summary.corporateNumberDuplicateAvailable === false && (
              <p
                data-testid="corporate-number-duplicate-permission-denied"
                className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              >
                法人番号重複候補を表示する権限がありません（必要な権限: owner_corporate_number=full）。
              </p>
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
                          {/* Phase 2-B: address が DB 上 null ではないが trim 後 0 文字の場合のみ
                              「空白のみ」バッジを追加表示。生の address 値は出さない。 */}
                          {c.addressIsWhitespaceOnly && (
                            <span
                              data-testid="whitespace-only-address-badge"
                              className="rounded-full bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700"
                            >
                              空白のみ
                            </span>
                          )}
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
                          c.recommendedAction === "delete_candidate" &&
                          // Codex P1 (round 3): non-name duplicate
                          // (corporate_number / external_link_key) と判定された
                          // 候補は route 側で recommendedAction を review に
                          // 落としているはずだが、Defense in Depth で UI でも
                          // archive button を出さない（万が一サーバが旧形式の
                          // レスポンスを返してもデータ損失を防ぐ）。
                          c.duplicateMatchedBy !== "corporate_number" &&
                          c.duplicateMatchedBy !== "external_link_key" && (
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
        重複候補をグループごとに表示しています。<strong>氏名住所一致</strong>グループのみ master / source を選んで統合プレビュー（dryRun）を取得できます。<strong>法人番号一致 / リンクキー一致</strong>は表示のみで、統合プレビュー / 実行は別 phase で対応予定です。
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
  // Codex P2-round-2: merge preview / execute は name_address 経路のみ対応。
  // corporate_number / external_link_key 経路では master/source 選択列も
  // プレビューボタンも表示しない（API 側 merge-preview が name+address 検証
  // しかしないので UI で merge できそうに見せると誤解を招く）。
  const supportsMerge = matchedBy === "name_address";

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
            {/* Codex P2-round-2: master/source/推奨 列は merge 可能な
                name_address group のみ表示。corporate_number / external_link_key
                では merge 経路がないため列ごと出さない。 */}
            {supportsMerge && <th className="px-2 py-1 text-left">master</th>}
            {supportsMerge && <th className="px-2 py-1 text-left">source</th>}
            {supportsMerge && <th className="px-2 py-1 text-left">推奨</th>}
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
              {supportsMerge && (
                <td className="px-2 py-1">
                  <input
                    type="radio"
                    name={`master-${groupIndex}`}
                    checked={masterId === m.id}
                    onChange={() => handleSelectMaster(m.id)}
                  />
                </td>
              )}
              {supportsMerge && (
                <td className="px-2 py-1">
                  <input
                    type="radio"
                    name={`source-${groupIndex}`}
                    checked={sourceId === m.id}
                    onChange={() => handleSelectSource(m.id)}
                  />
                </td>
              )}
              {supportsMerge && (
                <td className="px-2 py-1 text-purple-700">
                  {m.id === recommendedMaster.id ? "master 推奨" : ""}
                </td>
              )}
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

      {supportsMerge ? (
        canPreview && masterId && sourceId ? (
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
        )
      ) : (
        // Codex P2-round-2: corporate_number / external_link_key 経路は
        // merge-preview API 未対応。merge ボタンを出さず「要確認」注記のみ。
        <p
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          data-testid="duplicate-group-merge-unsupported-notice"
        >
          {matchedBy === "corporate_number"
            ? "法人番号一致のため要確認。"
            : matchedBy === "external_link_key"
              ? "リンクキー一致のため要確認。"
              : "要確認。"}
          Phase 2-A では統合プレビュー / 実行は氏名住所一致グループのみ対応しています。法人番号 / リンクキー一致グループは候補表示のみで、merge は別 phase で対応予定です。
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

  // 一括反映（missing 候補のみ）。選択は ownerId(uuid=非PII) のみ保持する。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPhase, setBulkPhase] = useState<"idle" | "confirm">("idle");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResultSummary | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // 選択・確認・結果は「現在表示中の行」に紐づくため、ページ/フィルタ切替時にリセットする。
  const resetBulkState = useCallback(() => {
    setSelectedIds(new Set());
    setBulkPhase("idle");
    setBulkError(null);
    setBulkResult(null);
  }, []);

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
      // 選択・確認・結果は表示中の行に紐づくのでページ切替で必ずクリアする。
      // （apply 後の refresh では handler が load 完了後に結果を再セットして保持する）
      resetBulkState();
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
    [resetBulkState],
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

  // --- 一括反映（missing のみ）の派生値・ハンドラ ---
  const eligibleIds = data ? eligibleOwnerIds(data.candidates) : [];
  const hasEligible = eligibleIds.length > 0;
  // 「全選択」で選べる集合は上限件数まで（候補は最大 100 件/ページだが 1 バッチ上限は MAX）。
  const pageSelectableIds = eligibleIds.slice(0, MAX_CORPORATE_BULK);
  const allSelectableSelected =
    pageSelectableIds.length > 0 &&
    pageSelectableIds.every((id) => selectedIds.has(id));
  // このページで選択済みの eligible 件数（cap 前の実数）。表示・送信可否・cap 判定に使う。
  const selectedCount = data
    ? data.candidates.filter(
        (c) => isBulkEligible(c) && selectedIds.has(c.ownerId),
      ).length
    : 0;
  const atSelectionCap = selectedCount >= MAX_CORPORATE_BULK;
  // 送信ペイロード（eligible かつ選択済み・保険で上限 cap）。UI 側でも cap 済なので等しい。
  const bulkPayload = data ? buildBulkPayload(data.candidates, selectedIds) : [];

  const toggleRow = (ownerId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(ownerId)) {
        next.delete(ownerId);
      } else if (!atSelectionCap) {
        next.add(ownerId); // 上限到達後は追加しない（silent truncation 防止）
      }
      return next;
    });
    // 選択を変えたら確認・前回結果は破棄する。
    setBulkPhase("idle");
    setBulkResult(null);
  };

  const toggleAllEligible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (
        pageSelectableIds.length > 0 &&
        pageSelectableIds.every((id) => next.has(id))
      ) {
        for (const id of pageSelectableIds) next.delete(id); // 全解除
      } else {
        for (const id of pageSelectableIds) next.add(id); // 上限まで全選択
      }
      return next;
    });
    setBulkPhase("idle");
    setBulkResult(null);
  };

  const onConfirmBulk = async () => {
    if (!data || !canSubmitBulk(bulkPayload.length)) return;
    setBulkSubmitting(true);
    setBulkError(null);
    try {
      const res = await bulkApplyCorporateNumbers(bulkPayload);
      const summary = summarizeBulkResults(res.results);
      // 反映後は現在ページを再取得（load が selection/phase/result を一旦クリアする）。
      await load(apiType, cursor);
      if (!mountedRef.current) return;
      setBulkResult(summary); // load 後にセットするので結果は残る
    } catch (e) {
      if (!mountedRef.current) return;
      // 503（API キー未設定）や権限エラーもここで文言表示する（fail-closed）。
      setBulkError(e instanceof Error ? e.message : "一括反映に失敗しました");
      setBulkPhase("idle");
    } finally {
      if (mountedRef.current) setBulkSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        所有者の氏名・住所・メモから法人番号候補を検出して dry-run で表示します。
        <strong>未登録</strong>（既存の法人番号が空・候補が 1 件）の行はチェックして
        「一括反映」できます（確認のうえ実行・最大 {MAX_CORPORATE_BULK} 件）。検出番号で
        国税庁 lookup を行い、該当する法人のみ <strong>法人番号欄だけ</strong>を反映します
        （氏名・住所は変更しません。廃止法人・該当なし・競合・複数候補はスキップ）。
        競合・複数候補など個別判断が必要な行は各 Owner 詳細画面で確認してください。
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

          {/* 一括反映ツールバー（このページに未登録候補がある場合のみ） */}
          {hasEligible && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-emerald-800">
                  未登録 {eligibleIds.length} 件中 {selectedCount} 件を選択
                  {atSelectionCap && (
                    <span className="ml-1 text-emerald-600">
                      （1 回の上限 {MAX_CORPORATE_BULK} 件に到達）
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={toggleAllEligible}
                  className="rounded-md border border-emerald-300 bg-white px-2 py-1 text-emerald-700 hover:bg-emerald-100"
                >
                  {allSelectableSelected
                    ? "このページの選択を全解除"
                    : `このページの未登録を全選択（最大 ${MAX_CORPORATE_BULK}）`}
                </button>
                {bulkPhase === "idle" && (
                  <button
                    type="button"
                    onClick={() => setBulkPhase("confirm")}
                    disabled={!canSubmitBulk(selectedCount) || bulkSubmitting}
                    className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 hover:bg-emerald-700"
                  >
                    選択した {selectedCount} 件を一括反映
                  </button>
                )}
              </div>

              {eligibleIds.length > MAX_CORPORATE_BULK && (
                <p className="mt-1 text-[11px] text-emerald-600">
                  ※ このページの未登録は {eligibleIds.length} 件あります。1 回で反映できるのは
                  {MAX_CORPORATE_BULK} 件までです。反映後に再度選択してください。
                </p>
              )}

              {/* preview → confirm: 実行前の最終確認 */}
              {bulkPhase === "confirm" && (
                <div className="mt-2 rounded-md border border-emerald-300 bg-white px-3 py-2">
                  <p className="text-gray-700">
                    選択した <strong>{selectedCount} 件</strong>{" "}
                    について、検出された法人番号で国税庁 lookup を行い、該当する法人のみ
                    <strong>法人番号欄だけ</strong>
                    を反映します。氏名・住所は変更しません。
                    廃止法人・該当なし・競合・複数候補・既設定はスキップされます。
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={onConfirmBulk}
                      disabled={bulkSubmitting || !canSubmitBulk(selectedCount)}
                      className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 hover:bg-emerald-700"
                    >
                      {bulkSubmitting ? "反映中..." : "実行する"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setBulkPhase("idle")}
                      disabled={bulkSubmitting}
                      className="rounded-md border border-gray-300 bg-white px-3 py-1 text-gray-700 disabled:opacity-50 hover:bg-gray-50"
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              )}

              {bulkError && (
                <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">
                  {bulkError}
                </p>
              )}

              {/* 結果（件数のみ・PII なし）。apply 後 refresh しても保持される。 */}
              {bulkResult && (
                <div className="mt-2 rounded-md border border-emerald-300 bg-white px-3 py-2 text-gray-700">
                  <p className="font-medium text-emerald-800">
                    反映 {bulkResult.applied} 件 / スキップ {bulkResult.skipped}{" "}
                    件
                  </p>
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-600">
                    {bulkResult.byStatus.map((s) => (
                      <li key={s.status}>
                        {BULK_STATUS_LABEL[s.status]}: {s.count}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
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
                    <th className="w-8 px-3 py-2 text-left font-medium">
                      <input
                        type="checkbox"
                        aria-label="このページの未登録を全選択"
                        checked={allSelectableSelected}
                        disabled={!hasEligible}
                        onChange={toggleAllEligible}
                        className="cursor-pointer disabled:cursor-not-allowed"
                      />
                    </th>
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
                      <td className="px-3 py-2">
                        {isBulkEligible(c) ? (
                          <input
                            type="checkbox"
                            aria-label="一括反映に含める"
                            checked={selectedIds.has(c.ownerId)}
                            disabled={!selectedIds.has(c.ownerId) && atSelectionCap}
                            onChange={() => toggleRow(c.ownerId)}
                            className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                          />
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
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

// DQ-03: 住所の登記由来文字列（受付番号/和暦日付/登記原因/持分/証明書定型文 = 除去可能、
// 地番ラベル/不動産番号/床面積 等 = 監査専用）の dry-run 一覧 + 明示 apply パネル。
// 自前 API（/api/admin/owners/correction/registry-address-candidates・
// /api/admin/owners/[id]/registry-address-cleanup）を叩く。corporate-cleanup と同型の preview→apply。
const REGISTRY_TYPE_LABEL: Record<RegistryStringType, string> = {
  receipt_number: "受付番号",
  registration_cause: "登記原因",
  registration_date: "登記日付",
  share_fraction: "持分",
  certificate_meta: "証明書定型文",
  real_estate_number: "不動産番号",
  parcel_label: "地番ラベル",
  building_number: "家屋番号",
  structure_area: "床面積",
  rank_number: "順位番号",
};

function RegistryAddressCandidatesPanel() {
  const [subFilter, setSubFilter] =
    useState<RegistryAddressCandidateFilter>("all");
  const [data, setData] = useState<RegistryAddressCandidatesResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<{ id: string; text: string; ok: boolean } | null>(
    null,
  );

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (type: RegistryAddressCandidateFilter, cur: string | null) => {
      const myReqId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const res = await fetchRegistryAddressCandidates(type, {
          cursor: cur ?? undefined,
        });
        if (!mountedRef.current || myReqId !== requestIdRef.current) return;
        setData(res);
      } catch (e) {
        if (!mountedRef.current || myReqId !== requestIdRef.current) return;
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

  useEffect(() => {
    setCursor(null);
    setCursorStack([]);
    load(subFilter, null);
  }, [subFilter, load]);

  const onApply = useCallback(
    async (row: RegistryAddressCandidateRow) => {
      setApplyingId(row.ownerId);
      setRowMsg(null);
      try {
        await applyRegistryAddressCleanup(row.ownerId, {
          version: row.version,
          apply: { address: true },
        });
        if (!mountedRef.current) return;
        setRowMsg({ id: row.ownerId, text: "適用しました", ok: true });
        // 反映後に現在ページを再取得（version 更新・除去済み行の消去を反映）。
        load(subFilter, cursor);
      } catch (e) {
        if (!mountedRef.current) return;
        const msg =
          e instanceof RegistryAddressCleanupClientError
            ? e.message
            : e instanceof Error
              ? e.message
              : "適用に失敗しました";
        setRowMsg({ id: row.ownerId, text: msg, ok: false });
      } finally {
        if (mountedRef.current) setApplyingId(null);
      }
    },
    [subFilter, cursor, load],
  );

  const subTabs: { key: RegistryAddressCandidateFilter; label: string }[] = [
    { key: "all", label: "すべて" },
    { key: "cleanup", label: "除去可能" },
    { key: "manual", label: "監査専用（手動確認）" },
  ];

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        所有者住所に混入した登記由来文字列（受付番号・和暦日付・登記原因・持分・証明書定型文）を
        検出して dry-run で表示します。「除去可能」は各行の「適用」で住所から除去できます（住所の
        書込権限が必要）。地番ラベル・不動産番号・床面積などは誤って番地を消さないため
        <strong>監査専用（自動除去しない）</strong>です。Owner 詳細で手動確認してください。
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

      {data && !loading && !error && (
        <>
          <div className="flex flex-wrap gap-2 text-xs text-gray-600">
            <span>合計 {data.summary.total} 件</span>
            <span>/ 除去可能 {data.summary.cleanup}</span>
            <span>/ 監査専用 {data.summary.manual}</span>
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
                    <th className="px-3 py-2 text-left font-medium">住所（現在）</th>
                    <th className="px-3 py-2 text-left font-medium">補正後（予定）</th>
                    <th className="px-3 py-2 text-left font-medium">検出種別</th>
                    <th className="px-3 py-2 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.candidates.map((c) => (
                    <tr key={c.ownerId} className="hover:bg-gray-50 align-top">
                      <td className="px-3 py-2 font-medium text-gray-900">
                        {c.ownerNameMasked ?? (
                          <span className="text-gray-400">***</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.addressBeforeMasked ?? (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.action === "cleanup" ? (
                          c.addressAfterMasked ?? (
                            <span className="text-gray-400">（空欄）</span>
                          )
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {c.detectedTypes.map((t) => (
                            <span
                              key={t}
                              className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                                c.removableTypes.includes(t)
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-amber-100 text-amber-700"
                              }`}
                            >
                              {REGISTRY_TYPE_LABEL[t]}
                            </span>
                          ))}
                        </div>
                        {c.manualReviewRequired && c.action === "cleanup" && (
                          <p className="mt-1 text-[10px] text-amber-600">
                            ※監査専用の検出あり（手動確認）
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-1">
                          {c.action === "cleanup" ? (
                            <button
                              type="button"
                              onClick={() => onApply(c)}
                              disabled={applyingId === c.ownerId}
                              className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-emerald-100"
                            >
                              {applyingId === c.ownerId ? "適用中..." : "適用"}
                            </button>
                          ) : (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-center text-[10px] text-amber-700">
                              監査専用（手動確認）
                            </span>
                          )}
                          <Link
                            href={c.detailUrl}
                            className="rounded-md border border-gray-300 px-2 py-1 text-center text-xs text-gray-700 hover:bg-gray-50"
                          >
                            Owner 詳細
                          </Link>
                          {rowMsg && rowMsg.id === c.ownerId && (
                            <span
                              className={`text-[10px] ${rowMsg.ok ? "text-emerald-600" : "text-red-600"}`}
                            >
                              {rowMsg.text}
                            </span>
                          )}
                        </div>
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
                load(subFilter, prev);
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
                load(subFilter, data.nextCursor);
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
