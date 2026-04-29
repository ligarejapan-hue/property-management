"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  SkipForward,
  Plus,
  Link2,
  Ban,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Search,
} from "lucide-react";
import {
  fetchImportJobDetail,
  fetchAffectedProperties,
  resolveImportRow,
  retryImportRow,
  searchProperties,
  searchOwners,
  type AffectedPropertiesResponse,
} from "@/lib/api-client";
import {
  isDuplicateMessage,
  extractDuplicateReason,
  isUpdateMessage,
  extractUpdateReason,
  extractUpdatedFields,
} from "@/lib/import-row-display";
import { calcImportSummary } from "@/lib/import-summary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportJobRow {
  id: string;
  jobId: string;
  rowNumber: number;
  status: "success" | "error" | "skipped" | "needs_review";
  rawData: Record<string, string> | null;
  errorMessage: string | null;
  createdId: string | null;
  createdAt: string;
}

interface ImportJob {
  id: string;
  jobType: string;
  fileName: string;
  status: string;
  totalRows: number | null;
  successCount: number | null;
  errorCount: number | null;
  executedBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  executor: { id: string; name: string };
  rows: ImportJobRow[];
}

interface SearchResult {
  id: string;
  address?: string;
  name?: string;
  lotNumber?: string | null;
  realEstateNumber?: string | null;
  propertyType?: string;
  nameKana?: string | null;
  phone?: string | null;
  externalLinkKey?: string | null;
}

type FilterStatus = "all" | "needs_review" | "error" | "success" | "skipped";

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const ROW_STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; icon: typeof CheckCircle2 }
> = {
  success: {
    label: "成功",
    color: "text-green-700",
    bg: "bg-green-50 border-green-200",
    icon: CheckCircle2,
  },
  error: {
    label: "エラー",
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
    icon: XCircle,
  },
  needs_review: {
    label: "要レビュー",
    color: "text-amber-700",
    bg: "bg-amber-50 border-amber-200",
    icon: AlertTriangle,
  },
  skipped: {
    label: "スキップ",
    color: "text-gray-500",
    bg: "bg-gray-50 border-gray-200",
    icon: SkipForward,
  },
};

const JOB_TYPE_LABELS: Record<string, string> = {
  property_csv: "物件CSV",
  owner_csv: "所有者CSV",
  property_pdf: "謄本PDF",
  dm_history_csv: "DM履歴CSV",
  investigation_csv: "調査CSV",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ImportJobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.jobId as string;

  const [job, setJob] = useState<ImportJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterStatus>("all");

  // この取込で作成・更新された物件一覧（物件CSVジョブのみ）。
  // 主の job fetch と並列に取得する。失敗時は null のまま縮退表示。
  const [affected, setAffected] = useState<AffectedPropertiesResponse | null>(
    null,
  );

  // Row action state
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const [editedData, setEditedData] = useState<Record<string, string>>({});

  // Search-and-link state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<SearchResult | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch job detail
  const fetchJob = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchImportJobDetail(jobId);
      setJob(data as ImportJob);
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  // この取込で作成・更新された物件一覧。job 本体とは別 API。
  // 行解決で createdId が増えた後にも最新化したいので、resolve / retry の
  // 完了直後にも呼べるよう関数化しておく。
  const fetchAffected = useCallback(async () => {
    try {
      const res = await fetchAffectedProperties(jobId);
      setAffected(res);
    } catch {
      // 取得失敗は致命ではない（メイン UI は動作継続）
      setAffected(null);
    }
  }, [jobId]);

  useEffect(() => {
    fetchJob();
    fetchAffected();
  }, [fetchJob, fetchAffected]);

  // Debounced search
  const doSearch = useCallback(
    async (query: string) => {
      if (!job || query.length < 2) {
        setSearchResults([]);
        return;
      }
      setSearchLoading(true);
      try {
        const isOwner = job.jobType === "owner_csv";
        const result = isOwner
          ? await searchOwners(query)
          : await searchProperties(query);
        setSearchResults(result.data as SearchResult[]);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    },
    [job],
  );

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    setSelectedTarget(null);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => doSearch(value), 300);
  };

  // Filter rows
  const filteredRows =
    job?.rows.filter((r) => filter === "all" || r.status === filter) ?? [];

  // 段階A: 5区分の集計を共有ヘルパで算出。
  // duplicate / updated は表示上の補助情報なので別途数えるが、
  // メイン指標 (新規 / 更新 / スキップ / 要レビュー / エラー) は calcImportSummary
  // を一意の真実とする。
  const summary = calcImportSummary(job?.rows ?? []);
  const counts = {
    all: job?.rows.length ?? 0,
    needs_review: summary.needsReviewCount,
    error: summary.errorCount,
    success: summary.createdCount + summary.updatedCount,
    skipped: summary.skippedCount,
    // 重複候補（表示上のヒント。要レビュー or スキップに含まれる「重複」由来の行）
    duplicate:
      job?.rows.filter(
        (r) =>
          (r.status === "needs_review" || r.status === "skipped") &&
          isDuplicateMessage(r.errorMessage),
      ).length ?? 0,
    // 更新件数 (= summary.updatedCount のエイリアス。既存表示との互換のため残す)
    updated: summary.updatedCount,
    // 新規件数 (派生表示用)
    created: summary.createdCount,
  };

  // Handle row actions
  const handleResolve = async (
    rowId: string,
    action: "create_new" | "link_existing" | "skip" | "mark_error",
  ) => {
    setActionLoading(rowId);
    try {
      const targetId =
        action === "link_existing" ? selectedTarget?.id : undefined;
      const edited =
        action === "create_new" && editingRow === rowId
          ? editedData
          : undefined;
      await resolveImportRow(jobId, rowId, action, targetId, edited);
      await Promise.all([fetchJob(), fetchAffected()]);
      setExpandedRow(null);
      setEditingRow(null);
      setEditedData({});
      setSelectedTarget(null);
      setSearchQuery("");
      setSearchResults([]);
    } catch (err) {
      alert(err instanceof Error ? err.message : "操作に失敗しました");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async (rowId: string) => {
    setActionLoading(rowId);
    try {
      await retryImportRow(
        jobId,
        rowId,
        editingRow === rowId ? editedData : undefined,
      );
      await Promise.all([fetchJob(), fetchAffected()]);
      setExpandedRow(null);
      setEditingRow(null);
      setEditedData({});
    } catch (err) {
      alert(err instanceof Error ? err.message : "リトライに失敗しました");
    } finally {
      setActionLoading(null);
    }
  };

  // Start editing
  const startEdit = (row: ImportJobRow) => {
    setEditingRow(row.id);
    setEditedData(row.rawData ? { ...row.rawData } : {});
  };

  const cancelEdit = () => {
    setEditingRow(null);
    setEditedData({});
  };

  // Batch actions
  const handleBatchResolve = async (
    action: "skip" | "mark_error",
  ) => {
    const targetRows = filteredRows.filter(
      (r) => r.status === "needs_review" || r.status === "error",
    );
    if (targetRows.length === 0) return;
    const label = action === "skip" ? "スキップ" : "エラー確定";
    if (!confirm(`${targetRows.length} 件を「${label}」にしますか？`)) return;

    setActionLoading("batch");
    try {
      for (const row of targetRows) {
        await resolveImportRow(jobId, row.id, action);
      }
      await Promise.all([fetchJob(), fetchAffected()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : "操作に失敗しました");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="py-10 text-center">
        <p className="mb-4 text-red-600">{error ?? "ジョブが見つかりません"}</p>
        <button
          onClick={() => router.back()}
          className="text-sm text-blue-600 hover:underline"
        >
          戻る
        </button>
      </div>
    );
  }

  const isOwnerJob = job.jobType === "owner_csv";

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/import"
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h2 className="text-2xl font-bold text-gray-800">取込ジョブ詳細</h2>
          <p className="text-sm text-gray-500">
            {JOB_TYPE_LABELS[job.jobType] ?? job.jobType} - {job.fileName}
          </p>
        </div>
      </div>

      {/* Job summary
          段階A: 既存の job.successCount / job.errorCount は使用せず、
          ImportJobRow から動的に再計算した 5 区分 (新規/更新/スキップ/要レビュー/エラー)
          を表示する。これは行単位 resolve 後の最新状態と整合させるため。 */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4 lg:grid-cols-9">
          <div>
            <span className="text-gray-500">ステータス</span>
            <div className="mt-0.5 font-medium text-gray-800">
              {job.status === "completed" && (
                <span className="text-green-600">完了</span>
              )}
              {job.status === "failed" && (
                <span className="text-red-600">エラーあり</span>
              )}
              {job.status === "processing" && (
                <span className="text-blue-600">処理中</span>
              )}
              {job.status === "pending" && (
                <span className="text-amber-600">待機中</span>
              )}
            </div>
          </div>
          <div>
            <span className="text-gray-500">総行数</span>
            <div className="mt-0.5 font-medium text-gray-800">
              {job.totalRows ?? job.rows.length ?? "-"}
            </div>
          </div>
          <div>
            <span className="text-gray-500" title="success かつ「更新」プレフィックス無し">
              新規
            </span>
            <div className="mt-0.5 font-medium text-green-600">
              {summary.createdCount}
            </div>
          </div>
          <div>
            <span
              className="text-gray-500"
              title="success かつ errorMessage が「更新...」"
            >
              更新
            </span>
            <div className="mt-0.5 font-medium text-blue-600">
              {summary.updatedCount}
            </div>
          </div>
          <div>
            <span className="text-gray-500" title="status === skipped">
              スキップ
            </span>
            <div className="mt-0.5 font-medium text-gray-700">
              {summary.skippedCount}
            </div>
          </div>
          <div>
            <span className="text-gray-500" title="status === needs_review">
              要レビュー
            </span>
            <div className="mt-0.5 font-medium text-amber-600">
              {summary.needsReviewCount}
            </div>
          </div>
          <div>
            <span
              className="text-gray-500"
              title="status === error（要レビューを含まない純エラー）"
            >
              エラー
            </span>
            <div className="mt-0.5 font-medium text-red-600">
              {summary.errorCount}
            </div>
          </div>
          <div>
            <span className="text-gray-500">実行者</span>
            <div className="mt-0.5 font-medium text-gray-800">
              {job.executor.name}
            </div>
          </div>
          <div>
            <span className="text-gray-500">実行日時</span>
            <div className="mt-0.5 font-medium text-gray-800">
              {job.createdAt
                ? new Date(job.createdAt).toLocaleString("ja-JP")
                : "-"}
            </div>
          </div>
        </div>
        {/* 補助情報: 重複候補（表示ヒント。要レビュー/スキップ件数の内数） */}
        {counts.duplicate > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-2 text-xs text-amber-700">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            上記のうち <strong>{counts.duplicate} 件</strong>{" "}
            は重複検知（要レビュー / スキップ の内数）です
          </div>
        )}
      </div>

      {/* ============================================================
          この取込で作成・更新された物件 (将来のロールバック準備のための表示)
          ============================================================
          - jobType !== "property_csv" は applicable=false で対象外表示
          - applicable=true で件数 0 のときは「対象なし」
          - 一覧表示では isUpdate でバッジを切替（新規/更新）
          - 物件が削除済みの場合は found=false で「削除済み」バッジ */}
      {affected && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-700">
              この取込で作成・更新された物件
            </h3>
            {affected.applicable && affected.affected.length > 0 && (
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">
                  全 <strong>{affected.affected.length}</strong> 件
                </span>
                <span className="text-green-700">
                  新規 <strong>{affected.createdCount}</strong>
                </span>
                <span className="text-blue-700">
                  更新 <strong>{affected.updatedCount}</strong>
                </span>
                {affected.missingCount > 0 && (
                  <span className="text-gray-400">
                    削除済み <strong>{affected.missingCount}</strong>
                  </span>
                )}
              </div>
            )}
          </div>

          {!affected.applicable ? (
            <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
              このジョブ種別 (<code className="font-mono">{affected.jobType}</code>) は物件の作成・更新一覧表示に対応していません。物件CSV取込ジョブで確認できます。
            </p>
          ) : affected.affected.length === 0 ? (
            <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
              この取込で作成・更新された物件はありません（成功行に createdId が無いか、対象が見つかりません）。
            </p>
          ) : (
            <div className="overflow-x-auto rounded border border-gray-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-2 py-1.5 font-medium text-gray-600 w-12">行</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600 w-16">区分</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600">住所</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600">識別</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600">棟</th>
                    <th className="px-2 py-1.5 font-medium text-gray-600 w-20">詳細</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {affected.affected.map((p) => (
                    <tr
                      key={`${p.rowNumber}-${p.propertyId}`}
                      className="hover:bg-gray-50"
                    >
                      <td className="px-2 py-1.5 font-mono text-gray-500">
                        #{p.rowNumber}
                      </td>
                      <td className="px-2 py-1.5">
                        {!p.found ? (
                          <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-600">
                            削除済み
                          </span>
                        ) : p.isUpdate ? (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-800">
                            更新
                          </span>
                        ) : (
                          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-medium text-green-800">
                            新規
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-700">
                        {p.address ?? (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-600">
                        {[
                          p.lotNumber && `地番 ${p.lotNumber}`,
                          p.buildingNumber && `家屋 ${p.buildingNumber}`,
                          p.roomNo && `${p.roomNo}号`,
                        ]
                          .filter(Boolean)
                          .join(" / ") || (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-600">
                        {p.buildingName ? (
                          <Link
                            href={`/buildings/${p.buildingId}`}
                            className="text-blue-600 hover:underline"
                          >
                            {p.buildingName}
                          </Link>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {p.found ? (
                          <Link
                            href={`/properties/${p.propertyId}`}
                            className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
                          >
                            開く
                            <ChevronRight className="h-3 w-3" />
                          </Link>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Completion guidance */}
      {job.status === "completed" && counts.needs_review === 0 && counts.error === 0 && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <CheckCircle2 className="mr-1.5 inline h-4 w-4" />
          すべての行が処理済みです。
          <Link href="/properties" className="ml-2 font-medium text-green-700 underline hover:text-green-900">
            物件一覧へ
          </Link>
        </div>
      )}
      {counts.needs_review > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mr-1.5 inline h-4 w-4" />
          <strong>{counts.needs_review} 件</strong>の行がレビュー待ちです
          {counts.duplicate > 0 && (
            <>（うち <strong>{counts.duplicate} 件</strong>は重複検知によるスキップ候補）</>
          )}
          。 各行を展開して「新規作成」「既存に紐付け」「スキップ」のいずれかを選択してください。
        </div>
      )}
      {counts.updated > 0 && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <RefreshCw className="mr-1.5 inline h-4 w-4" />
          <strong>{counts.updated} 件</strong>の行が既存レコードを更新しました（識別子/棟内部屋番号の強い一致のみ）。空欄の値は上書きしていません。
        </div>
      )}

      {/* Filter tabs + batch actions */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            { key: "all", label: "すべて" },
            { key: "needs_review", label: "要レビュー" },
            { key: "error", label: "エラー" },
            { key: "success", label: "成功" },
            { key: "skipped", label: "スキップ" },
          ] as { key: FilterStatus; label: string }[]
        ).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              filter === tab.key
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 opacity-70">({counts[tab.key]})</span>
          </button>
        ))}

        {/* Batch actions */}
        {(filter === "needs_review" || filter === "error") &&
          counts[filter] > 0 && (
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => handleBatchResolve("skip")}
                disabled={actionLoading === "batch"}
                className="flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                <SkipForward className="h-3 w-3" />
                全件スキップ
              </button>
              <button
                onClick={() => handleBatchResolve("mark_error")}
                disabled={actionLoading === "batch"}
                className="flex items-center gap-1 rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                <Ban className="h-3 w-3" />
                全件エラー確定
              </button>
            </div>
          )}
      </div>

      {/* Rows list */}
      <div className="space-y-2">
        {filteredRows.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white py-10 text-center text-sm text-gray-400">
            該当する行はありません
          </div>
        ) : (
          filteredRows.map((row) => {
            const config =
              ROW_STATUS_CONFIG[row.status] ?? ROW_STATUS_CONFIG.error;
            const Icon = config.icon;
            const isExpanded = expandedRow === row.id;
            const isEditing = editingRow === row.id;
            const isLoading = actionLoading === row.id;
            const rawData = row.rawData ?? {};

            return (
              <div
                key={row.id}
                className={`rounded-lg border ${config.bg} overflow-hidden`}
              >
                {/* Row header */}
                <button
                  onClick={() =>
                    setExpandedRow(isExpanded ? null : row.id)
                  }
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <span className="w-8 text-xs font-mono text-gray-400">
                    #{row.rowNumber}
                  </span>
                  <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
                  <span className={`text-sm font-medium ${config.color}`}>
                    {config.label}
                  </span>
                  {isDuplicateMessage(row.errorMessage) && (
                    <span
                      className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800"
                      title={row.errorMessage ?? ""}
                    >
                      重複{extractDuplicateReason(row.errorMessage) ? `・${extractDuplicateReason(row.errorMessage)}` : ""}
                    </span>
                  )}
                  {isUpdateMessage(row.errorMessage) && (
                    <span
                      className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-800"
                      title={row.errorMessage ?? ""}
                    >
                      更新{extractUpdateReason(row.errorMessage) ? `・${extractUpdateReason(row.errorMessage)}` : ""}
                      {(() => {
                        const fields = extractUpdatedFields(row.errorMessage);
                        return fields.length > 0 ? `（${fields.length}項目）` : "";
                      })()}
                    </span>
                  )}
                  <span className="flex-1 truncate text-sm text-gray-600">
                    {rawData["住所"] ||
                      rawData["address"] ||
                      rawData["氏名"] ||
                      rawData["name"] ||
                      ""}
                  </span>
                  {row.errorMessage &&
                    !isDuplicateMessage(row.errorMessage) &&
                    !isUpdateMessage(row.errorMessage) && (
                      <span className="hidden max-w-[200px] truncate text-xs text-red-500 sm:inline">
                        {row.errorMessage}
                      </span>
                    )}
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
                  )}
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-gray-200 bg-white px-4 py-4">
                    {/* Update summary (success + update) */}
                    {row.status === "success" && isUpdateMessage(row.errorMessage) && (
                      <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                        <strong>更新:</strong>{" "}
                        {extractUpdateReason(row.errorMessage) ?? "既存レコード更新"}
                        {(() => {
                          const fields = extractUpdatedFields(row.errorMessage);
                          if (fields.length === 0) {
                            return <span className="ml-2 text-blue-600">（差分なし）</span>;
                          }
                          return (
                            <span className="ml-2 text-blue-700">
                              更新項目: {fields.join(", ")}
                            </span>
                          );
                        })()}
                      </div>
                    )}
                    {/* Error / review reason */}
                    {row.errorMessage && !(row.status === "success" && isUpdateMessage(row.errorMessage)) && (
                      <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${
                        row.status === "needs_review"
                          ? "border-amber-200 bg-amber-50 text-amber-800"
                          : "border-red-200 bg-red-50 text-red-700"
                      }`}>
                        <strong>{row.status === "needs_review" ? "レビュー理由:" : "エラー内容:"}</strong>{" "}
                        {row.errorMessage}
                      </div>
                    )}
                    {row.status === "needs_review" && !row.errorMessage && (
                      <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                        <strong>レビュー理由:</strong> 重複の可能性があるデータです。既存レコードとの紐付けまたは新規作成を選択してください。
                      </div>
                    )}

                    {/* Created ID */}
                    {row.createdId && (
                      <div className="mb-4 flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>
                          作成済ID:{" "}
                          <Link
                            href={
                              isOwnerJob
                                ? "#"
                                : `/properties/${row.createdId}`
                            }
                            className="font-mono underline"
                          >
                            {row.createdId.slice(0, 8)}...
                          </Link>
                        </span>
                      </div>
                    )}

                    {/* Building candidates (for unit import needs_review) */}
                    {row.status === "needs_review" &&
                      rawData["__building_candidates"] && (
                        <BuildingCandidates
                          candidatesJson={rawData["__building_candidates"]}
                          onSelect={(buildingId) => {
                            // Set buildingId in editedData for create_new
                            startEdit(row);
                            setEditedData((prev) => ({
                              ...prev,
                              __resolved_building_id: buildingId,
                            }));
                          }}
                        />
                      )}

                    {/* Raw data display / edit */}
                    <div className="mb-4">
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="text-sm font-medium text-gray-700">
                          元データ
                        </h4>
                        {(row.status === "error" ||
                          row.status === "needs_review") &&
                          !isEditing && (
                            <button
                              onClick={() => startEdit(row)}
                              className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                            >
                              編集
                            </button>
                          )}
                        {isEditing && (
                          <button
                            onClick={cancelEdit}
                            className="text-xs text-gray-500 hover:underline"
                          >
                            キャンセル
                          </button>
                        )}
                      </div>
                      <div className="overflow-x-auto rounded border border-gray-200">
                        <table className="w-full text-xs">
                          <tbody className="divide-y divide-gray-100">
                            {Object.entries(
                              isEditing ? editedData : rawData,
                            ).filter(([key]) => !key.startsWith("__")).map(([key, value]) => (
                              <tr key={key} className="hover:bg-gray-50">
                                <td className="w-[120px] whitespace-nowrap px-3 py-1.5 font-medium text-gray-600">
                                  {key}
                                </td>
                                <td className="px-3 py-1.5 text-gray-800">
                                  {isEditing ? (
                                    <input
                                      type="text"
                                      value={editedData[key] ?? ""}
                                      onChange={(e) =>
                                        setEditedData((prev) => ({
                                          ...prev,
                                          [key]: e.target.value,
                                        }))
                                      }
                                      className="w-full rounded border border-gray-300 px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                  ) : (
                                    <span>{value}</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Action buttons */}
                    {(row.status === "needs_review" ||
                      row.status === "error") && (
                      <div className="space-y-3">
                        {/* Search & link existing */}
                        {row.status === "needs_review" && (
                          <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                            <p className="mb-2 text-xs font-medium text-gray-600">
                              既存{isOwnerJob ? "所有者" : "物件"}を検索して紐付け
                            </p>
                            <div className="relative">
                              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                              <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) =>
                                  handleSearchInput(e.target.value)
                                }
                                placeholder={
                                  isOwnerJob
                                    ? "氏名・電話番号・住所で検索..."
                                    : "住所・地番・不動産番号で検索..."
                                }
                                className="w-full rounded border border-gray-300 py-1.5 pl-8 pr-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </div>

                            {/* Search results */}
                            {searchLoading && (
                              <div className="mt-2 flex items-center gap-1 text-xs text-gray-400">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                検索中...
                              </div>
                            )}
                            {searchResults.length > 0 && (
                              <div className="mt-2 max-h-[200px] overflow-y-auto rounded border border-gray-200 bg-white">
                                {searchResults.map((result) => (
                                  <button
                                    key={result.id}
                                    onClick={() => {
                                      setSelectedTarget(result);
                                      setSearchResults([]);
                                      setSearchQuery(
                                        result.address ??
                                          result.name ??
                                          result.id,
                                      );
                                    }}
                                    className={`flex w-full items-start gap-2 border-b border-gray-100 px-3 py-2 text-left text-xs hover:bg-blue-50 last:border-b-0 ${
                                      selectedTarget?.id === result.id
                                        ? "bg-blue-50"
                                        : ""
                                    }`}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <p className="font-medium text-gray-800 truncate">
                                        {isOwnerJob
                                          ? result.name
                                          : result.address}
                                      </p>
                                      <p className="text-gray-500 truncate">
                                        {isOwnerJob
                                          ? [
                                              result.nameKana,
                                              result.phone,
                                              result.address,
                                            ]
                                              .filter(Boolean)
                                              .join(" / ")
                                          : [
                                              result.lotNumber &&
                                                `地番: ${result.lotNumber}`,
                                              result.realEstateNumber &&
                                                `不動産番号: ${result.realEstateNumber}`,
                                            ]
                                              .filter(Boolean)
                                              .join(" / ")}
                                      </p>
                                    </div>
                                    <span className="shrink-0 font-mono text-[10px] text-gray-400">
                                      {result.id.slice(0, 8)}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Selected target */}
                            {selectedTarget && (
                              <div className="mt-2 flex items-center gap-2">
                                <div className="flex-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700">
                                  <Link2 className="mr-1 inline h-3 w-3" />
                                  紐付け先:{" "}
                                  {isOwnerJob
                                    ? selectedTarget.name
                                    : selectedTarget.address}{" "}
                                  ({selectedTarget.id.slice(0, 8)}...)
                                </div>
                                <button
                                  onClick={() =>
                                    handleResolve(row.id, "link_existing")
                                  }
                                  disabled={isLoading}
                                  className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                                >
                                  {isLoading ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Link2 className="h-3 w-3" />
                                  )}
                                  紐付け確定
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Action buttons row */}
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() =>
                              handleResolve(row.id, "create_new")
                            }
                            disabled={isLoading}
                            className="flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                          >
                            {isLoading ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Plus className="h-3 w-3" />
                            )}
                            {isEditing ? "修正して新規作成" : "新規作成"}
                          </button>

                          {row.status === "error" && (
                            <button
                              onClick={() => handleRetry(row.id)}
                              disabled={isLoading}
                              className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              {isLoading ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3 w-3" />
                              )}
                              {isEditing ? "修正してリトライ" : "リトライ"}
                            </button>
                          )}

                          <button
                            onClick={() => handleResolve(row.id, "skip")}
                            disabled={isLoading}
                            className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                          >
                            <SkipForward className="h-3 w-3" />
                            スキップ
                          </button>

                          <button
                            onClick={() =>
                              handleResolve(row.id, "mark_error")
                            }
                            disabled={isLoading}
                            className="flex items-center gap-1 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            <Ban className="h-3 w-3" />
                            エラー確定
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building candidates component (for unit import needs_review)
// ---------------------------------------------------------------------------

function BuildingCandidates({
  candidatesJson,
  onSelect,
}: {
  candidatesJson: string;
  onSelect: (buildingId: string) => void;
}) {
  let candidates: Array<{ id: string; name: string; address: string }> = [];
  try {
    candidates = JSON.parse(candidatesJson);
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;

  return (
    <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3">
      <p className="mb-2 text-xs font-medium text-blue-800">
        棟候補が見つかりました。正しい棟を選択してください:
      </p>
      <div className="space-y-1">
        {candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className="flex w-full items-center gap-2 rounded border border-blue-200 bg-white px-3 py-2 text-left text-xs hover:bg-blue-100 transition-colors"
          >
            <span className="font-medium text-gray-800">{c.name}</span>
            <span className="text-gray-500">{c.address}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-gray-400">
              {c.id.slice(0, 8)}...
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
